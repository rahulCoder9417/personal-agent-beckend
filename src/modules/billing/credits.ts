// Credits as grants + an append-only ledger (HLD 7.3 / 7.4). There is no stored balance:
//   balance = sum(remaining) over unexpired grants, plus any negative remaining (debt never
//   expires).
// Invariant: sum(ledger.delta) for a user == sum(remaining) over all their grants.
//
// Every change runs in a transaction holding a per-user advisory lock, and carries an
// idempotency key (unique in the ledger), so re-running a job can't apply it twice.
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { db, type Tx } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { creditGrants, creditLedger } from './schema.ts';

export type CreditGrant = typeof creditGrants.$inferSelect;
export type LedgerRow = typeof creditLedger.$inferSelect;
export type GrantSource = CreditGrant['source'];
export type LedgerReason = LedgerRow['reason'];

/** Serialises all credit changes of one user; released at commit. Call inside a transaction. */
export async function lockUserCredits(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`credits:${userId}`}, 0))`);
}

const unexpired = (now: Date) =>
  or(isNull(creditGrants.expiresAt), gt(creditGrants.expiresAt, now));
/** Grants that make up the balance: unexpired ones, and debts (negative remaining) forever. */
const counted = (now: Date) => or(lt(creditGrants.remaining, 0), unexpired(now));
/** HLD 7.3: spend from the grant that expires soonest first; never-expiring grants last. */
const spendingOrder = [
  sql`${creditGrants.expiresAt} asc nulls last`,
  asc(creditGrants.createdAt),
  asc(creditGrants.id),
];

// --- reads ------------------------------------------------------------------------------------

export async function getBalance(userId: string, now = new Date(), tx: Tx = db()): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string | null>`coalesce(sum(${creditGrants.remaining}), 0)` })
    .from(creditGrants)
    .where(and(eq(creditGrants.userId, userId), counted(now)));
  return Number(row?.total ?? 0);
}

/** Admin: the balance of each user, worked out from the grants the same way. */
export async function balancesFor(
  userIds: string[],
  now = new Date(),
): Promise<Map<string, number>> {
  const out = new Map<string, number>(userIds.map((id) => [id, 0]));
  if (!userIds.length) return out;
  const rows = await db()
    .select({
      userId: creditGrants.userId,
      total: sql<string | null>`coalesce(sum(${creditGrants.remaining}), 0)`,
    })
    .from(creditGrants)
    .where(and(inArray(creditGrants.userId, userIds), counted(now)))
    .groupBy(creditGrants.userId);
  for (const r of rows) out.set(r.userId, Number(r.total ?? 0));
  return out;
}

/**
 * Admin overview: credits granted this month (every source; refunds and chargebacks are negative
 * grants and left out) and credits charged this month, less charges given back. From the first day
 * of the month, UTC.
 */
export async function creditsSince(since: Date): Promise<{ granted: number; spent: number }> {
  const [granted] = await db()
    .select({ n: sql<string | null>`coalesce(sum(${creditGrants.amount}), 0)` })
    .from(creditGrants)
    .where(and(gt(creditGrants.amount, 0), gte(creditGrants.createdAt, since)));
  const [spent] = await db()
    .select({ n: sql<string | null>`coalesce(sum(${creditLedger.delta}), 0)` })
    .from(creditLedger)
    .where(
      and(inArray(creditLedger.reason, ['charge', 'reversal']), gte(creditLedger.createdAt, since)),
    );
  return { granted: Number(granted?.n ?? 0), spent: -Number(spent?.n ?? 0) };
}

export async function getNextExpiry(userId: string, now = new Date()): Promise<Date | null> {
  const [row] = await db()
    .select({ next: sql<Date | string | null>`min(${creditGrants.expiresAt})` })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.userId, userId),
        gt(creditGrants.remaining, 0),
        gt(creditGrants.expiresAt, now),
      ),
    );
  return row?.next ? new Date(row.next) : null;
}

/** The grants the balance is made of, in spending order. */
export async function listBalanceGrants(userId: string, now = new Date()): Promise<CreditGrant[]> {
  return db()
    .select()
    .from(creditGrants)
    .where(and(eq(creditGrants.userId, userId), counted(now), ne(creditGrants.remaining, 0)))
    .orderBy(...spendingOrder);
}

/**
 * The balance and the grants it is made of, from one read: the balance is the sum of what those
 * grants have left (the grants left out have nothing left, so they add nothing). The same numbers
 * as getBalance and listBalanceGrants, in one round trip instead of two. For showing only.
 */
export async function getBalanceAndGrants(
  userId: string,
  now = new Date(),
): Promise<{ balance: number; grants: CreditGrant[] }> {
  const grants = await listBalanceGrants(userId, now);
  return { balance: grants.reduce((sum, g) => sum + g.remaining, 0), grants };
}

/**
 * The balance and when the next credits run out, from one read: the same numbers as getBalance and
 * getNextExpiry. For showing only (a charge decides with its own read under the user's lock).
 */
export async function getBalanceAndNextExpiry(
  userId: string,
  now = new Date(),
): Promise<{ balance: number; nextExpiry: Date | null }> {
  const [row] = await db()
    .select({
      total: sql<
        string | null
      >`coalesce(sum(${creditGrants.remaining}) filter (where ${counted(now)}), 0)`,
      next: sql<
        Date | string | null
      >`min(${creditGrants.expiresAt}) filter (where ${and(gt(creditGrants.remaining, 0), gt(creditGrants.expiresAt, now))})`,
    })
    .from(creditGrants)
    .where(eq(creditGrants.userId, userId));
  return {
    balance: Number(row?.total ?? 0),
    nextExpiry: row?.next ? new Date(row.next) : null,
  };
}

export async function listLedger(
  userId: string,
  opts: { cursor?: string; limit: number },
): Promise<{ items: LedgerRow[]; nextCursor: string | null }> {
  const where = [eq(creditLedger.userId, userId)];
  if (opts.cursor) where.push(lt(creditLedger.id, opts.cursor));
  const rows = await db()
    .select()
    .from(creditLedger)
    .where(and(...where))
    .orderBy(desc(creditLedger.id))
    .limit(opts.limit + 1);
  const items = rows.slice(0, opts.limit);
  return {
    items,
    nextCursor: rows.length > opts.limit ? items[items.length - 1]!.id : null,
  };
}

export async function ledgerKeyExists(tx: Tx, key: string): Promise<LedgerRow | undefined> {
  const [row] = await tx.select().from(creditLedger).where(eq(creditLedger.idempotencyKey, key));
  return row;
}

interface LedgerInput {
  userId: string;
  grantId: string | null;
  delta: number;
  reason: LedgerReason;
  idempotencyKey: string;
  description: string;
  meta?: Record<string, unknown> | null;
}

async function writeLedger(tx: Tx, rows: LedgerInput[]): Promise<void> {
  if (!rows.length) return;
  await tx.insert(creditLedger).values(
    rows.map((r) => ({
      id: newId('led'),
      userId: r.userId,
      grantId: r.grantId,
      delta: r.delta,
      reason: r.reason,
      idempotencyKey: r.idempotencyKey,
      description: r.description,
      meta: r.meta ?? null,
    })),
  );
}

/** Part keys of one multi-grant operation: `key`, `key#2`, `key#3`, … */
const partKey = (key: string, i: number) => (i === 0 ? key : `${key}#${i + 1}`);

