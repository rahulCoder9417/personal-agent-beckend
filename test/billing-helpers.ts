// Phase 5 test helpers: small DB shortcuts for billing tests.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { channelLinks } from '../src/modules/auth/schema.ts';
import { creditGrants, creditLedger } from '../src/modules/billing/schema.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';

export async function linkChat(userId: string): Promise<void> {
  await db()
    .insert(channelLinks)
    .values({
      id: newId('lnk'),
      userId,
      channel: 'telegram',
      externalId: randomUUID(),
      displayId: '@test',
    });
}

export async function grantsOf(userId: string) {
  return db().select().from(creditGrants).where(eq(creditGrants.userId, userId));
}

export async function ledgerOf(userId: string) {
  return db().select().from(creditLedger).where(eq(creditLedger.userId, userId));
}

/** sum(ledger.delta) must always equal sum(remaining) over all grants. */
export async function ledgerMatchesGrants(userId: string): Promise<boolean> {
  const g = (await grantsOf(userId)).reduce((n, r) => n + r.remaining, 0);
  const l = (await ledgerOf(userId)).reduce((n, r) => n + r.delta, 0);
  return g === l;
}

export const fakeJob = (data: Record<string, unknown>) => ({ data }) as unknown as Job;

export const DAY = 24 * 3600 * 1000;
