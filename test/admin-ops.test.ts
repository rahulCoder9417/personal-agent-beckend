// Admin operations: the job queues (list, count, retry, remove), the audit log of every user, the
// turn timings summary, the settings page and the health page. Admin only, paged, and never a
// secret in an answer (tested with planted fake secrets).
import { randomUUID } from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { audit } from '../src/modules/admin/audit.ts';
import { SECRETS, SETTINGS } from '../src/modules/admin/config-view.ts';
import { redactDetails, scrubText, summarizeJobData } from '../src/modules/admin/redact.ts';
import { closeQueues, queue, type QueueName } from '../src/modules/events/queues.ts';
import { turnTimings } from '../src/modules/orchestrator/schema.ts';
import { percentile, summarizeTimings } from '../src/modules/orchestrator/timings-summary.ts';
import type { TurnTimingRow } from '../src/modules/orchestrator/timings.ts';
import { SandboxState, setVmClient, type VmClient } from '../src/modules/orchestrator/vm.ts';
import { configSchema, resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { createRedis } from '../src/shared/redis.ts';
import { call, createUser, expectContract, waitFor } from './helpers.ts';

type Admin = Awaited<ReturnType<typeof createUser>>;
let admin: Admin;
let user: Admin;

beforeAll(async () => {
  admin = await createUser({ role: 'admin' });
  user = await createUser();
});
afterAll(closeQueues);

/** Planted fake secrets: none of these may ever appear in an answer. */
const PLANTED = {
  text: 'Hi, my bank PIN is 4711 and this is private',
  token: 'tok_PLANTED_9f8e7d6c5b4a39281706f5e4d3c2b1a0',
  apiKey: 'sk-ant-PLANTEDplanted0123456789abcdef',
  botToken: '123456789:AAPlantedTelegramBotTokenValue_abcdefghij',
  password: 'hunter2-planted-pw',
  code: '918273',
};

function expectNoPlanted(body: unknown) {
  const text = JSON.stringify(body);
  for (const v of Object.values(PLANTED)) expect(text).not.toContain(v);
}

const ADMIN_OPS: Array<{ op: string; path: string; method?: string; body?: unknown }> = [
  { op: 'adminListJobs', path: '/v1/admin/jobs' },
  { op: 'adminJobCounts', path: '/v1/admin/jobs/counts' },
  {
    op: 'adminRetryJob',
    path: '/v1/admin/jobs/system/x/retry',
    method: 'POST',
    body: { reason: 'r' },
  },
  {
    op: 'adminRemoveJob',
    path: '/v1/admin/jobs/system/x',
    method: 'DELETE',
    body: { reason: 'r' },
  },
  { op: 'adminListAudit', path: '/v1/admin/audit' },
  { op: 'adminTimingsSummary', path: '/v1/admin/timings/summary' },
  { op: 'adminGetConfig', path: '/v1/admin/config' },
  { op: 'adminGetHealth', path: '/v1/admin/health' },
];

describe('admin only', () => {
  it('every operation answers 401 without a session and 403 to a user who is not an admin', async () => {
    for (const { op, path, method, body } of ADMIN_OPS) {
      const init = { ...(method ? { method } : {}), ...(body ? { body } : {}) };
      await expectContract(op, await call(path, init), 401);
      const res = await expectContract<{ error: { message: string } }>(
        op,
        await call(path, { ...init, token: user.token }),
        403,
      );
      expect(res.error.message).toBe('Admins only');
    }
  });
});

// --- jobs -------------------------------------------------------------------------------------------

type AdminJob = {
  id: string;
  queue: QueueName;
  name: string;
  state: string;
  attempts: number;
  data: Record<string, unknown>;
  omittedKeys: string[];
  failedReason: string | null;
  userId: string | null;
  dueAt: string | null;
};
type JobPage = { items: AdminJob[]; nextCursor: string | null };

const jobData = (extra: Record<string, unknown> = {}) => ({
  userId: user.id,
  eventId: `evt_${randomUUID().replaceAll('-', '').slice(0, 26)}`,
  text: PLANTED.text,
  token: PLANTED.token,
  apiKey: PLANTED.apiKey,
  buttons: [{ id: 'b1', label: PLANTED.password }],
  ...extra,
});

describe('jobs', () => {
  let worker: Worker;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  let failedId: string;
  let completedId: string;
  let activeId: string;

  async function stateOf(q: QueueName, id: string) {
    return (await queue(q).getJob(id))?.getState();
  }

  beforeAll(async () => {
    worker = new Worker(
      'system',
      async (job: Job) => {
        if (job.name === 'boom')
          throw new Error(
            `fetch failed: https://api.telegram.org/bot${PLANTED.botToken}/sendMessage token=${PLANTED.token}\nstack line with ${PLANTED.password}`,
          );
        if (job.name === 'hold') await held;
        return null;
      },
      { connection: createRedis(), prefix: process.env.QUEUE_PREFIX!, concurrency: 5 },
    );
    const boom = await queue('system').add('boom', jobData(), { attempts: 1 });
    const ok = await queue('system').add('fine', jobData({ messageId: 'msg_1' }), { attempts: 1 });
    const hold = await queue('system').add('hold', jobData(), { attempts: 1 });
    failedId = boom.id!;
    completedId = ok.id!;
    activeId = hold.id!;
    await waitFor(async () => (await stateOf('system', failedId)) === 'failed');
    await waitFor(async () => (await stateOf('system', completedId)) === 'completed');
    await waitFor(async () => (await stateOf('system', activeId)) === 'active');
  });

  afterAll(async () => {
    release();
    await worker.close();
  });

  it('lists failed jobs with ids only, the error scrubbed, and no planted secret', async () => {
    const page = await expectContract<JobPage>(
      'adminListJobs',
      await call('/v1/admin/jobs?queue=system&state=failed', { token: admin.token }),
      200,
    );
    const job = page.items.find((j) => j.id === failedId)!;
    expect(job).toMatchObject({ queue: 'system', name: 'boom', state: 'failed', attempts: 1 });
    expect(job.userId).toBe(user.id);
    expect(Object.keys(job.data).sort()).toEqual(['eventId', 'userId']);
    expect(job.omittedKeys.sort()).toEqual(['apiKey', 'buttons', 'text', 'token']);
    expect(job.failedReason).toContain('fetch failed');
    expect(job.failedReason).toContain('[redacted]');
    expect(job.failedReason).not.toContain('stack line');
    expectNoPlanted(page);
  });

  it('shows completed, active, waiting (with priority) and delayed jobs', async () => {
    const completed = await expectContract<JobPage>(
      'adminListJobs',
      await call('/v1/admin/jobs?queue=system&state=completed&limit=100', { token: admin.token }),
      200,
    );
    expect(completed.items.find((j) => j.id === completedId)?.data).toEqual({
      userId: user.id,
      eventId: expect.any(String),
      messageId: 'msg_1',
    });
    const active = await expectContract<JobPage>(
      'adminListJobs',
      await call('/v1/admin/jobs?state=active', { token: admin.token }),
      200,
    );
    expect(active.items.map((j) => j.id)).toContain(activeId);

    const plain = await queue('outbound').add('send-raw', jobData());
    const paid = await queue('outbound').add('send-raw', jobData(), { priority: 1 });
    const later = await queue('outbound').add('send-raw', jobData(), { delay: 60_000 });
    const waiting = await expectContract<JobPage>(
      'adminListJobs',
      await call('/v1/admin/jobs?queue=outbound&state=waiting&limit=100', { token: admin.token }),
      200,
    );
    expect(waiting.items.map((j) => j.id)).toEqual(expect.arrayContaining([plain.id, paid.id]));
    expect(waiting.items.every((j) => j.state === 'waiting')).toBe(true);
    const delayed = await expectContract<JobPage>(
      'adminListJobs',
      await call('/v1/admin/jobs?queue=outbound&state=delayed', { token: admin.token }),
      200,
    );
    const due = Date.parse(delayed.items.find((j) => j.id === later.id)!.dueAt!);
    expect(Math.abs(due - (later.timestamp + 60_000))).toBeLessThan(5_000);
    expectNoPlanted([waiting, delayed, completed, active]);

    const counts = await expectContract<{
      queues: Array<{ queue: string; waiting: number; delayed: number; failed: number }>;
    }>('adminJobCounts', await call('/v1/admin/jobs/counts', { token: admin.token }), 200);
    const outbound = counts.queues.find((q) => q.queue === 'outbound')!;
    expect(outbound.waiting).toBeGreaterThanOrEqual(2);
    expect(outbound.delayed).toBeGreaterThanOrEqual(1);
    expect(counts.queues.find((q) => q.queue === 'system')!.failed).toBeGreaterThanOrEqual(1);
    expect(counts.queues.map((q) => q.queue)).toEqual([
      'inbound',
      'outbound',
      'scheduled',
      'system',
    ]);
  });

  it('pages through one queue, and through all four as one list, without repeats', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push((await queue('scheduled').add('run-automation', { automationId: `aut_${i}` })).id!);
    ids.push((await queue('inbound').add('process-message', jobData(), { priority: 3 })).id!);

    async function all(query: string) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 50; page++) {
        const res: JobPage = await expectContract<JobPage>(
          'adminListJobs',
          await call(`/v1/admin/jobs?${query}&limit=2${cursor ? `&cursor=${cursor}` : ''}`, {
            token: admin.token,
          }),
          200,
        );
        expect(res.items.length).toBeLessThanOrEqual(2);
        seen.push(...res.items.map((j) => `${j.queue}/${j.id}`));
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      return seen;
    }
    const scheduled = await all('queue=scheduled&state=waiting');
    expect(scheduled).toHaveLength(5);
    expect(new Set(scheduled).size).toBe(5);
    // Newest first.
    expect(scheduled[0]).toBe(`scheduled/${ids[4]}`);

    const everywhere = await all('state=waiting');
    expect(new Set(everywhere).size).toBe(everywhere.length);
    expect(everywhere).toEqual(
      expect.arrayContaining([
        ...ids.slice(0, 5).map((id) => `scheduled/${id}`),
        `inbound/${ids[5]}`,
      ]),
    );
    const counts = (
      await expectContract<{ queues: Array<{ waiting: number }> }>(
        'adminJobCounts',
        await call('/v1/admin/jobs/counts', { token: admin.token }),
        200,
      )
    ).queues.reduce((n, q) => n + q.waiting, 0);
    expect(everywhere).toHaveLength(counts);

    await expectContract(
      'adminListJobs',
      await call('/v1/admin/jobs?cursor=abc', { token: admin.token }),
      400,
    );
    await expectContract(
      'adminListJobs',
      await call('/v1/admin/jobs?state=stuck', { token: admin.token }),
      400,
    );
  });

  it('retries only a failed job, once more, with a reason, and audits it', async () => {
    const path = `/v1/admin/jobs/system/${failedId}/retry`;
    await expectContract(
      'adminRetryJob',
      await call(path, { method: 'POST', token: admin.token }),
      400,
    );
    await expectContract(
      'adminRetryJob',
      await call(path, { method: 'POST', token: admin.token, body: { reason: '   ' } }),
      400,
    );
    // Not an admin: nothing happens.
    await expectContract(
      'adminRetryJob',
      await call(path, { method: 'POST', token: user.token, body: { reason: 'x' } }),
      403,
    );
    expect(await stateOf('system', failedId)).toBe('failed');

    await expectContract(
      'adminRetryJob',
      await call(path, {
        method: 'POST',
        token: admin.token,
        body: { reason: 'Telegram was down; try again' },
      }),
      204,
    );
    // It ran once more (the handler fails again here): one more try, nothing else.
    await waitFor(async () => (await queue('system').getJob(failedId))?.attemptsMade === 2);
    await waitFor(async () => (await stateOf('system', failedId)) === 'failed');

    const entries = await expectContract<{ items: Array<Record<string, unknown>> }>(
      'adminListAudit',
      await call('/v1/admin/audit?action=job_retried', { token: admin.token }),
      200,
    );
    expect(entries.items[0]).toMatchObject({
      userId: user.id,
      actor: 'admin',
      action: 'job_retried',
      details: {
        adminId: admin.id,
        queue: 'system',
        jobId: failedId,
        jobName: 'boom',
        reason: 'Telegram was down; try again',
      },
    });

    // Never a running, finished, waiting or missing job.
    for (const [id, status] of [
      [activeId, 409],
      [completedId, 409],
      ['no-such-job', 404],
    ] as const)
      await expectContract(
        'adminRetryJob',
        await call(`/v1/admin/jobs/system/${id}/retry`, {
          method: 'POST',
          token: admin.token,
          body: { reason: 'x' },
        }),
        status,
      );
    const waitingJob = await queue('outbound').add('send-raw', { userId: user.id });
    await expectContract(
      'adminRetryJob',
      await call(`/v1/admin/jobs/outbound/${waitingJob.id}/retry`, {
        method: 'POST',
        token: admin.token,
        body: { reason: 'x' },
      }),
      409,
    );
    expect(await stateOf('system', activeId)).toBe('active');
  });

  it('removes only a failed or completed job, never an active, waiting or delayed one', async () => {
    const del = (q: string, id: string, body: unknown = { reason: 'clean up after the test' }) =>
      call(`/v1/admin/jobs/${q}/${id}`, { method: 'DELETE', token: admin.token, body });

    await expectContract('adminRemoveJob', await del('system', activeId), 409);
    expect(await stateOf('system', activeId)).toBe('active');
    const waitingJob = await queue('outbound').add('send-raw', { userId: user.id });
    await expectContract('adminRemoveJob', await del('outbound', waitingJob.id!), 409);
    const delayedJob = await queue('outbound').add('send-raw', {}, { delay: 60_000 });
    await expectContract('adminRemoveJob', await del('outbound', delayedJob.id!), 409);
    expect(await queue('outbound').getJob(waitingJob.id!)).toBeTruthy();
    expect(await queue('outbound').getJob(delayedJob.id!)).toBeTruthy();
    await expectContract('adminRemoveJob', await del('system', completedId, {}), 400);
    await expectContract('adminRemoveJob', await del('system', 'no-such-job'), 404);
    await expectContract(
      'adminRemoveJob',
      await call(`/v1/admin/jobs/system/${completedId}`, {
        method: 'DELETE',
        token: user.token,
        body: { reason: 'x' },
      }),
      403,
    );

    await expectContract('adminRemoveJob', await del('system', completedId), 204);
    expect(await queue('system').getJob(completedId)).toBeUndefined();
    const failed = await queue('system').add('boom', jobData(), { attempts: 1 });
    await waitFor(async () => (await stateOf('system', failed.id!)) === 'failed');
    await expectContract('adminRemoveJob', await del('system', failed.id!), 204);
    expect(await queue('system').getJob(failed.id!)).toBeUndefined();

    const entries = await expectContract<{ items: Array<Record<string, unknown>> }>(
      'adminListAudit',
      await call('/v1/admin/audit?action=job_removed&actor=admin', { token: admin.token }),
      200,
    );
    expect(entries.items.map((e) => (e.details as { jobId: string }).jobId)).toEqual([
      failed.id,
      completedId,
    ]);
    expect(entries.items[0]!.details).toMatchObject({
      adminId: admin.id,
      reason: 'clean up after the test',
    });
  });
});

