// The app tools after the speed fix of 16 October: list_app_actions without input schemas, one
// action's inputs from describe_app_action, the activity log written after the answer, and the
// web app's send in three round trips that stays safe to repeat.
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { events } from '../src/modules/events/schema.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { laterSettled } from '../src/shared/later.ts';
import { buildLogger, setLogger } from '../src/shared/logger.ts';
import { wireModules } from '../src/wiring.ts';
import { failNextQuery, installDbMeter } from './db-meter.ts';
import { gmailTools } from './gmail-fixture.ts';
import { installFakeComposio, installFakeVm, mcpCall } from './fakes.ts';
import { call, chatUser } from './helpers.ts';

process.env.COMPOSIO_AUTH_CONFIGS = JSON.stringify({ gmail: 'ac_gmail' });
resetConfig();

let vm: ReturnType<typeof installFakeVm>;
let fake: Awaited<ReturnType<typeof installFakeComposio>>;

beforeAll(() => {
  installDbMeter();
  wireModules();
});
afterAll(closeQueues);
beforeEach(async () => {
  vm = installFakeVm();
  fake = await installFakeComposio();
  fake.state.tools.set('gmail', gmailTools());
});

/** A user whose agent can call the tools, with Gmail connected unless `gmail: false`. */
async function agent(opts: { gmail?: boolean } = {}) {
  const user = await chatUser({ plan: 'max', credits: 500 });
  if (opts.gmail !== false)
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
  const mcp = (tool: string, args: Record<string, unknown> = {}) => mcpCall(token, tool, args);
  return { user, mcp };
}

/** Log lines written while `fn` runs. */
async function logsOf(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  setLogger(buildLogger(sink, 'info'));
  try {
    await fn();
  } finally {
    setLogger(undefined);
  }
  return lines;
}

