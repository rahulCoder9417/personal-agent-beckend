// Free-budget control (HLD 7.8): free credits = sign-up + coupon grants. An optional monthly cap
// (FREE_CREDITS_MONTHLY_CAP) blocks new sign-up grants and coupon redemptions once reached.
import { and, count, gte, inArray, sql } from 'drizzle-orm';
import { config } from '../../shared/config.ts';
import { db, type Tx } from '../../shared/db/client.ts';
import { couponRedemptions, creditGrants } from './schema.ts';

/** Accounts redeeming from one IP in a month before it is flagged for the admin (HLD 7.7). */
export const ABUSE_ACCOUNTS_PER_IP = 3;

export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function grantedThisMonth(tx: Tx, now: Date) {
  const rows = await tx
    .select({
      source: creditGrants.source,
      total: sql<string>`coalesce(sum(${creditGrants.amount}), 0)`,
    })
    .from(creditGrants)
    .where(
      and(
        inArray(creditGrants.source, ['signup', 'coupon']),
        gte(creditGrants.createdAt, monthStart(now)),
      ),
    )
    .groupBy(creditGrants.source);
  const get = (s: string) => Number(rows.find((r) => r.source === s)?.total ?? 0);
  return { signup: get('signup'), coupon: get('coupon') };
}

/**
 * Inside a transaction: may `amount` more free credits be granted this month? With a cap set,
 * takes a global lock first so parallel grants can't overshoot it together.
 */
export async function freeCapAllows(tx: Tx, amount: number, now = new Date()): Promise<boolean> {
  const cap = config().FREE_CREDITS_MONTHLY_CAP;
  if (cap === undefined) return true;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('free-credit-cap', 0))`);
  const g = await grantedThisMonth(tx, now);
  return g.signup + g.coupon + amount <= cap;
}

export interface FreeCreditStats {
  month: string;
  signupCredits: number;
  couponCredits: number;
  capCredits: number | null;
  capReached: boolean;
  abuseFlags: Array<{ ip: string; redemptions: number; userIds: string[] }>;
}

export async function freeCreditStats(now = new Date()): Promise<FreeCreditStats> {
  const g = await grantedThisMonth(db(), now);
  const cap = config().FREE_CREDITS_MONTHLY_CAP ?? null;
  const since = monthStart(now);
  const flagged = await db()
    .select({
      ip: couponRedemptions.ip,
      redemptions: count(),
      userIds: sql<string[]>`array_agg(distinct ${couponRedemptions.userId})`,
    })
    .from(couponRedemptions)
    .where(and(gte(couponRedemptions.createdAt, since), sql`${couponRedemptions.ip} is not null`))
    .groupBy(couponRedemptions.ip)
    .having(sql`count(distinct ${couponRedemptions.userId}) >= ${ABUSE_ACCOUNTS_PER_IP}`)
    .orderBy(sql`count(*) desc`)
    .limit(50);
  return {
    month: since.toISOString().slice(0, 7),
    signupCredits: g.signup,
    couponCredits: g.coupon,
    capCredits: cap,
    capReached: cap !== null && g.signup + g.coupon >= cap,
    abuseFlags: flagged.map((f) => ({
      ip: f.ip!,
      redemptions: Number(f.redemptions),
      userIds: f.userIds,
    })),
  };
}
