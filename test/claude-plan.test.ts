// Bring your own AI: agent settings, connecting the user's Claude plan (Claude Code sign-in in the
// container), runtime switching, AI_ACCESS_MODE=own_only, and "the code is never kept anywhere".
import { Writable } from 'node:stream';
import { Code, ConnectError } from '@connectrpc/connect';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../proto-gen/vm/v1/vm_pb.ts';
import { auditLog } from '../src/modules/admin/schema.ts';
import { usagePeriods } from '../src/modules/billing/schema.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { events } from '../src/modules/events/schema.ts';
import { setByokKey, setByokVerifier } from '../src/modules/integrations/byok.ts';
import { decideAccess, getAgentSettings } from '../src/modules/orchestrator/agent-settings.ts';
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
      claude: { connected: false, connectedAt: null },
      ownKeyProviders: [],
    });

    setAiAccessMode('own_only');
    expect(await settingsOf(u.token)).toMatchObject({ effectiveRuntime: null, aiAccess: 'none' });

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