describe('list_app_actions and describe_app_action', () => {
  it('the list has each action in one line, without its inputs', async () => {
    const { mcp } = await agent();
    const res = await mcp('list_app_actions');
    const listing = JSON.parse(res.text) as { actions: Array<Record<string, unknown>> };
    expect(listing.actions).toHaveLength(63);
    expect(listing.actions.find((a) => a.action === 'GMAIL_SEND_EMAIL')).toEqual({
      action: 'GMAIL_SEND_EMAIL',
      app: 'gmail',
      description: 'Sends an email via the Gmail API using the authenticated user profile.',
      requires_approval: true,
      costs_credits: 1,
    });
  });

  it("describe_app_action gives one action's inputs, from the listing already kept", async () => {
    const { mcp } = await agent();
    await mcp('list_app_actions');
    const before = fake.state.toolRequests.length;
    const res = await mcp('describe_app_action', { action: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID' });
    expect(res.isError).toBe(false);
    const d = JSON.parse(res.text) as Record<string, unknown> & {
      input_schema: { properties: Record<string, unknown>; required: string[] };
    };
    expect(d).toMatchObject({
      action: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
      app: 'gmail',
      requires_approval: false,
      costs_credits: 0,
    });
    expect(Object.keys(d.input_schema.properties)).toEqual(['message_id', 'format', 'user_id']);
    expect(d.input_schema.required).toEqual(['message_id']);
    expect(fake.state.toolRequests.length).toBe(before);
  });

  it('describe_app_action needs no connection, and says plainly when there is no such action', async () => {
    const { mcp } = await agent({ gmail: false });
    fake.state.toolsError.set('gmail', new Error('composio down'));
    fake.state.toolError = new Error('composio down');
    const down = await mcp('describe_app_action', { action: 'GMAIL_LIST_LABELS' });
    expect(down).toEqual({
      isError: true,
      text: "Gmail's actions could not be described right now. Try again in a moment.",
    });
    // Composio back: an action's inputs are the same for everyone, so no connection is needed.
    expect((await mcp('describe_app_action', { action: 'GMAIL_SEND_EMAIL' })).isError).toBe(false);
    const none = await mcp('describe_app_action', { action: 'GMAIL_SEND_A_FAX' });
    expect(none).toEqual({
      isError: true,
      text: 'Gmail has no action "GMAIL_SEND_A_FAX". Find the right one with list_app_actions (app "gmail").',
    });
    const other = await mcp('describe_app_action', { action: 'FOO_BAR_BAZ' });
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(/not an action of an app Textcrew connects/);
  });

  it("request_approval still checks the arguments against the action's inputs", async () => {
    const { mcp } = await agent();
    const res = await mcp('request_approval', {
      summary: 'Send an email to priya@acme.com',
      action: 'GMAIL_SEND_EMAIL',
      arguments: { to: 'priya@acme.com', subject: 'Hi', body: 'Hello' },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/it has no input named "to"/);
    expect(res.text).toMatch(/recipient_email/);
  });
});

describe('run_app_action', () => {
  it("Gmail's fetch runs without bodies unless asked, and the answer is short", async () => {
    const { mcp } = await agent();
    fake.state.executeData.set('GMAIL_FETCH_EMAILS', {
      messages: [
        { messageId: 'm1', sender: 'a@b.co', subject: 'Hi', messageText: 'x'.repeat(5000) },
      ],
    });
    const res = await mcp('run_app_action', {
      action: 'GMAIL_FETCH_EMAILS',
      arguments: { max_results: 5 },
    });
    expect(fake.executed.at(-1)!.arguments).toEqual({
      verbose: false,
      include_payload: false,
      max_results: 5,
    });
    const out = JSON.parse(res.text) as { data: { messages: Array<{ snippet: string }> } };
    expect(out.data.messages[0]).toMatchObject({ id: 'm1', from: 'a@b.co', subject: 'Hi' });
    expect(out.data.messages[0]!.snippet.length).toBeLessThanOrEqual(200);
  });

  it('its activity-log entry is written after the answer, and a failed write never fails the call', async () => {
    const { user, mcp } = await agent();
    await mcp('run_app_action', { action: 'GMAIL_LIST_LABELS', arguments: {} });
    const logged = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, user.id), eq(auditLog.action, 'run_app_action')));
    expect(logged.map((e) => e.summary)).toEqual(['Ran GMAIL_LIST_LABELS']);

    const lines = await logsOf(async () => {
      failNextQuery(/insert into "audit_log"/);
      const res = await mcp('run_app_action', { action: 'GMAIL_LIST_LABELS', arguments: {} });
      expect(res.isError).toBe(false);
      await laterSettled();
    });
    const line = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => String(l.msg).includes('activity log entry of a tool call failed'));
    expect(line).toMatchObject({ level: 50, userId: user.id, tool: 'run_app_action' });
  });
});

