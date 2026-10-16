// Auto top-up (HLD 7, "Auto top-up"; backend-report Part C, "Auto top-up"). Behind the server
// setting AUTO_TOPUP_ENABLED (off by default). A Pro or Max user allows Polar to charge their
// saved card for a top-up pack when a charge leaves their balance under a line they pick.
//
// The money rules stay as they are: nothing here adds credits. The charge is a Polar order made
// off-session (a draft order, then "finalize"); its credits arrive only with Polar's order.paid
// event, through the same handler and idempotency key (`topup:<order id>`) as a top-up bought by
// hand. Every try is a row in `auto_topup_attempts` with a unique key, and the Polar order id is
// saved before the card is charged, so a job that runs again finalizes that same order (Polar
// answers 412 once it is no longer a draft) and never makes a second charge.
import type { Job } from 'bullmq';
import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { config } from '../../shared/config.ts';
import { db } from '../../shared/db/client.ts';
import { badRequest, conflict, notFound, planLimit } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import { logger } from '../../shared/logger.ts';
import { redis } from '../../shared/redis.ts';
import { IGNORED } from '../../worker/runner.ts';
import { audit } from '../admin/audit.ts';
import { getUser, type User } from '../auth/users.ts';
import { addJob } from '../events/queues.ts';
import { getBalance } from './credits.ts';
import { monthStart } from './free-credits.ts';
import { fireAutoTopUpTurnedOff } from './hooks.ts';
import { getTopUp, planLimits, TOP_UPS } from './plans.ts';
import { polar, PolarHttpError, productFor, type SavedCard } from './polar.ts';
import { autoTopUpAttempts, autoTopUpSettings } from './schema.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The rules, in one place (the HLD and backend-report Part C say the same). */
export const AUTO_TOPUP = {
  thresholdDefault: 100,
  thresholdMin: 20,
  thresholdMax: 1000,
  capDefault: 2,
  capMax: 5,
  /** No new try within an hour of the last one… */
  cooldownMs: HOUR,
  /** …or within a day of a declined card. */
  afterDeclineMs: DAY,
  /** A paid top-up whose credits have not arrived blocks another one this long. */
  waitingMs: DAY,
  /** Declined cards in a row that switch it off. */
  declinesToTurnOff: 2,
} as const;

type Settings = typeof autoTopUpSettings.$inferSelect;
type Attempt = typeof autoTopUpAttempts.$inferSelect;
export type TurnedOffReason = NonNullable<Settings['turnedOffReason']>;

/** In flight or paid: what counts toward the monthly cap and "this month". */
const COUNTED: Attempt['status'][] = ['charging', 'waiting', 'credited'];

export function autoTopUpAvailable(): boolean {
  return config().AUTO_TOPUP_ENABLED;
}

async function getSettings(userId: string): Promise<Settings | undefined> {
  const [row] = await db()
    .select()
    .from(autoTopUpSettings)
    .where(eq(autoTopUpSettings.userId, userId));
  return row;
}

async function lastAttempt(userId: string): Promise<Attempt | undefined> {
  const [row] = await db()
    .select()
    .from(autoTopUpAttempts)
    .where(eq(autoTopUpAttempts.userId, userId))
    .orderBy(desc(autoTopUpAttempts.createdAt), desc(autoTopUpAttempts.id))
    .limit(1);
  return row;
}

async function monthTotals(userId: string, now: Date) {
  const since = monthStart(now);
  const [all] = await db()
    .select({ n: count() })
    .from(autoTopUpAttempts)
    .where(and(eq(autoTopUpAttempts.userId, userId), gte(autoTopUpAttempts.createdAt, since)));
  const [counted] = await db()
    .select({
      n: count(),
      cents: sql<string>`coalesce(sum(${autoTopUpAttempts.amountCents}), 0)`,
    })
    .from(autoTopUpAttempts)
    .where(
      and(
        eq(autoTopUpAttempts.userId, userId),
        gte(autoTopUpAttempts.createdAt, since),
        inArray(autoTopUpAttempts.status, COUNTED),
      ),
    );
  return {
    attempts: Number(all?.n ?? 0),
    count: Number(counted?.n ?? 0),
    spentCents: Number(counted?.cents ?? 0),
  };
}

