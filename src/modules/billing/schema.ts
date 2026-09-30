// Billing tables (HLD 7 + 8). There is deliberately NO "balance" column anywhere: the balance is
// the sum of `remaining` over a user's grants, and every change is also an append-only ledger row.
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = () => timestamp({ withTimezone: true });
const PLAN_IDS = ['free', 'pro', 'max'] as const;

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    plan: text({ enum: PLAN_IDS }).notNull(),
    polarSubscriptionId: text().notNull().unique(),
    status: text({ enum: ['active', 'cancel_at_period_end', 'past_due', 'cancelled'] }).notNull(),
    periodStart: ts(),
    periodEnd: ts(),
    /** Set once the user has been moved back to Free after a cancelled period ended. */
    endedAt: ts(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.userId), index().on(t.status, t.periodEnd)],
);

export const GRANT_SOURCES = ['signup', 'coupon', 'monthly', 'topup', 'admin', 'refund'] as const;

export const creditGrants = pgTable(
  'credit_grants',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    source: text({ enum: GRANT_SOURCES }).notNull(),
    /** Negative for refunds / chargebacks. */
    amount: integer().notNull(),
    /** What's left. May go slightly negative after an overrun; recovered from the next grant. */
    remaining: integer().notNull(),
    /** null = never expires. */
    expiresAt: ts(),
    /** May only pay for cheap-model AI and awake time (HLD 7.7). */
    cheapModelOnly: boolean().notNull().default(false),
    /** Payment id, subscription id or coupon id. */
    ref: text(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.userId, t.expiresAt), index().on(t.source, t.createdAt), index().on(t.ref)],
);

export const LEDGER_REASONS = [
  'grant',
  'charge',
  'expire',
  'refund',
  'adjust',
  'reversal',
] as const;

/** Append-only (an UPDATE is rejected by a trigger, see the migration). */
export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    grantId: text(),
    delta: integer().notNull(),
    reason: text({ enum: LEDGER_REASONS }).notNull(),
    idempotencyKey: text().notNull().unique(),
    description: text().notNull().default(''),
    meta: jsonb().$type<Record<string, unknown>>(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.userId, t.id), index().on(t.grantId)],
);

/** One row per charged sync (HLD 7.4). Unique (user, period_start): a re-run can't charge twice. */
export const usagePeriods = pgTable(
  'usage_periods',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    periodStart: ts().notNull(),
    periodEnd: ts().notNull(),
    /** Real AI cost in millionths of a dollar (a period's cost is often under a cent). */
    aiCostMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
    aiCredits: integer().notNull().default(0),
    awakeSeconds: integer().notNull().default(0),
    awakeCredits: integer().notNull().default(0),
    browserSeconds: integer().notNull().default(0),
    /** Browser minutes + paid tools. */
    toolCredits: integer().notNull().default(0),
    /** What was actually charged (AI is 0 for bring-your-own-key users). */
    creditsCharged: integer().notNull().default(0),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.userId, t.periodStart)],
);

/**
 * A coupon = one campaign. Its codes live in `coupon_codes`: `codeCount: 1` is one shared code
 * with `max_redemptions` uses; `codeCount > 1` is that many single-use codes. The campaign keeps
 * the total cap, and a user can redeem a campaign only once whichever code they use.
 */
export const coupons = pgTable('coupons', {
  id: text().primaryKey(),
  campaign: text().notNull(),
  /** e.g. `AGT-7K…` (or `AGT-7K… +49` for a batch of single-use codes). */
  codePrefix: text().notNull(),
  credits: integer().notNull(),
  maxRedemptions: integer().notNull(),
  redeemedCount: integer().notNull().default(0),
  codeCount: integer().notNull().default(1),
  expiresAt: ts().notNull(),
  creditExpiryDays: integer().notNull().default(90),
  cheapModelOnly: boolean().notNull().default(true),
  newUsersOnly: boolean().notNull().default(false),
  /** Empty = every plan. */
  plans: jsonb().$type<Array<(typeof PLAN_IDS)[number]>>().notNull().default([]),
  active: boolean().notNull().default(true),
  createdBy: text(),
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts().notNull().defaultNow(),
});

export const couponCodes = pgTable(
  'coupon_codes',
  {
    id: text().primaryKey(),
    couponId: text()
      .notNull()
      .references(() => coupons.id),
    /** sha256 of the normalised code; the code itself is never stored. */
    codeHash: text().notNull().unique(),
    codePrefix: text().notNull(),
    maxRedemptions: integer().notNull(),
    redeemedCount: integer().notNull().default(0),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.couponId)],
);

export const couponRedemptions = pgTable(
  'coupon_redemptions',
  {
    id: text().primaryKey(),
    couponId: text()
      .notNull()
      .references(() => coupons.id),
    codeId: text().notNull(),
    userId: text().notNull(),
    ip: text(),
    grantId: text().notNull(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.couponId, t.userId), index().on(t.ip, t.createdAt)],
);

/** Each user's LiteLLM virtual key (the only AI credential their container gets). */
export const litellmKeys = pgTable('litellm_keys', {
  userId: text().primaryKey(),
  /** Encrypted (AES-256-GCM). */
  keyEncrypted: text().notNull(),
  keyAlias: text().notNull(),
  models: jsonb().$type<string[]>().notNull().default([]),
  /** The max_budget last set on the key, in micro-USD (null = no cap). */
  maxBudgetMicroUsd: bigint({ mode: 'number' }),
  /** LiteLLM's cumulative spend for the key at the last usage sync (micro-USD). */
  syncedSpendMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
  syncedModelSpend: jsonb().$type<Record<string, number>>().notNull().default({}),
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts().notNull().defaultNow(),
  revokedAt: ts(),
});

/** Polar orders we have seen (maps refunds and disputes back to a user and the credits bought). */
export const payments = pgTable(
  'payments',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    polarOrderId: text().notNull().unique(),
    polarSubscriptionId: text(),
    kind: text({ enum: ['plan', 'topup'] }).notNull(),
    amountCents: integer().notNull(),
    /** Credits this payment bought (top-up credits, or the plan's monthly credits). */
    credits: integer().notNull(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)],
);
