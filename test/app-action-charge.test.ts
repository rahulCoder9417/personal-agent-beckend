// The app-action charge (HLD 7.2, launch plan D6): 1 credit for each successful app action that
// changes something; reading, listing and searching are free. Charged through grants + the
// append-only ledger with an idempotency key, never for a failed action, given back when the turn
// is reversed as our fault, and visible in the ledger, the activity log and usage.
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chargeAppAction } from '../src/modules/billing/app-actions.ts';
import { charge, createGrant, getBalance } from '../src/modules/billing/credits.ts';
import { setTurnRefundDelay } from '../src/modules/billing/jobs.ts';
import { reverseTurn, syncUsageForUser } from '../src/modules/billing/usage.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { appActionChangesSomething } from '../src/modules/integrations/apps.ts';
import {
  actionChangesSomething,
  actionKindByName,
  actionNeedsApproval,
} from '../src/modules/integrations/catalog.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { decideApproval } from '../src/modules/orchestrator/approvals.ts';
import { approvals } from '../src/modules/orchestrator/schema.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { grantsOf, ledgerMatchesGrants, ledgerOf } from './billing-helpers.ts';
import { installFakeComposio, installFakeVm, mcpCall } from './fakes.ts';
import { call, chatUser, createUser, expectContract, waitFor } from './helpers.ts';

let workers: Worker[];
let vm: ReturnType<typeof installFakeVm>;
let composio: Awaited<ReturnType<typeof installFakeComposio>>;

