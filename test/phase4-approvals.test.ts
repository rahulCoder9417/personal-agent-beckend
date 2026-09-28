import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { users } from '../src/modules/auth/schema.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { DeliverKind } from '../proto-gen/vm/v1/vm_pb.ts';
import {
  installFakeComposio,
  installFakeTelegram,
  installFakeVm,
  mcpCall,
  telegramButton,
  telegramUpdate,
  type ExecutedAction,
  type McpResult,
  type SentTelegram,
} from './fakes.ts';
import { call, createUser, expectContract, waitFor } from './helpers.ts';

let workers: Worker[];
let tg: { sent: SentTelegram[] };
let executed: ExecutedAction[];
let vmFake: ReturnType<typeof installFakeVm>;

beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(async () => {
  tg = installFakeTelegram();
  ({ executed } = await installFakeComposio());
});

const chat = () => Math.floor(Math.random() * 1e9);
const tgPost = (update: unknown) =>
  call('/webhooks/telegram', {
    method: 'POST',
    body: update,
    headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
  });

async function linkedUser(opts: { plan?: 'free' | 'pro' | 'max' } = {}) {
  const user = await createUser(opts.plan ? ({ plan: opts.plan } as never) : {});
  const chatId = chat();
  const lc = await expectContract<{ code: string }>(
    'createLinkCode',
    await call('/v1/channels/link-codes', {
      method: 'POST',
      token: user.token,
      body: { channel: 'telegram' },
    }),
    201,
  );
  await tgPost(telegramUpdate(chatId, lc.code));
  await waitFor(async () =>
    tg.sent.find((m) => m.chatId === String(chatId) && m.text.startsWith('✅')),
  );
  return { ...user, chatId };
}

async function connectGmail(userId: string) {
  await db()
    .insert(connections)
    .values({
      id: newId('con'),
      userId,
      app: 'gmail',
      composioAccountId: `ca_${randomUUID()}`,
      status: 'active',
    });
}

const EMAIL_ARGS = { to: 'priya@acme.com', subject: 'Report', body: 'Delayed to Monday' };

