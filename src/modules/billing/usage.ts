// sync-usage (HLD 7.4): LiteLLM spend + vm-manager awake/browser time → credits → ONE charge per
// user per sync, keyed by (user, period start), so re-running never double-charges.
//
// Per user, the next period starts where the last charged one ended. The whole sync for a user
// runs in one transaction under the user's credit lock, so the 5-minute job and the billing job
// after a turn (turn-billing.ts) can't charge the same window twice.
import { and, desc, eq, gte, isNull, lt, gt, sql, asc } from 'drizzle-orm';
import { decryptSecret } from '../../shared/crypto.ts';
import { db } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { logger } from '../../shared/logger.ts';
import { getUser } from '../auth/users.ts';
import { vm } from '../orchestrator/vm.ts';
import { restoreAppActionChargesInTx } from './app-actions.ts';
import { restorePaidToolChargesInTx } from './paid-tools.ts';
import { maybeQueueAutoTopUp } from './auto-topup.ts';
import { chargeInTx, getBalance, lockUserCredits, restoreChargesInTx } from './credits.ts';
import { afterCreditsAdded } from './enforce.ts';
import { fireBalanceDepleted } from './hooks.ts';
import { litellm, routesToOwnKey, syncLiteLLMKey } from './litellm.ts';
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

export interface SyncOptions {
  /**
   * `false`: LiteLLM is not asked at all. The AI since the last sync stays uncharged until a sync
   * that asks for it (the 5-minute one): AI is charged as the difference from the total saved,
   * so leaving it out never loses it. The key's budget is also left to that sync. Used after a
   * turn on the user's Claude plan, whose AI never goes through LiteLLM.
   */
  ai?: boolean;
}

export async function syncUsageForUser(
  userId: string,
  now = new Date(),
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const readAi = opts.ai !== false;
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
    if (keyRow && readAi) {
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

    // Bring-your-own-key: AI isn't charged in credits (HLD 7.1); awake time still is. What
    // counts is where the key really sent the AI (switches settle usage first: switchAiRouting).
    const byok = keyRow ? routesToOwnKey(keyRow) : false;
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

  // Enforce (HLD 7.5): budget = balance; at zero the budget is 0 and listeners are told. Also
  // when nothing was charged: this is where a LiteLLM update that failed earlier is applied.
  // Without the AI, LiteLLM is left alone: its budget needs the key's spend, which only it knows.
  if (readAi) {
    try {
      await syncLiteLLMKey(userId, spendUsd === undefined ? {} : { spendUsd });
    } catch (err) {
      logger().warn({ userId, err: (err as Error).message }, 'LiteLLM key update failed');
    }
  }
  if (!out)
    return { charged: 0, periodStart: null, periodEnd: null, balance: await getBalance(userId) };
  const balance = await getBalance(userId);
  if (out.charged > 0 && balance <= 0) await fireBalanceDepleted(userId);
  if (out.charged > 0) await maybeQueueAutoTopUp(userId, balance);
  return { ...out, balance };
}

/**
 * What pays for the user's AI may have changed (an own key saved or deleted, another AI chosen, a
 * Claude plan connected or gone). First charges the usage so far under the routing that ran,
 * then points the LiteLLM key at the new source. Throws if LiteLLM can't be switched.
 */
export async function switchAiRouting(userId: string): Promise<void> {
  try {
    await syncUsageForUser(userId);
  } catch (err) {
    logger().warn({ userId, err: (err as Error).message }, 'usage sync before an AI switch failed');
  }
  await syncLiteLLMKey(userId);
}

/** Best effort: a failure is logged; the 5-minute usage sync switches it later. */
export async function switchAiRoutingQuietly(userId: string): Promise<void> {
  try {
    await switchAiRouting(userId);
  } catch (err) {
    logger().warn({ userId, err: (err as Error).message }, 'AI switch failed; retried by the sync');
  }
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
 * credits for app actions and paid tools that ran in the turn. Idempotent per key: everything is
 * given back in one transaction, so a run that fails gives nothing and the next one starts over.
 *
 * Throws if LiteLLM's spend log can't be read, unless `withoutAiIfUnknown` (the job's last try):
 * then everything but the AI is given back, once, and `aiSkipped` says so. `ai: false` (a turn on
 * the user's Claude plan, whose AI never goes through LiteLLM): LiteLLM is not asked at all.
 */
export async function reverseTurn(
  userId: string,
  turn: { startedAt: Date; endedAt: Date; idempotencyKey: string },
  opts: { withoutAiIfUnknown?: boolean; ai?: boolean } = {},
): Promise<{ restored: number; aiSkipped?: true }> {
  const readAi = opts.ai !== false;
  await syncUsageForUser(userId, new Date(), { ai: readAi });
  const [keyRow] = readAi
    ? await db()
        .select()
        .from(litellmKeys)
        .where(and(eq(litellmKeys.userId, userId), isNull(litellmKeys.revokedAt)))
    : [];
  let ai = 0;
  let aiSkipped = false;
  if (keyRow && !routesToOwnKey(keyRow)) {
    try {
      const spend = await litellm().getSpendBetween(
        decryptSecret(keyRow.keyEncrypted),
        turn.startedAt,
        turn.endedAt,
      );
      ai = aiCostToCredits(usdToMicro(spend.spend));
    } catch (err) {
      if (!opts.withoutAiIfUnknown) throw err;
      aiSkipped = true;
      logger().warn(
        { userId, key: turn.idempotencyKey, err: (err as Error).message },
        "failed turn refunded without its AI: LiteLLM's spend log could not be read",
      );
    }
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
    const paidTools = await restorePaidToolChargesInTx(tx, userId, {
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      idempotencyKey: `reversal:${turn.idempotencyKey}:paid-tools`,
    });
    return usage.restored + appActions + paidTools;
  });
  if (restored > 0) await afterCreditsAdded(userId, { litellm: readAi });
  return aiSkipped ? { restored, aiSkipped: true } : { restored };
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