// --- the settings (GET / PUT /v1/billing/auto-topup) ------------------------------------------

export interface AutoTopUpView {
  available: boolean;
  enabled: boolean;
  thresholdCredits: number;
  topUpId: string;
  monthlyCap: number;
  consentedAt: string | null;
  card: { brand: string; last4: string } | null;
  turnedOffReason: TurnedOffReason | null;
  thisMonth: { count: number; spentCents: number };
  lastAttempt: {
    status: Attempt['status'];
    at: string;
    credits: number;
    amountCents: number;
  } | null;
}

const defaults = () => ({
  enabled: false,
  thresholdCredits: AUTO_TOPUP.thresholdDefault,
  topUpId: TOP_UPS[0]!.id,
  monthlyCap: AUTO_TOPUP.capDefault,
});

export async function getAutoTopUp(userId: string, now = new Date()): Promise<AutoTopUpView> {
  const base = {
    ...defaults(),
    consentedAt: null,
    card: null,
    turnedOffReason: null,
    thisMonth: { count: 0, spentCents: 0 },
    lastAttempt: null,
  };
  if (!autoTopUpAvailable()) return { available: false, ...base };
  const row = await getSettings(userId);
  const last = await lastAttempt(userId);
  const month = await monthTotals(userId, now);
  return {
    available: true,
    ...base,
    ...(row
      ? {
          enabled: row.enabled,
          thresholdCredits: row.thresholdCredits,
          topUpId: row.topUpId,
          monthlyCap: row.monthlyCap,
          consentedAt: row.consentedAt?.toISOString() ?? null,
          card: row.cardBrand ? { brand: row.cardBrand, last4: row.cardLast4 ?? '' } : null,
          turnedOffReason: row.turnedOffReason ?? null,
        }
      : {}),
    thisMonth: { count: month.count, spentCents: month.spentCents },
    lastAttempt: last
      ? {
          status: last.status,
          at: last.createdAt.toISOString(),
          credits: last.credits,
          amountCents: last.amountCents,
        }
      : null,
  };
}

export interface AutoTopUpInput {
  enabled: boolean;
  thresholdCredits?: number;
  topUpId?: string;
  monthlyCap?: number;
  consent?: boolean;
}

/**
 * Switching on (or changing the settings while on) needs the user's explicit consent, a paid plan
 * and a card Polar has saved. Switching off always works and needs nothing else.
 */
export async function setAutoTopUp(user: User, input: AutoTopUpInput): Promise<AutoTopUpView> {
  if (!autoTopUpAvailable()) throw notFound('Auto top-up is not available');
  const current = (await getSettings(user.id)) ?? defaults();
  const next = {
    thresholdCredits: input.thresholdCredits ?? current.thresholdCredits,
    topUpId: input.topUpId ?? current.topUpId,
    monthlyCap: input.monthlyCap ?? current.monthlyCap,
  };
  const pack = getTopUp(next.topUpId);
  if (!pack) throw badRequest('Unknown top-up pack', { topUpId: next.topUpId });
  const now = new Date();

  if (!input.enabled) {
    await db()
      .insert(autoTopUpSettings)
      .values({ userId: user.id, enabled: false, ...next })
      .onConflictDoUpdate({
        target: autoTopUpSettings.userId,
        set: { enabled: false, ...next, updatedAt: now },
      });
    if (current.enabled) {
      await audit({
        userId: user.id,
        actor: 'user',
        action: 'auto_topup_off',
        summary: 'Auto top-up switched off',
      });
    }
    return getAutoTopUp(user.id, now);
  }

  if (!planLimits(user.plan).topUps) {
    throw planLimit('Auto top-up is for Pro and Max, like top-ups.');
  }
  if (input.consent !== true) {
    throw badRequest('Allow the charges first: auto top-up charges your saved card.');
  }
  const card = await polar().savedCard(user.id);
  if (!card) {
    throw conflict(
      'Polar has no saved card for you, so nothing could be charged. Your plan’s card is used.',
    );
  }
  const values = {
    enabled: true,
    ...next,
    consentedAt: now,
    cardBrand: card.brand,
    cardLast4: card.last4,
    declinesInRow: 0,
    turnedOffReason: null,
  };
  await db()
    .insert(autoTopUpSettings)
    .values({ userId: user.id, ...values })
    .onConflictDoUpdate({ target: autoTopUpSettings.userId, set: { ...values, updatedAt: now } });
  await audit({
    userId: user.id,
    actor: 'user',
    action: 'auto_topup_on',
    summary: `Auto top-up on: ${pack.credits} credits for $${(pack.priceCents / 100).toFixed(2)} under ${next.thresholdCredits} credits, at most ${next.monthlyCap} a month`,
    details: { ...next, consentedAt: now.toISOString() },
  });
  return getAutoTopUp(user.id, now);
}

