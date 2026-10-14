// Admin tools for one user's agent and container (docs/backend-report.md, "Admin tools"): the
// view, stopping and waking the container through the vm-manager, putting settings back to their
// defaults, and cancelling a waiting approval or a crew job that has not started. Admins only,
// every change audited with the admin's id and the reason, and no secret in any response.
import { Code, ConnectError } from '@connectrpc/connect';
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime, SandboxState } from '../proto-gen/vm/v1/vm_pb.ts';
import { auditLog } from '../src/modules/admin/schema.ts';
import { crewJobs } from '../src/modules/automations/schema.ts';
import { CANCELLED_BY_SUPPORT, handleCrewJob } from '../src/modules/automations/crew-jobs.ts';
import { usagePeriods } from '../src/modules/billing/schema.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { events } from '../src/modules/events/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import {
  getAgentSettings,
  markClaudeConnected,
  updateAgentSettings,
} from '../src/modules/orchestrator/agent-settings.ts';
import { decideApproval } from '../src/modules/orchestrator/approvals.ts';
import { approvals } from '../src/modules/orchestrator/schema.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { vm } from '../src/modules/orchestrator/vm.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { IGNORED } from '../src/worker/ignored.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeVm } from './fakes.ts';
import { call, chatUser, createUser, expectContract } from './helpers.ts';

type Fake = ReturnType<typeof installFakeVm>;
type Err = { error: { code: string; message: string } };

let fake: Fake;
/** The LiteLLM key each CreateSandbox was given (it must never come back out). */
let litellmKeys: string[];
let admin: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  wireModules();
  admin = await createUser({ role: 'admin' });
});
afterAll(async () => {
  await closeQueues();
});
beforeEach(() => {
  fake = installFakeVm(async () => {});
  litellmKeys = [];
  const client = vm() as unknown as Record<string, (req: Record<string, unknown>) => unknown>;
  const create = client.createSandbox!.bind(client);
  client.createSandbox = (req) => {
    litellmKeys.push(String(req.litellmKey));
    return create(req);
  };
});
afterEach(() => {
  delete process.env.BROWSER_AVAILABLE;
  resetConfig();
});

const post = (token: string, body: unknown) => ({ method: 'POST', token, body });

/** Replaces one vm-manager call of the installed fake. */
function onVm(method: string, fn: (req: Record<string, unknown>) => unknown): void {
  (vm() as unknown as Record<string, unknown>)[method] = fn;
}

async function withContainer(overrides: Parameters<typeof chatUser>[0] = {}) {
  const u = await chatUser(overrides);
  await ensureSandbox(u.id);
  return u;
}

async function auditRows(userId: string, action: string) {
  return db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), eq(auditLog.action, action)));
}

/** Every key anywhere in a JSON value. */
function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysOf(x, out);
    }
  return out;
}

/** No field named like a secret, and none of this user's secrets anywhere in the text. */
function expectNoSecrets(text: string, userId: string): void {
  const keys = keysOf(JSON.parse(text));
  expect(
    keys.filter((k) => /token|secret|hash|password|litellm|apiKey|arguments/i.test(k)),
  ).toEqual([]);
  const token = fake.tokens.get(userId);
  if (token) expect(text).not.toContain(token);
  for (const key of litellmKeys) if (key) expect(text).not.toContain(key);
}

