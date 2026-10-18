// Gives back the wake fees charged on 18 Oct 2026, the few hours the fee was 1 credit per wake
// (it was removed the same day). Each wake charge in the ledger gets one admin grant of the same
// amount, keyed by the charge's own id, so running this twice gives nothing twice.
// Run inside the api container:
//   node --import tsx scripts/refund-wake-fees.ts            # shows what it would give back
//   node --import tsx scripts/refund-wake-fees.ts --apply    # gives it back
import { and, eq, lt, sql } from 'drizzle-orm';
import { adjustCredits } from '../src/modules/billing/admin.ts';
import { creditExpiry } from '../src/modules/billing/plans.ts';
import { creditLedger } from '../src/modules/billing/schema.ts';
import { WAKE_KIND } from '../src/modules/billing/wake-fee.ts';
import { closeDb, db } from '../src/shared/db/client.ts';

const apply = process.argv.includes('--apply');
const charges = await db()
  .select({ id: creditLedger.id, userId: creditLedger.userId, delta: creditLedger.delta })
  .from(creditLedger)
  .where(and(sql`${creditLedger.meta}->>'kind' = ${WAKE_KIND}`, lt(creditLedger.delta, 0)));

const perUser = new Map<string, number>();
for (const c of charges) perUser.set(c.userId, (perUser.get(c.userId) ?? 0) - c.delta);
console.log(
  `${charges.length} wake charges, ${perUser.size} users, ${[...perUser.values()].reduce((a, b) => a + b, 0)} credits`,
);
for (const [userId, credits] of perUser) console.log(`  ${userId}  +${credits}`);

if (apply) {
  for (const c of charges) {
    await adjustCredits({
      userId: c.userId,
      amount: -c.delta,
      reason: 'Refund: the wake fee was removed (18 Oct 2026)',
      expiresAt: creditExpiry(),
      idempotencyKey: `wake-refund:${c.id}`,
      adminId: 'system',
    });
  }
  const done = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.reason, 'grant'),
        sql`${creditLedger.idempotencyKey} like 'admin:%:wake-refund:%'`,
      ),
    );
  console.log(`Given back. Refund grants in the ledger now: ${done[0]?.n ?? 0}`);
} else if (charges.length) {
  console.log('Nothing changed. Run again with --apply to give these back.');
}
await closeDb();
process.exit(0);
