// Skip rules (founder's decision, 17 October): the user can say "don't ask again" for one risky
// app action, from its approval card. While the rule holds, that action runs at once without a card
// and is kept in Approvals as `auto_approved`. Deleting, paying, merging and the platform's own kinds
// always ask. Only the user makes or removes a rule, in the web app; the agent can't.
//
// Covered: which actions a rule may cover and who a request goes to; a rule lets a matching send run
// once without a card and logs it auto_approved (from run_app_action and from request_approval); a
// recipient outside the list still asks; the never-skippable kinds ask even with a rule written into
// the database; the agent can't make, widen or list rules; rules are the user's own; an automation
// set to ask before any change stays strict (with steps too); the same request again in a turn
// doesn't send twice.
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeliverKind } from '../proto-gen/vm/v1/vm_pb.ts';
import { auditLog } from '../src/modules/admin/schema.ts';
import { setMinIntervalMs } from '../src/modules/automations/automations.ts';
import { automationRuns } from '../src/modules/automations/schema.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { approvalSkippable } from '../src/modules/integrations/catalog.ts';
import type { ComposioTool } from '../src/modules/integrations/composio.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { platformTools } from '../src/modules/platform-mcp/registry.ts';
import '../src/modules/platform-mcp/server.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { approvals, skipRules } from '../src/modules/orchestrator/schema.ts';
import { recipientsOf, ruleCovers, skipOfferFor } from '../src/modules/orchestrator/skip-rules.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { ledgerOf } from './billing-helpers.ts';
import { installFakeComposio, installFakeVm, mcpCall, type McpResult } from './fakes.ts';
import { call, chatUser, expectContract, waitFor } from './helpers.ts';

let workers: Worker[];
let vm: ReturnType<typeof installFakeVm>;
let composio: Awaited<ReturnType<typeof installFakeComposio>>;

const SEND = 'GMAIL_SEND_EMAIL';
const DELETE = 'GMAIL_DELETE_MESSAGE';
const MERGE = 'GITHUB_MERGE_A_PULL_REQUEST';
const ME = 'rahul@example.com';

