// Approvals for the agent's own actions (docs/backend-report.md, "Approvals for the agent's own
// actions"): Claude Code's gate hook asks /mcp/gate before a command or file change that needs the
// user's OK, and the git gateway asks before a push to a branch that already existed or a force
// push. The user is asked with the usual card; the call is refused and the turn ends; after the yes
// the same call goes through once. During a crew job nothing is asked: what the brief does not
// cover is refused, kept on the job, and offered after the run as "run the job again with it".
import { randomBytes, randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeliverKind } from '../proto-gen/vm/v1/vm_pb.ts';
import { crewBranchName, offerCrewRerun } from '../src/modules/automations/crew-jobs.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { crewJobs } from '../src/modules/automations/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { setGitUpstream } from '../src/modules/integrations/git-gateway.ts';
import { connections, gitCreatedBranches } from '../src/modules/integrations/tables.ts';
import {
  COMMAND_ACTION,
  CREW_RERUN_ACTION,
  GIT_PUSH_ACTION,
} from '../src/modules/orchestrator/approval-kinds.ts';
import { approvalAskText } from '../src/modules/orchestrator/approval-text.ts';
import { gateSummary, pushSummary } from '../src/modules/orchestrator/gate.ts';
import { approvals, sandboxTokens } from '../src/modules/orchestrator/schema.ts';
import { sha256Hex } from '../src/shared/crypto.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { redis } from '../src/shared/redis.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import {
  installFakeComposio,
  installFakeTelegram,
  installFakeVm,
  telegramButton,
  telegramUpdate,
  type SentTelegram,
} from './fakes.ts';
import { commit, pack, receivePack } from './git-packs.ts';
import { call, chatUser, expectContract, testApp, waitFor, webConversationId } from './helpers.ts';

const ZERO = '0'.repeat(40);
const CURL = 'curl -s https://example.com/data.json';

let workers: Worker[];
let tg: { sent: SentTelegram[] };
let vmFake: ReturnType<typeof installFakeVm>;
/** What GitHub was asked to compare (`old...new` → its answer), and the pushes it received. */
let compare: Map<string, string>;
let pushes: string[];

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
  await installFakeComposio();
  vmFake = installFakeVm(async () => {});
  compare = new Map();
  pushes = [];
  setGitUpstream(async (input) => {
    const url = String(input);
    if (url.includes('/compare/'))
      return Response.json({ status: compare.get(url.split('/compare/')[1]!) ?? 'diverged' });
    if (url.startsWith('https://api.github.com/repos/'))
      return Response.json({ default_branch: 'main' });
    if (url.endsWith('/git-receive-pack')) {
      pushes.push(url);
      return new Response('0000', {
        status: 200,
        headers: { 'content-type': 'application/x-git-receive-pack-result' },
      });
    }
    return new Response('git-data', { status: 200 });
  });
});
afterEach(() => setGitUpstream(undefined));

async function connectGithub(userId: string) {
  await db()
    .insert(connections)
    .values({
      id: newId('con'),
      userId,
      app: 'github',
      composioAccountId: `ca_${randomUUID()}`,
      status: 'active',
    });
}

/** A user with a container token of its own and GitHub connected (no turn running). */
async function containerUser() {
  const user = await chatUser({ plan: 'pro' });
  const token = randomBytes(24).toString('hex');
  await db()
    .insert(sandboxTokens)
    .values({ userId: user.id, mcpTokenHash: sha256Hex(token) });
  await connectGithub(user.id);
  return { ...user, containerToken: token };
}

/** As the worker records it while one of the user's turns runs in web chat. */
async function inTurn(userId: string, kind = 'message') {
  await redis().set(
    `turn-conversation:${userId}`,
    JSON.stringify({
      sessionKey: 'web',
      conversationId: await webConversationId(userId),
      turnId: 'turn_test',
      inAutomationsChat: false,
      kind,
    }),
    'EX',
    600,
  );
}

const gate = async (token: string, body: Record<string, unknown>) => {
  const res = await testApp().request('/mcp/gate', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
};
const curlCall = {
  tool: 'Bash',
  target: CURL,
  why: 'it reaches the internet',
  cwd: '/data/workspace',
};

async function push(
  token: string,
  repo: string,
  cmds: Array<[string, string, string]>,
  body: Buffer,
) {
  const res = await testApp().request(`/git/acme/${repo}/git-receive-pack`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-git-receive-pack-request',
    },
    body: receivePack(cmds, body),
  });
  return { status: res.status, text: await res.text() };
}

