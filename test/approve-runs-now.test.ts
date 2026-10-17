// An approved app action runs the moment the user approves (founder's decision, 17 October): the
// platform runs it on the system queue, which never waits for the user's lock, and Tex is told the
// result. On 17 October the founder pressed Approve on a merge, sent a new message 0.1 s later, and
// the merge waited about a minute behind that message's turn.
//
// Covered: it runs once without a Tex turn; it runs while Tex is busy (web and Telegram buttons);
// running it again never runs it twice; Tex's later run_app_action gets the stored result; a
// failure is told to Tex and not retried; the answer's event is saved in the same step as the
// answer; the platform's own kinds and the steps of a run still go through Tex.
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { inboundJobOf } from '../src/modules/channels/inbound.ts';
import { findEvent } from '../src/modules/events/intake.ts';
import { addJob, closeQueues, queue } from '../src/modules/events/queues.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import {
  approvedRunText,
  decideApproval,
  requestApproval,
  runsWhenApproved,
  settleApprovedRun,
  RUN_APPROVED_JOB,
} from '../src/modules/orchestrator/approvals.ts';
import { COMMAND_ACTION } from '../src/modules/orchestrator/approval-kinds.ts';
import { acquireUserLock, releaseUserLock } from '../src/modules/orchestrator/lock.ts';
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
  type Delivery,
  type SentTelegram,
} from './fakes.ts';
import { call, chatUser, createUser, expectContract, finishedJob, waitFor } from './helpers.ts';

let workers: Worker[];
let vm: ReturnType<typeof installFakeVm>;
let composio: Awaited<ReturnType<typeof installFakeComposio>>;
let tg: { sent: SentTelegram[] };
/** The approval-answer turns Tex got, by approval id, with what its run_app_action call gave. */
let answers: Map<string, { delivery: Delivery; call: { isError?: boolean; text: string } }>;

const MERGE = 'GITHUB_MERGE_A_PULL_REQUEST';
const MERGE_ARGS = { owner: 'rahulcoder9417', repo: 'code-smith', pull_number: 7 };

beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(async () => {
  answers = new Map();
  tg = installFakeTelegram();
  composio = await installFakeComposio();
  // Tex after the yes: does what the old flow told it (run_app_action with the approval id).
  vm = installFakeVm(async (d, mcp) => {
    if (d.kind !== DeliverKind.APPROVAL_ANSWER || !d.approved) return;
    const r = await mcp('run_app_action', { action: MERGE, approval_id: d.approvalId });
    answers.set(d.approvalId, { delivery: d, call: r });
  });
});

/** A user with GitHub connected, a container, and Tex's tools. */
async function githubUser(opts: { credits?: number } = {}) {
  const user = opts.credits === 0 ? await createUser() : await chatUser();
  await db()
    .insert(connections)
    .values({
      id: newId('con'),
      userId: user.id,
      app: 'github',
      composioAccountId: `ca_${randomUUID()}`,
      status: 'active',
    });
  await ensureSandbox(user.id);
  const token = vm.tokens.get(user.id)!;
  const mcp = (tool: string, args: Record<string, unknown>) => mcpCall(token, tool, args);
  const ask = async (sessionKey = 'web') => {
    const r = await mcp('request_approval', {
      summary: 'Merge pull request #7 in code-smith',
      action: MERGE,
      arguments: MERGE_ARGS,
      session_key: sessionKey,
    });
    expect(r.isError).toBeFalsy();
    return (JSON.parse(r.text) as { approval_id: string }).approval_id;
  };
  return { ...user, mcp, ask };
}

const approvalRow = async (id: string) =>
  (await db().select().from(approvals).where(eq(approvals.id, id)))[0]!;