// --- audit log ----------------------------------------------------------------------------------------

describe('audit log', () => {
  it('lists every user, newest first, filtered and paged, with secrets removed', async () => {
    const other = await createUser();
    const before = new Date(Date.now() - 1000);
    await audit({
      userId: other.id,
      actor: 'agent',
      action: 'run_app_action',
      summary: `GMAIL_SEND_EMAIL with Bearer ${PLANTED.token}`,
      details: {
        args: {
          to: 'a@example.com',
          apiKey: PLANTED.apiKey,
          nested: { password: PLANTED.password, list: [{ authToken: PLANTED.token }] },
          note: `use key=${PLANTED.botToken}`,
        },
        code: PLANTED.code,
        idempotencyKey: 'idem-1',
      },
      creditsCharged: 1,
    });
    await audit({ userId: other.id, actor: 'user', action: 'chat_started', summary: 'Chat 1' });
    await audit({ userId: user.id, actor: 'system', action: 'browser_enabled', summary: 'on' });
    await audit({ userId: null, actor: 'system', action: 'health', summary: 'ok' });

    const mine = await expectContract<{
      items: Array<{ action: string; details: Record<string, unknown> | null; summary: string }>;
      nextCursor: string | null;
    }>(
      'adminListAudit',
      await call(`/v1/admin/audit?userId=${other.id}`, { token: admin.token }),
      200,
    );
    expect(mine.items.map((e) => e.action)).toEqual(['chat_started', 'run_app_action']);
    const action = mine.items[1]!;
    expect(action.details).toEqual({
      args: {
        to: 'a@example.com',
        apiKey: '[redacted]',
        nested: { password: '[redacted]', list: [{ authToken: '[redacted]' }] },
        note: 'use key=[redacted]',
      },
      code: '[redacted]',
      idempotencyKey: 'idem-1',
    });
    expect(action.summary).toBe('GMAIL_SEND_EMAIL with Bearer [redacted]');
    expectNoPlanted(mine);

    const agentOnly = await expectContract<{ items: Array<{ actor: string }> }>(
      'adminListAudit',
      await call(`/v1/admin/audit?actor=agent&userId=${other.id}`, { token: admin.token }),
      200,
    );
    expect(agentOnly.items).toHaveLength(1);

    // Time window, and pages of 2, newest first, every entry once.
    const from = encodeURIComponent(before.toISOString());
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page: { items: Array<{ id: string; createdAt: string }>; nextCursor: string | null } =
        await expectContract(
          'adminListAudit',
          await call(`/v1/admin/audit?from=${from}&limit=2${cursor ? `&cursor=${cursor}` : ''}`, {
            token: admin.token,
          }),
          200,
        );
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort().reverse()).toEqual(seen);

    const none = await expectContract<{ items: unknown[] }>(
      'adminListAudit',
      await call(
        `/v1/admin/audit?to=${encodeURIComponent(before.toISOString())}&userId=${other.id}`,
        {
          token: admin.token,
        },
      ),
      200,
    );
    expect(none.items).toHaveLength(0);
    await expectContract(
      'adminListAudit',
      await call('/v1/admin/audit?actor=robot', { token: admin.token }),
      400,
    );
    await expectContract(
      'adminListAudit',
      await call('/v1/admin/audit?from=yesterday', { token: admin.token }),
      400,
    );
  });
});

