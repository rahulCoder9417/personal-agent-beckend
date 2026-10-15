// Deleting an account (backend-report.md, section 33 "What is kept and what is deleted"): the
// approvals and the activity log go with it, as the messages, memories and the rest already did.
// An admin's record of the deletion stays. The credits ledger and grants are not touched. A re-run
// is safe, and other users keep everything. A connected app Composio could not remove keeps its
// row and makes the job fail, so its next try asks Composio again.
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT_DELETED_ACTION, audit } from '../src/modules/admin/audit.ts';
import { auditLog } from '../src/modules/admin/schema.ts';
import { creditGrants, creditLedger } from '../src/modules/billing/schema.ts';
import { saveWebMessage } from '../src/modules/channels/messages.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { requestApproval } from '../src/modules/orchestrator/approvals.ts';
import { handleDeleteUser } from '../src/modules/orchestrator/lifecycle.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { approvals } from '../src/modules/orchestrator/schema.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeComposio, installFakeVm } from './fakes.ts';
import { chatUser } from './helpers.ts';

let vmFake: ReturnType<typeof installFakeVm>;
let composio: Awaited<ReturnType<typeof installFakeComposio>>;

beforeAll(() => wireModules());
afterAll(async () => {
  await closeQueues();
});
beforeEach(async () => {
  vmFake = installFakeVm();
  composio = await installFakeComposio();
});

const deleteUser = (userId: string) => handleDeleteUser({ data: { userId } } as Job);

const approvalsOf = (userId: string) =>
  db().select().from(approvals).where(eq(approvals.userId, userId));
const auditOf = (userId: string) => db().select().from(auditLog).where(eq(auditLog.userId, userId));
const connectionsOf = (userId: string) =>
  db().select().from(connections).where(eq(connections.userId, userId));
const messagesOf = (userId: string) =>
  db().select().from(messages).where(eq(messages.userId, userId));

/**
 * A user with what the privacy page lists: an approval asked for an email to Priya (its inputs
 * are saved with it), the activity-log rows that go with it, a message, and a container.
 */
async function userWithData(tag: string) {
  const user = await chatUser();
  await ensureSandbox(user.id);
  const recipient = `priya.${tag}@example.com`;
  await requestApproval({
    userId: user.id,
    sessionKey: 'web',
    summary: `Send the notes to ${recipient}`,
    app: 'gmail',
    action: 'GMAIL_SEND_EMAIL',
    arguments: { recipient_email: recipient, subject: 'Notes' },
  });
  await audit({
    userId: user.id,
    actor: 'agent',
    action: 'run_app_action',
    summary: 'GMAIL_SEND_EMAIL',
    details: { inputs: { recipient_email: recipient, subject: 'Notes' } },
    creditsCharged: 1,
  });
  await audit({
    userId: user.id,
    actor: 'user',
    action: 'channel_linked',
    summary: 'Linked Telegram',
  });
  await saveWebMessage({ userId: user.id, text: 'email Priya the notes', clientMessageId: tag });
  return { user, recipient };
}

/** One connected app at Composio for this user (the account id is Composio's). */
async function connect(userId: string, app: string): Promise<string> {
  const accountId = `ca_${app}_${newId('x')}`;
  await db()
    .insert(connections)
    .values({
      id: newId('con'),
      userId,
      app,
      composioAccountId: accountId,
      status: 'active',
    });
  return accountId;
}