async function addToGrant(tx: Tx, grantId: string, delta: number): Promise<void> {
  await tx
    .update(creditGrants)
    .set({ remaining: sql`${creditGrants.remaining} + ${delta}` })
    .where(eq(creditGrants.id, grantId));
}

// --- grants -----------------------------------------------------------------------------------

/** `ref` of the per-user grants that carry an overrun (see overrunHolder). */
export const OVERRUN_REF = 'overrun';

export interface GrantInput {
  userId: string;
  source: GrantSource;
  /** Negative for refunds / chargebacks / removals ("negative grant"). */
  amount: number;
  expiresAt: Date | null;
  cheapModelOnly?: boolean;
  ref?: string | null;
  idempotencyKey: string;
  description: string;
  meta?: Record<string, unknown>;
  /** For a negative grant: settle it from these grants first (e.g. the refunded top-up). */
  settleFirst?: string[];
}

/**
 * Creates a grant and its ledger entry, once per idempotency key. A positive grant first
 * recovers any overrun/debt (HLD 7.5: "recovered from the next grant"); a negative grant is
 * settled from the user's remaining credits right away, and whatever is left stays as debt.
 */
export async function createGrantInTx(
  tx: Tx,
  input: GrantInput,
  now = new Date(),
): Promise<{ grant: CreditGrant; created: boolean }> {
  await lockUserCredits(tx, input.userId);
  const dup = await ledgerKeyExists(tx, input.idempotencyKey);
  if (dup) {
    const [grant] = await tx
      .select()
      .from(creditGrants)
      .where(and(eq(creditGrants.id, dup.grantId ?? ''), eq(creditGrants.userId, input.userId)));
    if (!grant) throw new Error(`idempotency key ${input.idempotencyKey} reused for another user`);
    return { grant, created: false };
  }
  const [grant] = await tx
    .insert(creditGrants)
    .values({
      id: newId('grt'),
      userId: input.userId,
      source: input.source,
      amount: input.amount,
      remaining: input.amount,
      expiresAt: input.expiresAt,
      cheapModelOnly: input.cheapModelOnly ?? false,
      ref: input.ref ?? null,
      createdAt: now,
    })
    .returning();
  await writeLedger(tx, [
    {
      userId: input.userId,
      grantId: grant!.id,
      delta: input.amount,
      reason: input.amount < 0 ? 'refund' : input.source === 'admin' ? 'adjust' : 'grant',
      idempotencyKey: input.idempotencyKey,
      description: input.description,
      meta: input.meta ?? null,
    },
  ]);
  if (input.amount !== 0) {
    await settleDebtInTx(
      tx,
      input.userId,
      input.idempotencyKey,
      now,
      input.amount > 0 ? [grant!.id] : (input.settleFirst ?? []),
    );
  }
  const [fresh] = await tx.select().from(creditGrants).where(eq(creditGrants.id, grant!.id));
  return { grant: fresh!, created: true };
}