// --- the trigger: after a charge ------------------------------------------------------------

/**
 * Called after a charge (usage sync, app action, paid tool) with the balance it left. Only adds a
 * job; the worker decides. Cheap when the setting is off (no query at all).
 */
export async function maybeQueueAutoTopUp(
  userId: string,
  balance: number,
  now = new Date(),
): Promise<void> {
  if (!autoTopUpAvailable()) return;
  try {
    const row = await getSettings(userId);
    if (!row?.enabled || balance >= row.thresholdCredits) return;
    // One job a minute at most per user; the job checks everything again anyway.
    await addJob(
      'system',
      'auto-topup',
      { userId },
      { jobId: `auto-topup-${userId}-${Math.floor(now.getTime() / MINUTE)}` },
    );
  } catch (err) {
    logger().warn({ userId, err: (err as Error).message }, 'auto top-up not queued');
  }
}

// --- the job ----------------------------------------------------------------------------------

/** Its own per-user lock: one auto top-up at a time per user, without waiting for a turn. */
const LOCK_TTL_MS = 2 * MINUTE;
const lockKey = (userId: string) => `lock:user:${userId}:auto-topup`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export type AutoTopUpResult =
  | { skipped: 'off' | 'plan' | 'enough' | 'waiting' | 'cooldown' | 'cap' | 'locked' | 'duplicate' }
  | { charged: true; attemptId: string }
  | { declined: true; turnedOff: boolean }
  | { failed: TurnedOffReason | 'not_needed' };

/** system/auto-topup `{ userId }`. Safe to run again: see the file's header. */
export async function handleAutoTopUp(job: Job): Promise<unknown> {
  if (!autoTopUpAvailable()) return IGNORED;
  const { userId } = job.data as { userId: string };
  return runAutoTopUp(userId);
}

export async function runAutoTopUp(userId: string, now = new Date()): Promise<AutoTopUpResult> {
  if (!autoTopUpAvailable()) return { skipped: 'off' };
  const token = randomUUID();
  const got = await redis().set(lockKey(userId), token, 'PX', LOCK_TTL_MS, 'NX');
  if (got !== 'OK') return { skipped: 'locked' }; // another run is on it right now
  try {
    return await tryTopUp(userId, now);
  } finally {
    await redis().eval(RELEASE, 1, lockKey(userId), token);
  }
}

