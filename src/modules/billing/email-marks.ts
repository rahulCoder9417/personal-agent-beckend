// One sign-up grant per inbox, and one coupon per person (backend-report.md, "Grants and the
// ledger" and "Coupon codes"). An inbox is the email in its normal form (shared/email.ts: letter
// case, Gmail dots, +tags and googlemail.com don't count). Only a keyed hash of it is kept, never
// the email: HMAC-SHA256 under the server's encryption key, so the marks can't be turned back
// into emails or checked against a list of guesses without that key. The marks stay when an
// account is deleted.
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { keyedHashHex } from '../../shared/crypto.ts';
import { db, type Tx } from '../../shared/db/client.ts';
import { normalizeEmail } from '../../shared/email.ts';
import { logger } from '../../shared/logger.ts';
import { listLiveUserEmails } from '../auth/users.ts';
import { addJob } from '../events/queues.ts';
import { signupEmailMarks } from './schema.ts';

/**
 * The mark of an inbox, or null when there is none to make: no email, or an address that can
 * never be delivered (a deleted account's row holds one under `.invalid`).
 */
export function emailMark(email: string): string | null {
  const n = normalizeEmail(email);
  const at = n.lastIndexOf('@');
  if (at <= 0 || at === n.length - 1 || n.endsWith('.invalid')) return null;
  return keyedHashHex(`signup-email:${n}`);
}

/** The mark of a chat linked to an account (a Telegram chat id, a WhatsApp number). */
export function chatMark(channel: string, externalId: string): string {
  return keyedHashHex(`chat:${channel}:${externalId.trim()}`);
}

export type SignupEmailClaim =
  /** This account is the first with this inbox (now, or on an earlier run of the same job). */
  | 'first'
  /** Another account, live or deleted, had this inbox first. */
  | 'taken'
  /** No email to compare. */
  | 'none';

/**
 * Inside the sign-up grant's transaction: records the inbox for this account unless another
 * account had it first. Safe to run again for the same account. Two new accounts of one inbox at
 * the same moment: the second insert waits for the first to be saved, then finds it.
 */
export async function claimSignupEmail(
  tx: Tx,
  userId: string,
  email: string,
): Promise<SignupEmailClaim> {
  const mark = emailMark(email);
  if (!mark) return 'none';
  await tx.insert(signupEmailMarks).values({ mark, userId }).onConflictDoNothing();
  const [row] = await tx
    .select({ userId: signupEmailMarks.userId })
    .from(signupEmailMarks)
    .where(eq(signupEmailMarks.mark, mark));
  return row?.userId === userId ? 'first' : 'taken';
}

/**
 * Records an account's inbox if no account had it yet. Used when an account is deleted (its email
 * is still there then, and it may have changed since sign-up) and for the accounts made before
 * the marks existed.
 */
export async function rememberEmail(userId: string, email: string): Promise<void> {
  const mark = emailMark(email);
  if (!mark) return;
  await db().insert(signupEmailMarks).values({ mark, userId }).onConflictDoNothing();
}

/**
 * system/remember-account-emails: marks the inbox of every account that is not deleted, oldest
 * first, so an account made before the marks existed counts too. Safe to run again: an inbox
 * already marked keeps its first account.
 */
export async function rememberAccountEmails(): Promise<{ accounts: number }> {
  const rows = await listLiveUserEmails();
  const values = rows.flatMap((r) => {
    const mark = emailMark(r.email);
    return mark ? [{ mark, userId: r.id }] : [];
  });
  for (let i = 0; i < values.length; i += 500) {
    await db()
      .insert(signupEmailMarks)
      .values(values.slice(i, i + 500))
      .onConflictDoNothing();
  }
  logger().info({ accounts: values.length }, 'inboxes of existing accounts marked');
  return { accounts: values.length };
}

export async function handleRememberAccountEmails(_job: Job): Promise<unknown> {
  return rememberAccountEmails();
}

/** On every worker start; the fixed job id lets a start soon after the last one add nothing. */
export async function queueRememberAccountEmails(): Promise<void> {
  await addJob(
    'system',
    'remember-account-emails',
    {},
    { jobId: 'remember-account-emails', removeOnComplete: { age: 24 * 3600 } },
  );
}
