// An approval holds exactly the arguments that will run (docs/backend-report.md, section 15):
// request_approval checks an app action's arguments against Composio's input schema before the
// user sees anything, run_app_action with the approval's id runs the stored arguments, and a
// request the agent has to ask again is marked `replaced`, never shown as rejected.
//
// The bug behind it (15 October): Tex asked to approve GMAIL_SEND_EMAIL with `to`; Composio's
// input is `recipient_email`. The approved run was refused by Composio, the corrected run by our
// own check, so Tex asked a second time for the same email.
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { appOfAction } from '../src/modules/integrations/action-inputs.ts';
import type { ComposioTool } from '../src/modules/integrations/composio.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { decideApproval } from '../src/modules/orchestrator/approvals.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { approvals } from '../src/modules/orchestrator/schema.ts';
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
  type SentTelegram,
} from './fakes.ts';
import { call, chatUser, expectContract, waitFor } from './helpers.ts';

let workers: Worker[];
let vm: ReturnType<typeof installFakeVm>;
let composio: Awaited<ReturnType<typeof installFakeComposio>>;
let tg: { sent: SentTelegram[] };

beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});

const SEND = 'GMAIL_SEND_EMAIL';
const DELETE = 'GMAIL_DELETE_MESSAGE';

/** Gmail's send action as Composio describes it (read from Composio on 15 October). */
const GMAIL_TOOLS: ComposioTool[] = [
  {
    slug: SEND,
    toolkit: 'gmail',
    name: 'Send Email',
    description: 'Sends an email via Gmail API',
    tags: [],
    inputParameters: {
      type: 'object',
      title: 'SendEmailRequest',
      properties: {
        cc: { type: 'array', default: [], items: { type: 'string' } },
        bcc: { type: 'array', default: [], items: { type: 'string' } },
        body: { type: 'string' },
        is_html: { type: 'boolean', default: false },
        subject: { type: 'string' },
        user_id: { type: 'string', default: 'me' },
        attachment: { anyOf: [{ type: 'object' }, { type: 'array' }] },
        from_email: { type: 'string' },
        recipient_email: { type: 'string' },
        extra_recipients: { type: 'array', default: [], items: { type: 'string' } },
      },
    },
  },
  {
    slug: DELETE,
    toolkit: 'gmail',
    name: 'Delete message',
    description: 'Deletes a message',
    tags: [],
    inputParameters: {
      type: 'object',
      properties: { message_id: { type: 'string' }, user_id: { type: 'string', default: 'me' } },
      required: ['message_id'],
    },
  },
  {
    slug: 'GMAIL_LIST_EMAILS',
    toolkit: 'gmail',
    name: 'List',
    description: 'List emails',
    tags: ['readOnlyHint'],
    inputParameters: { type: 'object', properties: { max_results: { type: 'integer' } } },
  },
];

/** What Tex sent on 15 October, and what Composio needs. */
const WRONG = { to: 'friend@example.com', subject: 'Test', body: 'Hello.', user_id: 'me' };
const RIGHT = {
  recipient_email: 'friend@example.com',
  subject: 'Test',
  body: 'Hello.',
  user_id: 'me',
};

beforeEach(async () => {
  vm = installFakeVm();
  tg = installFakeTelegram();
  composio = await installFakeComposio();
  composio.state.tools.set('gmail', GMAIL_TOOLS);
});

async function gmailUser() {
  const user = await chatUser();
  await db()
    .insert(connections)
    .values({
      id: newId('con'),
      userId: user.id,
      app: 'gmail',
      composioAccountId: `ca_${randomUUID()}`,
      status: 'active',
    });
  await ensureSandbox(user.id);
  const token = vm.tokens.get(user.id)!;
  const mcp = (tool: string, args: Record<string, unknown>) => mcpCall(token, tool, args);
  const ask = async (args: Record<string, unknown>) => {
    const r = await mcp('request_approval', {
      summary: 'Email a friend',
      session_key: 'web',
      ...args,
    });
    return { ...r, json: r.isError ? null : (JSON.parse(r.text) as Record<string, string>) };
  };
  return { ...user, mcp, ask };
}

const approvalsOf = (userId: string) =>
  db().select().from(approvals).where(eq(approvals.userId, userId));

const auditOf = async (userId: string, action: string) =>
  db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), eq(auditLog.action, action)));