const approvalsOf = (userId: string, action: string) =>
  db()
    .select()
    .from(approvals)
    .where(and(eq(approvals.userId, userId), eq(approvals.action, action)));

/** The user's yes, as decideApproval records it (without the turn that answer starts). */
const approve = (id: string) =>
  db()
    .update(approvals)
    .set({ status: 'approved', decidedAt: new Date(), decidedVia: 'web' })
    .where(eq(approvals.id, id));

describe('the gate hook (/mcp/gate)', () => {
  it('needs the container token and a gate call', async () => {
    const u = await containerUser();
    expect((await gate('not-a-token', curlCall)).status).toBe(401);
    expect((await gate(u.containerToken, { tool: 'Read', target: '/x' })).status).toBe(400);
    expect((await gate(u.containerToken, { tool: 'Bash' })).status).toBe(400);
  });

  it('asks on Telegram with buttons, once; after the yes the same command goes through once', async () => {
    const answers: Array<Record<string, string>> = [];
    const turns: string[] = [];
    vmFake.state.agent = async (d, mcp) => {
      const token = vmFake.tokens.get(d.userId)!;
      turns.push(d.text);
      if (d.kind === DeliverKind.MESSAGE) {
        answers.push((await gate(token, curlCall)).body);
        // The agent tries again in the same turn: the user is not asked twice.
        answers.push((await gate(token, curlCall)).body);
      } else if (d.kind === DeliverKind.APPROVAL_ANSWER && d.approved) {
        // Another command was not approved; the approved one goes through once.
        answers.push((await gate(token, { ...curlCall, target: `${CURL} -o out` })).body);
        answers.push((await gate(token, curlCall)).body);
        answers.push((await gate(token, curlCall)).body);
      }
      await mcp('send_message', { text: 'ok', session_key: d.sessionKey });
    };
    const user = await chatUser();
    const chatId = Math.floor(Math.random() * 1e9);
    const lc = await expectContract<{ code: string }>(
      'createLinkCode',
      await call('/v1/channels/link-codes', {
        method: 'POST',
        token: user.token,
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

    await tgPost(telegramUpdate(chatId, 'fetch the data file'));
    const ask = await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(chatId) && m.buttons),
    );
    expect(ask.text).toBe(
      `I'd like to run this command: ${CURL} (it reaches the internet). Approve or Deny below.`,
    );
    expect(ask.buttons!.map((b) => b.text)).toEqual(['✅ Approve', '❌ Deny']);
    await waitFor(async () => answers.length >= 2);
    expect(answers[0]!.decision).toBe('asked');
    expect(answers[0]!.message).toContain('End your turn now');
    expect(answers[1]!).toMatchObject({ decision: 'asked', approvalId: answers[0]!.approvalId });
    expect(tg.sent.filter((m) => m.buttons)).toHaveLength(1);

    const list = await expectContract<{ items: Array<Record<string, unknown>> }>(
      'listApprovals',
      await call('/v1/approvals', { token: user.token }),
      200,
    );
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      kind: 'command',
      action: COMMAND_ACTION,
      details: {
        tool: 'Bash',
        target: CURL,
        why: 'it reaches the internet',
        folder: '/data/workspace',
      },
    });

    await tgPost(telegramButton(chatId, ask.buttons![0]!.callback_data));
    await waitFor(async () => answers.length >= 5);
    expect(answers.slice(2).map((a) => a.decision)).toEqual(['asked', 'allow', 'asked']);
    expect(answers[3]!.approvalId).toBe(answers[0]!.approvalId);
    // The answer turn tells the agent to make exactly the same call again.
    expect(turns[1]).toContain('make exactly the same command again');
    expect(turns[1]).toContain(CURL);
    const [used] = (await approvalsOf(user.id, COMMAND_ACTION)).filter(
      (a) => a.id === answers[0]!.approvalId,
    );
    expect(used!.usedAt).not.toBeNull();
  });

  it('asks nothing without a turn in progress, and never for another user', async () => {
    const u = await containerUser();
    expect((await gate(u.containerToken, curlCall)).body.decision).toBe('refused');
    expect(await approvalsOf(u.id, COMMAND_ACTION)).toHaveLength(0);

    // Bob's approved command is not Alice's.
    const bob = await containerUser();
    await inTurn(bob.id);
    const asked = (await gate(bob.containerToken, curlCall)).body;
    await approve(asked.approvalId!);
    await inTurn(u.id);
    expect((await gate(u.containerToken, curlCall)).body.decision).toBe('asked');
    expect((await gate(bob.containerToken, curlCall)).body.decision).toBe('allow');
  });

  it('a yes counts for 24 hours from the answer, like any approval', async () => {
    const u = await containerUser();
    await inTurn(u.id);
    const asked = (await gate(u.containerToken, curlCall)).body;
    await db()
      .update(approvals)
      .set({ status: 'approved', decidedAt: new Date(Date.now() - 25 * 3600 * 1000) })
      .where(eq(approvals.id, asked.approvalId!));
    expect((await gate(u.containerToken, curlCall)).body.decision).toBe('asked');
  });
});

