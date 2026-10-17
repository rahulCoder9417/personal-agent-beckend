// Bring your own AI: agent settings, connecting the user's Claude plan (Claude Code sign-in in the
// container), runtime switching, AI_ACCESS_MODE=own_only, and "the code is never kept anywhere".
import { Writable } from 'node:stream';
import { Code, ConnectError } from '@connectrpc/connect';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../proto-gen/vm/v1/vm_pb.ts';
import { auditLog } from '../src/modules/admin/schema.ts';
import { usagePeriods } from '../src/modules/billing/schema.ts';
import { billTurnJobId, handleBillTurn } from '../src/modules/billing/turn-billing.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { events } from '../src/modules/events/schema.ts';
import { setByokKey, setByokVerifier } from '../src/modules/integrations/byok.ts';
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  decideAccess,
  getAgentSettings,
} from '../src/modules/orchestrator/agent-settings.ts';
import { deleteSandboxRecord, ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { agentSettings } from '../src/modules/orchestrator/schema.ts';
import { vm } from '../src/modules/orchestrator/vm.ts';
import { connectAiText, runTurn } from '../src/modules/orchestrator/turn.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { buildLogger, setLogger } from '../src/shared/logger.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeVm } from './fakes.ts';
import { call, chatUser, createUser, expectContract } from './helpers.ts';

type Settings = {
  runtime: string;
  effectiveRuntime: string | null;
  aiAccess: string;
  claude: { connected: boolean; connectedAt: string | null };
  ownKeyProviders: string[];
  claudeModel: string | null;
  claudeEffort: string | null;
  claudeCrew: Record<CrewMember, CrewChoice>;
  claudeChoices: {
    models: Array<{ id: string; label: string; group: string; efforts: string[]; note?: string }>;
    efforts: string[];
    crewDefaults: Record<CrewMember, CrewChoice>;
  };
};
type CrewMember = 'byte' | 'patch' | 'scout';
type CrewChoice = { model: string | null; effort: string | null };

const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];
const NO_XHIGH = ['low', 'medium', 'high', 'max'];
const FABLE_NOTE =
  'Pro: paid with usage credits. Max: up to half your weekly limit, then usage credits.';
/**
 * The list the web app shows: every Claude model Claude Code can use (Anthropic's models overview
 * and Claude Code's model page, 2026-10-13), the current ones first, then the older ones, newest
 * first; each with the effort levels Claude Code gives it.
 */
const CLAUDE_CHOICES = {
  models: [
    { id: 'claude-opus-5-5', label: 'Opus 5.5', group: 'current', efforts: ALL },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', group: 'current', efforts: ALL },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5', group: 'current', efforts: ALL },
    {
      id: 'claude-fable-5-1',
      label: 'Fable 5.1',
      group: 'current',
      efforts: ALL,
      note: FABLE_NOTE,
    },
    { id: 'claude-fable-5', label: 'Fable 5', group: 'older', efforts: ALL, note: FABLE_NOTE },
    { id: 'claude-opus-5', label: 'Opus 5', group: 'older', efforts: ALL },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', group: 'older', efforts: ALL },
    { id: 'claude-opus-4-8', label: 'Opus 4.8', group: 'older', efforts: ALL },
    { id: 'claude-opus-4-7', label: 'Opus 4.7', group: 'older', efforts: ALL },
    { id: 'claude-opus-4-6', label: 'Opus 4.6', group: 'older', efforts: NO_XHIGH },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', group: 'older', efforts: NO_XHIGH },
    { id: 'claude-opus-4-5', label: 'Opus 4.5', group: 'older', efforts: [] },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', group: 'older', efforts: [] },
  ],
  efforts: ALL,
  // What each crew member left on Default runs (null: the same as Tex).
  crewDefaults: {
    byte: { model: 'claude-opus-5-5', effort: 'medium' },
    patch: { model: 'claude-opus-5-5', effort: 'medium' },
    scout: { model: null, effort: null },
  },
};
type Fake = ReturnType<typeof installFakeVm>;

let fake: Fake;
beforeAll(() => wireModules());
afterAll(async () => {
  await closeQueues();
});
beforeEach(() => {
  fake = installFakeVm();
  setByokVerifier(async () => true);
});
afterEach(() => setAiAccessMode(undefined));

function setAiAccessMode(mode: 'platform' | 'own_only' | undefined): void {
  if (mode) process.env.AI_ACCESS_MODE = mode;
  else delete process.env.AI_ACCESS_MODE;
  resetConfig();
}