describe('admins only', () => {
  const ops: Array<[string, string, string, unknown?]> = [
    ['adminGetUserAgent', 'GET', '/v1/admin/users/usr_x/agent'],
    ['adminStopContainer', 'POST', '/v1/admin/users/usr_x/container/stop', { reason: 'r' }],
    ['adminWakeContainer', 'POST', '/v1/admin/users/usr_x/container/wake', { reason: 'r' }],
    [
      'adminResetAgent',
      'POST',
      '/v1/admin/users/usr_x/agent/reset',
      { reason: 'r', what: ['engine'] },
    ],
    ['adminListUserApprovals', 'GET', '/v1/admin/users/usr_x/approvals'],
    ['adminCancelApproval', 'POST', '/v1/admin/approvals/apr_x/cancel', { reason: 'r' }],
    ['adminListUserCrewJobs', 'GET', '/v1/admin/users/usr_x/crew-jobs'],
    ['adminCancelCrewJob', 'POST', '/v1/admin/crew-jobs/crj_x/cancel', { reason: 'r' }],
  ];

  it('answers 401 without a session and 403 to a user who is not an admin', async () => {
    const u = await withContainer();
    for (const [op, method, path, body] of ops) {
      const real = path.replace('usr_x', u.id);
      await expectContract(op, await call(real, { method, body }), 401);
      const res = await call(real, { method, body, token: u.token });
      const err = await expectContract<Err>(op, res, 403);
      expect(err.error.message).toBe('Admins only');
    }
    // Nothing reached the vm-manager or the audit log.
    expect(fake.stops).toEqual([]);
    expect(fake.wakes).toEqual([]);
    expect(await auditRows(u.id, 'container_stopped')).toEqual([]);
  });

  it('answers 404 for a user that does not exist', async () => {
    for (const [op, method, path, body] of ops) {
      if (!path.includes('usr_x')) continue;
      await expectContract(
        op,
        await call(path.replace('usr_x', 'usr_missing'), { method, body, token: admin.token }),
        404,
      );
    }
    expect(fake.stops).toEqual([]);
    expect(fake.wakes).toEqual([]);
  });

  it('needs a reason, and a reason of spaces only is none', async () => {
    const u = await withContainer();
    for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
      await expectContract(
        'adminStopContainer',
        await call(`/v1/admin/users/${u.id}/container/stop`, post(admin.token, body)),
        400,
      );
    }
    await expectContract(
      'adminResetAgent',
      await call(
        `/v1/admin/users/${u.id}/agent/reset`,
        post(admin.token, { reason: 'x', what: [] }),
      ),
      400,
    );
    await expectContract(
      'adminResetAgent',
      await call(
        `/v1/admin/users/${u.id}/agent/reset`,
        post(admin.token, { reason: 'x', what: ['everything'] }),
      ),
      400,
    );
    expect(fake.stops).toEqual([]);
  });
});

