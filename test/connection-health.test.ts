// A connection that stopped working (the Composio audit of 17 October, M2): until 18 October only
// Composio's webhook could say a sign-in had expired, so the Apps page kept saying "Connected".
// Now Composio is asked about the connection itself when the Apps page is opened (once in 15
// minutes) and right after an action on it failed; "expired" or "failed" is copied, so the page
// says "Reconnect needed" and Tex is told to send the user there.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeQueues } from '../src/modules/events/queues.ts';
import { ACTIVE_CHECK_MS } from '../src/modules/integrations/apps.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeComposio, installFakeVm, mcpCall } from './fakes.ts';
import { call, chatUser, expectContract } from './helpers.ts';

let vm: ReturnType<typeof installFakeVm>;
let composio: Awaited<ReturnType<typeof installFakeComposio>>;

beforeAll(() => wireModules());
afterAll(async () => {
  await closeQueues();
});
beforeEach(async () => {
  vm = installFakeVm(async () => {});
  composio = await installFakeComposio();
});

/** A user with a working Gmail connection; Composio says `composioStatus` about it. */
async function gmailUser(composioStatus: string, checkedMinutesAgo: number | null = null) {
  const user = await chatUser();
  const id = newId('con');
  const accountId = `ca_${randomUUID()}`;
  await db()
    .insert(connections)
    .values({
      id,
      userId: user.id,
      app: 'gmail',
      composioAccountId: accountId,
      status: 'active',
      accountLabel: 'me@example.com',
      checkedAt:
        checkedMinutesAgo === null ? null : new Date(Date.now() - checkedMinutesAgo * 60_000),
    });
  composio.state.accounts.set(user.id, [
    { id: accountId, toolkit: 'gmail', status: composioStatus, label: null },
  ]);
  await ensureSandbox(user.id);
  return { ...user, connectionId: id, accountId, mcp: vm.tokens.get(user.id)! };
}

type Apps = { items: Array<{ slug: string; connections: Array<{ status: string }> }> };
const gmailOnPage = async (token: string) =>
  (await expectContract<Apps>('listApps', await call('/v1/apps', { token }), 200)).items.find(
    (a) => a.slug === 'gmail',
  )!.connections;
const rowOf = async (id: string) =>
  (await db().select().from(connections).where(eq(connections.id, id)))[0]!;

describe('the Apps page', () => {
  it('asks Composio about a working connection and shows an expired one as expired', async () => {
    const u = await gmailUser('EXPIRED');
    expect(await gmailOnPage(u.token)).toEqual([
      { id: u.connectionId, accountLabel: 'me@example.com', status: 'expired' },
    ]);
    expect(composio.state.accountGets).toEqual([u.accountId]);
    // Tex is told too.
    const listed = JSON.parse(
      (await mcpCall(u.mcp, 'list_app_actions', { app: 'gmail' })).text,
    ) as {
      apps: Array<{ app: string; status: string; note?: string }>;
    };
    expect(listed.apps).toMatchObject([{ app: 'gmail', status: 'needs_reconnecting' }]);
    expect(listed.apps[0]!.note).toContain('connected again');
  });

  it('a failed one is shown as error; a working one stays, and is asked again only after 15 minutes', async () => {
    const failed = await gmailUser('FAILED');
    expect((await gmailOnPage(failed.token))[0]!.status).toBe('error');

    const fine = await gmailUser('ACTIVE');
    expect((await gmailOnPage(fine.token))[0]!.status).toBe('active');
    expect((await rowOf(fine.connectionId)).checkedAt).not.toBeNull();
    composio.state.accountGets.length = 0;
    await gmailOnPage(fine.token);
    expect(composio.state.accountGets).toEqual([]);
    // Checked longer ago than that: asked again.
    await db()
      .update(connections)
      .set({ checkedAt: new Date(Date.now() - ACTIVE_CHECK_MS - 1000) })
      .where(eq(connections.id, fine.connectionId));
    await gmailOnPage(fine.token);
    expect(composio.state.accountGets).toEqual([fine.accountId]);
  });

  it('Composio down: nothing changes and the page still loads', async () => {
    const u = await gmailUser('EXPIRED');
    composio.state.accountsError = new Error('composio down');
    expect((await gmailOnPage(u.token))[0]!.status).toBe('active');
  });
});

describe('after an action failed', () => {
  it('Composio says the sign-in expired: marked, and Tex is told to send the user to reconnect', async () => {
    const u = await gmailUser('EXPIRED', 5);
    composio.state.executeFailure = 'invalid_grant: Token has been expired or revoked';
    const res = await mcpCall(u.mcp, 'run_app_action', {
      action: 'GMAIL_FETCH_EMAILS',
      arguments: { query: 'is:unread' },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('Gmail needs to be connected again: its connection expired');
    expect(res.text).toContain('/integrations/apps');
    expect((await rowOf(u.connectionId)).status).toBe('expired');
  });

  it('the connection still works: only the app’s own error', async () => {
    const u = await gmailUser('ACTIVE', 5);
    composio.state.executeFailure = 'Invalid query';
    const res = await mcpCall(u.mcp, 'run_app_action', {
      action: 'GMAIL_FETCH_EMAILS',
      arguments: { query: '(' },
    });
    expect(res.isError).toBe(true);
    expect(res.text).not.toContain('connected again');
    expect((await rowOf(u.connectionId)).status).toBe('active');
  });
});