async function settingsOf(token: string): Promise<Settings> {
  return expectContract<Settings>(
    'getAgentSettings',
    await call('/v1/agent/settings', { token }),
    200,
  );
}

async function startLogin(token: string) {
  return expectContract<{ loginId: string; authorizeUrl: string; expiresAt: string }>(
    'startClaudeLogin',
    await call('/v1/agent/claude/login', { method: 'POST', token }),
    201,
  );
}

function complete(token: string, loginId: string, code: string) {
  return call(`/v1/agent/claude/login/${loginId}/complete`, {
    method: 'POST',
    token,
    body: { code },
  });
}

/** Signs a user in to Claude through the whole API flow; returns the code that was used. */
async function connectClaude(user: { token: string }): Promise<string> {
  const start = await startLogin(user.token);
  const code = fake.logins.get(start.loginId)!.code;
  await expectContract('completeClaudeLogin', await complete(user.token, start.loginId, code), 200);
  return code;
}

async function outgoing(userId: string): Promise<string[]> {
  const rows = await db()
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.direction, 'out')));
  return rows.map((r) => r.text);
}

function webTurn(userId: string, text = 'hi') {
  return runTurn({
    userId,
    deliveryId: `evt_${Math.random().toString(36).slice(2)}`,
    kind: 'message',
    sessionKey: 'web',
    channel: 'web',
    text,
  });
}

describe('who runs and who pays (effectiveRuntime / aiAccess)', () => {
  it('follows the rule in order: Claude plan → own key → platform → none', () => {
    const base = { runtime: 'hermes' as const, claudeConnected: false, hasOwnKey: false };
    const cases = [
      [{ runtime: 'claude_code', claudeConnected: true }, 'platform', 'claude_code', 'claude_plan'],
      [
        { runtime: 'claude_code', claudeConnected: true, hasOwnKey: true },
        'platform',
        'claude_code',
        'claude_plan',
      ],
      [{ claudeConnected: true, hasOwnKey: true }, 'own_only', 'hermes', 'own_key'],
      [{ hasOwnKey: true }, 'platform', 'hermes', 'own_key'],
      [{}, 'platform', 'hermes', 'platform'],
      [{ claudeConnected: true }, 'platform', 'hermes', 'platform'],
      // own_only: a connected plan is the only AI source, so Claude Code runs.
      [{ claudeConnected: true }, 'own_only', 'claude_code', 'claude_plan'],
      [{}, 'own_only', null, 'none'],
    ] as const;
    for (const [over, mode, effectiveRuntime, aiAccess] of cases) {
      expect(decideAccess({ ...base, ...over, mode }), JSON.stringify({ over, mode })).toEqual({
        effectiveRuntime,
        aiAccess,
      });
    }
  });

  it('GET /v1/agent/settings: platform by default, own_key with a BYOK key, none in own_only', async () => {
    const u = await createUser();
    await expectContract('getAgentSettings', await call('/v1/agent/settings'), 401);
    expect(await settingsOf(u.token)).toEqual({
      runtime: 'hermes',
      effectiveRuntime: 'hermes',
      aiAccess: 'platform',
      aiPreference: 'auto',
      platformAvailable: true,
      claude: { connected: false, connectedAt: null },
      ownKeyProviders: [],
      claudeModel: null,
      claudeEffort: null,
      claudeCrew: {
        byte: { model: null, effort: null },
        patch: { model: null, effort: null },
        scout: { model: null, effort: null },
      },
      claudeChoices: CLAUDE_CHOICES,
    });

    setAiAccessMode('own_only');
    expect(await settingsOf(u.token)).toMatchObject({
      effectiveRuntime: null,
      aiAccess: 'none',
      platformAvailable: false,
    });

    await setByokKey(u.id, 'anthropic', 'sk-ant-test-1234', null);
    expect(await settingsOf(u.token)).toMatchObject({
      effectiveRuntime: 'hermes',
      aiAccess: 'own_key',
      ownKeyProviders: ['anthropic'],
    });
  });
});