describe('the git gateway: pushes to branches that already exist', () => {
  it('a new branch goes through; more commits on it too; a force push to it is asked', async () => {
    const u = await containerUser();
    await inTurn(u.id);
    const c1 = commit([]);
    expect(
      (await push(u.containerToken, 'web', [[ZERO, c1.id, 'refs/heads/fix-1']], pack([c1]))).status,
    ).toBe(200);
    expect(
      await db().select().from(gitCreatedBranches).where(eq(gitCreatedBranches.userId, u.id)),
    ).toMatchObject([{ owner: 'acme', repo: 'web', branch: 'fix-1' }]);

    const c2 = commit([c1.id]);
    expect(
      (await push(u.containerToken, 'web', [[c1.id, c2.id, 'refs/heads/fix-1']], pack([c2])))
        .status,
    ).toBe(200);
    expect(await approvalsOf(u.id, GIT_PUSH_ACTION)).toHaveLength(0);

    // A rewrite: the new commit sits on another base, which GitHub says is not after c2.
    const base = commit([]);
    const r1 = commit([base.id]);
    const res = await push(
      u.containerToken,
      'web',
      [[c2.id, r1.id, 'refs/heads/fix-1']],
      pack([r1]),
    );
    expect(res.status).toBe(403);
    expect(res.text).toContain("needs your user's OK");
    expect(res.text).toContain('Force push to the branch "fix-1" of acme/web');
    const [asked] = await approvalsOf(u.id, GIT_PUSH_ACTION);
    expect(asked).toMatchObject({
      status: 'pending',
      arguments: { owner: 'acme', repo: 'web', branch: 'fix-1', force: true },
      details: { repo: 'acme/web', branch: 'fix-1', force: true },
    });
    expect(pushes).toHaveLength(2);
  });

  it('a push to a branch that existed before is asked; after the yes it goes through once', async () => {
    const u = await containerUser();
    await inTurn(u.id);
    const old = commit([]);
    const c1 = commit([old.id]);
    const first = await push(
      u.containerToken,
      'web',
      [[old.id, c1.id, 'refs/heads/develop']],
      pack([c1]),
    );
    expect(first.status).toBe(403);
    expect(first.text).toContain('Push to the branch "develop" of acme/web, which already existed');
    // Asked again before an answer: the same request, no second card.
    await push(u.containerToken, 'web', [[old.id, c1.id, 'refs/heads/develop']], pack([c1]));
    const asked = await approvalsOf(u.id, GIT_PUSH_ACTION);
    expect(asked).toHaveLength(1);
    expect(pushes).toHaveLength(0);

    await approve(asked[0]!.id);
    expect(
      (await push(u.containerToken, 'web', [[old.id, c1.id, 'refs/heads/develop']], pack([c1])))
        .status,
    ).toBe(200);
    const c2 = commit([c1.id]);
    expect(
      (await push(u.containerToken, 'web', [[c1.id, c2.id, 'refs/heads/develop']], pack([c2])))
        .status,
    ).toBe(403);
    expect(pushes).toHaveLength(1);
  });

  it('a yes for a push that adds commits does not cover a force push; a yes for a force push does', async () => {
    const u = await containerUser();
    await inTurn(u.id);
    const old = commit([]);
    const c1 = commit([old.id]);
    await push(u.containerToken, 'web', [[old.id, c1.id, 'refs/heads/develop']], pack([c1]));
    await approve((await approvalsOf(u.id, GIT_PUSH_ACTION))[0]!.id);
    const other = commit([]);
    const forced = await push(
      u.containerToken,
      'web',
      [[old.id, other.id, 'refs/heads/develop']],
      pack([other]),
    );
    expect(forced.status).toBe(403);
    const force = (await approvalsOf(u.id, GIT_PUSH_ACTION)).find(
      (a) => a.arguments?.force === true,
    )!;
    await approve(force.id);
    expect(
      (
        await push(
          u.containerToken,
          'web',
          [[old.id, other.id, 'refs/heads/develop']],
          pack([other]),
        )
      ).status,
    ).toBe(200);
    // The other yes is still there for the push that only adds commits.
    expect(
      (await push(u.containerToken, 'web', [[old.id, c1.id, 'refs/heads/develop']], pack([c1])))
        .status,
    ).toBe(200);
  });

  it('GitHub is asked when the new commits sit on commits it has', async () => {
    const u = await containerUser();
    await inTurn(u.id);
    const base = commit([]);
    const mine = commit([]);
    await db()
      .insert(gitCreatedBranches)
      .values({ userId: u.id, owner: 'acme', repo: 'web', branch: 'mine' });
    const c1 = commit([base.id]);
    compare.set(`${mine.id}...${base.id}`, 'ahead');
    expect(
      (await push(u.containerToken, 'web', [[mine.id, c1.id, 'refs/heads/mine']], pack([c1])))
        .status,
    ).toBe(200);
  });

  it('the default branch, deletes and tags stay refused, even with a yes', async () => {
    const u = await containerUser();
    const old = commit([]);
    const c1 = commit([old.id]);
    for (const [cmd, text] of [
      [[old.id, c1.id, 'refs/heads/main'], 'default branch'],
      [[old.id, ZERO, 'refs/heads/develop'], 'Deleting'],
    ] as const) {
      const res = await push(u.containerToken, 'web', [[...cmd]], pack([c1]));
      expect(res.status).toBe(403);
      expect(res.text).toContain(text);
    }
    expect(pushes).toHaveLength(0);
  });

  it("Hermes's pushes meet the same rules (the gateway does not ask which engine runs)", async () => {
    const results: Array<{ status: number; text: string }> = [];
    const engines: Array<string | null> = [];
    const old = commit([]);
    const c1 = commit([old.id]);
    vmFake.state.agent = async (d, mcp) => {
      engines.push(await redis().get(`turn-engine:${d.userId}`));
      results.push(
        await push(
          vmFake.tokens.get(d.userId)!,
          'web',
          [[old.id, c1.id, 'refs/heads/develop']],
          pack([c1]),
        ),
      );
      await mcp('send_message', { text: 'tried', session_key: d.sessionKey });
    };
    const user = await chatUser();
    await connectGithub(user.id);
    await call('/v1/messages', {
      method: 'POST',
      token: user.token,
      body: { text: 'push it', clientMessageId: randomUUID() },
    });
    await waitFor(async () => results.length > 0);
    expect(engines).toEqual(['hermes']);
    expect(results[0]!.status).toBe(403);
    expect(results[0]!.text).toContain("needs your user's OK");
    expect(await approvalsOf(user.id, GIT_PUSH_ACTION)).toHaveLength(1);
  });
});