describe('request_approval checks the arguments against the action', () => {
  it('refuses a name the action does not have, names the real inputs, and asks nothing', async () => {
    const u = await gmailUser();
    const r = await u.ask({ action: SEND, arguments: WRONG });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('it has no input named "to"');
    expect(r.text).toContain('recipient_email (string)');
    expect(r.text).toContain('the user was not asked');
    expect(await approvalsOf(u.id)).toHaveLength(0);
    expect(await auditOf(u.id, 'approval_requested')).toHaveLength(0);

    const ok = await u.ask({ action: SEND, arguments: RIGHT });
    expect(ok.isError).toBe(false);
    const [saved] = await approvalsOf(u.id);
    expect(saved).toMatchObject({
      app: 'gmail',
      action: SEND,
      arguments: RIGHT,
      status: 'pending',
    });
  });

  it('refuses a missing required input and a wrong kind of value', async () => {
    const u = await gmailUser();
    const missing = await u.ask({ action: DELETE, arguments: { user_id: 'me' } });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('the input "message_id" is required');
    expect(missing.text).toContain('message_id (string, required)');

    const wrongKind = await u.ask({ action: SEND, arguments: { ...RIGHT, cc: 'a@example.com' } });
    expect(wrongKind.isError).toBe(true);
    expect(wrongKind.text).toContain('"cc" must be array, not string');

    // An empty value is left to the app; an input with several kinds takes any of them.
    const fine = await u.ask({
      action: SEND,
      arguments: { ...RIGHT, cc: ['a@example.com'], from_email: null, attachment: [] },
    });
    expect(fine.isError).toBe(false);
    expect(await approvalsOf(u.id)).toHaveLength(1);
  });

  it('refuses an action the app does not have, and says so when Composio cannot be asked', async () => {
    const u = await gmailUser();
    const unknown = await u.ask({ action: 'GMAIL_SEND_FAX', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('Gmail has no action "GMAIL_SEND_FAX"');

    composio = await installFakeComposio(); // empties the cached listing
    composio.state.toolsError.set('gmail', new Error('composio down'));
    composio.state.toolError = new Error('composio down');
    const down = await u.ask({ action: SEND, arguments: RIGHT });
    expect(down.isError).toBe(true);
    expect(down.text).toContain('could not be checked right now');
    expect(await approvalsOf(u.id)).toHaveLength(0);
  });

  it('checks an action the listing leaves out (it holds at most 200) by asking for it by name', async () => {
    const u = await gmailUser();
    const [send, ...others] = GMAIL_TOOLS;
    composio.state.tools.set('gmail', others); // the listing lacks the send action
    composio.state.tools.set('gmail_more', [send!]); // Composio still knows it by name
    const wrong = await u.ask({ action: SEND, arguments: WRONG });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain('it has no input named "to"');
    expect(composio.state.toolLookups).toEqual([SEND]);
    // Asked once, then kept.
    expect((await u.ask({ action: SEND, arguments: RIGHT })).isError).toBe(false);
    expect(composio.state.toolLookups).toEqual([SEND]);
  });

  it('an app approval asked without arguments holds none, and runs with none', async () => {
    const u = await gmailUser();
    const asked = await u.ask({ action: SEND });
    expect(asked.isError).toBe(false);
    const [saved] = await approvalsOf(u.id);
    expect(saved!.arguments).toEqual({});
    await decideApproval(u.id, asked.json!.approval_id!, true, 'web');
    // Arguments the user never saw can't ride on it.
    const more = await u.mcp('run_app_action', {
      action: SEND,
      approval_id: asked.json!.approval_id,
      arguments: RIGHT,
    });
    expect(more.isError).toBe(true);
    const none = await u.mcp('run_app_action', {
      action: SEND,
      approval_id: asked.json!.approval_id,
    });
    expect(none.isError).toBe(false);
    expect(composio.executed.map((e) => e.arguments)).toEqual([{}]);
  });

  it('leaves a request that is not an app action as it was', async () => {
    const u = await gmailUser();
    const plain = await u.ask({ summary: 'Clear out the downloads folder' });
    expect(plain.isError).toBe(false);
    const [saved] = await approvalsOf(u.id);
    expect(saved).toMatchObject({ app: null, action: null, arguments: null });
    expect(appOfAction('MICROSOFT_TEAMS_SEND_MESSAGE')?.slug).toBe('microsoft_teams');
  });
});

describe('after the yes, the approved arguments run', () => {
  it('runs the stored arguments when the agent leaves them out, exactly once', async () => {
    const u = await gmailUser();
    const asked = await u.ask({ action: SEND, arguments: RIGHT });
    await decideApproval(u.id, asked.json!.approval_id!, true, 'web');

    const sent = await u.mcp('run_app_action', {
      action: SEND,
      approval_id: asked.json!.approval_id,
    });
    expect(sent.isError).toBe(false);
    expect(composio.executed).toHaveLength(1);
    expect(composio.executed[0]).toMatchObject({ slug: SEND, userId: u.id, arguments: RIGHT });

    const again = await u.mcp('run_app_action', {
      action: SEND,
      approval_id: asked.json!.approval_id,
    });
    expect(again.isError).toBe(true);
    expect(composio.executed).toHaveLength(1);
  });

  it('accepts the same arguments sent again, and refuses changed ones without using the approval', async () => {
    const u = await gmailUser();
    const asked = await u.ask({ action: SEND, arguments: RIGHT });
    const id = asked.json!.approval_id!;
    await decideApproval(u.id, id, true, 'web');

    const changed = await u.mcp('run_app_action', {
      action: SEND,
      approval_id: id,
      arguments: { ...RIGHT, recipient_email: 'someone-else@example.com' },
    });
    expect(changed.isError).toBe(true);
    expect(changed.text).toContain('Leave arguments out');
    expect(composio.executed).toHaveLength(0);

    const same = await u.mcp('run_app_action', { action: SEND, approval_id: id, arguments: RIGHT });
    expect(same.isError).toBe(false);
    expect(composio.executed.map((e) => e.arguments)).toEqual([RIGHT]);
  });

  it('without the approval id, says to use the yes the user already gave', async () => {
    const u = await gmailUser();
    const r = await u.mcp('run_app_action', { action: SEND, arguments: RIGHT });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(
      'If the user already approved it, call run_app_action again with that approval_id',
    );
  });

  it('the wake-up after a yes tells the agent to leave the arguments out', async () => {
    const woken: string[] = [];
    vm = installFakeVm(async (d) => {
      if (d.kind === DeliverKind.APPROVAL_ANSWER) woken.push(d.text);
    });
    const u = await gmailUser();
    const asked = await u.ask({ action: SEND, arguments: RIGHT });
    await decideApproval(u.id, asked.json!.approval_id!, true, 'web');
    const text = await waitFor(async () => woken[0]);
    expect(text).toContain(
      `call run_app_action with action "${SEND}" and approval_id "${asked.json!.approval_id}"`,
    );
    expect(text).toContain('leave arguments out');
  });
});

describe('asking again replaces the earlier request', () => {
  it('the app refuses the approved run: nothing is sent, the agent asks again, the first is replaced', async () => {
    const u = await gmailUser();
    const first = await u.ask({ action: SEND, arguments: RIGHT });
    const firstId = first.json!.approval_id!;
    await decideApproval(u.id, firstId, true, 'web');

    composio.state.executeFailure = 'Invalid request data provided';
    const refused = await u.mcp('run_app_action', { action: SEND, approval_id: firstId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('nothing was done');
    expect(refused.text).toContain(`replaces_approval_id "${firstId}"`);
    expect(composio.executed).toHaveLength(0);
    // Still usable for one more try: the problem may pass.
    const [kept] = await db().select().from(approvals).where(eq(approvals.id, firstId));
    expect(kept).toMatchObject({ status: 'approved', usedAt: null });

    const second = await u.ask({
      action: SEND,
      arguments: { ...RIGHT, subject: 'Test (again)' },
      replaces_approval_id: firstId,
    });
    expect(second.isError).toBe(false);
    expect(second.json).toMatchObject({ replaced_approval_id: firstId });
    expect(second.json!.next).toContain('nothing was done yet');

    // Shown as replaced, never as rejected, and listed under its own status.
    const replaced = await expectContract<{ items: Array<{ id: string; status: string }> }>(
      'listApprovals',
      await call('/v1/approvals?status=replaced', { token: u.token }),
      200,
    );
    expect(replaced.items.map((a) => [a.id, a.status])).toEqual([[firstId, 'replaced']]);
    const rejected = await expectContract<{ items: unknown[] }>(
      'listApprovals',
      await call('/v1/approvals?status=rejected', { token: u.token }),
      200,
    );
    expect(rejected.items).toHaveLength(0);
    const [entry] = await auditOf(u.id, 'approval_replaced');
    expect(entry).toMatchObject({ actor: 'agent' });
    expect(entry!.details).toMatchObject({
      approvalId: firstId,
      replacedBy: second.json!.approval_id,
    });

    // The replaced one can neither run nor be answered.
    const old = await u.mcp('run_app_action', { action: SEND, approval_id: firstId });
    expect(old.isError).toBe(true);
    const late = await expectContract<{ error: { message: string } }>(
      'decideApproval',
      await call(`/v1/approvals/${firstId}/decision`, {
        method: 'POST',
        token: u.token,
        body: { decision: 'approve' },
      }),
      409,
    );
    expect(late.error.message).toContain('replaced by a newer one');

    // The new one runs, with its own arguments.
    await decideApproval(u.id, second.json!.approval_id!, true, 'web');
    const sent = await u.mcp('run_app_action', {
      action: SEND,
      approval_id: second.json!.approval_id,
    });
    expect(sent.isError).toBe(false);
    expect(composio.executed.map((e) => e.arguments.subject)).toEqual(['Test (again)']);
  });

  it('a waiting request can be replaced too; a rejected one stays rejected', async () => {
    const u = await gmailUser();
    const waiting = await u.ask({ action: SEND, arguments: RIGHT });
    const again = await u.ask({
      action: SEND,
      arguments: RIGHT,
      replaces_approval_id: waiting.json!.approval_id,
    });
    expect(again.json).toMatchObject({ replaced_approval_id: waiting.json!.approval_id });

    await decideApproval(u.id, again.json!.approval_id!, false, 'web');
    const third = await u.ask({
      action: SEND,
      arguments: RIGHT,
      replaces_approval_id: again.json!.approval_id,
    });
    expect(third.isError).toBe(false);
    expect(third.json!.replaced_approval_id).toBeUndefined();
    const statuses = Object.fromEntries((await approvalsOf(u.id)).map((a) => [a.id, a.status]));
    expect(statuses).toEqual({
      [waiting.json!.approval_id!]: 'replaced',
      [again.json!.approval_id!]: 'rejected',
      [third.json!.approval_id!]: 'pending',
    });
  });

  it("refuses to replace another action's request or another user's", async () => {
    const u = await gmailUser();
    const other = await gmailUser();
    const del = await u.ask({ action: DELETE, arguments: { message_id: 'm1' } });
    const notSame = await u.ask({
      action: SEND,
      arguments: RIGHT,
      replaces_approval_id: del.json!.approval_id,
    });
    expect(notSame.isError).toBe(true);
    expect(notSame.text).toContain('earlier request of yours for the same action');

    const theirs = await other.ask({ action: SEND, arguments: RIGHT });
    const crafted = await u.ask({
      action: SEND,
      arguments: RIGHT,
      replaces_approval_id: theirs.json!.approval_id,
    });
    expect(crafted.isError).toBe(true);
    const [still] = await approvalsOf(other.id);
    expect(still!.status).toBe('pending');
    expect(await approvalsOf(u.id)).toHaveLength(1);
  });

  it('a late tap on a replaced request in Telegram says it was replaced', async () => {
    const u = await gmailUser();
    const chatId = Math.floor(Math.random() * 1e9);
    const lc = await expectContract<{ code: string }>(
      'createLinkCode',
      await call('/v1/channels/link-codes', {
        method: 'POST',
        token: u.token,
        body: { channel: 'telegram' },
      }),
      201,
    );
    const tgPost = (update: unknown) =>
      call('/webhooks/telegram', {
        method: 'POST',
        body: update,
        headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
      });
    await tgPost(telegramUpdate(chatId, lc.code));
    await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(chatId) && m.text.startsWith('✅')),
    );

    const first = await u.ask({
      action: SEND,
      arguments: RIGHT,
      session_key: `telegram:${chatId}`,
    });
    await u.ask({
      action: SEND,
      arguments: RIGHT,
      session_key: `telegram:${chatId}`,
      replaces_approval_id: first.json!.approval_id,
    });
    await tgPost(telegramButton(chatId, `apr:${first.json!.approval_id}:yes`));
    await waitFor(async () =>
      tg.sent.find(
        (m) =>
          m.chatId === String(chatId) &&
          m.text === 'That request was replaced by a newer one. Please answer the newest request.',
      ),
    );
    const [row] = await db()
      .select()
      .from(approvals)
      .where(eq(approvals.id, first.json!.approval_id!));
    expect(row!.status).toBe('replaced');
  });
});

describe('the 15 October email, replayed', () => {
  it('one request, one yes, the email goes out with the approved inputs', async () => {
    const u = await gmailUser();
    // Tex guesses `to`: refused before the user sees a card, with the real names.
    const guess = await u.ask({ action: SEND, arguments: WRONG });
    expect(guess.isError).toBe(true);
    // Tex asks again with Composio's names: the one card the user sees.
    const asked = await u.ask({ action: SEND, arguments: RIGHT });
    await decideApproval(u.id, asked.json!.approval_id!, true, 'web');
    const sent = await u.mcp('run_app_action', {
      action: SEND,
      approval_id: asked.json!.approval_id,
    });
    expect(sent.isError).toBe(false);
    expect(composio.executed.map((e) => [e.slug, e.arguments])).toEqual([[SEND, RIGHT]]);
    expect((await approvalsOf(u.id)).map((a) => a.status)).toEqual(['approved']);
  });
});