// --- redaction ------------------------------------------------------------------------------------------

describe('redaction', () => {
  it('hides secrets in text and keeps ordinary words and ids', () => {
    expect(scrubText('postgres://agent:s3cret@db:5432/agent')).toBe(
      'postgres://[redacted]@db:5432/agent',
    );
    expect(scrubText(`https://api.telegram.org/bot${PLANTED.botToken}/getMe`)).toBe(
      'https://api.telegram.org/bot[redacted]/getMe',
    );
    expect(scrubText(`Authorization: Bearer ${PLANTED.token}`)).not.toContain(PLANTED.token);
    expect(scrubText(`key ${PLANTED.apiKey} refused`)).toBe('key [redacted] refused');
    expect(scrubText('whsec_abcdefghijklmnop and ghp_abcdefghijklmnopqrstuvwx')).toBe(
      '[redacted] and [redacted]',
    );
    expect(scrubText('https://x.test/cb?code=abc123&state=xyz&ok=1')).toBe(
      'https://x.test/cb?code=[redacted]&state=[redacted]&ok=1',
    );
    expect(scrubText('{"password":"hunter2","user":"bob"}')).toBe(
      '{"password":"[redacted]","user":"bob"}',
    );
    const ordinary =
      'Job evt_01jz3m8q4kd2v7x9w0t5b6c8ya failed: connect ECONNREFUSED 10.0.0.5:9090';
    expect(scrubText(ordinary)).toBe(ordinary);
    expect(redactDetails({ a: [{ secretValue: 1 }], sessionKey: 'telegram:1' })).toEqual({
      a: [{ secretValue: '[redacted]' }],
      sessionKey: '[redacted]',
    });
  });

  it('job data keeps ids only', () => {
    expect(
      summarizeJobData({
        userId: 'usr_1',
        connectionId: 'con_1',
        tokenId: 'tok_1',
        ids: ['a', 'b'],
        messageIds: ['msg_1', 'msg_2'],
        externalChatId: 12345,
        automationId: 'has spaces so not an id',
        text: 'hello',
        run: 2,
      }),
    ).toEqual({
      data: {
        userId: 'usr_1',
        connectionId: 'con_1',
        messageIds: ['msg_1', 'msg_2'],
        externalChatId: 12345,
      },
      omittedKeys: ['tokenId', 'ids', 'automationId', 'text', 'run'],
      userId: 'usr_1',
    });
  });
});

