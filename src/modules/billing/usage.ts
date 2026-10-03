// sync-usage (HLD 7.4): LiteLLM spend + vm-manager awake/browser time → credits → ONE charge per
// user per sync, keyed by (user, period start), so re-running never double-charges.
//
// Per user, the next period starts where the last charged one ended. The whole sync for a user
// runs in one transaction under the user's credit lock, so the 5-minute job and an after-turn
// sync can't charge the same window twice.
import { and, desc, eq, gte, isNull, lt, gt, sql, asc } from 'drizzle-orm';
import { decryptSecret } from '../../shared/crypto.ts';
import { db } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { logger } from '../../shared/logger.ts';
import { getUser } from '../auth/users.ts';
import { ownKeyPaysForAi } from '../orchestrator/agent-settings.ts';
import { vm } from '../orchestrator/vm.ts';
import { restoreAppActionChargesInTx } from './app-actions.ts';
import { chargeInTx, getBalance, lockUserCredits, restoreChargesInTx } from './credits.ts';
import { afterCreditsAdded } from './enforce.ts';
import { fireBalanceDepleted } from './hooks.ts';
import { litellm, refreshBudget } from './litellm.ts';
import {
  AWAKE_SECONDS_PER_CREDIT,
  BROWSER_SECONDS_PER_CREDIT,
  aiCostToCredits,
  cheapModel,
  planLimits,
  usdToMicro,
} from './plans.ts';
import { litellmKeys, usagePeriods } from './schema.ts';

export type UsagePeriod = typeof usagePeriods.$inferSelect;

export interface SyncResult {
  /** Credits charged by this sync (0 if nothing happened or it was already charged). */
  charged: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  balance: number;
}

const usageKey = (userId: string, periodStart: Date) =>
  `usage:${userId}:${periodStart.toISOString()}`;

/** Newly completed blocks when `add` seconds join `before` seconds (fractions carry over). */
const blocks = (before: number, add: number, per: number) =>
  Math.floor((before + add) / per) - Math.floor(before / per);

export async function syncUsageForUser(userId: string, now = new Date()): Promise<SyncResult> {
  let spendUsd: number | undefined;
  const out = await db().transaction(async (tx) => {
    await lockUserCredits(tx, userId);
    const user = await getUser(userId, tx);
    if (!user) return null;
    const [keyRow] = await tx
      .select()
      .from(litellmKeys)
      .where(and(eq(litellmKeys.userId, userId), isNull(litellmKeys.revokedAt)));
    const [last] = await tx
      .select({ end: usagePeriods.periodEnd })
      .from(usagePeriods)
      .where(eq(usagePeriods.userId, userId))
      .orderBy(desc(usagePeriods.periodStart))
      .limit(1);
    const since = last?.end ?? keyRow?.createdAt ?? user.createdAt;
    if (now.getTime() <= since.getTime()) return null;

    // Awake + browser time in [since, now).
    const res = await vm().getUsage({
      sinceUnixMs: BigInt(since.getTime()),
      untilUnixMs: BigInt(now.getTime()),
      userId,
    });
    const u = res.usage.find((x) => x.userId === userId);
    const awakeSeconds = Number(u?.awakeSeconds ?? 0n);
    const browserSeconds = Number(u?.browserSeconds ?? 0n);

    // AI: LiteLLM keeps cumulative spend per key; the new part is the difference.
    let aiMicro = 0;
    let otherMicro = 0;
    let synced: { total: number; models: Record<string, number> } | undefined;
    if (keyRow) {
      const spend = await litellm().getKeySpend(decryptSecret(keyRow.keyEncrypted));
      spendUsd = spend.spend;
      const models = Object.fromEntries(
        Object.entries(spend.modelSpend).map(([m, v]) => [m, usdToMicro(v)]),
      );
      synced = { total: usdToMicro(spend.spend), models };
      aiMicro = Math.max(0, synced.total - keyRow.syncedSpendMicroUsd);
      if (planLimits(user.plan).models === 'all') {
        const cheap = cheapModel();
        const cheapMicro = Math.max(
          0,
          (models[cheap] ?? 0) - (keyRow.syncedModelSpend[cheap] ?? 0),
        );
        otherMicro = Math.max(0, aiMicro - cheapMicro);
      }
    }
    // Nothing happened: write nothing; the next sync simply covers a longer window.
    if (aiMicro === 0 && awakeSeconds === 0 && browserSeconds === 0) return null;

    // Bring-your-own-key: AI isn't charged in credits (HLD 7.1); awake time still is.
    // Not so for a user who chose Textcrew AI over their key.
    const byok = await ownKeyPaysForAi(userId, tx);
    const aiCredits = byok ? 0 : aiCostToCredits(aiMicro);
    const otherAi = byok ? 0 : Math.min(aiCredits, aiCostToCredits(otherMicro));
    const [prev] = await tx
      .select({
        awake: sql<string>`coalesce(sum(${usagePeriods.awakeSeconds}), 0)`,
        browser: sql<string>`coalesce(sum(${usagePeriods.browserSeconds}), 0)`,
      })
      .from(usagePeriods)
      .where(eq(usagePeriods.userId, userId));
    const awakeCredits = blocks(Number(prev?.awake ?? 0), awakeSeconds, AWAKE_SECONDS_PER_CREDIT);
    const browserCredits = blocks(
      Number(prev?.browser ?? 0),
      browserSeconds,
      BROWSER_SECONDS_PER_CREDIT,
    );
    const total = aiCredits + awakeCredits + browserCredits;

    const periodId = newId('use');
    const [row] = await tx
      .insert(usagePeriods)
      .values({
        id: periodId,
        userId,
        periodStart: since,
        periodEnd: now,
        aiCostMicroUsd: aiMicro,
        aiCredits,
        awakeSeconds,
        awakeCredits,
        browserSeconds,
        browserCredits,
        creditsCharged: total,
      })
      .onConflictDoNothing({ target: [usagePeriods.userId, usagePeriods.periodStart] })
      .returning();
    if (!row) return null; // already charged
    if (keyRow && synced) {
      await tx
        .update(litellmKeys)
        .set({ syncedSpendMicroUsd: synced.total, syncedModelSpend: synced.models, updatedAt: now })
        .where(eq(litellmKeys.userId, userId));
    }
    const { charged } = await chargeInTx(
      tx,
      userId,
      {
        cheapAi: aiCredits - otherAi,
        otherAi,
        awake: awakeCredits,
        browser: browserCredits,
        tools: 0,
      },
      {
        idempotencyKey: usageKey(userId, since),
        description: describe(aiCredits, awakeCredits, browserCredits),
        meta: { usagePeriodId: periodId },
      },
      now,
    );
    return { charged, periodStart: since, periodEnd: now };
  });

  if (!out)
    return { charged: 0, periodStart: null, periodEnd: null, balance: await getBalance(userId) };
  // Enforce (HLD 7.5): budget = balance; at zero the budget is 0 and listeners are told.
  const balance = await getBalance(userId);
  try {
    await refreshBudget(userId, spendUsd === undefined ? {} : { spendUsd });
  } catch (err) {
    logger().warn({ userId, err: (err as Error).message }, 'LiteLLM budget update failed');
  }
  if (out.charged > 0 && balance <= 0) await fireBalanceDepleted(userId);
  return { ...out, balance };
}