describe('GET /v1/admin/users/{id}/agent', () => {
  it("shows the container, the engine and the AI, and none of the container's secrets", async () => {
    const u = await withContainer({ plan: 'pro' });
    await markClaudeConnected(u.id);
    await updateAgentSettings(u.id, { claudeModel: 'claude-opus-5-5', claudeEffort: 'xhigh' });
    onVm('getSandbox', async (req) => ({
      userId: req.userId,
      containerId: 'c0ffee',
      imageVersion: 'agent:2026-10-14',
      state: SandboxState.BUSY,
      lastActiveAtUnixMs: 1_760_000_000_000n,
      memoryBytes: 412_000_000n,
      allowlist: ['mcp.example.com'],
      runtime: AgentRuntime.CLAUDE_CODE,
      claudeConnected: true,
      browserEnabled: false,
    }));
    // Usage charged today and yesterday: only today's counts.
    const today = new Date();
    const midnight = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    await db()
      .insert(usagePeriods)
      .values([
        {
          id: newId('use'),
          userId: u.id,
          periodStart: new Date(midnight.getTime() + 60_000),
          periodEnd: new Date(midnight.getTime() + 360_000),
          awakeSeconds: 300,
          browserSeconds: 30,
          creditsCharged: 3,
        },
        {
          id: newId('use'),
          userId: u.id,
          periodStart: new Date(midnight.getTime() - 3_600_000),
          periodEnd: new Date(midnight.getTime() - 3_300_000),
          awakeSeconds: 900,
          creditsCharged: 9,
        },
      ]);

    const res = await call(`/v1/admin/users/${u.id}/agent`, { token: admin.token });
    const text = await res.clone().text();
    const body = await expectContract<Record<string, unknown>>('adminGetUserAgent', res, 200);
    expect(body).toMatchObject({
      userId: u.id,
      plan: 'pro',
      container: {
        reachable: true,
        state: 'busy',
        busy: true,
        lastActiveAt: new Date(1_760_000_000_000).toISOString(),
        imageVersion: 'agent:2026-10-14',
        memoryBytes: 412_000_000,
        engine: 'claude_code',
        claudeSignedIn: true,
        browserOn: false,
      },
      engine: { chosen: 'claude_code', effective: 'claude_code' },
      claude: { connected: true },
      claudeModel: 'claude-opus-5-5',
      claudeEffort: 'xhigh',
      browser: { available: false, wanted: false, onRecord: false },
      ai: {
        access: 'claude_plan',
        preference: 'auto',
        serverMode: 'platform',
        ownKeyProviders: [],
      },
      today: {
        since: midnight.toISOString(),
        awakeSeconds: 300,
        browserSeconds: 30,
        creditsCharged: 3,
      },
    });
    // Not the container's id or its allowlist either.
    expect(text).not.toContain('c0ffee');
    expect(text).not.toContain('mcp.example.com');
    expectNoSecrets(text, u.id);
    expect(litellmKeys.length).toBeGreaterThan(0);
  });

  it('still answers when the vm-manager cannot be asked, and says so', async () => {
    const u = await withContainer();
    onVm('getSandbox', async () => {
      throw new ConnectError('down', Code.Unavailable);
    });
    const body = await expectContract<{
      container: { reachable: boolean; state: string };
      engine: { chosen: string };
    }>(
      'adminGetUserAgent',
      await call(`/v1/admin/users/${u.id}/agent`, { token: admin.token }),
      200,
    );
    expect(body.container).toMatchObject({ reachable: false, state: 'unknown', busy: null });
    expect(body.engine.chosen).toBe('hermes');
  });

  it('says "none" for a user with no container', async () => {
    const u = await chatUser();
    onVm('getSandbox', async () => {
      throw new ConnectError('sandbox not found', Code.NotFound);
    });
    const body = await expectContract<{ container: { reachable: boolean; state: string } }>(
      'adminGetUserAgent',
      await call(`/v1/admin/users/${u.id}/agent`, { token: admin.token }),
      200,
    );
    expect(body.container).toMatchObject({ reachable: true, state: 'none' });
  });
});

describe('POST /v1/admin/users/{id}/container/stop', () => {
  it('stops politely through the vm-manager and audits the admin and the reason', async () => {
    const u = await withContainer();
    const res = await call(
      `/v1/admin/users/${u.id}/container/stop`,
      post(admin.token, { reason: 'User asked us to restart their agent' }),
    );
    const text = await res.clone().text();
    const body = await expectContract<{ container: { state: string } }>(
      'adminStopContainer',
      res,
      200,
    );
    expect(body.container.state).toBe('stopped');
    expect(fake.stops).toEqual([{ userId: u.id, force: false, reason: `admin ${admin.id}` }]);
    expectNoSecrets(text, u.id);

    const [row] = await auditRows(u.id, 'container_stopped');
    expect(row).toMatchObject({
      actor: 'admin',
      summary: "Textcrew support stopped the agent's container",
      details: { adminId: admin.id, reason: 'User asked us to restart their agent', force: false },
    });
    // The reason is for support: the user's activity log shows the summary only.
    const activity = await call('/v1/activity', { token: u.token });
    expect(await activity.text()).not.toContain('restart their agent');
  });

  it('answers 409 when the vm-manager refuses a polite stop mid-turn, and audits nothing', async () => {
    const u = await withContainer();
    fake.state.stopError = new ConnectError(
      'sandbox is busy: use force to stop a stuck turn',
      Code.FailedPrecondition,
    );
    const err = await expectContract<Err>(
      'adminStopContainer',
      await call(`/v1/admin/users/${u.id}/container/stop`, post(admin.token, { reason: 'check' })),
      409,
    );
    expect(err.error.message).toMatch(/stop it by force/);
    expect(await auditRows(u.id, 'container_stopped')).toEqual([]);
  });

  it('stops by force only when asked, and marks it so', async () => {
    const u = await withContainer();
    await expectContract(
      'adminStopContainer',
      await call(
        `/v1/admin/users/${u.id}/container/stop`,
        post(admin.token, { reason: 'stuck turn', force: true }),
      ),
      200,
    );
    expect(fake.stops).toEqual([
      { userId: u.id, force: true, reason: `admin ${admin.id} (force)` },
    ]);
    const [row] = await auditRows(u.id, 'container_stopped');
    expect(row?.summary).toMatch(/by force/);
    expect(row?.details).toMatchObject({ force: true, reason: 'stuck turn' });
  });

  it('answers 404 without a container and 503 when the vm-manager is down', async () => {
    const none = await chatUser();
    await expectContract(
      'adminStopContainer',
      await call(`/v1/admin/users/${none.id}/container/stop`, post(admin.token, { reason: 'x' })),
      404,
    );
    const u = await withContainer();
    fake.state.stopError = new ConnectError('down', Code.Unavailable);
    await expectContract(
      'adminStopContainer',
      await call(`/v1/admin/users/${u.id}/container/stop`, post(admin.token, { reason: 'x' })),
      503,
    );
    expect(await auditRows(u.id, 'container_stopped')).toEqual([]);
  });
});