// --- timings ----------------------------------------------------------------------------------------------

/** A task turn whose every stage time is `k` times the base turn's. */
function taskRow(
  k: number,
  wake: 'cold' | 'warm',
  engine: 'hermes' | 'claude_code',
): TurnTimingRow {
  const base: Record<string, number> = {
    queued: 0,
    picked_up: 100,
    turn_started: 150,
    wake_started: 160,
    routed: 650,
    woken: 2650,
    deliver_sent: 2700,
    accepted: 2800,
    engine_ready: 3800,
    first_text: 5800,
    engine_done: 9800,
    answer_sent: 10000,
    turn_done: 10100,
  };
  return {
    deliveryId: `evt_task_${k}_${randomUUID().slice(0, 8)}`,
    userId: user.id,
    kind: 'message',
    channel: 'web',
    route: 'task',
    engine,
    wake,
    outcome: 'done',
    attempt: 1,
    startedAt: new Date(Date.now() - 3600_000 * k),
    stages: Object.fromEntries(Object.entries(base).map(([s, ms]) => [s, ms * k])),
    details: {},
    createdAt: new Date(),
  };
}

function simpleRow(): TurnTimingRow {
  return {
    ...taskRow(1, 'warm', 'hermes'),
    deliveryId: `evt_simple_${randomUUID().slice(0, 8)}`,
    route: 'simple',
    engine: null,
    wake: null,
    outcome: 'simple',
    stages: { queued: 0, picked_up: 10, turn_started: 20, routed: 520, answered: 1520 },
  };
}