describe('connecting a Claude plan', () => {
  it('start → Anthropic URL → complete with the right code → Claude Code runs', async () => {
    const u = await createUser();
    const start = await startLogin(u.token);
    expect(start.authorizeUrl).toMatch(/^https:\/\/claude\.ai\//);
    expect(new Date(start.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(fake.created).toContain(u.id); // ensureSandbox ran first

    const code = fake.logins.get(start.loginId)!.code;
    const s = await expectContract<Settings>(
      'completeClaudeLogin',
      await complete(u.token, start.loginId, code),
      200,
    );
    expect(s).toMatchObject({
      runtime: 'claude_code',
      effectiveRuntime: 'claude_code',
      aiAccess: 'claude_plan',
      claude: { connected: true },
    });
    expect(s.claude.connectedAt).not.toBeNull();
    expect(fake.runtimeCalls).toContainEqual({ userId: u.id, runtime: AgentRuntime.CLAUDE_CODE });
    expect(fake.runtimes.get(u.id)).toBe(AgentRuntime.CLAUDE_CODE);

    const audits = await db().select().from(auditLog).where(eq(auditLog.userId, u.id));
    expect(audits.map((a) => a.action)).toContain('claude_connected');
  });

  it('a wrong code → 400 with the safe message; an unknown or foreign loginId → 404', async () => {
    const u = await createUser();
    const other = await createUser();
    const start = await startLogin(u.token);

    const wrong = await expectContract<{ error: { code: string; message: string } }>(
      'completeClaudeLogin',
      await complete(u.token, start.loginId, 'not-the-code'),
      400,
    );
    expect(wrong.error.message).toBe('That code is wrong or expired. Start again.');
    expect((await settingsOf(u.token)).claude.connected).toBe(false);

    await expectContract('completeClaudeLogin', await complete(u.token, 'login_nope', 'abcd'), 404);
    await expectContract(
      'completeClaudeLogin',
      await complete(other.token, start.loginId, 'abcd'),
      404,
    );
    // The vm-manager can also refuse with FAILED_PRECONDITION (e.g. expired sign-in).
    const client = vm() as unknown as { completeClaudeLogin: () => Promise<unknown> };
    const orig = client.completeClaudeLogin;
    client.completeClaudeLogin = async () => {
      throw new ConnectError('The sign-in expired. Start again.', Code.FailedPrecondition);
    };
    const expired = await expectContract<{ error: { message: string } }>(
      'completeClaudeLogin',
      await complete(u.token, 'login_expired', 'abcd'),
      400,
    );
    expect(expired.error.message).toBe('The sign-in expired. Start again.');
    client.completeClaudeLogin = orig;

    // Body validation: the code is required and at least 4 characters.
    await expectContract('completeClaudeLogin', await complete(u.token, start.loginId, 'ab'), 400);
    await expectContract(
      'completeClaudeLogin',
      await call(`/v1/agent/claude/login/${start.loginId}/complete`, { method: 'POST' }),
      401,
    );
  });

  it('start is rate limited (10 per hour per user) and 503 when the container is unavailable', async () => {
    const u = await createUser();
    await expectContract(
      'startClaudeLogin',
      await call('/v1/agent/claude/login', { method: 'POST' }),
      401,
    );
    fake.state.claudeError = new ConnectError('server full', Code.ResourceExhausted);
    await expectContract(
      'startClaudeLogin',
      await call('/v1/agent/claude/login', { method: 'POST', token: u.token }),
      503,
    );
    for (let i = 0; i < 9; i++) await startLogin(u.token);
    const limited = await call('/v1/agent/claude/login', { method: 'POST', token: u.token });
    await expectContract('startClaudeLogin', limited, 429);
  });

  it('the code never appears in logs, the audit log, events or messages', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    setLogger(buildLogger(sink, 'trace'));
    try {
      const u = await createUser();
      const start = await startLogin(u.token);
      const wrongCode = 'wrong-code-9f8e7d6c-secret';
      await expectContract(
        'completeClaudeLogin',
        await complete(u.token, start.loginId, wrongCode),
        400,
      );
      const code = fake.logins.get(start.loginId)!.code;
      await expectContract(
        'completeClaudeLogin',
        await complete(u.token, start.loginId, code),
        200,
      );

      const logged = lines.join('');
      expect(logged).toContain('"route":"/v1/agent/claude/login/:loginId/complete"'); // capture works
      for (const secret of [code, wrongCode]) {
        expect(logged).not.toContain(secret);
        const tables = await Promise.all([
          db().select().from(auditLog).where(eq(auditLog.userId, u.id)),
          db().select().from(events).where(eq(events.userId, u.id)),
          db().select().from(messages).where(eq(messages.userId, u.id)),
          db().select().from(agentSettings).where(eq(agentSettings.userId, u.id)),
        ]);
        expect(JSON.stringify(tables)).not.toContain(secret);
      }

      // Belt and braces: a `code` field is redacted wherever it's logged.
      buildLogger(sink, 'trace').info({ code: 'top-secret-1', body: { code: 'nested-secret-2' } });
      buildLogger(sink, 'trace').info({ req: { body: { code: 'deep-secret-3' } } });
      const after = lines.join('');
      expect(after).not.toMatch(/top-secret-1|nested-secret-2|deep-secret-3/);
    } finally {
      setLogger(undefined);
    }
  });
});

describe('switching the agent and disconnecting', () => {
  it('PATCH runtime: claude_code without a plan → 409; with a plan it switches both ways', async () => {
    const u = await createUser();
    await expectContract(
      'updateAgentSettings',
      await call('/v1/agent/settings', {
        method: 'PATCH',
        token: u.token,
        body: { runtime: 'claude_code' },
      }),
      409,
    );
    await expectContract(
      'updateAgentSettings',
      await call('/v1/agent/settings', {
        method: 'PATCH',
        token: u.token,
        body: { runtime: 'gpt' },
      }),
      400,
    );
    await expectContract(
      'updateAgentSettings',
      await call('/v1/agent/settings', { method: 'PATCH', body: { runtime: 'hermes' } }),
      401,
    );

    await connectClaude(u);
    const toHermes = await expectContract<Settings>(
      'updateAgentSettings',
      await call('/v1/agent/settings', {
        method: 'PATCH',
        token: u.token,
        body: { runtime: 'hermes' },
      }),
      200,
    );
    expect(toHermes).toMatchObject({
      runtime: 'hermes',
      effectiveRuntime: 'hermes',
      aiAccess: 'platform',
      claude: { connected: true },
    });
    expect(fake.runtimes.get(u.id)).toBe(AgentRuntime.HERMES);

    const back = await expectContract<Settings>(
      'updateAgentSettings',
      await call('/v1/agent/settings', {
        method: 'PATCH',
        token: u.token,
        body: { runtime: 'claude_code' },
      }),
      200,
    );
    expect(back).toMatchObject({ effectiveRuntime: 'claude_code', aiAccess: 'claude_plan' });
    expect(fake.runtimes.get(u.id)).toBe(AgentRuntime.CLAUDE_CODE);
  });

  it('DELETE /v1/agent/claude signs Claude Code out and goes back to Hermes', async () => {
    const u = await createUser();
    await expectContract(
      'disconnectClaude',
      await call('/v1/agent/claude', { method: 'DELETE' }),
      401,
    );
    await connectClaude(u);
    await expectContract(
      'disconnectClaude',
      await call('/v1/agent/claude', { method: 'DELETE', token: u.token }),
      204,
    );
    expect(fake.logouts).toContain(u.id);
    expect(fake.claudeConnected.has(u.id)).toBe(false);
    expect(fake.runtimes.get(u.id)).toBe(AgentRuntime.HERMES);
    expect(await settingsOf(u.token)).toMatchObject({
      runtime: 'hermes',
      effectiveRuntime: 'hermes',
      claude: { connected: false, connectedAt: null },
    });
    const audits = await db().select().from(auditLog).where(eq(auditLog.userId, u.id));
    expect(audits.map((a) => a.action)).toContain('claude_disconnected');
    // Without a container it still works (nothing to sign out of).
    const fresh = await createUser();
    await expectContract(
      'disconnectClaude',
      await call('/v1/agent/claude', { method: 'DELETE', token: fresh.token }),
      204,
    );
    // vm-manager down → 503 (documented), the user can retry.
    await connectClaude(fresh);
    fake.state.claudeError = new ConnectError('vm-manager down', Code.Unavailable);
    await expectContract(
      'disconnectClaude',
      await call('/v1/agent/claude', { method: 'DELETE', token: fresh.token }),
      503,
    );
  });

  it('a new container is created with the runtime from the settings', async () => {
    const u = await createUser();
    await ensureSandbox(u.id);
    expect(fake.runtimes.get(u.id)).toBe(AgentRuntime.HERMES);

    await connectClaude(u);
    fake.tokens.delete(u.id);
    fake.runtimes.delete(u.id);
    await deleteSandboxRecord(u.id);
    await ensureSandbox(u.id);
    expect(fake.runtimes.get(u.id)).toBe(AgentRuntime.CLAUDE_CODE);
  });
});

describe('turns', () => {
  it('own_only with no API key and no Claude plan → "connect your AI", no wake, no delivery', async () => {
    setAiAccessMode('own_only');
    const u = await chatUser();
    expect(await webTurn(u.id)).toBe('simple');
    expect(await outgoing(u.id)).toEqual([connectAiText()]);
    expect(connectAiText()).toBe(
      'Connect your own AI first: add an API key or connect your Claude plan at http://web.test/settings/ai',
    );
    expect(fake.deliveries).toHaveLength(0);
    expect(fake.created).not.toContain(u.id);
  });

  it('own_only with an own key → Hermes runs as usual', async () => {
    setAiAccessMode('own_only');
    const u = await chatUser();
    await setByokKey(u.id, 'openai', 'sk-test-5678', null);
    expect(await webTurn(u.id)).toBe('done');
    expect(fake.deliveries.map((d) => d.userId)).toEqual([u.id]);
    expect(fake.runtimes.get(u.id)).toBe(AgentRuntime.HERMES);
  });

  it("a Claude plan user's turn delivers to Claude Code and charges no AI credits (awake time only)", async () => {
    const u = await chatUser();
    await connectClaude(u);
    fake.runtimes.set(u.id, AgentRuntime.HERMES); // drifted: the turn re-syncs after the wake
    fake.state.usage.set(u.id, { awakeSeconds: 1200n, browserSeconds: 0n });

    expect(await webTurn(u.id, 'plan my week')).toBe('done');
    expect(fake.deliveries.map((d) => d.text)).toEqual(['plan my week']);
    expect(fake.runtimes.get(u.id)).toBe(AgentRuntime.CLAUDE_CODE);
    expect(await outgoing(u.id)).toContain('echo: plan my week');

    // The turn only queued its billing, marked as a Claude plan turn (LiteLLM is not asked).
    expect(await db().select().from(usagePeriods).where(eq(usagePeriods.userId, u.id))).toEqual([]);
    const job = await queue('system').getJob(billTurnJobId(fake.deliveries[0]!.deliveryId));
    expect(job!.data).toEqual({ userId: u.id, turnId: fake.deliveries[0]!.deliveryId, ai: false });
    await handleBillTurn(job!);

    const periods = await db().select().from(usagePeriods).where(eq(usagePeriods.userId, u.id));
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ aiCostMicroUsd: 0, aiCredits: 0, awakeCredits: 2 });
    expect(periods[0]!.creditsCharged).toBe(2);
  });

  it('own_only + a connected plan but Hermes chosen and no key → Claude Code runs', async () => {
    setAiAccessMode('own_only');
    const u = await chatUser();
    await connectClaude(u);
    await expectContract(
      'updateAgentSettings',
      await call('/v1/agent/settings', {
        method: 'PATCH',
        token: u.token,
        body: { runtime: 'hermes' },
      }),
      200,
    );
    expect(await getAgentSettings(u.id)).toMatchObject({
      runtime: 'hermes',
      effectiveRuntime: 'claude_code',
      aiAccess: 'claude_plan',
    });
    expect(await webTurn(u.id)).toBe('done');
    expect(fake.runtimes.get(u.id)).toBe(AgentRuntime.CLAUDE_CODE);
  });

  it('Claude sign-in gone (vm-manager says not connected) → error reply, back to Hermes for the next turn', async () => {
    const u = await chatUser();
    await connectClaude(u);
    fake.claudeConnected.delete(u.id); // e.g. the user revoked access on claude.ai
    fake.state.turnError = { message: 'Connect your Claude plan again', platformFault: false };

    expect(await webTurn(u.id)).toBe('error');
    const out = await outgoing(u.id);
    expect(out).toContain("I couldn't finish that: Connect your Claude plan again");
    expect(out.some((t) => t.startsWith('Your Claude plan is no longer connected'))).toBe(true);
    expect(await getAgentSettings(u.id)).toMatchObject({
      runtime: 'hermes',
      effectiveRuntime: 'hermes',
      claude: { connected: false },
    });
    expect(fake.runtimes.get(u.id)).toBe(AgentRuntime.HERMES);

    expect(await webTurn(u.id, 'again')).toBe('done');
    expect(fake.deliveries.map((d) => d.text)).toEqual(['hi', 'again']);
  });

  it('an ordinary error for a connected Claude user keeps the plan connected', async () => {
    const u = await chatUser();
    await connectClaude(u);
    fake.state.turnError = { message: 'the website timed out', platformFault: false };
    expect(await webTurn(u.id)).toBe('error');
    expect((await getAgentSettings(u.id)).effectiveRuntime).toBe('claude_code');
  });
});