describe('POST /v1/admin/users/{id}/container/wake', () => {
  it('wakes with the plan priority, sets the engine again, and audits', async () => {
    const u = await withContainer({ plan: 'max' });
    await markClaudeConnected(u.id);
    // The container still runs Hermes on record: the wake sets it again, like a turn's wake.
    fake.runtimes.set(u.id, AgentRuntime.HERMES);
    fake.runtimeCalls.length = 0;
    const res = await call(
      `/v1/admin/users/${u.id}/container/wake`,
      post(admin.token, { reason: 'checking a report' }),
    );
    const text = await res.clone().text();
    const body = await expectContract<{ container: { state: string }; wasStopped: boolean }>(
      'adminWakeContainer',
      res,
      200,
    );
    expect(body).toMatchObject({ container: { state: 'awake' }, wasStopped: true });
    expect(fake.wakePriorities).toEqual([{ userId: u.id, priority: 3 }]);
    expect(fake.runtimeCalls).toEqual([{ userId: u.id, runtime: AgentRuntime.CLAUDE_CODE }]);
    expectNoSecrets(text, u.id);
    const [row] = await auditRows(u.id, 'container_woken');
    expect(row).toMatchObject({
      actor: 'admin',
      details: { adminId: admin.id, reason: 'checking a report' },
    });
  });

  it('does not wake a user with no credits (awake time is charged to them)', async () => {
    const u = await createUser();
    await expectContract(
      'adminWakeContainer',
      await call(`/v1/admin/users/${u.id}/container/wake`, post(admin.token, { reason: 'x' })),
      409,
    );
    expect(fake.wakes).toEqual([]);
    expect(await auditRows(u.id, 'container_woken')).toEqual([]);
  });

  it('answers 503 when the server is full', async () => {
    const u = await withContainer();
    fake.state.wakeError = new ConnectError('awake cap reached', Code.ResourceExhausted);
    const err = await expectContract<Err>(
      'adminWakeContainer',
      await call(`/v1/admin/users/${u.id}/container/wake`, post(admin.token, { reason: 'x' })),
      503,
    );
    expect(err.error.message).toMatch(/awake limit/);
    expect(await auditRows(u.id, 'container_woken')).toEqual([]);
  });
});