function describe(ai: number, awake: number, browser: number): string {
  const parts = [];
  if (ai) parts.push(`AI ${ai}`);
  if (awake) parts.push(`awake time ${awake}`);
  if (browser) parts.push(`browser ${browser}`);
  return `Usage: ${parts.join(', ') || 'none'}`;
}

/** The 5-minute system job: every user with a LiteLLM key. One user's failure doesn't stop it. */
export async function syncAllUsage(
  now = new Date(),
): Promise<{ users: number; charged: number; failed: number }> {
  const rows = await db()
    .select({ userId: litellmKeys.userId })
    .from(litellmKeys)
    .where(isNull(litellmKeys.revokedAt))
    .orderBy(asc(litellmKeys.userId));
  let charged = 0;
  let failed = 0;
  const queue = rows.map((r) => r.userId);
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        charged += (await syncUsageForUser(id, now)).charged;
      } catch (err) {
        failed++;
        logger().warn({ userId: id, err: (err as Error).message }, 'usage sync failed');
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { users: rows.length, charged, failed };
}

/**
 * HLD 7.2: a failed turn caused by us is not charged. Syncs first (so the turn is charged), works
 * out what the turn cost, and gives that back to the grants it came from, together with the
 * credits for app actions that ran in the turn. Idempotent per key.
 */
export async function reverseTurn(
  userId: string,
  turn: { startedAt: Date; endedAt: Date; idempotencyKey: string },
): Promise<{ restored: number }> {
  await syncUsageForUser(userId);
  const [keyRow] = await db()
    .select()
    .from(litellmKeys)
    .where(and(eq(litellmKeys.userId, userId), isNull(litellmKeys.revokedAt)));
  let ai = 0;
  if (keyRow && !(await ownKeyPaysForAi(userId))) {
    const spend = await litellm().getSpendBetween(
      decryptSecret(keyRow.keyEncrypted),
      turn.startedAt,
      turn.endedAt,
    );
    ai = aiCostToCredits(usdToMicro(spend.spend));
  }
  const res = await vm().getUsage({
    sinceUnixMs: BigInt(turn.startedAt.getTime()),
    untilUnixMs: BigInt(turn.endedAt.getTime()),
    userId,
  });
  const u = res.usage.find((x) => x.userId === userId);
  const awake = Math.ceil(Number(u?.awakeSeconds ?? 0n) / AWAKE_SECONDS_PER_CREDIT);
  const browser = Math.ceil(Number(u?.browserSeconds ?? 0n) / BROWSER_SECONDS_PER_CREDIT);

  const periods = await db()
    .select({ start: usagePeriods.periodStart })
    .from(usagePeriods)
    .where(
      and(
        eq(usagePeriods.userId, userId),
        gt(usagePeriods.periodEnd, turn.startedAt),
        lt(usagePeriods.periodStart, turn.endedAt),
      ),
    );
  const restored = await db().transaction(async (tx) => {
    const usage = await restoreChargesInTx(tx, userId, {
      chargeKeys: periods.map((p) => usageKey(userId, p.start)),
      amount: ai + awake + browser,
      idempotencyKey: `reversal:${turn.idempotencyKey}`,
      description: 'Failed turn refunded',
    });
    const appActions = await restoreAppActionChargesInTx(tx, userId, {
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      idempotencyKey: `reversal:${turn.idempotencyKey}:app-actions`,
    });
    return usage.restored + appActions;
  });
  if (restored > 0) await afterCreditsAdded(userId);
  return { restored };
}

export async function listUsagePeriods(
  userId: string,
  from: Date,
  to: Date,
): Promise<UsagePeriod[]> {
  return db()
    .select()
    .from(usagePeriods)
    .where(
      and(
        eq(usagePeriods.userId, userId),
        gte(usagePeriods.periodStart, from),
        lt(usagePeriods.periodStart, to),
      ),
    )
    .orderBy(asc(usagePeriods.periodStart));
}
