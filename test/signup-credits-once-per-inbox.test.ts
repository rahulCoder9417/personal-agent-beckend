// The 100 sign-up credits: 14 days, and once per inbox (decided 18 Oct 2026). An inbox is the email
// in its normal form; a new account whose inbox had an account before (live or deleted) is made as
// usual but gets no sign-up credits, with an activity-log line saying why.
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { scrubDeletedUser } from '../src/modules/auth/users.ts';
import { getBalance } from '../src/modules/billing/credits.ts';
import { emailMark, rememberAccountEmails } from '../src/modules/billing/email-marks.ts';
import { offboardBilling, onboardBilling } from '../src/modules/billing/onboard.ts';
import { SIGNUP_CREDIT_EXPIRY_DAYS } from '../src/modules/billing/plans.ts';
import { signupEmailMarks } from '../src/modules/billing/schema.ts';
import { db } from '../src/shared/db/client.ts';
import { normalizeEmail } from '../src/shared/email.ts';
import { installFakes } from './billing-fakes.ts';
import { grantsOf } from './billing-helpers.ts';
import { createUser } from './helpers.ts';

const { llm } = installFakes();

/** A new account with this email, onboarded: did it get the sign-up credits? */
async function signUp(email: string) {
  const u = await createUser({ email });
  const { signupGranted } = await onboardBilling(u.id);
  return { user: u, signupGranted };
}

async function skipLines(userId: string) {
  return db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), eq(auditLog.action, 'signup_credits_skipped')));
}

describe('normalizeEmail', () => {
  it.each([
    ['Ann@Example.com', 'ann@example.com'], // letter case
    ['  ann@example.com ', 'ann@example.com'],
    ['a.n.n@gmail.com', 'ann@gmail.com'], // Gmail dots
    ['ann+news@gmail.com', 'ann@gmail.com'], // +tag
    ['A.nn+x+y@GMAIL.com', 'ann@gmail.com'],
    ['ann@googlemail.com', 'ann@gmail.com'], // googlemail is gmail
    ['a.nn+promo@GoogleMail.com', 'ann@gmail.com'],
    ['ann.lee@example.com', 'ann.lee@example.com'], // dots count on other domains
    ['ann.lee+shop@example.com', 'ann.lee@example.com'], // a +tag never does
    ['ann.lee@sub.gmail.com.example.org', 'ann.lee@sub.gmail.com.example.org'],
    ['no-at-sign', 'no-at-sign'],
  ])('%s → %s', (input, out) => {
    expect(normalizeEmail(input)).toBe(out);
  });

  it('the mark is a keyed hash of the normal form, never the email', () => {
    const m = emailMark('Ann.Lee+x@GoogleMail.com')!;
    expect(m).toMatch(/^[0-9a-f]{64}$/);
    expect(emailMark('annlee@gmail.com')).toBe(m);
    expect(emailMark('ann.lee@example.com')).not.toBe(emailMark('annlee@example.com'));
    expect(emailMark('')).toBeNull();
    expect(emailMark('deleted-usr_1@deleted.invalid')).toBeNull();
  });
});

describe('sign-up credits: 14 days, once per inbox', () => {
  it('a new inbox gets 100 credits that last 14 days', async () => {
    const { user, signupGranted } = await signUp('first.person@gmail.com');
    expect(signupGranted).toBe(true);
    const [grant] = await grantsOf(user.id);
    expect(grant).toMatchObject({ source: 'signup', amount: 100 });
    const days = (grant!.expiresAt!.getTime() - Date.now()) / 86400_000;
    expect(SIGNUP_CREDIT_EXPIRY_DAYS).toBe(14);
    expect(days).toBeGreaterThan(13.99);
    expect(days).toBeLessThanOrEqual(14);
    // Running the job again gives nothing more.
    expect(await onboardBilling(user.id)).toEqual({ signupGranted: false });
    expect(await getBalance(user.id)).toBe(100);
    expect(await skipLines(user.id)).toHaveLength(0);
  });

  it('another spelling of the same inbox gets none, with an activity-log line saying why', async () => {
    expect((await signUp('Ann.Lee@gmail.com')).signupGranted).toBe(true);
    for (const variant of [
      'annlee+promo@googlemail.com',
      'ANNLEE@GMAIL.COM',
      'a.n.n.l.e.e@gmail.com',
    ]) {
      const { user, signupGranted } = await signUp(variant);
      expect(signupGranted, variant).toBe(false);
      expect(await getBalance(user.id)).toBe(0);
      // The account itself is made as usual: it has its LiteLLM key.
      expect(llm.byUser(user.id)).toBeDefined();
      const [line] = await skipLines(user.id);
      expect(line?.summary).toMatch(/another account had this email/);
      expect(line?.details).toEqual({ reason: 'email_seen_before' });
    }
  });

  it('on other domains dots count and +tags do not', async () => {
    expect((await signUp('ann.lee@example.com')).signupGranted).toBe(true);
    expect((await signUp('ann.lee+shop@example.com')).signupGranted).toBe(false);
    expect((await signUp('Ann.Lee@Example.com')).signupGranted).toBe(false);
    expect((await signUp('annlee@example.com')).signupGranted).toBe(true); // another inbox
  });

  it('deleting the account and signing up again gives no second 100', async () => {
    const { user } = await signUp('again@example.com');
    await offboardBilling(user.id);
    await scrubDeletedUser(user.id);
    const { user: back, signupGranted } = await signUp('again@example.com');
    expect(signupGranted).toBe(false);
    expect(await getBalance(back.id)).toBe(0);
  });

  it('an account made before the marks counts when it is deleted', async () => {
    // Never onboarded here, so no mark yet; its deletion records the inbox it has then.
    const old = await createUser({ email: 'old.timer+x@gmail.com' });
    await offboardBilling(old.id);
    await scrubDeletedUser(old.id);
    expect((await signUp('oldtimer@gmail.com')).signupGranted).toBe(false);
  });

  it('accounts made before the marks count too: the one-off job marks every live account', async () => {
    const older = await createUser({ email: 'early.bird@gmail.com' });
    expect(await rememberAccountEmails()).toMatchObject({ accounts: expect.any(Number) });
    expect(await rememberAccountEmails()).toMatchObject({ accounts: expect.any(Number) }); // again: no harm
    expect((await signUp('earlybird+2@googlemail.com')).signupGranted).toBe(false);
    // The inbox stays with the account that had it first.
    const [row] = await db()
      .select()
      .from(signupEmailMarks)
      .where(eq(signupEmailMarks.mark, emailMark('earlybird@gmail.com')!));
    expect(row?.userId).toBe(older.id);
  });

  it('two new accounts of one inbox at the same moment: one gets the credits', async () => {
    const [a, b] = await Promise.all([
      createUser({ email: 'twin@example.com' }),
      createUser({ email: 'Twin+b@example.com' }),
    ]);
    const results = await Promise.all([onboardBilling(a!.id), onboardBilling(b!.id)]);
    expect(results.filter((r) => r.signupGranted)).toHaveLength(1);
    expect((await getBalance(a!.id)) + (await getBalance(b!.id))).toBe(100);
  });

  it('only keyed hashes are kept, never an email', async () => {
    await signUp('Secret.Person+tag@gmail.com');
    const rows = JSON.stringify(await db().select().from(signupEmailMarks)).toLowerCase();
    for (const plain of ['secret', 'person', '@gmail.com', '@example.com'])
      expect(rows).not.toContain(plain);
  });
});