export async function createGrant(input: GrantInput, now = new Date()) {
  return db().transaction((tx) => createGrantInTx(tx, input, now));
}

/**
 * Moves credits from positive grants onto negative ones (debts). A debt on a normal grant may only
 * be recovered from normal grants; a debt on a cheap-model-only grant (it paid for cheap usage)
 * from any grant. Preferred grants go first, then the spending order.
 */
async function settleDebtInTx(
  tx: Tx,
  userId: string,
  baseKey: string,
  now: Date,
  preferIds: string[],
): Promise<void> {
  const debts = await tx
    .select()
    .from(creditGrants)
    .where(and(eq(creditGrants.userId, userId), lt(creditGrants.remaining, 0)))
    .orderBy(asc(creditGrants.createdAt), asc(creditGrants.id))
    .for('update');
  if (!debts.length) return;
  const sources = await tx
    .select()
    .from(creditGrants)
    .where(and(eq(creditGrants.userId, userId), gt(creditGrants.remaining, 0), unexpired(now)))
    .orderBy(...spendingOrder)
    .for('update');
  const rank = (g: CreditGrant) => (preferIds.includes(g.id) ? 0 : 1);
  sources.sort((a, b) => rank(a) - rank(b)); // stable: keeps the spending order within a rank

  const rows: LedgerInput[] = [];
  const deltas = new Map<string, number>();
  const bump = (id: string, d: number) => deltas.set(id, (deltas.get(id) ?? 0) + d);
  for (const debt of debts) {
    let owed = -debt.remaining;
    const what = debt.source === 'refund' ? 'Refund settled' : 'Overrun recovered';
    for (const src of sources) {
      if (owed <= 0) break;
      if (!debt.cheapModelOnly && src.cheapModelOnly) continue;
      const take = Math.min(owed, src.remaining);
      if (take <= 0) continue;
      src.remaining -= take;
      owed -= take;
      bump(src.id, -take);
      bump(debt.id, take);
      const n = rows.length;
      rows.push(
        {
          userId,
          grantId: src.id,
          delta: -take,
          reason: 'adjust',
          idempotencyKey: `${baseKey}:settle#${n + 1}`,
          description: what,
          meta: { debtGrantId: debt.id },
        },
        {
          userId,
          grantId: debt.id,
          delta: take,
          reason: 'adjust',
          idempotencyKey: `${baseKey}:settle#${n + 2}`,
          description: what,
          meta: { fromGrantId: src.id },
        },
      );
    }
  }
  for (const [id, d] of deltas) await addToGrant(tx, id, d);
  await writeLedger(tx, rows);
}