beforeAll(() => {
  wireModules();
  setTurnRefundDelay(0); // the refund job of a failed turn runs at once
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(async () => {
  vm = installFakeVm();
  composio = await installFakeComposio();
});

const DRAFT = 'GMAIL_CREATE_EMAIL_DRAFT'; // changes something, needs no approval
const LIST = 'GMAIL_LIST_EMAILS'; // only reads
const SEND = 'GMAIL_SEND_EMAIL'; // changes something, needs approval
const ARGS = { to: 'priya@acme.com', subject: 'Report', body: 'Delayed to Monday' };

/** A user with Gmail connected and a container token for /mcp. */
async function appUser(opts: { credits?: number } = {}) {
  const user = opts.credits === 0 ? await createUser() : await chatUser(opts);
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
  const run = (action: string, extra: Record<string, unknown> = {}) =>
    mcpCall(token, 'run_app_action', { action, arguments: ARGS, ...extra });
  return { ...user, mcp: token, run };
}

const appActionRows = async (userId: string) =>
  (await ledgerOf(userId)).filter((r) => r.meta?.kind === 'app_action');

/** The platform runs an approved app action at once: waits until that run has ended. */
const ranOnApproval = (id: string) =>
  waitFor(async () => {
    const [a] = await db().select().from(approvals).where(eq(approvals.id, id));
    return a?.runResult && a.runResult.state !== 'running' ? a : null;
  });

describe('which actions change something', () => {
  it('names with a write word change something; names with only a read word read', () => {
    for (const a of [
      'GMAIL_SEND_EMAIL',
      'GMAIL_CREATE_EMAIL_DRAFT',
      'GMAIL_DELETE_MESSAGE',
      'GOOGLECALENDAR_UPDATE_EVENT',
      'GITHUB_CREATE_AN_ISSUE',
      'GITHUB_ADD_LABELS_TO_AN_ISSUE',
      'NOTION_ADD_PAGE_CONTENT',
      'GOOGLESHEETS_BATCH_UPDATE',
      'GMAIL_MARK_AS_READ', // "read" is not the verb here
      'TRELLO_UPDATE_LIST', // nor is "list"
      'SLACK_SET_READ_CURSOR',
      'HUBSPOT_GET_OR_CREATE_CONTACT',
    ])
      expect(actionKindByName(a), a).toBe('changes');
    for (const a of [
      'GMAIL_LIST_EMAILS',
      'GMAIL_FETCH_EMAILS',
      'GOOGLECALENDAR_FIND_FREE_SLOTS',
      'GITHUB_GET_A_PULL_REQUEST',
      'GITHUB_LIST_REPOSITORY_ISSUES',
      'GITHUB_GET_AN_ISSUE_COMMENT',
      'SLACK_SEARCH_MESSAGES',
      'NOTION_QUERY_DATABASE',
      'GOOGLEDRIVE_DOWNLOAD_FILE',
      'EXA_SEARCH',
      'gmail_list_emails',
    ])
      expect(actionKindByName(a), a).toBe('reads');
    for (const a of [
      'SLACK_CONVERSATIONS_HISTORY',
      'GITHUB_STAR_A_REPOSITORY',
      'TODOIST_CHECK_ITEM',
    ])
      expect(actionKindByName(a), a).toBe('unknown');
  });

  it('everything that needs approval changes something', () => {
    for (const a of ['GMAIL_SEND_EMAIL', 'GMAIL_REPLY_TO_THREAD', 'GITHUB_MERGE_A_PULL_REQUEST']) {
      expect(actionNeedsApproval(a), a).toBe(true);
      expect(actionChangesSomething(a, ['readOnlyHint']), a).toBe(true); // the name wins
    }
  });

  it("an unknown name changes something, unless Composio's readOnlyHint says it only reads", () => {
    expect(actionChangesSomething('SLACK_CONVERSATIONS_HISTORY')).toBe(true);
    expect(actionChangesSomething('SLACK_CONVERSATIONS_HISTORY', ['important'])).toBe(true);
    expect(actionChangesSomething('SLACK_CONVERSATIONS_HISTORY', ['readOnlyHint'])).toBe(false);
    // The tag never makes a named write free, and isn't needed for a named read.
    expect(actionChangesSomething('GMAIL_CREATE_EMAIL_DRAFT', ['readOnlyHint'])).toBe(true);
    expect(actionChangesSomething('GMAIL_LIST_EMAILS')).toBe(false);
  });

  it('asks Composio for tags only when the name says nothing, once per tool', async () => {
    expect(await appActionChangesSomething(DRAFT)).toBe(true);
    expect(await appActionChangesSomething(LIST)).toBe(false);
    expect(composio.state.tagLookups).toEqual([]);

    composio.state.tags.set('SLACK_CONVERSATIONS_HISTORY', ['readOnlyHint']);
    expect(await appActionChangesSomething('SLACK_CONVERSATIONS_HISTORY')).toBe(false);
    expect(await appActionChangesSomething('slack_conversations_history')).toBe(false);
    expect(await appActionChangesSomething('GITHUB_STAR_A_REPOSITORY')).toBe(true);
    expect(composio.state.tagLookups).toEqual([
      'SLACK_CONVERSATIONS_HISTORY',
      'GITHUB_STAR_A_REPOSITORY',
    ]);
  });

  it("when Composio can't be asked, an unknown action counts as changing something", async () => {
    composio.state.tags.set('SLACK_USERS_INFO', ['readOnlyHint']);
    composio.state.tagsError = new Error('composio is down');
    expect(await appActionChangesSomething('SLACK_USERS_INFO')).toBe(true);
    // The failure isn't remembered: the next call asks again.
    expect(await appActionChangesSomething('SLACK_USERS_INFO')).toBe(false);
    expect(composio.state.tagLookups).toEqual(['SLACK_USERS_INFO', 'SLACK_USERS_INFO']);
  });
});

describe('app-action charge', () => {
  it('reading is free; a successful action that changes something costs 1 credit', async () => {
    const u = await appUser();
    const read = await u.run(LIST);
    expect(JSON.parse(read.text)).toMatchObject({ ok: true, credits_charged: 0 });
    expect(await getBalance(u.id)).toBe(1000);
    expect(await appActionRows(u.id)).toHaveLength(0);

    const write = await u.run(DRAFT);
    expect(JSON.parse(write.text)).toMatchObject({ ok: true, credits_charged: 1 });
    expect(await getBalance(u.id)).toBe(999);
    const rows = await appActionRows(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      delta: -1,
      reason: 'charge',
      description: `App action: ${DRAFT}`,
      meta: { kind: 'app_action', action: DRAFT },
    });
    expect(rows[0]!.idempotencyKey).toMatch(/^app-action:act_/);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
    expect(composio.executed.map((e) => e.slug)).toEqual([LIST, DRAFT]);
  });

  it('list_app_actions says what each action costs', async () => {
    const u = await appUser();
    const { actions } = JSON.parse(
      (await mcpCall(u.mcp, 'list_app_actions', { app: 'gmail' })).text,
    ) as { actions: Array<{ action: string; costs_credits: number; requires_approval: boolean }> };
    expect(actions.find((a) => a.action === SEND)).toMatchObject({
      costs_credits: 1,
      requires_approval: true,
    });
    expect(actions.find((a) => a.action === LIST)).toMatchObject({
      costs_credits: 0,
      requires_approval: false,
    });
  });

  it('an approved action is charged once, keyed by its approval', async () => {
    const u = await appUser();
    const asked = JSON.parse(
      (
        await mcpCall(u.mcp, 'request_approval', {
          summary: 'Email priya',
          action: SEND,
          arguments: ARGS,
          session_key: 'web',
        })
      ).text,
    ) as { approval_id: string };
    await decideApproval(u.id, asked.approval_id, true, 'web');
    // It runs at the yes, and is charged then.
    const ran = await ranOnApproval(asked.approval_id);
    expect(ran.runResult).toMatchObject({ state: 'done', creditsCharged: 1 });
    expect((await appActionRows(u.id)).map((r) => r.idempotencyKey)).toEqual([
      `app-action:${asked.approval_id}`,
    ]);

    // The agent's call gets that result, and is charged nothing more.
    const sent = await u.run(SEND, { approval_id: asked.approval_id });
    expect(JSON.parse(sent.text)).toMatchObject({
      ok: true,
      credits_charged: 0,
      already_done: true,
    });
    // The same approval can't run again, and its charge can't be written again.
    expect(JSON.parse((await u.run(SEND, { approval_id: asked.approval_id })).text)).toMatchObject({
      already_done: true,
    });
    expect(composio.executed.filter((e) => e.slug === SEND)).toHaveLength(1);
    expect(await chargeAppAction(u.id, { action: SEND, ref: asked.approval_id })).toMatchObject({
      charged: 0,
      balance: 999,
    });
    expect(await getBalance(u.id)).toBe(999);
    expect(await appActionRows(u.id)).toHaveLength(1);
  });

  it('a failed action is not charged (and its approval can be used again)', async () => {
    const u = await appUser();
    composio.state.executeFailure = 'quota exceeded';
    const refused = await u.run(DRAFT);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('quota exceeded');
    composio.state.executeFailure = new Error('composio is down');
    expect((await u.run(DRAFT)).isError).toBe(true);
    expect(await getBalance(u.id)).toBe(1000);
    expect(await appActionRows(u.id)).toHaveLength(0);

    const asked = JSON.parse(
      (
        await mcpCall(u.mcp, 'request_approval', {
          summary: 'Email priya',
          action: SEND,
          arguments: ARGS,
          session_key: 'web',
        })
      ).text,
    ) as { approval_id: string };
    // The run at the yes fails: nothing is charged, and the approval stays usable.
    composio.state.executeFailure = 'mailbox unavailable';
    await decideApproval(u.id, asked.approval_id, true, 'web');
    await ranOnApproval(asked.approval_id);
    composio.state.executeFailure = 'mailbox unavailable';
    expect((await u.run(SEND, { approval_id: asked.approval_id })).isError).toBe(true);
    expect(await getBalance(u.id)).toBe(1000);
    const [approval] = await db()
      .select()
      .from(approvals)
      .where(eq(approvals.id, asked.approval_id));
    expect(approval!.usedAt).toBeNull();
    // The retry works and is charged once.
    expect((await u.run(SEND, { approval_id: asked.approval_id })).isError).toBeFalsy();
    expect(await getBalance(u.id)).toBe(999);
  });

  it('an unknown action is charged; one Composio marks read-only is free', async () => {
    const u = await appUser();
    composio.state.tags.set('GMAIL_THREAD_HISTORY', ['readOnlyHint']);
    expect(JSON.parse((await u.run('GMAIL_THREAD_HISTORY')).text).credits_charged).toBe(0);
    expect(JSON.parse((await u.run('GMAIL_PROFILE_SYNC')).text).credits_charged).toBe(1);
    expect(await getBalance(u.id)).toBe(999);
  });

  it('at zero credits an action that changes something is refused; reading still works', async () => {
    const u = await appUser({ credits: 1 });
    expect(JSON.parse((await u.run(DRAFT)).text).credits_charged).toBe(1);
    expect(await getBalance(u.id)).toBe(0);

    const refused = await u.run(DRAFT);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('out of credits');
    expect(refused.text).toContain('Textcrew web app');
    expect(refused.text).not.toMatch(/https?:\/\//);
    expect(composio.executed).toHaveLength(1); // the second one never reached Composio
    expect(await getBalance(u.id)).toBe(0); // and no debt was made

    expect((await u.run(LIST)).isError).toBeFalsy();
  });

  it('shows in the activity log, the credit history and usage', async () => {
    const u = await appUser();
    vm.state.usage.set(u.id, { awakeSeconds: 300n, browserSeconds: 0n });
    await u.run(LIST);
    await u.run(DRAFT);
    await u.run(DRAFT);
    await syncUsageForUser(u.id);

    const activity = await expectContract<{
      items: Array<{ action: string; summary: string; creditsCharged: number | null }>;
    }>('listActivity', await call('/v1/activity', { token: u.token }), 200);
    const runs = activity.items.filter((a) => a.action === 'run_app_action');
    expect(runs.map((a) => [a.summary, a.creditsCharged])).toEqual([
      [`Ran ${DRAFT}`, 1],
      [`Ran ${DRAFT}`, 1],
      [`Ran ${LIST}`, 0],
    ]);

    const ledger = await expectContract<{
      items: Array<{ delta: number; reason: string; description: string }>;
    }>('listLedger', await call('/v1/credits/ledger', { token: u.token }), 200);
    expect(
      ledger.items.filter((l) => l.description === `App action: ${DRAFT}`).map((l) => l.delta),
    ).toEqual([-1, -1]);

    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const usage = await expectContract<{
      items: Array<Record<string, number>>;
      totals: Record<string, number>;
    }>('getUsage', await call(`/v1/usage?from=${from}&to=${to}`, { token: u.token }), 200);
    expect(usage.items).toHaveLength(1);
    expect(usage.items[0]).toMatchObject({ awakeCredits: 1, appActionCredits: 2, totalCredits: 3 });
    expect(usage.totals).toEqual({
      aiCredits: 0,
      awakeCredits: 1,
      wakeCredits: 0,
      appActionCredits: 2,
      browserCredits: 0,
      toolCredits: 0,
      totalCredits: 3,
    });
    expect(await getBalance(u.id)).toBe(997);
  });
});

describe('app-action charge: which grants pay (HLD 7.7)', () => {
  it('a cheap-model-only coupon grant pays app actions, and still never pays other AI', async () => {
    const u = await appUser({ credits: 0 });
    await createGrant({
      userId: u.id,
      source: 'coupon',
      amount: 5,
      expiresAt: new Date(Date.now() + 86400_000),
      cheapModelOnly: true,
      idempotencyKey: `test-coupon:${u.id}`,
      description: 'test coupon',
    });
    expect(JSON.parse((await u.run(DRAFT)).text).credits_charged).toBe(1);
    const coupon = (await grantsOf(u.id)).find((g) => g.source === 'coupon')!;
    expect(coupon.remaining).toBe(4);
    expect(await grantsOf(u.id)).toHaveLength(1); // paid by the coupon itself: no overrun grant

    // Non-cheap AI still can't draw from it: it goes to the overrun holder, the coupon is untouched.
    await charge(
      u.id,
      { cheapAi: 0, otherAi: 2, awake: 0, browser: 0, tools: 0 },
      { idempotencyKey: `test-other-ai:${u.id}`, description: 'test' },
    );
    const after = await grantsOf(u.id);
    expect(after.find((g) => g.source === 'coupon')!.remaining).toBe(4);
    expect(after.find((g) => g.ref === 'overrun')!.remaining).toBe(-2);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it('a Free-plan user pays it from the sign-up credits; the oldest-expiry grant goes first', async () => {
    const u = await appUser({ credits: 0 });
    expect(u.plan).toBe('free');
    const day = 86400_000;
    for (const [source, days] of [
      ['signup', 30],
      ['coupon', 10],
    ] as const)
      await createGrant({
        userId: u.id,
        source,
        amount: 100,
        expiresAt: new Date(Date.now() + days * day),
        cheapModelOnly: source === 'coupon',
        idempotencyKey: `test-${source}:${u.id}`,
        description: `test ${source}`,
      });
    await u.run(DRAFT);
    const grants = await grantsOf(u.id);
    expect(grants.find((g) => g.source === 'coupon')!.remaining).toBe(99); // expires first
    expect(grants.find((g) => g.source === 'signup')!.remaining).toBe(100);
  });
});

describe('app-action charge: a turn reversed as our fault', () => {
  it('gives back only the app-action credits charged during that turn, once', async () => {
    const u = await appUser();
    await u.run(DRAFT); // before the turn: stays charged
    await new Promise((r) => setTimeout(r, 20));
    const startedAt = new Date();
    await u.run(DRAFT);
    await u.run(DRAFT);
    await u.run(LIST);
    const turn = { startedAt, endedAt: new Date(), idempotencyKey: `fault:${randomUUID()}` };
    expect(await getBalance(u.id)).toBe(997);

    expect(await reverseTurn(u.id, turn)).toEqual({ restored: 2 });
    expect(await getBalance(u.id)).toBe(999);
    const reversals = (await ledgerOf(u.id)).filter((r) => r.reason === 'reversal');
    expect(reversals.map((r) => [r.delta, r.description])).toEqual([
      [1, 'Failed turn refunded (app actions)'],
      [1, 'Failed turn refunded (app actions)'],
    ]);
    // Re-running the reversal gives nothing more.
    expect(await reverseTurn(u.id, turn)).toEqual({ restored: 0 });
    expect(await getBalance(u.id)).toBe(999);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it('end to end: the agent acts, the turn fails on our side, the user is not charged', async () => {
    vm = installFakeVm(async (_d, mcp) => {
      await mcp('run_app_action', { action: DRAFT, arguments: ARGS });
    });
    const u = await appUser();
    vm.state.turnErrorAfterAgent = { message: 'bridge crashed', platformFault: true };
    await expectContract(
      'sendMessage',
      await call('/v1/messages', {
        method: 'POST',
        token: u.token,
        body: { text: 'draft the email to priya', clientMessageId: randomUUID() },
      }),
      202,
    );
    await waitFor(async () =>
      (await ledgerOf(u.id)).find((r) => r.reason === 'reversal' && r.delta === 1),
    );
    expect(composio.executed.map((e) => e.slug)).toEqual([DRAFT]);
    expect((await appActionRows(u.id)).map((r) => r.delta)).toEqual([-1]);
    expect(await getBalance(u.id)).toBe(1000);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });
});
