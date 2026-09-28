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
    limits: { apps: 10, automations: 3, ownMcpServers: false, topUps: false, models: 'cheap' },
    features: [
      '100 credits at sign-up',
      'Coupon codes',
      'Cheap model only',
      '10 apps',
      '3 automations',
      'Bring your own key',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceCents: 1200,
    interval: 'month',
    monthlyCredits: 1500,
    signupCredits: 0,
    limits: { apps: ALL_APPS, automations: 20, ownMcpServers: false, topUps: true, models: 'all' },
    features: [
      '1,500 credits every month',
      'All models, including Claude',
      `All ${ALL_APPS} apps`,
      '20 automations',
      'Top-ups: $10 = 800 credits',
      'Bring your own key',
    ],
  },
  max: {
    id: 'max',
    name: 'Max',
    priceCents: 2900,
    interval: 'month',
    monthlyCredits: 4500,
    signupCredits: 0,
    limits: { apps: ALL_APPS, automations: 50, ownMcpServers: true, topUps: true, models: 'all' },
    features: [
      '4,500 credits every month',
      'All models + priority in the queue',
      `All ${ALL_APPS} apps + your own MCP servers`,
      '50 automations',
      'Top-ups: $10 = 800 credits',
      'Bring your own key',
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
  { id: 'topup_10', priceCents: 1000, credits: 800, expiresInDays: 365 },
];

export function planLimits(plan: PlanId): PlanLimits {
  return { ...PLANS[plan].limits };
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
export function aiCostToCredits(microUsd: number): number {
  if (microUsd <= 0) return 0;
  // micro-USD × 250 / 1e6 = micro-USD / 4000, done in integers to avoid float drift.
  return Math.ceil(microUsd / (1_000_000 / CREDITS_PER_USD));
}

/** Credits → dollars of real cost (the LiteLLM budget unit): credits ÷ 2.5 ÷ 100. */
export function creditsToRealUsd(credits: number): number {
  return credits / CREDITS_PER_USD;
}

export const usdToMicro = (usd: number): number => Math.round(usd * 1_000_000);
export const microToUsd = (micro: number): number => micro / 1_000_000;
