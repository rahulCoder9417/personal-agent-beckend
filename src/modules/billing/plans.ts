// Plans, top-up packs and the credit maths (HLD 7.1 + 7.2).
import { config } from '../../shared/config.ts';

export type PlanId = 'free' | 'pro' | 'max';
export const PLAN_IDS: PlanId[] = ['free', 'pro', 'max'];

export interface PlanLimits {
  /** Composio apps the user may connect. */
  apps: number;
  automations: number;
  ownMcpServers: boolean;
  topUps: boolean;
  models: 'cheap' | 'all';
  /** Browser use (Scout's real browser, 2 credits per minute): Max only (launch-plan D10). */
  browser: boolean;
}

export interface PlanDef {
  id: PlanId;
  name: string;
  priceCents: number;
  interval: 'month' | null;
  monthlyCredits: number;
  signupCredits: number;
  limits: PlanLimits;
  features: string[];
}

export const SIGNUP_CREDITS = 100;
/**
 * Every credit lasts 90 days from the day it's granted, whatever the source (sign-up, monthly,
 * top-up, coupon). Unused monthly credits therefore carry over for up to 90 days.
 */
export const CREDIT_EXPIRY_DAYS = 90;
const DAY_MS = 24 * 3600 * 1000;

/** When a grant made at `from` expires. */
export function creditExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + CREDIT_EXPIRY_DAYS * DAY_MS);
}
/** Total Composio apps in the catalogue ("All 25"). */
export const ALL_APPS = 25;

export const PLANS: Record<PlanId, PlanDef> = {
  free: {
    id: 'free',
    name: 'Free',
    priceCents: 0,
    interval: null,
    monthlyCredits: 0,
    signupCredits: SIGNUP_CREDITS,
    // Model limits stay in code (models: 'cheap') even though the pricing page no longer shows them.
    limits: {
      apps: 10,
      automations: 1,
      ownMcpServers: false,
      topUps: false,
      models: 'cheap',
      browser: false,
    },
    features: [
      '100 credits at sign-up',
      'Coupon codes',
      '10 apps',
      '1 automation',
      'Bring your own key',
      'Credits last 90 days',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceCents: 1200,
    interval: 'month',
    monthlyCredits: 1500,
    signupCredits: 0,
    limits: {
      apps: ALL_APPS,
      automations: 5,
      ownMcpServers: false,
      topUps: true,
      models: 'all',
      browser: false,
    },
    features: [
      '1,500 credits every month',
      `All ${ALL_APPS} apps`,
      '5 automations',
      'Top-ups: $10 = 800 credits',
      'Bring your own key',
      'Unused credits carry over for 90 days',
    ],
  },
  max: {
    id: 'max',
    name: 'Max',
    priceCents: 3000,
    interval: 'month',
    monthlyCredits: 4500,
    signupCredits: 0,
    limits: {
      apps: ALL_APPS,
      automations: 50,
      ownMcpServers: true,
      topUps: true,
      models: 'all',
      browser: true,
    },
    features: [
      '4,500 credits every month',
      'Priority when things get busy',
      `All ${ALL_APPS} apps + your own MCP servers`,
      '50 automations',
      "Scout's web search: 1 credit per search",
      'Browser use: 2 credits per minute',
      'Top-ups: $10 = 800 credits',
      'Bring your own key',
      'Unused credits carry over for 90 days',
    ],
  },
};

export interface TopUpPack {
  id: string;
  priceCents: number;
  credits: number;
  expiresInDays: number;
}

export const TOP_UPS: TopUpPack[] = [
  { id: 'topup_10', priceCents: 1000, credits: 800, expiresInDays: CREDIT_EXPIRY_DAYS },
];

export function planLimits(plan: PlanId): PlanLimits {
  return { ...PLANS[plan].limits };
}

/**
 * Scout's web search through Textcrew (the `web_search` tool, backed by Brave) is a Max feature,
 * like the browser (HLD 7.1, decided 2026-10-04). The search built into a user's own engine is
 * not the platform's and needs no plan. Kept out of `limits`, which is the API's shape.
 */
const WEB_SEARCH_PLANS: readonly PlanId[] = ['max'];
export function planHasWebSearch(plan: PlanId): boolean {
  return WEB_SEARCH_PLANS.includes(plan);
}

export function getTopUp(id: string): TopUpPack | undefined {
  return TOP_UPS.find((t) => t.id === id);
}

export function isPaidPlan(plan: PlanId): boolean {
  return plan !== 'free';
}

// --- models ---------------------------------------------------------------------------------

export function cheapModel(): string {
  return config().LITELLM_CHEAP_MODEL;
}

/** Model names a plan may call through LiteLLM. */
export function modelsForPlan(plan: PlanId): string[] {
  if (PLANS[plan].limits.models === 'cheap') return [cheapModel()];
  const paid = config()
    .LITELLM_PAID_MODELS.split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return [...new Set([cheapModel(), ...paid])];
}

/**
 * Per-key model aliases: containers always call `agent-default` (LITELLM_AGENT_MODEL); on Free
 * it means the cheap model, on paid plans the premium one.
 */
export function aliasesForPlan(plan: PlanId): Record<string, string> {
  const c = config();
  const target = PLANS[plan].limits.models === 'cheap' ? cheapModel() : c.LITELLM_PREMIUM_MODEL;
  return { [c.LITELLM_AGENT_MODEL]: target };
}

/** What the user's LiteLLM key may call: the agent alias plus the plan's models. */
export function keyModelsForPlan(plan: PlanId): string[] {
  return [config().LITELLM_AGENT_MODEL, ...modelsForPlan(plan)];
}

// --- credit maths (HLD 7.2) -------------------------------------------------------------------

/** 1 credit = $0.01 of price, prices are 2.5× real cost → 1 credit = $0.004 of real cost. */
export const MARKUP = 2.5;
const CREDITS_PER_USD = MARKUP * 100; // 250
export const AWAKE_SECONDS_PER_CREDIT = 600; // 1 credit per 10 minutes awake
export const BROWSER_SECONDS_PER_CREDIT = 30; // 2 credits per minute

/** Real AI cost (micro-USD) → credits, rounded up. */
/** Real cost that makes one credit: 4,000 micro-USD ($0.004 × 2.5 = $0.01). */
export const MICRO_USD_PER_CREDIT = 1_000_000 / CREDITS_PER_USD;
export function aiCostToCredits(microUsd: number): number {
  if (microUsd <= 0) return 0;
  // micro-USD × 250 / 1e6 = micro-USD / 4000, done in integers to avoid float drift.
  return Math.ceil(microUsd / MICRO_USD_PER_CREDIT);
}

/** Credits → dollars of real cost (the LiteLLM budget unit): credits ÷ 2.5 ÷ 100. */
export function creditsToRealUsd(credits: number): number {
  return credits / CREDITS_PER_USD;
}

export const usdToMicro = (usd: number): number => Math.round(usd * 1_000_000);
export const microToUsd = (micro: number): number => micro / 1_000_000;