describe('deleting an account', () => {
  it('removes its approvals and its activity log; another user keeps theirs', async () => {
    const { user, recipient } = await userWithData('a');
    const other = await userWithData('b');
    expect(await approvalsOf(user.id)).toHaveLength(1);
    expect((await auditOf(user.id)).length).toBeGreaterThanOrEqual(3);
    const otherAudit = await auditOf(other.user.id);
    const otherMessages = await messagesOf(other.user.id);

    await deleteUser(user.id);

    expect(vmFake.tokens.has(user.id)).toBe(false);
    expect(await messagesOf(user.id)).toEqual([]);
    expect(await approvalsOf(user.id)).toEqual([]);
    expect(await auditOf(user.id)).toEqual([]);
    // The recipient was in the approval's inputs, its question and the activity log: gone from all.
    const all = JSON.stringify([
      await db().select().from(approvals),
      await db().select().from(auditLog),
      await db().select().from(messages),
    ]);
    expect(all).not.toContain(recipient);

    // The other user is untouched.
    expect(await approvalsOf(other.user.id)).toHaveLength(1);
    expect(await auditOf(other.user.id)).toEqual(otherAudit);
    expect(await messagesOf(other.user.id)).toEqual(otherMessages);
    expect(vmFake.tokens.has(other.user.id)).toBe(true);
  });

  it('keeps an admin’s record of the deletion, and the credits ledger and grants', async () => {
    const { user } = await userWithData('c');
    await audit({
      userId: user.id,
      actor: 'admin',
      action: ACCOUNT_DELETED_ACTION,
      summary: 'An admin deleted this account',
      details: { adminId: 'usr_admin', reason: 'asked by email' },
    });
    const grants = await db().select().from(creditGrants).where(eq(creditGrants.userId, user.id));
    const ledger = await db().select().from(creditLedger).where(eq(creditLedger.userId, user.id));
    expect(grants).toHaveLength(1);
    expect(ledger).toHaveLength(1);

    await deleteUser(user.id);

    const left = await auditOf(user.id);
    expect(left.map((r) => [r.actor, r.action])).toEqual([['admin', ACCOUNT_DELETED_ACTION]]);
    expect(left[0]!.details).toEqual({ adminId: 'usr_admin', reason: 'asked by email' });
    // Money records are append-only and stay (backend-report.md, Part C).
    expect(await db().select().from(creditGrants).where(eq(creditGrants.userId, user.id))).toEqual(
      grants,
    );
    expect(await db().select().from(creditLedger).where(eq(creditLedger.userId, user.id))).toEqual(
      ledger,
    );
  });

  it('is safe to run again: a second and a third run change nothing', async () => {
    const { user } = await userWithData('d');
    const other = await userWithData('e');
    const otherAudit = await auditOf(other.user.id);

    await deleteUser(user.id);
    await expect(deleteUser(user.id)).resolves.toBeNull();
    await expect(deleteUser(user.id)).resolves.toBeNull();

    expect(await approvalsOf(user.id)).toEqual([]);
    expect(await auditOf(user.id)).toEqual([]);
    expect(await approvalsOf(other.user.id)).toHaveLength(1);
    expect(await auditOf(other.user.id)).toEqual(otherAudit);
  });

  it('removes connected apps at Composio; one Composio could not remove is tried again', async () => {
    const { user } = await userWithData('f');
    const other = await userWithData('g');
    const gmail = await connect(user.id, 'gmail');
    const github = await connect(user.id, 'github');
    const othersApp = await connect(other.user.id, 'gmail');
    composio.state.deleteAccountErrors.set(github, new Error('Composio is down'));

    // The first try: Gmail goes, GitHub keeps its row, and the job fails so it runs again.
    await expect(deleteUser(user.id)).rejects.toThrow(
      "Composio could not remove 1 of the user's connected accounts",
    );
    expect(composio.state.deletedAccounts).toEqual([gmail]);
    expect((await connectionsOf(user.id)).map((c) => c.composioAccountId)).toEqual([github]);
    // What comes before the connected apps is already gone.
    expect(await messagesOf(user.id)).toEqual([]);
    expect(await approvalsOf(user.id)).toEqual([]);

    // The next try, with Composio back: GitHub goes too, then the activity log.
    composio.state.deleteAccountErrors.clear();
    await deleteUser(user.id);
    expect(composio.state.deletedAccounts).toEqual([gmail, github]);
    expect(await connectionsOf(user.id)).toEqual([]);
    expect(await auditOf(user.id)).toEqual([]);

    // The other user's app was never asked about, and its row stays.
    expect(composio.state.deletedAccounts).not.toContain(othersApp);
    expect(await connectionsOf(other.user.id)).toHaveLength(1);
  });
});