describe('crew jobs: the brief is the yes for its own branch, nothing more', () => {
  it('refuses the rest, keeps it, and runs the job again with it allowed after the yes', async () => {
    const runs: Array<{ job: string; gate: string; own: number; develop: number }> = [];
    const old = commit([]);
    vmFake.state.agent = async (d, mcp) => {
      const meta = JSON.parse(d.metadataJson ?? '{}') as { crew_job?: { id: string } };
      if (!meta.crew_job) return;
      const token = vmFake.tokens.get(d.userId)!;
      const own = crewBranchName({ id: meta.crew_job.id });
      const c1 = commit([old.id]);
      const ownC = commit([]);
      runs.push({
        job: meta.crew_job.id,
        gate: (await gate(token, curlCall)).body.decision!,
        // Its own branch: even a force push goes through.
        own: (await push(token, 'web', [[old.id, ownC.id, `refs/heads/${own}`]], pack([ownC])))
          .status,
        develop: (await push(token, 'web', [[old.id, c1.id, 'refs/heads/develop']], pack([c1])))
          .status,
      });
      await mcp('send_message', { text: '**Verdict:** done', session_key: d.sessionKey });
    };
    const user = await chatUser({ plan: 'pro' });
    await connectGithub(user.id);
    const job = await expectContract<{ id: string }>(
      'createCrewJob',
      await call('/v1/crew-jobs', {
        method: 'POST',
        token: user.token,
        body: {
          member: 'byte',
          owner: 'acme',
          repo: 'web',
          branch: 'develop',
          instructions: 'Fix the login redirect loop.',
          clientRequestId: randomUUID(),
        },
      }),
      201,
    );
    const rerun = await waitFor(async () => (await approvalsOf(user.id, CREW_RERUN_ACTION))[0]);
    expect(runs).toEqual([{ job: job.id, gate: 'refused', own: 200, develop: 403 }]);
    // Nothing was asked during the run.
    expect(await approvalsOf(user.id, COMMAND_ACTION)).toHaveLength(0);
    expect(await approvalsOf(user.id, GIT_PUSH_ACTION)).toHaveLength(0);
    const done = await expectContract<{ blocked: string[]; status: string }>(
      'getCrewJob',
      await call(`/v1/crew-jobs/${job.id}`, { token: user.token }),
      200,
    );
    expect(done.blocked).toEqual([
      `Run \`${CURL}\` (it reaches the internet)`,
      'Push to the branch "develop" of acme/web, which already existed',
    ]);
    expect(rerun).toMatchObject({ status: 'pending', arguments: { crew_job_id: job.id } });
    expect(rerun.summary).toContain(
      'Run Byte\'s job "Fix the login redirect loop in acme/web" again',
    );
    const card = await expectContract<{ items: Array<Record<string, unknown>> }>(
      'listApprovals',
      await call('/v1/approvals', { token: user.token }),
      200,
    );
    expect(card.items[0]).toMatchObject({ kind: 'crew_rerun', details: { items: done.blocked } });

    await call(`/v1/approvals/${rerun.id}/decision`, {
      method: 'POST',
      token: user.token,
      body: { decision: 'approve' },
    });
    await waitFor(async () => runs.length >= 2);
    const [again] = await db().select().from(crewJobs).where(eq(crewJobs.rerunOf, job.id));
    expect(again).toBeDefined();
    expect(runs[1]).toEqual({ job: again!.id, gate: 'allow', own: 200, develop: 200 });
    expect(again!.approved).toHaveLength(2);
    // Its instruction says what the user approved.
    const delivered = vmFake.deliveries.find((d) => d.text.includes(`[Crew job ${again!.id}]`))!;
    expect(delivered.text).toContain('your user has approved each of them since');
    // The yes is used: answering again does not start a third job.
    expect((await approvalsOf(user.id, CREW_RERUN_ACTION))[0]!.usedAt).not.toBeNull();
  });
});