const sampleRows = () => [
  taskRow(1, 'cold', 'claude_code'),
  taskRow(2, 'cold', 'claude_code'),
  taskRow(3, 'warm', 'hermes'),
  taskRow(4, 'warm', 'hermes'),
  simpleRow(),
];

describe('timings summary', () => {
  it('percentiles read between the two nearest values', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(3); // 2.5, rounded
    expect(percentile([100, 200, 300, 400], 0.9)).toBe(370);
    expect(percentile([10, 100, 200, 300, 400], 0.5)).toBe(200);
  });

  it('works out each stage, the routes and engines, and the slowest turns', () => {
    const s = summarizeTimings(sampleRows(), 7, new Date('2026-10-07T00:00:00Z'));
    const stage = (name: string) => s.stages.find((x) => x.stage === name);
    expect(s.turns).toBe(5);
    // queue: 10, 100, 200, 300, 400
    expect(stage('queue')).toEqual({ stage: 'queue', count: 5, p50Ms: 200, p90Ms: 360 });
    // wake, split by kind: cold 2000, 4000; warm 6000, 8000
    expect(stage('wake cold')).toEqual({ stage: 'wake cold', count: 2, p50Ms: 3000, p90Ms: 3800 });
    expect(stage('wake warm')).toEqual({ stage: 'wake warm', count: 2, p50Ms: 7000, p90Ms: 7800 });
    // engine start 1000·k, first output 2000·k, work 4000·k, send answer 200·k
    expect(stage('engine start')).toEqual({
      stage: 'engine start',
      count: 4,
      p50Ms: 2500,
      p90Ms: 3700,
    });
    expect(stage('first output')!.p50Ms).toBe(5000);
    expect(stage('work')).toEqual({ stage: 'work', count: 4, p50Ms: 10000, p90Ms: 14800 });
    expect(stage('send answer')!.p90Ms).toBe(740);
    expect(stage('reply')).toEqual({ stage: 'reply', count: 1, p50Ms: 1000, p90Ms: 1000 });
    // total: 1520, 10000, 20000, 30000, 40000
    expect(stage('total')).toEqual({ stage: 'total', count: 5, p50Ms: 20000, p90Ms: 36000 });
    // In the order a turn passes them.
    expect(s.stages.map((x) => x.stage)).toEqual([
      'queue',
      'prepare',
      'route',
      'reply',
      'wake warm',
      'wake cold',
      'context',
      'handover',
      'engine start',
      'first output',
      'work',
      'send answer',
      'wrap up',
      'total',
    ]);
    expect(s.routes).toEqual([
      { name: 'task', count: 4 },
      { name: 'simple', count: 1 },
    ]);
    expect(s.engines).toEqual([
      { name: 'claude_code', count: 2 },
      { name: 'hermes', count: 2 },
      { name: 'none', count: 1 },
    ]);
    expect(s.slowest.map((t) => t.totalMs)).toEqual([40000, 30000, 20000, 10000, 1520]);
    expect(s.slowest[0]).toMatchObject({
      biggestStage: 'work',
      biggestStageMs: 16000,
      wake: 'warm',
    });
    expect(s.slowest[4]).toMatchObject({
      biggestStage: 'reply',
      biggestStageMs: 1000,
      route: 'simple',
    });
  });

  it('keeps the 20 slowest turns only', () => {
    const rows = Array.from({ length: 25 }, (_, i) => taskRow(i + 1, 'warm', 'hermes'));
    const s = summarizeTimings(rows, 7, new Date());
    expect(s.slowest).toHaveLength(20);
    expect(s.slowest[0]!.totalMs).toBe(250_000);
    expect(s.slowest[19]!.totalMs).toBe(60_000);
  });

  it('reads the last days from turn_timings', async () => {
    const rows = sampleRows();
    const old = {
      ...taskRow(1, 'cold', 'hermes'),
      startedAt: new Date(Date.now() - 10 * 86_400_000),
    };
    await db()
      .insert(turnTimings)
      .values([...rows, old]);
    const week = await expectContract<{ turns: number; days: number; slowest: unknown[] }>(
      'adminTimingsSummary',
      await call('/v1/admin/timings/summary', { token: admin.token }),
      200,
    );
    expect(week.days).toBe(7);
    expect(week.turns).toBe(5);
    const month = await expectContract<{ turns: number }>(
      'adminTimingsSummary',
      await call('/v1/admin/timings/summary?days=30', { token: admin.token }),
      200,
    );
    expect(month.turns).toBe(6);
    await expectContract(
      'adminTimingsSummary',
      await call('/v1/admin/timings/summary?days=31', { token: admin.token }),
      400,
    );
  });
});