// --- spending ---------------------------------------------------------------------------------

export interface SpendInput {
  /** Credits only normal grants may pay (non-cheap AI, browser use, paid tools). */
  restricted: number;
  /** Credits any grant may pay, including cheap-model-only ones (cheap-model AI, awake time). */
  flexible: number;
  idempotencyKey: string;
  reason: 'charge' | 'adjust';
  description: string;
  meta?: Record<string, unknown>;
}

/**
 * Takes credits from grants in the spending order, once per idempotency key. If the grants run
 * out, the rest is recorded as a small negative balance (HLD 7.5) on the user's overrun holder,
 * and recovered from the next grant. Returns what was charged (0 for a duplicate).
 */
export async function spendInTx(
  tx: Tx,
  userId: string,
  input: SpendInput,
  now = new Date(),
): Promise<{ charged: number; duplicate: boolean }> {
  const restricted = Math.max(0, Math.round(input.restricted));
  const flexible = Math.max(0, Math.round(input.flexible));
  if (restricted + flexible === 0) return { charged: 0, duplicate: false };
  await lockUserCredits(tx, userId);
  if (await ledgerKeyExists(tx, input.idempotencyKey)) return { charged: 0, duplicate: true };

  const grants = await tx
    .select()
    .from(creditGrants)
    .where(and(eq(creditGrants.userId, userId), gt(creditGrants.remaining, 0), unexpired(now)))
    .orderBy(...spendingOrder)
    .for('update');
  const take = new Map<string, number>();
  const pay = (need: number, eligible: (g: CreditGrant) => boolean) => {
    for (const g of grants) {
      if (need <= 0) break;
      if (!eligible(g)) continue;
      const available = g.remaining - (take.get(g.id) ?? 0);
      if (available <= 0) continue;
      const x = Math.min(available, need);
      take.set(g.id, (take.get(g.id) ?? 0) + x);
      need -= x;
    }
    return need;
  };
  // Restricted usage first, so cheap-only grants are kept for what they are allowed to pay.
  const restrictedLeft = pay(restricted, (g) => !g.cheapModelOnly);
  const flexibleLeft = pay(flexible, () => true);
  for (const [left, cheap] of [
    [restrictedLeft, false],
    [flexibleLeft, true],
  ] as const) {
    if (left <= 0) continue;
    const holder = await overrunHolder(tx, userId, cheap, now);
    take.set(holder.id, (take.get(holder.id) ?? 0) + left);
  }

  const rows: LedgerInput[] = [];
  let i = 0;
  for (const [grantId, x] of take) {
    await addToGrant(tx, grantId, -x);
    rows.push({
      userId,
      grantId,
      delta: -x,
      reason: input.reason,
      idempotencyKey: partKey(input.idempotencyKey, i++),
      description: input.description,
      meta: { ...input.meta, chargeKey: input.idempotencyKey },
    });
  }
  await writeLedger(tx, rows);
  return { charged: restricted + flexible, duplicate: false };
}

/**
 * Where an overrun is recorded: an empty, never-expiring grant per user and kind (ref
 * `overrun`). Its cheap-model flag says what the overrun paid for, which decides what may
 * recover it: an overrun of cheap-model/awake usage from any grant, any other only from normal
 * grants.
 */