describe('Claude Code model and effort', () => {
  const patch = (token: string, body: unknown) =>
    call('/v1/agent/settings', { method: 'PATCH', token, body });
  /** The delivery's `metadata_json`, read back. */
  const metadataOf = (i = -1) =>
    JSON.parse((fake.deliveries.at(i) as unknown as { metadataJson: string }).metadataJson) as {
      claude?: { model?: string; effort?: string };
    };

  it('PATCH sets and clears them, with or without a Claude plan; GET lists the choices', async () => {
    const u = await createUser();
    // Saved while Hermes runs: they wait for the turns that run on Claude Code.
    const set = await expectContract<Settings>(
      'updateAgentSettings',
      await patch(u.token, { claudeModel: 'claude-opus-5-5', claudeEffort: 'xhigh' }),
      200,
    );
    expect(set).toMatchObject({
      effectiveRuntime: 'hermes',
      claudeModel: 'claude-opus-5-5',
      claudeEffort: 'xhigh',
      claudeChoices: CLAUDE_CHOICES,
    });
    expect(await settingsOf(u.token)).toMatchObject({
      claudeModel: 'claude-opus-5-5',
      claudeEffort: 'xhigh',
    });

    // One at a time; the other stays.
    expect(
      await expectContract<Settings>(
        'updateAgentSettings',
        await patch(u.token, { claudeEffort: 'low' }),
        200,
      ),
    ).toMatchObject({ claudeModel: 'claude-opus-5-5', claudeEffort: 'low' });
    // Null goes back to Claude Code's own default.
    expect(
      await expectContract<Settings>(
        'updateAgentSettings',
        await patch(u.token, { claudeModel: null, claudeEffort: null }),
        200,
      ),
    ).toMatchObject({ claudeModel: null, claudeEffort: null });

    // Together with the runtime, once a plan is connected.
    await connectClaude(u);
    expect(
      await expectContract<Settings>(
        'updateAgentSettings',
        await patch(u.token, {
          runtime: 'claude_code',
          claudeModel: 'claude-fable-5-1',
          claudeEffort: 'max',
        }),
        200,
      ),
    ).toMatchObject({
      effectiveRuntime: 'claude_code',
      claudeModel: 'claude-fable-5-1',
      claudeEffort: 'max',
    });
  });

  it('every model on the list can be chosen, and a Claude Code turn carries it', async () => {
    const u = await chatUser();
    await connectClaude(u);
    for (const { id } of CLAUDE_CHOICES.models) {
      expect(
        await expectContract<Settings>(
          'updateAgentSettings',
          await patch(u.token, { claudeModel: id }),
          200,
        ),
        id,
      ).toMatchObject({ claudeModel: id });
      expect(await webTurn(u.id, `on ${id}`)).toBe('done');
      expect(metadataOf().claude, id).toEqual({ model: id });
    }
  });

  it('the list: no id twice, current before older, each model with levels from the full ladder', () => {
    const ids = CLAUDE_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const groups = CLAUDE_MODELS.map((m) => m.group);
    expect(groups).toEqual([...groups].sort((a, b) => (a === b ? 0 : a === 'current' ? -1 : 1)));
    for (const m of CLAUDE_MODELS) {
      // Lowest first, in the order of CLAUDE_EFFORTS.
      expect(m.efforts, m.id).toEqual(CLAUDE_EFFORTS.filter((e) => m.efforts.includes(e)));
    }
  });

  it('a model or an effort that is not on the list → 400 invalid_request, nothing saved', async () => {
    const u = await createUser();
    await expectContract(
      'updateAgentSettings',
      await patch(u.token, { claudeEffort: 'high' }),
      200,
    );
    for (const body of [
      { claudeModel: 'claude-opus-4' },
      { claudeModel: 'opus' },
      { claudeModel: '' },
      { claudeModel: 'claude-opus-5-5', claudeEffort: 'ultra' },
      { claudeEffort: 3 },
    ]) {
      const err = await expectContract<{ error: { code: string } }>(
        'updateAgentSettings',
        await patch(u.token, body),
        400,
      );
      expect(err.error.code, JSON.stringify(body)).toBe('invalid_request');
    }
    expect(await settingsOf(u.token)).toMatchObject({ claudeModel: null, claudeEffort: 'high' });
  });

  it('a Claude Code turn carries them in metadata_json; Hermes turns do not', async () => {
    const u = await chatUser();
    await connectClaude(u);
    // Nothing chosen: the `claude` field is there, empty (the CLI's defaults).
    expect(await webTurn(u.id, 'first')).toBe('done');
    expect(metadataOf().claude).toEqual({});

    await patch(u.token, { claudeModel: 'claude-opus-5-5', claudeEffort: 'xhigh' });
    expect(await webTurn(u.id, 'second')).toBe('done');
    expect(metadataOf().claude).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' });

    await patch(u.token, { claudeModel: null });
    expect(await webTurn(u.id, 'third')).toBe('done');
    expect(metadataOf().claude).toEqual({ effort: 'xhigh' });

    // Hermes runs: the choice is kept but not sent.
    await patch(u.token, { runtime: 'hermes' });
    expect(await webTurn(u.id, 'fourth')).toBe('done');
    expect(metadataOf()).not.toHaveProperty('claude');
    expect(await settingsOf(u.token)).toMatchObject({ claudeEffort: 'xhigh' });
  });

  it('a model taken off the list is treated as the default', async () => {
    const u = await chatUser();
    await connectClaude(u);
    await db()
      .update(agentSettings)
      .set({ claudeModel: 'claude-retired-1', claudeEffort: 'medium' })
      .where(eq(agentSettings.userId, u.id));
    expect(await settingsOf(u.token)).toMatchObject({ claudeModel: null, claudeEffort: 'medium' });
    expect(await webTurn(u.id)).toBe('done');
    expect(metadataOf().claude).toEqual({ effort: 'medium' });
  });

  it('the plan refuses the model: the turn ends with the CLI message, not our fault, settings kept', async () => {
    const u = await chatUser();
    await connectClaude(u);
    await patch(u.token, { claudeModel: 'claude-fable-5-1' });
    fake.state.turnError = {
      message: 'Claude Fable 5.1 is not available on your plan',
      platformFault: false,
    };
    expect(await webTurn(u.id)).toBe('error');
    const out = await outgoing(u.id);
    expect(out).toEqual(["I couldn't finish that: Claude Fable 5.1 is not available on your plan"]);
    expect(await settingsOf(u.token)).toMatchObject({
      effectiveRuntime: 'claude_code',
      claudeModel: 'claude-fable-5-1',
    });
  });
});