const merges = () => composio.executed.filter((e) => e.slug === MERGE);
const approveOnWeb = async (token: string, id: string) =>
  expectContract(
    'decideApproval',
    await call(`/v1/approvals/${id}/decision`, {
      method: 'POST',
      token,
      body: { decision: 'approve' },
    }),
    200,
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('an approved app action runs at once', () => {
  it('runs once at the yes, without a Tex turn; Tex is then told it is done, with the result', async () => {
    const u = await githubUser();
    composio.state.executeData.set(MERGE, { merged: true, sha: 'abc123' });
    const id = await u.ask();
    // Tex is busy with another message: no turn can start until it is done.
    const lock = (await acquireUserLock(u.id))!;
    try {
      await approveOnWeb(u.token, id);
      await waitFor(async () => merges().length > 0);
      expect(merges()).toHaveLength(1);
      expect(merges()[0]).toMatchObject({ userId: u.id, arguments: MERGE_ARGS });
      const ran = await waitFor(async () => {
        const a = await approvalRow(id);
        return a.runResult?.state === 'done' ? a : null;
      });
      expect(ran.usedAt).not.toBeNull();
      expect(ran.runResult).toMatchObject({ data: { merged: true, sha: 'abc123' } });
      // No turn has run: the action did not wait for Tex.
      await sleep(300);
      expect(vm.deliveries.filter((d) => d.kind === DeliverKind.APPROVAL_ANSWER)).toHaveLength(0);
    } finally {
      await releaseUserLock(u.id, lock);
    }

    // Then Tex's turn: approved AND done, with the result; its call gets that result.
    const answer = await waitFor(async () => answers.get(id));
    expect(answer.delivery.text).toContain('The user APPROVED: Merge pull request #7');
    expect(answer.delivery.text).toContain(`It is DONE: Textcrew ran ${MERGE}`);
    expect(answer.delivery.text).toContain('"sha":"abc123"');
    expect(answer.delivery.text).toContain("Don't run it again");
    expect(JSON.parse(answer.call.text)).toMatchObject({
      ok: true,
      already_done: true,
      credits_charged: 0,
      data: { merged: true, sha: 'abc123' },
    });
    expect(merges()).toHaveLength(1);

    // The activity log has the run once, charged once; Tex's look at the result costs nothing.
    const runs = await waitFor(async () => {
      const rows = (await db().select().from(auditLog).where(eq(auditLog.userId, u.id))).filter(
        (r) => r.action === 'run_app_action',
      );
      return rows.length === 2 ? rows : null;
    });
    expect(runs.map((r) => [r.summary, r.creditsCharged]).sort()).toEqual([
      [`Ran ${MERGE} (approved)`, 1],
      [`Result of ${MERGE} (it ran when the user approved)`, 0],
    ]);
    const log = await db().select().from(auditLog).where(eq(auditLog.userId, u.id));
    expect(log.some((r) => r.action === 'approval_decided')).toBe(true);
  });

  it('a tap on Telegram runs it while Tex is busy: the tap does not wait for the lock', async () => {
    const u = await githubUser();
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
    const id = await u.ask(`telegram:${chatId}`);
    const asked = await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(chatId) && m.buttons),
    );
    expect(asked.buttons![0]!.callback_data).toBe(`apr:${id}:yes`);

    const lock = (await acquireUserLock(u.id))!;
    try {
      const tap = telegramButton(chatId, `apr:${id}:yes`);
      expect((await tgPost(tap)).status).toBe(200);
      await waitFor(async () => merges().length > 0);
      const a = await approvalRow(id);
      expect(a).toMatchObject({ status: 'approved', decidedVia: 'telegram:button' });
      const event = await findEvent('telegram', String(tap.update_id));
      expect(event).toMatchObject({ queue: 'system', jobName: 'approval-button' });
    } finally {
      await releaseUserLock(u.id, lock);
    }
    await waitFor(async () => answers.get(id));
    expect(merges()).toHaveLength(1);
  });

  it('is safe to run again: a second job, a second turn or Tex never run it twice', async () => {
    const u = await githubUser();
    const id = await u.ask();
    const lock = (await acquireUserLock(u.id))!;
    try {
      await decideApproval(u.id, id, true, 'web');
      // The job again (another id), the turn's own settle and two more at the same moment.
      await addJob('system', RUN_APPROVED_JOB, { approvalId: id, userId: u.id });
      const runs = await Promise.all([
        settleApprovedRun(u.id, id, { waitMs: 20_000 }),
        settleApprovedRun(u.id, id, { waitMs: 20_000 }),
        settleApprovedRun(u.id, id, { waitMs: 20_000 }),
      ]);
      expect(runs.map((r) => r?.state)).toEqual(['done', 'done', 'done']);
      await sleep(300);
      expect(merges()).toHaveLength(1);
    } finally {
      await releaseUserLock(u.id, lock);
    }
    await waitFor(async () => answers.get(id));
    const again = await u.mcp('run_app_action', { action: MERGE, approval_id: id });
    expect(JSON.parse(again.text)).toMatchObject({ already_done: true });
    // Other arguments with the same approval are refused, and run nothing.
    const other = await u.mcp('run_app_action', {
      action: MERGE,
      approval_id: id,
      arguments: { ...MERGE_ARGS, pull_number: 8 },
    });
    expect(other.isError).toBe(true);
    expect(other.text).toContain('were not used');
    expect(merges()).toHaveLength(1);
  });

  it('a failure is told to Tex in the same turn, never retried by itself; Tex may try once more', async () => {
    const u = await githubUser();
    const id = await u.ask();
    composio.state.executeFailure = 'Pull request is not mergeable';
    await decideApproval(u.id, id, true, 'web');
    const answer = await waitFor(async () => answers.get(id));
    expect(answer.delivery.text).toContain('did not go through, so nothing was done');
    expect(answer.delivery.text).toContain('Pull request is not mergeable');
    expect(answer.delivery.text).toContain(`replaces_approval_id "${id}"`);
    // The job did not try again by itself; the approval was handed back for one more try, which
    // Tex made (the fake follows the old flow) and which went through.
    expect(JSON.parse(answer.call.text)).toMatchObject({ ok: true });
    expect(merges()).toHaveLength(1);
    const { job, state } = await finishedJob(queue('system'), `apr-run-${id}`);
    expect(state).toBe('completed');
    expect(job.attemptsMade).toBe(1);
  });

  it('out of credits: nothing runs, and Tex is told why', async () => {
    const u = await githubUser({ credits: 0 });
    const id = await u.ask();
    await decideApproval(u.id, id, true, 'web');
    const a = await waitFor(async () => {
      const row = await approvalRow(id);
      return row.runResult?.state === 'failed' ? row : null;
    });
    expect(a.usedAt).toBeNull();
    const text = approvedRunText(a, a.runResult!);
    expect(text).toContain('out of credits');
    expect(text).toContain('nothing was done');
    expect(merges()).toHaveLength(0);
  });

  it('the answer and its event are one step: queued before the decision request returns', async () => {
    const u = await githubUser();
    const id = await u.ask();
    const lock = (await acquireUserLock(u.id))!;
    try {
      await approveOnWeb(u.token, id);
      // Saved with the answer, its job already added: a message sent now comes after it.
      const event = await findEvent('approval', id);
      expect(event).toMatchObject({ type: 'approved', queue: 'inbound', userId: u.id });
      expect(await queue('inbound').getJob(event!.id)).toBeTruthy();
      expect(await queue('system').getJob(`apr-run-${id}`)).toBeTruthy();
    } finally {
      await releaseUserLock(u.id, lock);
    }
    await waitFor(async () => answers.get(id));
  });

  it('a stale run is never run again, and Tex is told the result did not come back', async () => {
    const u = await githubUser();
    const id = await u.ask();
    const long = new Date(Date.now() - 10 * 60_000);
    await db()
      .update(approvals)
      .set({
        status: 'approved',
        decidedAt: new Date(),
        usedAt: long,
        runResult: { state: 'running', at: long.toISOString() },
      })
      .where(eq(approvals.id, id));
    const run = await settleApprovedRun(u.id, id, { waitMs: 20_000 });
    expect(run).toMatchObject({ state: 'running' });
    expect(approvedRunText(await approvalRow(id), run!)).toContain('has not come back');
    const r = await u.mcp('run_app_action', { action: MERGE, approval_id: id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Don't run it again");
    expect(merges()).toHaveLength(0);
  });
});

describe('what still goes through Tex', () => {
  it("the platform's own kinds and a step of an automation's run are not run by the platform", async () => {
    const app = { app: 'github', action: MERGE, arguments: MERGE_ARGS };
    expect(runsWhenApproved({ ...app, automationRunId: null })).toBe(true);
    expect(runsWhenApproved({ ...app, automationRunId: 'run_1' })).toBe(false);
    expect(runsWhenApproved({ ...app, app: null, automationRunId: null })).toBe(false);
    expect(
      runsWhenApproved({
        app: null,
        action: COMMAND_ACTION,
        arguments: { tool: 'Bash', target: 'curl x' },
        automationRunId: null,
      }),
    ).toBe(false);
    expect(runsWhenApproved({ ...app, action: 'TEXTCREW_GIT_PUSH', automationRunId: null })).toBe(
      false,
    );
  });

  it('a command approval is answered as before: Tex makes the same call again', async () => {
    vm = installFakeVm(async (d) => {
      if (d.kind === DeliverKind.APPROVAL_ANSWER)
        answers.set(d.approvalId, { delivery: d, call: { text: '' } });
    });
    const u = await githubUser();
    const a = await requestApproval({
      userId: u.id,
      sessionKey: 'web',
      summary: 'Run this command: curl https://example.com',
      action: COMMAND_ACTION,
      arguments: { tool: 'Bash', target: 'curl https://example.com' },
    });
    await decideApproval(u.id, a.id, true, 'web');
    const answer = await waitFor(async () => answers.get(a.id));
    expect(answer.delivery.text).toContain('Go ahead: make exactly the same command again');
    expect(await queue('system').getJob(`apr-run-${a.id}`)).toBeFalsy();
    expect((await approvalRow(a.id)).runResult).toBeNull();
  });

  it('only a tap on an approval button skips the lock; messages and other buttons keep their order', () => {
    const tap = telegramButton(1, 'apr:apr_01abc:yes') as unknown as Record<string, unknown>;
    expect(inboundJobOf('telegram', tap)).toEqual({ queue: 'system', jobName: 'approval-button' });
    const save = telegramButton(1, 'drf:drf_01abc:save') as unknown as Record<string, unknown>;
    expect(inboundJobOf('telegram', save)).toEqual({
      queue: 'inbound',
      jobName: 'process-message',
    });
    const text = telegramUpdate(1, 'apr:apr_01abc:yes') as unknown as Record<string, unknown>;
    expect(inboundJobOf('telegram', text)).toEqual({
      queue: 'inbound',
      jobName: 'process-message',
    });
  });
});