async function tryTopUp(userId: string, now: Date): Promise<AutoTopUpResult> {
  const settings = await getSettings(userId);
  if (!settings?.enabled) return { skipped: 'off' };
  const user = await getUser(userId);
  if (!user || !planLimits(user.plan).topUps) return { skipped: 'plan' };
  const balance = await getBalance(userId, now);
  const last = await lastAttempt(userId);

  // A try that did not finish (the worker stopped, Polar did not answer): finish that one.
  if (last?.status === 'charging') return charge(settings, last, balance);

  if (balance >= settings.thresholdCredits) return { skipped: 'enough' };
  if (last) {
    const since = now.getTime() - last.createdAt.getTime();
    if (last.status === 'waiting' && since < AUTO_TOPUP.waitingMs) return { skipped: 'waiting' };
    const wait = last.status === 'declined' ? AUTO_TOPUP.afterDeclineMs : AUTO_TOPUP.cooldownMs;
    if (since < wait) return { skipped: 'cooldown' };
  }
  const month = await monthTotals(userId, now);
  if (month.count >= settings.monthlyCap) return { skipped: 'cap' };

  const pack = getTopUp(settings.topUpId) ?? TOP_UPS[0]!;
  const ym = now.toISOString().slice(0, 7);
  const [attempt] = await db()
    .insert(autoTopUpAttempts)
    .values({
      id: newId('atu'),
      userId,
      // The n-th try of the month: two runs at once can't both start the same one.
      idempotencyKey: `autotopup:${userId}:${ym}:${month.attempts + 1}`,
      topUpId: pack.id,
      credits: pack.credits,
      amountCents: pack.priceCents,
      status: 'charging',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: autoTopUpAttempts.idempotencyKey })
    .returning();
  if (!attempt) return { skipped: 'duplicate' };
  return charge(settings, attempt, balance);
}

async function setAttempt(
  attempt: Attempt,
  values: Partial<Pick<Attempt, 'status' | 'reason' | 'polarOrderId'>>,
): Promise<void> {
  await db()
    .update(autoTopUpAttempts)
    .set({ ...values, updatedAt: new Date() })
    // Only a try still being charged moves on (order.paid may have marked it credited already).
    .where(and(eq(autoTopUpAttempts.id, attempt.id), eq(autoTopUpAttempts.status, 'charging')));
}

/** Makes (or reuses) the Polar draft order, then charges it once. */
async function charge(settings: Settings, attempt: Attempt, balance: number) {
  const userId = attempt.userId;
  let orderId = attempt.polarOrderId;
  let card: SavedCard | null = null;

  if (orderId) {
    // Resuming: Polar knows whether that order was already charged.
    const status = await polar().orderStatus(orderId);
    if (status === 'paid') return paid(settings, attempt);
    if (status !== 'draft') throw new Error(`auto top-up order is ${status}; trying later`);
    if (balance >= settings.thresholdCredits) {
      await setAttempt(attempt, { status: 'failed', reason: 'no longer needed' });
      return { failed: 'not_needed' as const };
    }
  } else {
    card = await polar().savedCard(userId);
    if (!card) {
      await setAttempt(attempt, { status: 'failed', reason: 'no saved card' });
      await turnOff(settings, attempt, 'no_card');
      return { failed: 'no_card' as const };
    }
    await db()
      .update(autoTopUpSettings)
      .set({ cardBrand: card.brand, cardLast4: card.last4 })
      .where(eq(autoTopUpSettings.userId, userId));
    try {
      ({ orderId } = await polar().createDraftOrder({
        customerId: card.customerId,
        productId: productFor('topup', attempt.topUpId),
        metadata: {
          user_id: userId,
          kind: 'topup',
          top_up_id: attempt.topUpId,
          auto_topup_attempt: attempt.id,
        },
      }));
    } catch (err) {
      if (!(err instanceof PolarHttpError) || !err.refusal) throw err; // the job tries again
      await setAttempt(attempt, { status: 'failed', reason: err.reason || `${err.status}` });
      await turnOff(settings, attempt, 'refused');
      return { failed: 'refused' as const };
    }
    // Saved before the charge: a re-run finalizes this order, never a new one.
    await setAttempt(attempt, { polarOrderId: orderId });
  }

  const result = await polar().finalizeOrder(orderId, card?.paymentMethodId);
  switch (result.outcome) {
    case 'paid':
      return paid(settings, attempt);
    case 'not_draft': {
      const status = await polar().orderStatus(orderId);
      if (status === 'paid') return paid(settings, attempt);
      throw new Error(`auto top-up order is ${status}; trying later`);
    }
    case 'declined': {
      await setAttempt(attempt, { status: 'declined', reason: result.reason });
      const [row] = await db()
        .update(autoTopUpSettings)
        .set({ declinesInRow: sql`${autoTopUpSettings.declinesInRow} + 1`, updatedAt: new Date() })
        .where(eq(autoTopUpSettings.userId, userId))
        .returning();
      const off = (row?.declinesInRow ?? 0) >= AUTO_TOPUP.declinesToTurnOff;
      if (off) await turnOff(settings, attempt, 'declined');
      return { declined: true as const, turnedOff: off };
    }
    case 'refused':
      await setAttempt(attempt, { status: 'failed', reason: result.reason });
      await turnOff(settings, attempt, 'refused');
      return { failed: 'refused' as const };
  }
}