describe('Phase 4: approvals + Composio', () => {
  it('"email X that…" drafts, asks for approval, sends only after ✅, and is audit-logged', async () => {
    const attempts: McpResult[] = [];
    vmFake = installFakeVm(async (d, mcp) => {
      if (d.kind === DeliverKind.MESSAGE) {
        const actions = JSON.parse(
          (await mcp('list_app_actions', { app: 'gmail' })).text,
        ) as Array<{ action: string; requires_approval: boolean }>;
        const send = actions.find((a) => a.action === 'GMAIL_SEND_EMAIL')!;
        expect(send.requires_approval).toBe(true);
        attempts.push(await mcp('run_app_action', { action: send.action, arguments: EMAIL_ARGS }));
        await mcp('request_approval', {
          summary: 'Email priya@acme.com: "Report delayed to Monday"',
          action: send.action,
          arguments: EMAIL_ARGS,
          session_key: d.sessionKey,
        });
        await mcp('send_message', {
          text: 'Drafted it. Waiting for your OK.',
          session_key: d.sessionKey,
        });
      } else if (d.kind === DeliverKind.APPROVAL_ANSWER && d.approved) {
        const r = await mcp('run_app_action', {
          action: 'GMAIL_SEND_EMAIL',
          arguments: EMAIL_ARGS,
          approval_id: d.approvalId,
        });
        attempts.push(r);
        await mcp('send_message', {
          text: r.isError ? `failed: ${r.text}` : 'Sent ✅',
          session_key: d.sessionKey,
        });
      }
    });
    const alice = await linkedUser();
    await connectGmail(alice.id);

    await tgPost(telegramUpdate(alice.chatId, 'email priya that the report is delayed to monday'));
    const ask = await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(alice.chatId) && m.buttons),
    );
    expect(ask.text).toContain('Approval needed');
    expect(ask.buttons!.map((b) => b.text)).toEqual(['✅ Approve', '❌ Reject']);
    await waitFor(async () => tg.sent.find((m) => m.text === 'Drafted it. Waiting for your OK.'));
    // Before ✅ nothing was sent, and trying without approval failed.
    expect(executed).toHaveLength(0);
    expect(attempts[0]!.isError).toBe(true);

    const pending = await expectContract<{ items: Array<{ id: string; status: string }> }>(
      'listApprovals',
      await call('/v1/approvals', { token: alice.token }),
      200,
    );
    expect(pending.items).toHaveLength(1);

    await tgPost(telegramButton(alice.chatId, ask.buttons![0]!.callback_data));
    await waitFor(async () => tg.sent.find((m) => m.text === 'Sent ✅'));
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({
      slug: 'GMAIL_SEND_EMAIL',
      userId: alice.id,
      arguments: EMAIL_ARGS,
    });

    const actions = (await db().select().from(auditLog).where(eq(auditLog.userId, alice.id))).map(
      (a) => a.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['approval_requested', 'approval_decided', 'run_app_action']),
    );

    // The approval is single use.
    const replay = await mcpCall(vmFake.tokens.get(alice.id)!, 'run_app_action', {
      action: 'GMAIL_SEND_EMAIL',
      arguments: EMAIL_ARGS,
      approval_id: pending.items[0]!.id,
    });
    expect(replay.isError).toBe(true);
    expect(executed).toHaveLength(1);
  });

  it('❌ means nothing is sent', async () => {
    vmFake = installFakeVm(async (d, mcp) => {
      if (d.kind === DeliverKind.MESSAGE) {
        await mcp('request_approval', {
          summary: 'Email bob',
          action: 'GMAIL_SEND_EMAIL',
          arguments: EMAIL_ARGS,
          session_key: d.sessionKey,
        });
      } else if (d.kind === DeliverKind.APPROVAL_ANSWER) {
        await mcp('send_message', {
          text: d.approved ? 'approved?!' : 'OK, not sending.',
          session_key: d.sessionKey,
        });
      }
    });
    const u = await linkedUser();
    await connectGmail(u.id);
    await tgPost(telegramUpdate(u.chatId, 'email bob'));
    const ask = await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(u.chatId) && m.buttons),
    );
    await tgPost(telegramButton(u.chatId, ask.buttons![1]!.callback_data));
    await waitFor(async () => tg.sent.find((m) => m.text === 'OK, not sending.'));
    expect(executed).toHaveLength(0);
  });

  it("a container can't act as another user even with a crafted request", async () => {
    vmFake = installFakeVm(async (d, mcp) => {
      if (d.kind === DeliverKind.MESSAGE)
        await mcp('request_approval', {
          summary: 'Email someone',
          action: 'GMAIL_SEND_EMAIL',
          arguments: EMAIL_ARGS,
          session_key: d.sessionKey,
        });
    });
    const alice = await linkedUser();
    const bob = await linkedUser();
    await connectGmail(alice.id);
    await connectGmail(bob.id);
    // Bob gets an approval and approves it.
    await tgPost(telegramUpdate(bob.chatId, 'email someone'));
    const ask = await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(bob.chatId) && m.buttons),
    );
    const bobApprovalId = ask.buttons![0]!.callback_data.split(':')[1]!;
    await expectContract(
      'decideApproval',
      await call(`/v1/approvals/${bobApprovalId}/decision`, {
        method: 'POST',
        token: bob.token,
        body: { decision: 'approve' },
      }),
      200,
    );

    await tgPost(telegramUpdate(alice.chatId, 'hi'));
    await waitFor(async () => vmFake.tokens.get(alice.id));
    const aliceToken = vmFake.tokens.get(alice.id)!;
    const crafted = await mcpCall(aliceToken, 'run_app_action', {
      action: 'GMAIL_SEND_EMAIL',
      arguments: EMAIL_ARGS,
      approval_id: bobApprovalId,
      user_id: bob.id,
    });
    expect(crafted.isError).toBe(true);
    // A non-risky action runs, but always as Alice.
    const list = await mcpCall(aliceToken, 'run_app_action', {
      action: 'GMAIL_LIST_EMAILS',
      arguments: {},
      userId: bob.id,
    });
    expect(list.isError).toBeFalsy();
    expect(executed.every((e) => e.userId === alice.id)).toBe(true);
    // Alice can't see or decide Bob's approval over REST either.
    await expectContract(
      'decideApproval',
      await call(`/v1/approvals/${bobApprovalId}/decision`, {
        method: 'POST',
        token: alice.token,
        body: { decision: 'approve' },
      }),
      404,
    );
    await expectContract(
      'decideApproval',
      await call(`/v1/approvals/${bobApprovalId}/decision`, {
        method: 'POST',
        token: bob.token,
        body: { decision: 'reject' },
      }),
      409,
    );
  });

  it('approved arguments must match exactly', async () => {
    vmFake = installFakeVm(async (d, mcp) => {
      if (d.kind === DeliverKind.MESSAGE)
        await mcp('request_approval', {
          summary: 'Email someone',
          action: 'GMAIL_SEND_EMAIL',
          arguments: EMAIL_ARGS,
          session_key: d.sessionKey,
        });
    });
    const u = await linkedUser();
    await connectGmail(u.id);
    await tgPost(telegramUpdate(u.chatId, 'go'));
    const ask = await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(u.chatId) && m.buttons),
    );
    const id = ask.buttons![0]!.callback_data.split(':')[1]!;
    await call(`/v1/approvals/${id}/decision`, {
      method: 'POST',
      token: u.token,
      body: { decision: 'approve' },
    });
    const token = vmFake.tokens.get(u.id)!;
    const changed = await mcpCall(token, 'run_app_action', {
      action: 'GMAIL_SEND_EMAIL',
      arguments: { ...EMAIL_ARGS, to: 'evil@x.com' },
      approval_id: id,
    });
    expect(changed.isError).toBe(true);
    const same = await mcpCall(token, 'run_app_action', {
      action: 'GMAIL_SEND_EMAIL',
      arguments: EMAIL_ARGS,
      approval_id: id,
    });
    expect(same.isError).toBeFalsy();
    expect(executed.map((e) => e.arguments.to)).toEqual(['priya@acme.com']);
  });
});