describe('POST /v1/admin/users/{id}/agent/reset', () => {
  it('puts the engine, model and effort back to their defaults through the settings', async () => {
    const u = await withContainer();
    await markClaudeConnected(u.id);
    await updateAgentSettings(u.id, { claudeModel: 'claude-sonnet-4-6', claudeEffort: 'max' });
    fake.runtimeCalls.length = 0;

    const res = await call(
      `/v1/admin/users/${u.id}/agent/reset`,
      post(admin.token, { reason: 'Opus quota errors', what: ['engine', 'model', 'effort'] }),
    );
    const text = await res.clone().text();
    const body = await expectContract<Record<string, unknown>>('adminResetAgent', res, 200);
    expect(body).toMatchObject({
      engine: { chosen: 'hermes', effective: 'hermes' },
      claude: { connected: true },
      claudeModel: null,
      claudeEffort: null,
    });
    expectNoSecrets(text, u.id);
    const settings = await getAgentSettings(u.id);
    expect(settings).toMatchObject({ runtime: 'hermes', claudeModel: null, claudeEffort: null });
    // The vm-manager was told the way the user's own change tells it.
    expect(fake.runtimeCalls).toEqual([{ userId: u.id, runtime: AgentRuntime.HERMES }]);

    const [changed] = await auditRows(u.id, 'agent_runtime_changed');
    expect(changed).toMatchObject({ actor: 'admin', summary: 'Agent switched to Hermes' });
    const [reset] = await auditRows(u.id, 'agent_reset');
    expect(reset).toMatchObject({
      actor: 'admin',
      details: {
        adminId: admin.id,
        reason: 'Opus quota errors',
        what: ['engine', 'model', 'effort'],
      },
    });
    expect(reset?.summary).not.toContain('Opus quota');
  });

  it("sets the browser switch again from the plan, and says when it couldn't", async () => {
    const u = await withContainer({ plan: 'free' });
    fake.browser.set(u.id, true);
    await expectContract(
      'adminResetAgent',
      await call(
        `/v1/admin/users/${u.id}/agent/reset`,
        post(admin.token, { reason: 'browser left on', what: ['browser'] }),
      ),
      200,
    );
    expect(fake.browserCalls).toEqual([{ userId: u.id, enabled: false }]);

    // The vm-manager can't be told: the rest is reset, the call answers 503, and the audit says so.
    await updateAgentSettings(u.id, { claudeEffort: 'low' });
    fake.browser.set(u.id, true);
    fake.state.browserError = new ConnectError('down', Code.Unavailable);
    await expectContract(
      'adminResetAgent',
      await call(
        `/v1/admin/users/${u.id}/agent/reset`,
        post(admin.token, { reason: 'again', what: ['effort', 'browser'] }),
      ),
      503,
    );
    expect((await getAgentSettings(u.id)).claudeEffort).toBeNull();
    const rows = await auditRows(u.id, 'agent_reset');
    expect(rows.map((r) => r.details)).toContainEqual({
      adminId: admin.id,
      reason: 'again',
      what: ['effort', 'browser'],
      browserFailed: true,
    });
  });
});

/** Ids made in this file sort in the order they were made, even within one millisecond. */
let tick = 0;
const orderedId = (prefix: string) => newId(prefix, Date.now() + ++tick);

async function addApproval(
  userId: string,
  values: Partial<typeof approvals.$inferInsert> = {},
): Promise<string> {
  const id = orderedId('apr');
  await db()
    .insert(approvals)
    .values({
      id,
      userId,
      summary: 'Send the notes to priya@example.com',
      app: 'gmail',
      action: 'GMAIL_SEND_EMAIL',
      arguments: { to: 'priya@example.com', body: 'the secret notes' },
      details: { draft: 'the secret notes' },
      sessionKey: 'web',
      expiresAt: new Date(Date.now() + 3_600_000),
      ...values,
    });
  return id;
}

