// Subscription state. The user's plan (auth.users.plan) changes only here, and only from Dodo
// webhooks or when a cancelled period ends (HLD 7.6) — never from the web app directly.
import { and, desc, eq, inArray, isNull, lte, ne } from 'drizzle-orm';
import { db, type Tx } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { setPlan } from '../auth/users.ts';
import { expireGrantsNowInTx } from './credits.ts';
import { afterCreditsRemoved } from './enforce.ts';
import type { PlanId } from './plans.ts';
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

export async function getSubscriptionByDodoId(dodoId: string, tx: Tx = db()) {
  const [row] = await tx
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.dodoSubscriptionId, dodoId));
  return row;
}

export async function upsertSubscriptionInTx(
  tx: Tx,
  input: {
    userId: string;
    plan: PlanId;
    dodoSubscriptionId: string;
    status: SubscriptionStatus;
    periodStart?: Date | null;
    periodEnd?: Date | null;
  },
): Promise<Subscription> {
  const now = new Date();
  const set = {
    plan: input.plan,
    status: input.status,
    updatedAt: now,
    ...(input.periodStart !== undefined ? { periodStart: input.periodStart } : {}),
    ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
  };
  const [row] = await tx
    .insert(subscriptions)
    .values({
      id: newId('sub'),
      userId: input.userId,
      dodoSubscriptionId: input.dodoSubscriptionId,
      ...set,
    })
    .onConflictDoUpdate({ target: subscriptions.dodoSubscriptionId, set })
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
 * plan). Monthly credits expire; top-ups stay. Idempotent (`ended_at`).
 */
export async function endSubscription(sub: Subscription, now = new Date()): Promise<boolean> {
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
    await setPlan(sub.userId, other?.plan ?? 'free', tx);
    if (!other) {
      await expireGrantsNowInTx(
        tx,
        sub.userId,
        { source: 'monthly', description: 'Monthly credits ended with the plan' },
        now,
      );
    }
    return true;
  });
  if (ended) await afterCreditsRemoved(sub.userId); // also updates the key's models
  return ended;
}

/** Hourly: end every cancelled subscription whose paid period is over. */
export async function endLapsedSubscriptions(now = new Date()): Promise<number> {
  const due = await db()
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, 'cancelled'),
        isNull(subscriptions.endedAt),
        lte(subscriptions.periodEnd, now),
      ),
    );
  let n = 0;
  for (const sub of due) if (await endSubscription(sub, now)) n++;
  return n;
}