describe('apps + user MCP servers', () => {
  beforeEach(() => {
    vmFake = installFakeVm();
    process.env.COMPOSIO_AUTH_CONFIGS = JSON.stringify({
      gmail: 'ac_gmail',
      hubspot: 'ac_hubspot',
    });
  });

  it('lists the catalog and starts connecting with plan limits', async () => {
    const { resetConfig } = await import('../src/shared/config.ts');
    resetConfig();
    const u = await createUser();
    const apps = await expectContract<{ items: Array<{ slug: string; availableOnPlan: boolean }> }>(
      'listApps',
      await call('/v1/apps', { token: u.token }),
      200,
    );
    expect(apps.items).toHaveLength(25);
    expect(apps.items.filter((a) => a.availableOnPlan)).toHaveLength(10);
    const ok = await expectContract<{ redirectUrl: string }>(
      'connectApp',
      await call('/v1/apps/gmail/connect', { method: 'POST', token: u.token, body: {} }),
      200,
    );
    expect(ok.redirectUrl).toContain('composio.test');
    const limited = await expectContract<{ error: { code: string } }>(
      'connectApp',
      await call('/v1/apps/hubspot/connect', { method: 'POST', token: u.token }),
      403,
    );
    expect(limited.error.code).toBe('plan_limit');
    await expectContract(
      'connectApp',
      await call('/v1/apps/nope/connect', { method: 'POST', token: u.token }),
      404,
    );

    // Composio confirms the connection by webhook.
    const [pending] = await db().select().from(connections).where(eq(connections.userId, u.id));
    expect(pending!.status).toBe('pending');
    const webhook = { kind: 'connection', accountId: pending!.composioAccountId, status: 'active' };
    await expectContract(
      'webhookComposio',
      await call('/webhooks/composio', {
        method: 'POST',
        body: webhook,
        headers: { 'webhook-signature': 'bad', 'webhook-id': 'w1', 'webhook-timestamp': '1' },
      }),
      401,
    );
    await expectContract(
      'webhookComposio',
      await call('/webhooks/composio', {
        method: 'POST',
        body: webhook,
        headers: {
          'webhook-signature': 'valid',
          'webhook-id': `w-${randomUUID()}`,
          'webhook-timestamp': '1',
        },
      }),
      200,
    );
    await waitFor(
      async () =>
        (await db().select().from(connections).where(eq(connections.id, pending!.id)))[0]
          ?.status === 'active',
    );
    const after = await expectContract<{
      items: Array<{ slug: string; connections: Array<{ id: string; status: string }> }>;
    }>('listApps', await call('/v1/apps', { token: u.token }), 200);
    const gmail = after.items.find((a) => a.slug === 'gmail')!;
    expect(gmail.connections).toEqual([
      expect.objectContaining({ id: pending!.id, status: 'active' }),
    ]);
    await expectContract(
      'disconnectApp',
      await call(`/v1/connections/${pending!.id}`, { method: 'DELETE', token: u.token }),
      204,
    );
    await expectContract(
      'disconnectApp',
      await call(`/v1/connections/${pending!.id}`, { method: 'DELETE', token: u.token }),
      404,
    );
  });

  it('own MCP servers: Max only, https public hosts, allowlist pushed, secret never returned', async () => {
    const free = await createUser();
    await expectContract(
      'createMcpServer',
      await call('/v1/mcp-servers', {
        method: 'POST',
        token: free.token,
        body: { name: 'mine', url: 'https://mcp.example.com/sse' },
      }),
      403,
    );
    const max = await createUser();
    await db().update(users).set({ plan: 'max' }).where(eq(users.id, max.id));
    await expectContract(
      'createMcpServer',
      await call('/v1/mcp-servers', {
        method: 'POST',
        token: max.token,
        body: { name: 'x', url: 'http://mcp.example.com' },
      }),
      400,
    );
    await expectContract(
      'createMcpServer',
      await call('/v1/mcp-servers', {
        method: 'POST',
        token: max.token,
        body: { name: 'x', url: 'https://10.0.0.5/mcp' },
      }),
      400,
    );
    await expectContract(
      'createMcpServer',
      await call('/v1/mcp-servers', {
        method: 'POST',
        token: max.token,
        body: { name: 'x', url: 'https://litellm/mcp' },
      }),
      400,
    );
    const created = await expectContract<{ id: string; hasSecret: boolean }>(
      'createMcpServer',
      await call('/v1/mcp-servers', {
        method: 'POST',
        token: max.token,
        body: { name: 'Notes', url: 'https://mcp.example.com/mcp', authSecret: 's3cret-value' },
      }),
      201,
    );
    expect(created.hasSecret).toBe(true);
    expect(JSON.stringify(created)).not.toContain('s3cret');
    const pushed = await waitFor(async () => vmFake.allowlists.find((a) => a.userId === max.id));
    expect(pushed.domains).toEqual(['mcp.example.com']);
    expect(pushed.mcpServers[0]!.authSecret).toBe('s3cret-value');
    const list = await expectContract<{ items: unknown[] }>(
      'listMcpServers',
      await call('/v1/mcp-servers', { token: max.token }),
      200,
    );
    expect(JSON.stringify(list)).not.toContain('s3cret');
    await expectContract(
      'updateMcpServer',
      await call(`/v1/mcp-servers/${created.id}`, {
        method: 'PATCH',
        token: max.token,
        body: { enabled: false },
      }),
      200,
    );
    await waitFor(async () =>
      vmFake.allowlists.find((a) => a.userId === max.id && a.domains.length === 0),
    );
    await expectContract(
      'updateMcpServer',
      await call(`/v1/mcp-servers/${created.id}`, {
        method: 'PATCH',
        token: free.token,
        body: { enabled: true },
      }),
      404,
    );
    await expectContract(
      'deleteMcpServer',
      await call(`/v1/mcp-servers/${created.id}`, { method: 'DELETE', token: max.token }),
      204,
    );
  });
});