async function overrunHolder(
  tx: Tx,
  userId: string,
  cheap: boolean,
  now: Date,
): Promise<CreditGrant> {
  const [g] = await tx
    .select()
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.userId, userId),
        eq(creditGrants.ref, OVERRUN_REF),
        eq(creditGrants.cheapModelOnly, cheap),
      ),
    )
    .limit(1);
  if (g) return g;
  const [holder] = await tx
    .insert(creditGrants)
    .values({
      id: newId('grt'),
      userId,
      source: 'admin',
      amount: 0,
      remaining: 0,
      expiresAt: null,
      cheapModelOnly: cheap,
      ref: OVERRUN_REF,
      createdAt: now,
    })
    .returning();
  return holder!;
}

export interface UsageCharge {
  cheapAi: number;
  otherAi: number;
  awake: number;
  browser: number;
  tools: number;
}

/** A usage charge (HLD 7.4). Cheap-model-only grants pay only cheap-model AI and awake time. */
export async function chargeInTx(
  tx: Tx,
  userId: string,
  usage: UsageCharge,
  opts: { idempotencyKey: string; description: string; meta?: Record<string, unknown> },
  now = new Date(),
) {
  return spendInTx(
    tx,
    userId,
    {
      restricted: usage.otherAi + usage.browser + usage.tools,
      flexible: usage.cheapAi + usage.awake,
      reason: 'charge',
      ...opts,
    },
    now,
  );
}

export async function charge(
  userId: string,
  usage: UsageCharge,
  opts: { idempotencyKey: string; description: string; meta?: Record<string, unknown> },
  now = new Date(),
) {
  return db().transaction((tx) => chargeInTx(tx, userId, usage, opts, now));
}

// --- expiry -----------------------------------------------------------------------------------

async function expireGrantInTx(tx: Tx, grantId: string, now: Date, description: string) {
  const [g] = await tx
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.id, grantId))
    .for('update');
  if (!g) return 0;
  const set: Partial<CreditGrant> = {};
  if (!g.expiresAt || g.expiresAt > now) set.expiresAt = now;
  const lost = g.remaining > 0 ? g.remaining : 0;
  if (lost > 0) set.remaining = 0;
  if (Object.keys(set).length)
    await tx.update(creditGrants).set(set).where(eq(creditGrants.id, g.id));
  if (lost > 0) {
    await writeLedger(tx, [
      {
        userId: g.userId,
        grantId: g.id,
        delta: -lost,
        reason: 'expire',
        idempotencyKey: `expire:${g.id}`,
        description,
      },
    ]);
  }
  return lost;
}

/** Expires every grant past its end date (hourly job). Returns the users whose balance fell. */
export async function expireDueGrants(now = new Date()): Promise<string[]> {
  const users = new Set<string>();
  for (;;) {
    const due = await db()
      .select({ id: creditGrants.id, userId: creditGrants.userId })
      .from(creditGrants)
      .where(and(gt(creditGrants.remaining, 0), lte(creditGrants.expiresAt, now)))
      .limit(500);
    if (!due.length) break;
    for (const g of due) {
      const lost = await db().transaction(async (tx) => {
        await lockUserCredits(tx, g.userId);
        return expireGrantInTx(tx, g.id, now, 'Credits expired');
      });
      if (lost > 0) users.add(g.userId);
    }
  }
  return [...users];
}

/**
 * Ends grants of one source now (e.g. the old monthly grant on renewal, or monthly credits when
 * a subscription lapses). `olderThan`: only grants expiring before this date.
 */
export async function expireGrantsNowInTx(
  tx: Tx,
  userId: string,
  opts: { source: GrantSource; exceptId?: string; olderThan?: Date; description: string },
  now = new Date(),
): Promise<number> {
  await lockUserCredits(tx, userId);
  const where = [
    eq(creditGrants.userId, userId),
    eq(creditGrants.source, opts.source),
    unexpired(now),
  ];
  if (opts.exceptId) where.push(ne(creditGrants.id, opts.exceptId));
  if (opts.olderThan) where.push(lt(creditGrants.expiresAt, opts.olderThan));
  const rows = await tx
    .select({ id: creditGrants.id })
    .from(creditGrants)
    .where(and(...where));
  let lost = 0;
  for (const r of rows) lost += await expireGrantInTx(tx, r.id, now, opts.description);
  return lost;
}

