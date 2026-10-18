// Subscription state. The user's plan (auth.users.plan) changes only here, and only from Polar
// webhooks or when a cancelled period ends (HLD 7.6) — never from the web app directly.
import { and, desc, eq, gt, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import { db, type Tx } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { audit } from '../admin/audit.ts';
import { setPlan } from '../auth/users.ts';
import { afterCreditsRemoved } from './enforce.ts';
import { firePlanChanged } from './hooks.ts';
import { PLANS, type PlanId } from './plans.ts';
import { subscriptions } from './schema.ts';

export type Subscription = typeof subscriptions.$inferSelect;
export type SubscriptionStatus = Subscription['status'];

const LIVE: SubscriptionStatus[] = ['active', 'cancel_at_period_end', 'past_due'];

/** The subscription that currently drives the plan, if any (live, or cancelled but not ended). */
export async function getCurrentSubscription(userId: string): Promise<Subscription | undefined> {
  const rows = await db()
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.endedAt)))
    .orderBy(desc(subscriptions.updatedAt));
  return rows.find((r) => LIVE.includes(r.status)) ?? rows[0];
}

/** An active (or past-due) subscription that will renew. */
export async function getRenewingSubscription(userId: string): Promise<Subscription | undefined> {
  const [row] = await db()
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        inArray(subscriptions.status, ['active', 'past_due']),
        isNull(subscriptions.endedAt),
      ),
    )
    .orderBy(desc(subscriptions.updatedAt))
    .limit(1);
  return row;
}

/**
 * A subscription set to end at the end of its period whose period is not over yet: the one
 * "Keep my plan" can still undo.
 */
export async function getEndingSubscription(
  userId: string,
  now = new Date(),
): Promise<Subscription | undefined> {
  const [row] = await db()
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.status, 'cancel_at_period_end'),
        isNull(subscriptions.endedAt),
        or(isNull(subscriptions.periodEnd), gt(subscriptions.periodEnd, now)),
      ),
    )
    .orderBy(desc(subscriptions.updatedAt))
    .limit(1);
  return row;
}

export async function getSubscriptionByPolarId(polarId: string, tx: Tx = db()) {
  const [row] = await tx
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.polarSubscriptionId, polarId));
  return row;
}

export async function upsertSubscriptionInTx(
  tx: Tx,
  input: {
    userId: string;
    plan: PlanId;
    polarSubscriptionId: string;
    status: SubscriptionStatus;
    periodStart?: Date | null;
    periodEnd?: Date | null;
    /** Only `null`, to bring back a paused subscription that was resumed and paid. */
    endedAt?: null;
  },
): Promise<Subscription> {
  const now = new Date();
  const set = {
    plan: input.plan,
    status: input.status,
    updatedAt: now,
    ...(input.periodStart !== undefined ? { periodStart: input.periodStart } : {}),
    ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
    ...(input.endedAt === null ? { endedAt: null } : {}),
  };
  const [row] = await tx
    .insert(subscriptions)
    .values({
      id: newId('sub'),
      userId: input.userId,
      polarSubscriptionId: input.polarSubscriptionId,
      ...set,
    })
    .onConflictDoUpdate({ target: subscriptions.polarSubscriptionId, set })
    .returning();
  return row!;
}

export async function setSubscriptionStatus(
  subscriptionId: string,
  status: SubscriptionStatus,
  tx: Tx = db(),
): Promise<Subscription | undefined> {
  const [row] = await tx
    .update(subscriptions)
    .set({ status, updatedAt: new Date() })
    .where(eq(subscriptions.id, subscriptionId))
    .returning();
  return row;
}

/**
 * A cancelled subscription whose period is over: back to Free (or to another live subscription's
 * plan). Credits already granted keep their own 90-day expiry. Idempotent (`ended_at`).
 */
export async function endSubscription(sub: Subscription, now = new Date()): Promise<boolean> {
  let planChanged = false;
  const ended = await db().transaction(async (tx) => {
    const [row] = await tx
      .update(subscriptions)
      .set({ endedAt: now, updatedAt: now })
      .where(and(eq(subscriptions.id, sub.id), isNull(subscriptions.endedAt)))
      .returning();
    if (!row) return false;
    const [other] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, sub.userId),
          ne(subscriptions.id, sub.id),
          inArray(subscriptions.status, LIVE),
          isNull(subscriptions.endedAt),
        ),
      )
      .orderBy(desc(subscriptions.updatedAt))
      .limit(1);
    const after = other?.plan ?? 'free';
    planChanged = await setPlan(sub.userId, after, tx);
    // The one line for the end of a paid plan (Polar's revoke or the hourly safety net).
    await audit(
      {
        userId: sub.userId,
        actor: 'system',
        action: 'plan_ended',
        summary: `${PLANS[sub.plan].name} plan ended: now on ${PLANS[after].name}`,
        details: {
          subscriptionId: sub.polarSubscriptionId,
          periodEnd: sub.periodEnd ? sub.periodEnd.toISOString() : null,
        },
      },
      tx,
    );
    return true;
  });
  if (ended) await afterCreditsRemoved(sub.userId); // also updates the key's models
  if (planChanged) await firePlanChanged(sub.userId); // e.g. Scout's browser goes off
  return ended;
}

/**
 * Hourly: end every cancelled subscription whose paid period is over. Polar sends
 * subscription.revoked at the end of a cancelled period; this is the safety net if it never
 * comes (a subscription set to cancel does not renew, so once its period is over it is over).
 */
export async function endLapsedSubscriptions(now = new Date()): Promise<number> {
  const due = await db()
    .select()
    .from(subscriptions)
    .where(
      and(
        inArray(subscriptions.status, ['cancelled', 'cancel_at_period_end']),
        isNull(subscriptions.endedAt),
        lte(subscriptions.periodEnd, now),
      ),
    );
  let n = 0;
  for (const sub of due) if (await endSubscription(sub, now)) n++;
  return n;
}