// --- settings ---------------------------------------------------------------------------------------------

describe('settings', () => {
  const planted: Record<string, string> = {
    COMPOSIO_API_KEY: PLANTED.apiKey,
    TELEGRAM_BOT_TOKEN: PLANTED.botToken,
    POLAR_ACCESS_TOKEN: PLANTED.token,
    ALERT_WEBHOOK_URL: `https://hooks.slack.com/services/T0/B0/${PLANTED.password}`,
    BACKUP_UPLOAD_CMD: `rclone copy {dir} remote:${PLANTED.password}`,
    LITELLM_MASTER_KEY: `sk-master-${PLANTED.code}`,
    LITELLM_URL: `http://admin:${PLANTED.password}@litellm:4000/?k=${PLANTED.code}`,
    COMPOSIO_AUTH_CONFIGS: JSON.stringify({ gmail: `ac_${PLANTED.code}`, github: 'ac_gh' }),
    COMPOSIO_MANAGED_APPS: 'googlecalendar,notion',
    CREW_AVAILABLE: 'byte,scout',
    BROWSER_AVAILABLE: 'true',
    WAKE_WHILE_ROUTING: 'false',
    FREE_CREDITS_MONTHLY_CAP: '5000',
  };

  it('shows the switches and lists, and of each secret only whether it is set', async () => {
    Object.assign(process.env, planted);
    resetConfig();
    try {
      const res = await expectContract<{
        environment: string;
        settings: Array<{ name: string; value: unknown; note?: string }>;
        secrets: Array<{ name: string; set: boolean }>;
        apps: Array<{ slug: string; connectable: boolean; setup: string }>;
      }>('adminGetConfig', await call('/v1/admin/config', { token: admin.token }), 200);
      const value = (n: string) => res.settings.find((s) => s.name === n)?.value;
      const isSet = (n: string) => res.secrets.find((s) => s.name === n)?.set;

      expect(res.environment).toBe('test');
      expect(value('CREW_AVAILABLE')).toEqual(['byte', 'scout']);
      expect(value('BROWSER_AVAILABLE')).toBe(true);
      expect(value('WAKE_WHILE_ROUTING')).toBe(false);
      expect(value('COMPOSIO_MANAGED_APPS')).toEqual(['googlecalendar', 'notion']);
      expect(value('COMPOSIO_AUTH_CONFIGS')).toEqual(['github', 'gmail']);
      expect(value('ENABLED_CHANNELS')).toEqual(['telegram', 'web']);
      expect(value('FREE_CREDITS_MONTHLY_CAP')).toBe(5000);
      expect(value('LITELLM_URL')).toBe('http://litellm:4000');
      expect(res.settings.find((s) => s.name === 'AWAKE_CAP')).toMatchObject({ value: null });
      expect(isSet('COMPOSIO_API_KEY')).toBe(true);
      expect(isSet('TELEGRAM_BOT_TOKEN')).toBe(true);
      expect(isSet('DATABASE_URL')).toBe(true);
      expect(isSet('JEV_API_KEY')).toBe(false);
      expect(res.apps.find((a) => a.slug === 'gmail')).toMatchObject({
        connectable: true,
        setup: 'settings',
      });
      expect(res.apps.find((a) => a.slug === 'googlecalendar')).toMatchObject({
        setup: 'server_may_make',
      });
      expect(res.apps.find((a) => a.slug === 'slack')).toMatchObject({
        connectable: false,
        setup: 'none',
      });

      expectNoPlanted(res);
      const text = JSON.stringify(res);
      expect(text).not.toContain(process.env.DATABASE_URL!);
      expect(text).not.toContain(process.env.ENCRYPTION_KEY!);
      expect(text).not.toContain(process.env.VM_INTERNAL_SECRET!);
      expect(text).not.toContain(process.env.CLERK_WEBHOOK_SECRET!);
      expect(text).not.toContain(process.env.TELEGRAM_WEBHOOK_SECRET!);
    } finally {
      for (const k of Object.keys(planted)) delete process.env[k];
      resetConfig();
    }
  });

  it('every listed name is a real setting, and no secret-looking one is shown with its value', () => {
    const known = new Set(Object.keys(configSchema.shape));
    for (const [name] of SETTINGS) expect(known.has(name), name).toBe(true);
    for (const name of SECRETS) expect(known.has(name), name).toBe(true);
    const shown = SETTINGS.map(([name]) => name);
    for (const name of shown) {
      expect(name, name).not.toMatch(
        /SECRET|TOKEN|PASSWORD|_KEY$|DATABASE_URL|REDIS_URL|WEBHOOK_URL|CMD/,
      );
      expect((SECRETS as readonly string[]).includes(name)).toBe(false);
    }
    // Every setting whose name says secret is in the secrets list.
    for (const name of known)
      if (/SECRET|TOKEN|PASSWORD|_KEY$/.test(name) && name !== 'CLERK_JWT_KEY')
        expect((SECRETS as readonly string[]).includes(name), name).toBe(true);
  });
});