describe('the crew’s own models and efforts (Claude Code)', () => {
  const patch = (token: string, body: unknown) =>
    call('/v1/agent/settings', { method: 'PATCH', token, body });
  const metadataOf = (i = -1) =>
    JSON.parse((fake.deliveries.at(i) as unknown as { metadataJson: string }).metadataJson) as {
      claude?: { model?: string; effort?: string; crew?: Record<string, unknown> };
    };
  const onDefault = { model: null, effort: null };
  const allDefault = { byte: onDefault, patch: onDefault, scout: onDefault };

  it('GET: every member on Default, and what Default is for each (as the Bridge runs it)', async () => {
    const u = await createUser();
    const s = await settingsOf(u.token);
    expect(s.claudeCrew).toEqual(allDefault);
    expect(s.claudeChoices.crewDefaults).toEqual(CLAUDE_CHOICES.crewDefaults);
    // Default for Byte and Patch is a model on the list.
    const ids = s.claudeChoices.models.map((m) => m.id);
    expect(ids).toContain(s.claudeChoices.crewDefaults.byte.model);
    expect(ids).toContain(s.claudeChoices.crewDefaults.patch.model);
  });

  it('PATCH sets one member at a time; only the fields sent change; null goes back to Default', async () => {
    const u = await createUser();
    const set = await expectContract<Settings>(
      'updateAgentSettings',
      await patch(u.token, {
        claudeCrew: { patch: { model: 'claude-sonnet-5-5', effort: 'low' } },
      }),
      200,
    );
    // Tex's own choice is not touched, nor are the other members.
    expect(set).toMatchObject({ claudeModel: null, claudeEffort: null });
    expect(set.claudeCrew).toEqual({
      ...allDefault,
      patch: { model: 'claude-sonnet-5-5', effort: 'low' },
    });

    // Only the effort: the model stays. Another member: the first stays.
    const next = await expectContract<Settings>(
      'updateAgentSettings',
      await patch(u.token, {
        claudeModel: 'claude-opus-5-5',
        claudeCrew: { patch: { effort: 'high' }, byte: { model: 'claude-haiku-5-5' } },
      }),
      200,
    );
    expect(next.claudeModel).toBe('claude-opus-5-5');
    expect(next.claudeCrew).toEqual({
      byte: { model: 'claude-haiku-5-5', effort: null },
      patch: { model: 'claude-sonnet-5-5', effort: 'high' },
      scout: onDefault,
    });
    expect((await settingsOf(u.token)).claudeCrew).toEqual(next.claudeCrew);

    // Tex's choice changes nothing for the crew.
    const tex = await expectContract<Settings>(
      'updateAgentSettings',
      await patch(u.token, { claudeModel: null, claudeEffort: 'max' }),
      200,
    );
    expect(tex.claudeCrew).toEqual(next.claudeCrew);

    // Back to Default.
    const back = await expectContract<Settings>(
      'updateAgentSettings',
      await patch(u.token, {
        claudeCrew: { patch: { model: null, effort: null }, byte: { model: null } },
      }),
      200,
    );
    expect(back.claudeCrew).toEqual(allDefault);
    const [row] = await db().select().from(agentSettings).where(eq(agentSettings.userId, u.id));
    expect(row?.claudeCrew).toBeNull();
  });

  it('a wrong model, effort or member → 400 invalid_request, nothing saved', async () => {
    const u = await createUser();
    await patch(u.token, { claudeCrew: { scout: { effort: 'high' } } });
    for (const body of [
      { claudeCrew: { byte: { model: 'claude-opus-4' } } },
      { claudeCrew: { byte: { model: 'opus' } } },
      { claudeCrew: { patch: { model: '' } } },
      { claudeCrew: { patch: { effort: 'ultra' } } },
      { claudeCrew: { tex: { model: 'claude-opus-5-5' } } },
      { claudeCrew: { byte: { model: 'claude-opus-5-5', color: 'red' } } },
      { claudeCrew: { byte: {} } },
      { claudeCrew: {} },
      { claudeCrew: { byte: 'claude-opus-5-5' } },
    ]) {
      const err = await expectContract<{ error: { code: string } }>(
        'updateAgentSettings',
        await patch(u.token, body),
        400,
      );
      expect(err.error.code, JSON.stringify(body)).toBe('invalid_request');
    }
    expect((await settingsOf(u.token)).claudeCrew).toEqual({
      ...allDefault,
      scout: { model: null, effort: 'high' },
    });
  });

  it('a Claude Code turn carries the members off Default under claude.crew; Hermes turns do not', async () => {
    const u = await chatUser();
    await connectClaude(u);
    // Everyone on Default: no `crew` at all.
    expect(await webTurn(u.id, 'first')).toBe('done');
    expect(metadataOf().claude).toEqual({});

    await patch(u.token, {
      claudeCrew: {
        patch: { model: 'claude-sonnet-5-5', effort: 'low' },
        scout: { model: 'claude-haiku-5-5' },
      },
    });
    expect(await webTurn(u.id, 'second')).toBe('done');
    expect(metadataOf().claude).toEqual({
      crew: {
        patch: { model: 'claude-sonnet-5-5', effort: 'low' },
        scout: { model: 'claude-haiku-5-5' },
      },
    });

    // With Tex's own choice next to it.
    await patch(u.token, {
      claudeModel: 'claude-opus-5-5',
      claudeCrew: { scout: { model: null } },
    });
    expect(await webTurn(u.id, 'third')).toBe('done');
    expect(metadataOf().claude).toEqual({
      model: 'claude-opus-5-5',
      crew: { patch: { model: 'claude-sonnet-5-5', effort: 'low' } },
    });

    // Hermes runs: the choices are kept but not sent.
    await patch(u.token, { runtime: 'hermes' });
    expect(await webTurn(u.id, 'fourth')).toBe('done');
    expect(metadataOf()).not.toHaveProperty('claude');
    expect((await settingsOf(u.token)).claudeCrew.patch).toEqual({
      model: 'claude-sonnet-5-5',
      effort: 'low',
    });
  });

  it('a stored value that is no longer on offer counts as Default', async () => {
    const u = await chatUser();
    await connectClaude(u);
    await db()
      .update(agentSettings)
      .set({
        claudeCrew: {
          byte: { model: 'claude-retired-1', effort: 'medium' },
          patch: { model: 'claude-opus-5-5', effort: 'extreme' },
          ...({ tex: { model: 'claude-opus-5-5' } } as object),
        },
      })
      .where(eq(agentSettings.userId, u.id));
    expect((await settingsOf(u.token)).claudeCrew).toEqual({
      byte: { model: null, effort: 'medium' },
      patch: { model: 'claude-opus-5-5', effort: null },
      scout: onDefault,
    });
    expect(await webTurn(u.id)).toBe('done');
    expect(metadataOf().claude).toEqual({
      crew: { byte: { effort: 'medium' }, patch: { model: 'claude-opus-5-5' } },
    });
  });
});