describe('approvals', () => {
  it("lists the user's approvals in every state, without the action's inputs", async () => {
    const u = await withContainer();
    const other = await chatUser();
    const pending = await addApproval(u.id);
    const used = await addApproval(u.id, {
      status: 'approved',
      decidedAt: new Date(),
      decidedVia: 'telegram:button',
      usedAt: new Date(),
    });
    const stale = await addApproval(u.id, { expiresAt: new Date(Date.now() - 1000) });
    await addApproval(other.id);

    const res = await call(`/v1/admin/users/${u.id}/approvals`, { token: admin.token });
    const text = await res.clone().text();
    const body = await expectContract<{
      items: Array<{ id: string; status: string; used: boolean; decidedVia: string | null }>;
    }>('adminListUserApprovals', res, 200);
    expect(body.items.map((a) => [a.id, a.status, a.used])).toEqual([
      [stale, 'expired', false],
      [used, 'approved', true],
      [pending, 'pending', false],
    ]);
    expect(text).not.toContain('the secret notes');
    expect(text).toContain('Send the notes to priya@example.com');
    expectNoSecrets(text, u.id);

    const only = await expectContract<{ items: Array<{ id: string }> }>(
      'adminListUserApprovals',
      await call(`/v1/admin/users/${u.id}/approvals?status=pending`, { token: admin.token }),
      200,
    );
    expect(only.items.map((a) => a.id)).toEqual([pending]);
  });

  it('cancels a waiting approval the way expiry does, once, and audits it', async () => {
    const u = await withContainer();
    const id = await addApproval(u.id);
    const body = await expectContract<{ id: string; status: string; decidedVia: string }>(
      'adminCancelApproval',
      await call(
        `/v1/admin/approvals/${id}/cancel`,
        post(admin.token, { reason: 'Looks like a prompt injection' }),
      ),
      200,
    );
    expect(body).toMatchObject({ id, status: 'expired', decidedVia: 'admin' });
    const [row] = await db().select().from(approvals).where(eq(approvals.id, id));
    expect(row?.status).toBe('expired');
    expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    const [audited] = await auditRows(u.id, 'approval_cancelled');
    expect(audited).toMatchObject({
      actor: 'admin',
      details: { approvalId: id, adminId: admin.id, reason: 'Looks like a prompt injection' },
    });
    expect(audited?.summary).not.toContain('prompt injection');

    // The agent is not woken, and the user's late answer finds it gone.
    expect(fake.deliveries).toEqual([]);
    expect(
      await db()
        .select()
        .from(events)
        .where(and(eq(events.source, 'approval'), eq(events.externalId, id))),
    ).toEqual([]);
    await expect(decideApproval(u.id, id, true, 'web')).rejects.toThrow(/already expired/);

    // A second cancel, an answered approval and an unknown one are refused.
    await expectContract(
      'adminCancelApproval',
      await call(`/v1/admin/approvals/${id}/cancel`, post(admin.token, { reason: 'again' })),
      409,
    );
    const approved = await addApproval(u.id, { status: 'approved', decidedAt: new Date() });
    await expectContract(
      'adminCancelApproval',
      await call(`/v1/admin/approvals/${approved}/cancel`, post(admin.token, { reason: 'x' })),
      409,
    );
    await expectContract(
      'adminCancelApproval',
      await call('/v1/admin/approvals/apr_missing/cancel', post(admin.token, { reason: 'x' })),
      404,
    );
    expect(await auditRows(u.id, 'approval_cancelled')).toHaveLength(1);
  });
});

async function addCrewJob(
  userId: string,
  values: Partial<typeof crewJobs.$inferInsert> = {},
): Promise<string> {
  const id = orderedId('crj');
  await db()
    .insert(crewJobs)
    .values({
      id,
      userId,
      member: 'byte',
      source: 'app',
      owner: 'acme',
      repo: 'web',
      instructions: 'Fix the private login bug',
      commands: 'pnpm test',
      acceptance: 'the login works',
      finish: 'pull_request',
      sessionKey: 'web',
      eventId: `evt_${id}`,
      ...values,
    });
  return id;
}