// --- health -----------------------------------------------------------------------------------------------

describe('health', () => {
  it('asks each service and says ok, error or off with a short message', async () => {
    setVmClient({
      async listSandboxes() {
        return {
          sandboxes: [
            { userId: 'usr_a', state: SandboxState.AWAKE },
            { userId: 'usr_b', state: SandboxState.STOPPED },
            { userId: 'usr_c', state: SandboxState.BUSY },
          ],
        };
      },
    } as unknown as VmClient);
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      asked.push(url);
      if (url.includes('/health/liveliness')) return new Response("I'm alive!", { status: 200 });
      if (url.includes('/api/v3/auth_configs')) {
        const key = new Headers(init?.headers).get('x-api-key');
        return new Response('{}', { status: key === PLANTED.apiKey ? 401 : 200 });
      }
      return realFetch(input, init);
    });
    process.env.GIT_COMMIT = 'abc1234';
    resetConfig();
    try {
      // Composio not set up: off.
      let res = await expectContract<{
        ok: boolean;
        version: { version: string; commit: string | null };
        services: Array<{ name: string; status: string; message: string }>;
      }>('adminGetHealth', await call('/v1/admin/health', { token: admin.token }), 200);
      const svc = (n: string) => res.services.find((s) => s.name === n)!;
      expect(res.services.map((s) => s.name)).toEqual([
        'postgres',
        'redis',
        'vm-manager',
        'litellm',
        'composio',
      ]);
      expect(svc('postgres')).toMatchObject({ status: 'ok' });
      expect(svc('redis')).toMatchObject({ status: 'ok' });
      expect(svc('vm-manager')).toMatchObject({
        status: 'ok',
        message: 'reachable: 3 containers, 2 awake',
      });
      expect(svc('litellm')).toMatchObject({ status: 'ok' });
      expect(svc('composio')).toMatchObject({ status: 'off' });
      expect(res.ok).toBe(true);
      expect(res.version).toMatchObject({ version: '0.1.0', commit: 'abc1234' });

      // A refused key, and the vm-manager down.
      process.env.COMPOSIO_API_KEY = PLANTED.apiKey;
      resetConfig();
      setVmClient({
        async listSandboxes() {
          throw new Error(`connect ECONNREFUSED http://vm-manager:9090 secret=${PLANTED.token}`);
        },
      } as unknown as VmClient);
      res = await expectContract(
        'adminGetHealth',
        await call('/v1/admin/health', { token: admin.token }),
        200,
      );
      expect(svc('composio')).toMatchObject({
        status: 'error',
        message: 'reachable, but the key was refused (401)',
      });
      expect(svc('vm-manager').status).toBe('error');
      expect(svc('vm-manager').message).toContain('ECONNREFUSED');
      expect(res.ok).toBe(false);
      expectNoPlanted(res);
      expect(asked.some((u) => u.includes('/api/v3/auth_configs'))).toBe(true);
    } finally {
      spy.mockRestore();
      setVmClient(undefined);
      delete process.env.GIT_COMMIT;
      delete process.env.COMPOSIO_API_KEY;
      resetConfig();
    }
  });
});