describe('POST /v1/messages', () => {
  const send = (token: string, body: Record<string, unknown>) =>
    call('/v1/messages', { method: 'POST', token, body });

  it('saves the message with its event, queues one job, and is safe to send again', async () => {
    const u = await chatUser({ credits: 50 });
    const clientMessageId = randomUUID();
    const first = (await (await send(u.token, { text: 'hi', clientMessageId })).json()) as {
      id: string;
      clientMessageId: string;
    };
    expect(first.clientMessageId).toBe(clientMessageId);
    const again = await send(u.token, { text: 'hi', clientMessageId });
    expect(again.status).toBe(202);
    expect(((await again.json()) as { id: string }).id).toBe(first.id);
    const [msg] = await db().select().from(messages).where(eq(messages.id, first.id));
    const evts = await db()
      .select()
      .from(events)
      .where(and(eq(events.source, 'web'), eq(events.externalId, `${u.id}:${clientMessageId}`)));
    expect(evts).toHaveLength(1);
    expect(msg!.eventId).toBe(evts[0]!.id);
    expect(evts[0]!.payload).toEqual({ messageId: first.id });
    expect(evts[0]!.status).toBe('queued');
    const job = await queue('inbound').getJob(evts[0]!.id);
    expect(job?.data).toMatchObject({ messageId: first.id, eventId: evts[0]!.id });
  });

  it('the same message sent twice at once: one message, one event, pointing to each other', async () => {
    const u = await chatUser({ credits: 50 });
    const clientMessageId = randomUUID();
    const [a, b] = await Promise.all([
      send(u.token, { text: 'twice', clientMessageId }),
      send(u.token, { text: 'twice', clientMessageId }),
    ]);
    expect([a.status, b.status]).toEqual([202, 202]);
    const ids = [((await a.json()) as { id: string }).id, ((await b.json()) as { id: string }).id];
    expect(ids[0]).toBe(ids[1]);
    const rows = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, u.id), eq(messages.clientMessageId, clientMessageId)));
    const evts = await db()
      .select()
      .from(events)
      .where(eq(events.externalId, `${u.id}:${clientMessageId}`));
    expect(rows).toHaveLength(1);
    expect(evts).toHaveLength(1);
    expect(rows[0]!.eventId).toBe(evts[0]!.id);
    expect(evts[0]!.payload).toEqual({ messageId: rows[0]!.id });
  });

  it('a message saved without its event (a crash in between) gets it when sent again', async () => {
    const u = await chatUser({ credits: 50 });
    const clientMessageId = randomUUID();
    const first = (await (await send(u.token, { text: 'lost', clientMessageId })).json()) as {
      id: string;
    };
    await db()
      .delete(events)
      .where(eq(events.externalId, `${u.id}:${clientMessageId}`));
    await send(u.token, { text: 'lost', clientMessageId });
    const [evt] = await db()
      .select()
      .from(events)
      .where(eq(events.externalId, `${u.id}:${clientMessageId}`));
    const [msg] = await db().select().from(messages).where(eq(messages.id, first.id));
    expect(evt).toMatchObject({ status: 'queued', payload: { messageId: first.id } });
    expect(msg!.eventId).toBe(evt!.id);
  });

  it("a failed write of the conversation's last message time doesn't stop the message", async () => {
    const u = await chatUser({ credits: 50 });
    await send(u.token, { text: 'first', clientMessageId: randomUUID() });
    failNextQuery(/^update "conversations"/);
    const res = await send(u.token, { text: 'still goes', clientMessageId: randomUUID() });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    const [msg] = await db().select().from(messages).where(eq(messages.id, id));
    const job = await queue('inbound').getJob(msg!.eventId!);
    expect(job?.data).toMatchObject({ messageId: id });
  });

  it('out of credits comes before an unknown conversation, as before', async () => {
    const u = await chatUser({ credits: 0 });
    const res = await send(u.token, {
      text: 'hi',
      clientMessageId: randomUUID(),
      conversationId: 'cnv_unknown',
    });
    expect(res.status).toBe(402);
    const rich = await chatUser({ credits: 5 });
    const missing = await send(rich.token, {
      text: 'hi',
      clientMessageId: randomUUID(),
      conversationId: 'cnv_unknown',
    });
    expect(missing.status).toBe(404);
  });

  it('the same message sent again does not change which conversation is active', async () => {
    const u = await chatUser({ credits: 50 });
    const clientMessageId = randomUUID();
    const first = (await (await send(u.token, { text: 'one', clientMessageId })).json()) as {
      conversationId: string;
    };
    const fresh = (await (
      await call('/v1/conversations', { method: 'POST', token: u.token })
    ).json()) as { id: string };
    // Sent again naming the old conversation: nothing changes, the new one stays active.
    await send(u.token, { text: 'one', clientMessageId, conversationId: first.conversationId });
    const list = (await (
      await call('/v1/conversations?limit=10&kind=chat', { token: u.token })
    ).json()) as { items: Array<{ id: string; active: boolean }> };
    expect(list.items.find((c) => c.active)?.id).toBe(fresh.id);
    // A new message there does make it the active one again.
    await send(u.token, {
      text: 'two',
      clientMessageId: randomUUID(),
      conversationId: first.conversationId,
    });
    const after = (await (
      await call('/v1/conversations?limit=10&kind=chat', { token: u.token })
    ).json()) as { items: Array<{ id: string; active: boolean }> };
    expect(after.items.find((c) => c.active)?.id).toBe(first.conversationId);
  });
});