describe('running a crew job again: the no', () => {
  it('starts nothing and says so in the job’s chat', async () => {
    const user = await chatUser({ plan: 'pro' });
    const id = newId('crj');
    await db()
      .insert(crewJobs)
      .values({
        id,
        userId: user.id,
        member: 'byte',
        status: 'done',
        source: 'chat',
        owner: 'acme',
        repo: 'web',
        instructions: 'Fix the login redirect loop.',
        sessionKey: 'web',
        blocked: [{ kind: 'command', tool: 'Bash', target: CURL, why: 'it reaches the internet' }],
      });
    await offerCrewRerun(user.id, id, null);
    await offerCrewRerun(user.id, id, null); // asked once only
    const asked = await approvalsOf(user.id, CREW_RERUN_ACTION);
    expect(asked).toHaveLength(1);
    await call(`/v1/approvals/${asked[0]!.id}/decision`, {
      method: 'POST',
      token: user.token,
      body: { decision: 'reject' },
    });
    await waitFor(async () =>
      (
        await db()
          .select()
          .from(messages)
          .where(and(eq(messages.userId, user.id), eq(messages.direction, 'out')))
      ).find((m) => m.text === 'OK. I won\'t run "Fix the login redirect loop in acme/web" again.'),
    );
    expect(await db().select().from(crewJobs).where(eq(crewJobs.rerunOf, id))).toHaveLength(0);
    expect(vmFake.deliveries.filter((d) => d.userId === user.id)).toHaveLength(0);
  });
});

describe('what the user reads (Telegram, iMessage)', () => {
  it('says plainly what the command or the push is', () => {
    expect(
      approvalAskText(
        gateSummary({
          tool: 'Write',
          target: '/data/home/.npmrc',
          why: 'it overwrites a file outside the workspace',
        }),
        'telegram',
      ),
    ).toBe(
      "I'd like to write the file /data/home/.npmrc (it overwrites a file outside the workspace). Approve or Deny below.",
    );
    expect(
      approvalAskText(
        pushSummary({ owner: 'acme', repo: 'web', branch: 'develop', force: true }),
        'telegram',
      ),
    ).toBe(
      'I\'d like to force push to the branch "develop" of acme/web (it rewrites the branch\'s history). Approve or Deny below.',
    );
    expect(
      approvalAskText(
        pushSummary({ owner: 'acme', repo: 'web', branch: 'develop', force: false }),
        'imessage',
      ),
    ).toBe('I\'d like to push to the branch "develop" of acme/web, which already existed.');
  });
});