const GMAIL_TOOLS: ComposioTool[] = [
  {
    slug: SEND,
    toolkit: 'gmail',
    name: 'Send Email',
    description: 'Sends an email via Gmail API',
    tags: [],
    inputParameters: {
      type: 'object',
      properties: {
        cc: { type: 'array', items: { type: 'string' } },
        bcc: { type: 'array', items: { type: 'string' } },
        body: { type: 'string' },
        subject: { type: 'string' },
        user_id: { type: 'string', default: 'me' },
        recipient_email: { type: 'string' },
        extra_recipients: { type: 'array', items: { type: 'string' } },
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
      properties: { message_id: { type: 'string' } },
      required: ['message_id'],
    },
  },
  {
    slug: 'GMAIL_FETCH_EMAILS',
    toolkit: 'gmail',
    name: 'Fetch emails',
    description: 'Fetch emails',
    tags: ['readOnlyHint'],
    inputParameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
];

beforeAll(() => {
  wireModules();
  setMinIntervalMs(15 * 60 * 1000);
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(async () => {
  vm = installFakeVm(async () => {});
  composio = await installFakeComposio();
  composio.state.tools.set('gmail', GMAIL_TOOLS);
});

/** A Pro user with Gmail and GitHub connected, a container, and Tex's tools. */
async function person() {
  const user = await chatUser({ plan: 'pro', timezone: 'Asia/Kolkata' });
  for (const app of ['gmail', 'github'])
    await db()
      .insert(connections)
      .values({
        id: newId('con'),
        userId: user.id,
        app,
        composioAccountId: `ca_${randomUUID()}`,
        status: 'active',
      });
  await ensureSandbox(user.id);
  const container = vm.tokens.get(user.id)!;
  const mcp = (tool: string, args: Record<string, unknown>) => mcpCall(container, tool, args);
  /** request_approval as Tex asks it; the answer as JSON. */
  const ask = async (action: string, args: Record<string, unknown>, summary = 'Email it') => {
    const r = await mcp('request_approval', {
      summary,
      action,
      arguments: args,
      session_key: 'web',
    });
    expect(r.isError, r.text).toBeFalsy();
    return JSON.parse(r.text) as Record<string, unknown> & { approval_id: string; status: string };
  };
  return { ...user, container, mcp, ask };
}
type Person = Awaited<ReturnType<typeof person>>;

const mail = (to: string, extra: Record<string, unknown> = {}) => ({
  recipient_email: to,
  subject: `Note ${randomUUID().slice(0, 6)}`,
  body: 'Hello.',
  ...extra,
});
const sends = () => composio.executed.filter((e) => e.slug === SEND);
const json = (r: McpResult) => JSON.parse(r.text) as Record<string, unknown>;
const approvalRow = async (id: string) =>
  (await db().select().from(approvals).where(eq(approvals.id, id)))[0]!;
const rulesOf = (userId: string) =>
  db().select().from(skipRules).where(eq(skipRules.userId, userId));

type ApiApproval = {
  id: string;
  status: string;
  summary: string;
  skip: { actionName: string; recipients: string[]; target: string; scopes: string[] } | null;
  skipRule: { id: string; scope: string; recipients: string[] } | null;
  run: { state: string; result: string | null; creditsCharged: number } | null;
};
type ApiRule = {
  id: string;
  app: string;
  action: string;
  actionName: string;
  scope: string;
  recipients: string[];
};

const listed = async (u: Person, status: string) =>
  (
    await expectContract<{ items: ApiApproval[] }>(
      'listApprovals',
      await call(`/v1/approvals?status=${status}`, { token: u.token }),
      200,
    )
  ).items;
/** The card's "Don't ask again for this…": the rule, then the yes. */
async function dontAskAgain(
  u: Person,
  approvalId: string,
  scope: string,
  recipients?: string[],
): Promise<ApiRule> {
  const rule = await expectContract<ApiRule>(
    'createSkipRule',
    await call('/v1/skip-rules', {
      method: 'POST',
      token: u.token,
      body: { approvalId, scope, ...(recipients ? { recipients } : {}) },
    }),
    201,
  );
  await expectContract(
    'decideApproval',
    await call(`/v1/approvals/${approvalId}/decision`, {
      method: 'POST',
      token: u.token,
      body: { decision: 'approve' },
    }),
    200,
  );
  // The approved one runs at once (approve-runs-now): wait until it has.
  await waitFor(async () => {
    const a = await approvalRow(approvalId);
    return a.runResult && a.runResult.state !== 'running' ? a : null;
  });
  return rule;
}
/** A rule for sends to the user's own address, made from a first approved email. */
async function ruleForMe(u: Person, scope = 'listed') {
  const first = await u.ask(SEND, mail(ME));
  return dontAskAgain(u, first.approval_id, scope);
}
/** Messages that carry an approval (an Approve / Deny card). */
const cardsOf = async (userId: string) =>
  (await db().select().from(messages).where(eq(messages.userId, userId))).filter(
    (m) => m.approvalId,
  );

describe('which actions a rule may cover', () => {
  it('deleting, paying, merging and the platform’s own kinds always ask; sending and changing may be skipped', () => {
    for (const a of [
      'GMAIL_SEND_EMAIL',
      'GMAIL_REPLY_TO_THREAD',
      'SLACK_SEND_MESSAGE',
      'GOOGLECALENDAR_CREATE_EVENT',
      'GOOGLECALENDAR_UPDATE_EVENT',
      'GITHUB_CLOSE_AN_ISSUE',
      'GITHUB_CREATE_AN_ISSUE_COMMENT',
      'LINKEDIN_CREATE_LINKED_IN_POST',
    ])
      expect(approvalSkippable(a), a).toBe(true);
    for (const a of [
      'GMAIL_DELETE_MESSAGE',
      'GMAIL_MOVE_TO_TRASH',
      'SLACK_REMOVE_A_USER_FROM_A_CONVERSATION',
      'SLACK_ARCHIVE_A_SLACK_CONVERSATION',
      'STRIPE_CREATE_A_PAYMENT',
      'PAYPAL_SEND_PAYMENT',
      'STRIPE_CREATE_REFUND',
      'BANK_TRANSFER_FUNDS',
      'GITHUB_MERGE_A_PULL_REQUEST',
      'TEXTCREW_RUN_COMMAND',
      'TEXTCREW_GIT_PUSH',
      'TEXTCREW_START_CREW_JOB',
      'TEXTCREW_RERUN_CREW_JOB',
      // Not risky: it never asks, so there is nothing to skip.
      'GMAIL_FETCH_EMAILS',
      'GMAIL_CREATE_EMAIL_DRAFT',
    ])
      expect(approvalSkippable(a), a).toBe(false);
    // A GitHub review only as a plain comment: an approval can set off an auto-merge.
    const review = 'GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST';
    expect(approvalSkippable(review, { event: 'COMMENT' })).toBe(true);
    expect(approvalSkippable(review, { event: 'APPROVE' })).toBe(false);
    expect(approvalSkippable(review, { event: 'REQUEST_CHANGES' })).toBe(false);
  });

  it('who a request goes to: every recipient input, addresses cleaned, GitHub by repository', () => {
    expect(
      recipientsOf(SEND, {
        recipient_email: 'Priya <Priya@Acme.com>',
        cc: ['a@b.com', 'c@d.com'],
        bcc: 'e@f.com; g@h.com',
        extra_recipients: ['i@j.com'],
        from_email: 'me@x.com',
        user_id: 'me',
        subject: 'to: nobody@x.com',
      }).sort(),
    ).toEqual(['a@b.com', 'c@d.com', 'e@f.com', 'g@h.com', 'i@j.com', 'priya@acme.com']);
    expect(recipientsOf('OUTLOOK_SEND_EMAIL', { to_email: 'x@y.com', to_name: 'Ex Why' })).toEqual([
      'x@y.com',
    ]);
    expect(recipientsOf('SLACK_SEND_MESSAGE', { channel: '#General' })).toEqual(['general']);
    expect(
      recipientsOf('GOOGLECALENDAR_CREATE_EVENT', {
        attendees: [{ email: 'a@b.com', displayName: 'A' }, 'c@d.com'],
      }),
    ).toEqual(['a@b.com', 'c@d.com']);
    expect(
      recipientsOf('GITHUB_CLOSE_AN_ISSUE', { owner: 'Acme', repo: 'Web', issue_number: 3 }),
    ).toEqual(['acme/web']);
    expect(recipientsOf('GMAIL_REPLY_TO_THREAD', { thread_id: 't1', message_body: 'Hi' })).toEqual(
      [],
    );
  });

  it('a listed rule covers only its own action and recipients; "this action" only a request that names none', () => {
    const listedRule = { action: SEND, scope: 'listed' as const, recipients: [ME] };
    expect(ruleCovers(listedRule, SEND, mail(ME))).toBe(true);
    expect(ruleCovers(listedRule, 'gmail_send_email', mail(ME))).toBe(true);
    expect(ruleCovers(listedRule, SEND, mail('other@x.com'))).toBe(false);
    expect(ruleCovers(listedRule, SEND, mail(ME, { cc: ['other@x.com'] }))).toBe(false);
    expect(ruleCovers(listedRule, SEND, { subject: 'x', body: 'y' })).toBe(false);
    expect(ruleCovers(listedRule, 'GMAIL_REPLY_TO_THREAD', mail(ME))).toBe(false);
    const anyone = { action: SEND, scope: 'anyone' as const, recipients: [] };
    expect(ruleCovers(anyone, SEND, mail('stranger@x.com', { bcc: ['z@z.com'] }))).toBe(true);
    const update = {
      action: 'GOOGLECALENDAR_UPDATE_EVENT',
      scope: 'action' as const,
      recipients: [],
    };
    expect(ruleCovers(update, 'GOOGLECALENDAR_UPDATE_EVENT', { event_id: 'e', summary: 'x' })).toBe(
      true,
    );
    expect(
      ruleCovers(update, 'GOOGLECALENDAR_UPDATE_EVENT', { event_id: 'e', attendees: ['a@b.com'] }),
    ).toBe(false);
    // A rule never covers an action that always asks, whatever it says.
    for (const action of [DELETE, MERGE, 'TEXTCREW_RUN_COMMAND', 'TEXTCREW_GIT_PUSH'])
      expect(ruleCovers({ action, scope: 'anyone', recipients: [] }, action, {}), action).toBe(
        false,
      );
  });

  it('what the card offers: only to these or anyone; anyone alone for a post; the action alone for a change', () => {
    expect(skipOfferFor(SEND, mail(ME))).toEqual({
      actionName: 'Send email',
      recipients: [ME],
      target: 'people',
      scopes: ['listed', 'anyone'],
    });
    expect(skipOfferFor('LINKEDIN_CREATE_LINKED_IN_POST', { text: 'Hi' })).toMatchObject({
      scopes: ['anyone'],
    });
    expect(
      skipOfferFor('GITHUB_CLOSE_AN_ISSUE', { owner: 'acme', repo: 'web', issue_number: 3 }),
    ).toMatchObject({
      actionName: 'Close an issue',
      target: 'repository',
      scopes: ['listed', 'anyone'],
    });
    expect(skipOfferFor('GOOGLECALENDAR_UPDATE_EVENT', { event_id: 'e' })).toMatchObject({
      scopes: ['action'],
    });
    expect(skipOfferFor(DELETE, { message_id: 'm' })).toBeNull();
    expect(skipOfferFor(MERGE, { owner: 'a', repo: 'b', pull_number: 1 })).toBeNull();
  });
});

describe('a skip rule lets a matching request run without a card', () => {
  it('the card offers it; with the rule saved, the next send to the same address runs at once and is logged auto-approved', async () => {
    const u = await person();
    const first = await u.ask(SEND, mail(ME), 'Email me the notes');
    // The pending card may offer the skip, with the action in words and its recipient.
    const [pending] = await listed(u, 'pending');
    expect(pending).toMatchObject({
      id: first.approval_id,
      skip: {
        actionName: 'Send email',
        recipients: [ME],
        target: 'people',
        scopes: ['listed', 'anyone'],
      },
      skipRule: null,
      run: null,
    });
    const rule = await dontAskAgain(u, first.approval_id, 'listed');
    expect(rule).toMatchObject({
      app: 'gmail',
      action: SEND,
      actionName: 'Send email',
      scope: 'listed',
      recipients: [ME],
    });
    expect(sends()).toHaveLength(1);
    const cardsBefore = (await cardsOf(u.id)).length;

    // Tex sends to the same address again: it runs now, without approval_id and without a card.
    const r = await u.mcp('run_app_action', { action: SEND, arguments: mail(ME) });
    expect(r.isError, r.text).toBe(false);
    const out = json(r);
    expect(out).toMatchObject({
      ok: true,
      auto_approved: true,
      credits_charged: 1,
      skip_rule_id: rule.id,
    });
    expect(out.about_approval).toMatch(
      /This ran without asking: your user made a rule to skip approval/,
    );
    expect(out.about_approval).toMatch(/Tell the user in one short sentence what was done/);
    expect(sends()).toHaveLength(2);
    expect(await cardsOf(u.id)).toHaveLength(cardsBefore);
    expect(await listed(u, 'pending')).toEqual([]);

    // Kept as an auto-approved approval: the rule, used, its result; charged once, keyed by it.
    const row = await approvalRow(out.approval_id as string);
    expect(row).toMatchObject({
      status: 'auto_approved',
      decidedVia: `rule:${rule.id}`,
      action: SEND,
      app: 'gmail',
    });
    expect(row.usedAt).not.toBeNull();
    expect(row.runResult).toMatchObject({ state: 'done', creditsCharged: 1 });
    expect(row.summary).toBe(`Send email to ${ME}`);
    const charges = (await ledgerOf(u.id)).filter((l) => l.meta?.kind === 'app_action');
    expect(charges.map((c) => c.idempotencyKey)).toContain(`app-action:${row.id}`);

    // The Auto-approved tab lists it, with the rule and the result.
    const [auto] = await listed(u, 'auto_approved');
    expect(auto).toMatchObject({
      id: row.id,
      status: 'auto_approved',
      skip: null,
      skipRule: { id: rule.id, scope: 'listed', recipients: [ME] },
      run: { state: 'done', creditsCharged: 1 },
    });
    expect(auto!.run!.result).toContain('ok');
    // It can't be answered.
    const answer = await call(`/v1/approvals/${row.id}/decision`, {
      method: 'POST',
      token: u.token,
      body: { decision: 'reject' },
    });
    expect(answer.status).toBe(409);

    // The activity log: the rule made by the user, the run without asking, charged once.
    const log = await db().select().from(auditLog).where(eq(auditLog.userId, u.id));
    expect(log.find((l) => l.action === 'skip_rule_created')).toMatchObject({
      actor: 'user',
      summary: `Don't ask again: Gmail: send email only to ${ME}`,
    });
    expect(
      log.find((l) => l.summary === `Ran ${SEND} without asking (your skip rule)`),
    ).toMatchObject({ creditsCharged: 1 });
  });

  it('request_approval for a request the rule covers runs it at once: status auto_approved, no card', async () => {
    const u = await person();
    const rule = await ruleForMe(u);
    const cardsBefore = (await cardsOf(u.id)).length;
    const asked = await u.ask(SEND, mail(ME), 'Email me the summary');
    expect(asked).toMatchObject({
      status: 'auto_approved',
      ok: true,
      auto_approved: true,
      skip_rule_id: rule.id,
    });
    expect(sends()).toHaveLength(2);
    expect(await cardsOf(u.id)).toHaveLength(cardsBefore);
    expect(await listed(u, 'pending')).toEqual([]);
    const row = await approvalRow(asked.approval_id);
    expect(row).toMatchObject({ status: 'auto_approved', summary: 'Email me the summary' });
    const log = await db().select().from(auditLog).where(eq(auditLog.userId, u.id));
    expect(
      log.find((l) => l.action === 'request_approval' && l.creditsCharged === 1)?.summary,
    ).toBe(`Ran ${SEND} without asking (your skip rule)`);
  });

  it('a recipient outside the list still asks: another address, a cc, a bcc, extra recipients', async () => {
    const u = await person();
    await ruleForMe(u);
    for (const args of [
      mail('priya@acme.com'),
      mail(ME, { cc: ['priya@acme.com'] }),
      mail(ME, { bcc: ['priya@acme.com'] }),
      mail(ME, { extra_recipients: ['priya@acme.com'] }),
    ]) {
      const r = await u.mcp('run_app_action', { action: SEND, arguments: args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.text).toContain("This action needs the user's approval");
    }
    // Asked about, it is a card, with both recipients offered.
    const asked = await u.ask(SEND, mail(ME, { cc: ['priya@acme.com'] }));
    expect(asked.status).toBe('pending');
    const [pending] = await listed(u, 'pending');
    expect(pending!.skip!.recipients.sort()).toEqual([ME, 'priya@acme.com'].sort());
    expect(sends()).toHaveLength(1);
    // "Anyone" covers them all.
    await dontAskAgain(u, asked.approval_id, 'anyone');
    const r = await u.mcp('run_app_action', { action: SEND, arguments: mail('x@y.com') });
    expect(json(r)).toMatchObject({ auto_approved: true });
  });

  it('deleting, paying, merging and Tex’s own kinds always ask, even with a rule written into the database', async () => {
    const u = await person();
    // Rules no API would make, written straight into the table.
    for (const [app, action] of [
      ['gmail', DELETE],
      ['github', MERGE],
      ['textcrew', 'TEXTCREW_RUN_COMMAND'],
      ['textcrew', 'TEXTCREW_GIT_PUSH'],
    ] as const)
      for (const scope of ['anyone', 'action'] as const)
        await db()
          .insert(skipRules)
          .values({
            id: newId('skp'),
            userId: u.id,
            app,
            action,
            scope,
            recipients: [],
            createdVia: 'forged',
          });
    const del = await u.mcp('run_app_action', { action: DELETE, arguments: { message_id: 'm1' } });
    expect(del.isError).toBe(true);
    expect(del.text).toContain("This action needs the user's approval");
    const merge = await u.mcp('run_app_action', {
      action: MERGE,
      arguments: { owner: 'acme', repo: 'web', pull_number: 7 },
    });
    expect(merge.isError).toBe(true);
    expect(merge.text).toContain("This action needs the user's approval");
    // Asked, each is a card, with no "Don't ask again" on it.
    const askDel = await u.ask(DELETE, { message_id: 'm1' }, 'Delete the old email');
    const askMerge = await u.ask(MERGE, { owner: 'acme', repo: 'web', pull_number: 7 }, 'Merge #7');
    expect([askDel.status, askMerge.status]).toEqual(['pending', 'pending']);
    const pending = await listed(u, 'pending');
    expect(pending.map((a) => a.skip)).toEqual([null, null]);
    // And the API refuses to make one for them.
    for (const id of [askDel.approval_id, askMerge.approval_id]) {
      const res = await call('/v1/skip-rules', {
        method: 'POST',
        token: u.token,
        body: { approvalId: id, scope: 'anyone' },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_skippable');
    }
    expect(composio.executed.filter((e) => e.slug === DELETE || e.slug === MERGE)).toEqual([]);
    expect(await listed(u, 'auto_approved')).toEqual([]);
  });

  it('the agent cannot make, widen or list rules', async () => {
    const u = await person();
    // No tool of Tex's touches rules.
    expect(
      platformTools()
        .map((t) => t.name)
        .filter((n) => /skip|rule/i.test(n)),
    ).toEqual([]);
    // The container's token is not a session: the rules API answers 401.
    for (const init of [
      { method: 'GET' },
      { method: 'POST', body: { approvalId: 'apr_x', scope: 'anyone' } },
    ]) {
      const res = await call('/v1/skip-rules', { ...init, token: u.container });
      expect(res.status).toBe(401);
    }
    // Inputs that try to make one do nothing: no rule, and the send still asks.
    const sneaky = await u.mcp('request_approval', {
      summary: 'Email Priya',
      action: SEND,
      arguments: mail('priya@acme.com'),
      session_key: 'web',
      skip_rule: { scope: 'anyone' },
      scope: 'anyone',
      dont_ask_again: true,
    });
    expect(json(sneaky).status).toBe('pending');
    const run = await u.mcp('run_app_action', {
      action: SEND,
      arguments: mail('priya@acme.com'),
      skip_approval: true,
      scope: 'anyone',
    });
    expect(run.isError).toBe(true);
    expect(await rulesOf(u.id)).toEqual([]);

    // With a rule for the user's own address, a request with more recipients changes nothing in it.
    const rule = await ruleForMe(u);
    await u.ask(SEND, mail(ME, { cc: ['priya@acme.com', 'boss@acme.com'] }));
    expect((await rulesOf(u.id)).map((r) => [r.id, r.scope, r.recipients])).toEqual([
      [rule.id, 'listed', [ME]],
    ]);
  });

  it('rules are the user’s own: another user’s rule covers nothing for them, and they can’t see, remove or copy it', async () => {
    const a = await person();
    const b = await person();
    const rule = await ruleForMe(a);
    // B's send to the same address asks.
    const r = await b.mcp('run_app_action', { action: SEND, arguments: mail(ME) });
    expect(r.isError).toBe(true);
    expect(
      (
        await expectContract<{ items: ApiRule[] }>(
          'listSkipRules',
          await call('/v1/skip-rules', { token: b.token }),
          200,
        )
      ).items,
    ).toEqual([]);
    expect(
      (await call(`/v1/skip-rules/${rule.id}`, { method: 'DELETE', token: b.token })).status,
    ).toBe(404);
    const aAsked = await a.ask(SEND, mail('priya@acme.com'));
    const copy = await call('/v1/skip-rules', {
      method: 'POST',
      token: b.token,
      body: { approvalId: aAsked.approval_id, scope: 'anyone' },
    });
    expect(copy.status).toBe(404);
    expect(await listed(b, 'auto_approved')).toEqual([]);

    // A's own list has it; removed, the send asks again.
    const mine = await expectContract<{ items: ApiRule[] }>(
      'listSkipRules',
      await call('/v1/skip-rules', { token: a.token }),
      200,
    );
    expect(mine.items.map((x) => x.id)).toEqual([rule.id]);
    expect(
      (await call(`/v1/skip-rules/${rule.id}`, { method: 'DELETE', token: a.token })).status,
    ).toBe(204);
    const again = await a.mcp('run_app_action', { action: SEND, arguments: mail(ME) });
    expect(again.isError).toBe(true);
    const log = await db().select().from(auditLog).where(eq(auditLog.userId, a.id));
    expect(log.some((l) => l.action === 'skip_rule_removed')).toBe(true);
  });

  it('the same request again in one turn sends once; a new turn is a new request', async () => {
    const u = await person();
    await ruleForMe(u);
    const args = mail(ME);
    const results: McpResult[] = [];
    vm.state.agent = async (d, mcp) => {
      // Only the user's messages (not the turn after the first yes).
      if (d.userId !== u.id || d.kind !== DeliverKind.MESSAGE) return;
      // A call made again, and two at the same moment.
      results.push(await mcp('run_app_action', { action: SEND, arguments: args }));
      results.push(
        ...(await Promise.all([
          mcp('run_app_action', { action: SEND, arguments: args }),
          mcp('request_approval', {
            summary: 'Again',
            action: SEND,
            arguments: args,
            session_key: d.sessionKey,
          }),
        ])),
      );
      await mcp('send_message', { text: 'done', session_key: d.sessionKey });
    };
    const before = sends().length;
    const say = (text: string) =>
      call('/v1/messages', {
        method: 'POST',
        token: u.token,
        body: { text, clientMessageId: randomUUID() },
      });
    expect((await say('email me the note')).status).toBe(202);
    await waitFor(async () => results.length === 3, 20_000);
    expect(results.map((r) => r.isError)).toEqual([false, false, false]);
    expect(sends().length - before).toBe(1);
    const outs = results.map(json);
    expect(outs.filter((o) => o.already_done === true)).toHaveLength(2);
    expect(new Set(outs.map((o) => o.approval_id)).size).toBe(1);
    expect(outs.reduce((n, o) => n + (o.credits_charged as number), 0)).toBe(1);
    const autos = await db()
      .select()
      .from(approvals)
      .where(and(eq(approvals.userId, u.id), eq(approvals.status, 'auto_approved')));
    expect(autos).toHaveLength(1);

    // The next message's turn sends it again: it is a new request.
    expect((await say('and once more')).status).toBe(202);
    await waitFor(async () => results.length === 6, 20_000);
    expect(sends().length - before).toBe(2);
  });
});

describe('automations', () => {
  const runNow = (u: Person, id: string) =>
    call(`/v1/automations/${id}/run`, {
      method: 'POST',
      token: u.token,
      body: { clientRequestId: randomUUID() },
    });
  const create = async (u: Person, body: Record<string, unknown>) =>
    expectContract<{ id: string }>(
      'createAutomation',
      await call('/v1/automations', {
        method: 'POST',
        token: u.token,
        body: { clientRequestId: randomUUID(), ...body },
      }),
      201,
    );

  it('set to ask before anything that changes something, it stays strict; with the usual setting the rule applies', async () => {
    const u = await person();
    await ruleForMe(u);
    const results: McpResult[] = [];
    vm.state.agent = async (d, mcp) => {
      // Only the automation's runs (not the turn after the first yes).
      if (
        d.userId !== u.id ||
        d.kind === DeliverKind.APPROVAL_ANSWER ||
        d.kind === DeliverKind.MESSAGE
      )
        return;
      results.push(await mcp('run_app_action', { action: SEND, arguments: mail(ME) }));
      await mcp('send_message', { text: 'done', session_key: d.sessionKey });
    };
    const strict = await create(u, {
      title: 'Strict',
      instruction: 'Email me the day',
      cron: '0 9 * * *',
      apps: ['gmail'],
      askFirst: 'changes',
    });
    expect((await runNow(u, strict.id)).status).toBe(202);
    await waitFor(async () => results.length === 1, 20_000);
    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.text).toContain("This action needs the user's approval");
    const before = sends().length;

    const usual = await create(u, {
      title: 'Usual',
      instruction: 'Email me the day',
      cron: '0 10 * * *',
      apps: ['gmail'],
    });
    expect((await runNow(u, usual.id)).status).toBe(202);
    await waitFor(async () => results.length === 2, 20_000);
    expect(json(results[1]!)).toMatchObject({ auto_approved: true });
    expect(sends().length - before).toBe(1);
  });

  it('a step that asks only because its action is risky uses the rule; the strict setting still asks', async () => {
    const u = await person();
    await ruleForMe(u);
    const results: McpResult[] = [];
    vm.state.agent = async (d, mcp) => {
      // Only the automation's runs (not the turn after the first yes).
      if (
        d.userId !== u.id ||
        d.kind === DeliverKind.APPROVAL_ANSWER ||
        d.kind === DeliverKind.MESSAGE
      )
        return;
      results.push(
        await mcp('run_app_action', { action: SEND, arguments: { body: 'Today: all calm.' } }),
      );
      await mcp('send_message', { text: 'done', session_key: d.sessionKey });
    };
    const steps = [
      {
        id: 'send',
        type: 'action',
        app: 'gmail',
        action: SEND,
        inputs: { recipient_email: ME, subject: 'Your day' },
      },
    ];
    const strict = await create(u, {
      title: 'Strict steps',
      instruction: 'Email me my day',
      cron: '0 9 * * *',
      askFirst: 'changes',
      steps,
    });
    expect((await runNow(u, strict.id)).status).toBe(202);
    await waitFor(async () => results.length === 1, 20_000);
    expect(results[0]!.isError).toBe(true);
    const before = sends().length;

    const usual = await create(u, {
      title: 'Usual steps',
      instruction: 'Email me my day',
      cron: '0 10 * * *',
      steps,
    });
    expect((await runNow(u, usual.id)).status).toBe(202);
    await waitFor(async () => results.length === 2, 20_000);
    expect(json(results[1]!)).toMatchObject({ auto_approved: true });
    expect(sends().length - before).toBe(1);
    expect(sends().at(-1)!.arguments).toMatchObject({ recipient_email: ME, subject: 'Your day' });
    // The step is done, by the rule, and its approval is bound to that step of that run.
    const [run] = await db()
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, usual.id));
    expect(run!.steps[0]!.state).toBe('done');
    const row = await approvalRow(json(results[1]!).approval_id as string);
    expect(row).toMatchObject({
      status: 'auto_approved',
      automationRunId: run!.id,
      automationStepId: 'send',
    });
  });
});