/** Admin "revoke unspent credits": zero what's left of these grants (debts are left alone). */
export async function revokeGrantsInTx(
  tx: Tx,
  grantIds: string[],
  description: string,
): Promise<Map<string, number>> {
  const byUser = new Map<string, number>();
  if (!grantIds.length) return byUser;
  const owners = await tx
    .selectDistinct({ userId: creditGrants.userId })
    .from(creditGrants)
    .where(inArray(creditGrants.id, grantIds));
  // Same lock order everywhere (sorted) so two revocations can't deadlock.
  for (const o of owners.map((x) => x.userId).sort()) await lockUserCredits(tx, o);
  const rows = await tx
    .select()
    .from(creditGrants)
    .where(and(inArray(creditGrants.id, grantIds), gt(creditGrants.remaining, 0)))
    .for('update');
  for (const g of rows) {
    await addToGrant(tx, g.id, -g.remaining);
    await writeLedger(tx, [
      {
        userId: g.userId,
        grantId: g.id,
        delta: -g.remaining,
        reason: 'adjust',
        idempotencyKey: `revoke:${g.id}:${newId('r')}`,
        description,
      },
    ]);
    byUser.set(g.userId, (byUser.get(g.userId) ?? 0) + g.remaining);
  }
  return byUser;
}

// --- reversal ---------------------------------------------------------------------------------

/**
 * Gives back up to `amount` credits that were charged under `chargeKeys` (HLD 7.2: failed turns
 * caused by us are not charged). Credits go back to the grants they came from — only unexpired
 * ones, latest expiry first — and never more than was charged there minus earlier reversals.
 */
export async function restoreChargesInTx(
  tx: Tx,
  userId: string,
  opts: { chargeKeys: string[]; amount: number; idempotencyKey: string; description: string },
  now = new Date(),
): Promise<{ restored: number; duplicate: boolean }> {
  await lockUserCredits(tx, userId);
  if (await ledgerKeyExists(tx, opts.idempotencyKey)) return { restored: 0, duplicate: true };
  if (opts.amount <= 0 || !opts.chargeKeys.length) return { restored: 0, duplicate: false };
  const chargeKey = sql<string>`${creditLedger.meta}->>'chargeKey'`;
  const rows = await tx
    .select({
      grantId: creditLedger.grantId,
      reason: creditLedger.reason,
      delta: creditLedger.delta,
      chargeKey,
    })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.userId, userId),
        inArray(creditLedger.reason, ['charge', 'reversal']),
        inArray(chargeKey, opts.chargeKeys),
      ),
    );
  // Available per (charge, grant) = charged − already reversed.
  const avail = new Map<string, { grantId: string; chargeKey: string; n: number }>();
  for (const r of rows) {
    if (!r.grantId) continue;
    const k = `${r.chargeKey}|${r.grantId}`;
    const cur = avail.get(k) ?? { grantId: r.grantId, chargeKey: r.chargeKey, n: 0 };
    cur.n -= r.delta; // a charge row is negative (adds), a reversal row positive (subtracts)
    avail.set(k, cur);
  }
  const grantIds = [...new Set([...avail.values()].map((a) => a.grantId))];
  if (!grantIds.length) return { restored: 0, duplicate: false };
  const live = await tx
    .select()
    .from(creditGrants)
    .where(and(inArray(creditGrants.id, grantIds), unexpired(now)))
    .orderBy(sql`${creditGrants.expiresAt} desc nulls first`, desc(creditGrants.createdAt))
    .for('update');

  let left = opts.amount;
  const out: LedgerInput[] = [];
  for (const g of live) {
    for (const a of avail.values()) {
      if (left <= 0) break;
      if (a.grantId !== g.id || a.n <= 0) continue;
      const x = Math.min(a.n, left);
      left -= x;
      a.n -= x;
      await addToGrant(tx, g.id, x);
      out.push({
        userId,
        grantId: g.id,
        delta: x,
        reason: 'reversal',
        idempotencyKey: partKey(opts.idempotencyKey, out.length),
        description: opts.description,
        meta: { chargeKey: a.chargeKey },
      });
    }
  }
  await writeLedger(tx, out);
  return { restored: opts.amount - left, duplicate: false };
}