/** Charged: wait for order.paid (the "waiting" marker); the decline count starts again. */
async function paid(settings: Settings, attempt: Attempt) {
  await setAttempt(attempt, { status: 'waiting' });
  await db()
    .update(autoTopUpSettings)
    .set({ declinesInRow: 0 })
    .where(eq(autoTopUpSettings.userId, settings.userId));
  await audit({
    userId: settings.userId,
    actor: 'system',
    action: 'auto_topup_charged',
    summary: `Auto top-up charged: ${attempt.credits} credits for $${(attempt.amountCents / 100).toFixed(2)}`,
    details: { attemptId: attempt.id },
  });
  return { charged: true as const, attemptId: attempt.id };
}

/** Switches it off by itself and tells the user once (only the run that switched it off). */
async function turnOff(settings: Settings, attempt: Attempt, reason: TurnedOffReason) {
  const [row] = await db()
    .update(autoTopUpSettings)
    .set({ enabled: false, turnedOffReason: reason, updatedAt: new Date() })
    .where(and(eq(autoTopUpSettings.userId, settings.userId), eq(autoTopUpSettings.enabled, true)))
    .returning();
  if (!row) return;
  await audit({
    userId: settings.userId,
    actor: 'system',
    action: 'auto_topup_off',
    summary: `Auto top-up switched itself off (${reason})`,
    details: { attemptId: attempt.id },
  });
  await fireAutoTopUpTurnedOff(settings.userId, turnedOffNotice(reason, attempt));
}

/** What the user is told, for the web chat (with the link) and for chat apps (no purchase link). */
export function turnedOffNotice(
  reason: TurnedOffReason,
  pack: { credits: number; amountCents: number },
): { web: string; chat: string } {
  const what = `${pack.credits} credits ($${(pack.amountCents / 100).toFixed(2)})`;
  const why = {
    declined: `Your card was declined twice when I tried to add ${what}, so nothing was charged.`,
    no_card: `Polar has no saved card for you, so I couldn't add ${what}. Nothing was charged.`,
    refused: `Polar refused the charge when I tried to add ${what}, so nothing was charged.`,
  }[reason];
  const head = `Auto top-up is off. ${why}`;
  return {
    web: `${head} You can switch it on again in Pricing: ${config().WEB_APP_URL}/pricing`,
    chat: `${head} You can switch it on again in the Textcrew web app.`,
  };
}

// --- order.paid -------------------------------------------------------------------------------

/**
 * Called by the order.paid handler once a top-up order's credits are granted. The try (found by
 * its Polar order id) is marked credited, which lifts the "waiting" marker.
 */
export async function markAutoTopUpCredited(polarOrderId: string): Promise<void> {
  await db()
    .update(autoTopUpAttempts)
    .set({ status: 'credited', updatedAt: new Date() })
    .where(
      and(
        eq(autoTopUpAttempts.polarOrderId, polarOrderId),
        inArray(autoTopUpAttempts.status, ['charging', 'waiting']),
      ),
    );
}