describe('crew jobs', () => {
  it('lists jobs without the brief or the report, and with the report when asked', async () => {
    const u = await withContainer();
    const queued = await addCrewJob(u.id);
    const done = await addCrewJob(u.id, {
      member: 'patch',
      pullNumber: 42,
      status: 'done',
      report: '**Verdict:** ship',
      startedAt: new Date(),
      finishedAt: new Date(),
      reportPullRequest: true,
      postedAt: new Date(),
    });

    const res = await call(`/v1/admin/users/${u.id}/crew-jobs`, { token: admin.token });
    const text = await res.clone().text();
    const body = await expectContract<{ items: Array<Record<string, unknown>> }>(
      'adminListUserCrewJobs',
      res,
      200,
    );
    expect(body.items.map((j) => [j.id, j.status, j.hasReport, j.postedOnPullRequest])).toEqual([
      [done, 'done', true, true],
      [queued, 'queued', false, false],
    ]);
    expect(body.items.every((j) => !('report' in j))).toBe(true);
    for (const words of ['private login', 'pnpm test', 'the login works', 'Verdict'])
      expect(text).not.toContain(words);
    expectNoSecrets(text, u.id);

    const withReport = await expectContract<{
      items: Array<{ id: string; report?: string | null }>;
    }>(
      'adminListUserCrewJobs',
      await call(`/v1/admin/users/${u.id}/crew-jobs?withReport=1`, { token: admin.token }),
      200,
    );
    expect(withReport.items.map((j) => j.report)).toEqual(['**Verdict:** ship', null]);
    await expectContract(
      'adminListUserCrewJobs',
      await call(`/v1/admin/users/${u.id}/crew-jobs?withReport=yes`, { token: admin.token }),
      400,
    );
  });

  it('cancels a queued job: it never runs, the user is told, and it is audited', async () => {
    const u = await withContainer();
    const id = await addCrewJob(u.id);
    const body = await expectContract<{ status: string; error: string }>(
      'adminCancelCrewJob',
      await call(
        `/v1/admin/crew-jobs/${id}/cancel`,
        post(admin.token, { reason: 'Repo flagged for abuse' }),
      ),
      200,
    );
    expect(body).toMatchObject({ status: 'failed', error: CANCELLED_BY_SUPPORT });
    const [audited] = await auditRows(u.id, 'crew_job_cancelled');
    expect(audited).toMatchObject({
      actor: 'admin',
      details: { crewJobId: id, adminId: admin.id, reason: 'Repo flagged for abuse' },
    });
    expect(audited?.summary).not.toContain('abuse');
    const told = await db().select().from(messages).where(eq(messages.userId, u.id));
    expect(told.map((m) => m.text)).toContainEqual(
      '"Fix the private login bug in acme/web" was cancelled by Textcrew support and won\'t run.',
    );

    // Its queued turn finds nothing to do.
    const job = {
      data: { crewJobId: id, userId: u.id, eventId: `evt_${id}` },
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as unknown as Job;
    expect(await handleCrewJob(job)).toBe(IGNORED);
    expect(fake.deliveries).toEqual([]);

    // Again: already failed.
    await expectContract(
      'adminCancelCrewJob',
      await call(`/v1/admin/crew-jobs/${id}/cancel`, post(admin.token, { reason: 'x' })),
      409,
    );
  });

  it("refuses a running or finished job, and one that doesn't exist", async () => {
    const u = await withContainer();
    const running = await addCrewJob(u.id, { status: 'running', startedAt: new Date() });
    const err = await expectContract<Err>(
      'adminCancelCrewJob',
      await call(`/v1/admin/crew-jobs/${running}/cancel`, post(admin.token, { reason: 'x' })),
      409,
    );
    expect(err.error.message).toMatch(/running/);
    const [row] = await db().select().from(crewJobs).where(eq(crewJobs.id, running));
    expect(row?.status).toBe('running');
    const done = await addCrewJob(u.id, { status: 'done', finishedAt: new Date() });
    await expectContract(
      'adminCancelCrewJob',
      await call(`/v1/admin/crew-jobs/${done}/cancel`, post(admin.token, { reason: 'x' })),
      409,
    );
    await expectContract(
      'adminCancelCrewJob',
      await call('/v1/admin/crew-jobs/crj_missing/cancel', post(admin.token, { reason: 'x' })),
      404,
    );
    expect(await auditRows(u.id, 'crew_job_cancelled')).toEqual([]);
  });
});
