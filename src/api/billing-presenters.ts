// API shapes for billing, credits, coupons and BYOK (openapi.yaml components).
import type { ByokKeyView } from '../modules/integrations/byok.ts';
import type { Coupon, RedeemResult } from '../modules/billing/coupons.ts';
import type { CreditGrant, LedgerRow } from '../modules/billing/credits.ts';
import type { PlanDef, PlanId } from '../modules/billing/plans.ts';
import type { Subscription } from '../modules/billing/subscriptions.ts';
import type { UsagePeriod } from '../modules/billing/usage.ts';
import { iso } from './presenters.ts';
import type { Schemas } from './types.ts';

export function toPlan(p: PlanDef): Schemas['Plan'] {
  return {
    id: p.id,
    name: p.name,
    priceCents: p.priceCents,
    regularPriceCents: p.regularPriceCents,
    interval: p.interval,
    monthlyCredits: p.monthlyCredits,
    signupCredits: p.signupCredits,
    limits: { ...p.limits },
    features: [...p.features],
  };
}

export function toSubscription(
  plan: PlanId,
  sub: Subscription | undefined,
): Schemas['Subscription'] {
  return {
    plan,
    status: sub ? sub.status : 'none',
    currentPeriodStart: iso(sub?.periodStart),
    currentPeriodEnd: iso(sub?.periodEnd),
  };
}

export function toGrant(g: CreditGrant): Schemas['CreditGrant'] {
  return {
    id: g.id,
    source: g.source,
    amount: g.amount,
    remaining: g.remaining,
    expiresAt: iso(g.expiresAt),
    cheapModelOnly: g.cheapModelOnly,
    createdAt: g.createdAt.toISOString(),
  };
}

export function toBalance(balance: number, grants: CreditGrant[]): Schemas['CreditBalance'] {
  return { balance, grants: grants.map(toGrant) };
}

export function toLedgerEntry(r: LedgerRow): Schemas['LedgerEntry'] {
  return {
    id: r.id,
    delta: r.delta,
    reason: r.reason,
    grantId: r.grantId,
    description: r.description,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * `appActionCredits` and `paidToolCredits`: what app actions and paid tools cost in this period
 * (they are charged when they run, apart from the sync). Browser time has its own number.
 */
export function toUsagePeriod(
  p: UsagePeriod,
  appActionCredits: number,
  paidToolCredits = 0,
): Schemas['UsagePeriod'] {
  const toolCredits = p.toolCredits + paidToolCredits;
  return {
    periodStart: p.periodStart.toISOString(),
    periodEnd: p.periodEnd.toISOString(),
    aiCredits: p.aiCredits,
    awakeSeconds: p.awakeSeconds,
    awakeCredits: p.awakeCredits,
    appActionCredits,
    browserSeconds: p.browserSeconds,
    browserCredits: p.browserCredits,
    toolCredits,
    totalCredits: p.aiCredits + p.awakeCredits + appActionCredits + p.browserCredits + toolCredits,
  };
}

export function toCoupon(c: Coupon): Schemas['Coupon'] {
  return {
    id: c.id,
    campaign: c.campaign,
    codePrefix: c.codePrefix,
    credits: c.credits,
    maxRedemptions: c.maxRedemptions,
    redeemedCount: c.redeemedCount,
    expiresAt: iso(c.expiresAt),
    creditExpiryDays: c.creditExpiryDays,
    cheapModelOnly: c.cheapModelOnly,
    newUsersOnly: c.newUsersOnly,
    plans: [...c.plans],
    active: c.active,
    createdAt: c.createdAt.toISOString(),
  };
}

export function toRedemption(r: RedeemResult): Schemas['CouponRedemption'] {
  return {
    creditsAdded: r.creditsAdded,
    expiresAt: iso(r.expiresAt),
    cheapModelOnly: r.cheapModelOnly,
    balance: r.balance,
  };
}

/** `inUse`: the agent's model calls go to this provider with this key right now. */
export function toByokKey(v: ByokKeyView, inUse: boolean): Schemas['ByokKey'] {
  return {
    provider: v.provider,
    set: v.set,
    last4: v.last4,
    model: v.model,
    effectiveModel: v.effectiveModel,
    inUse: v.set && inUse,
    updatedAt: iso(v.updatedAt),
  };
}
