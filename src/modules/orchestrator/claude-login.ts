// Connect the user's own Claude plan (Anthropic's rules: code.claude.com/docs/en/legal-and-compliance).
// The sign-in runs in the unmodified Claude Code inside the user's container, on Anthropic's own
// page. We NEVER collect, store or log Claude credentials or tokens: the code the user pastes goes
// straight to CompleteClaudeLogin and nowhere else (no log, no audit, no event, no table).
import { Code, ConnectError } from '@connectrpc/connect';
import { AppError, badRequest, notFound } from '../../shared/errors.ts';
import { enforce } from '../../shared/rate-limit.ts';
import { audit } from '../admin/audit.ts';
import {
  markClaudeDisconnected,
  markClaudeConnected,
  type AgentSettingsView,
} from './agent-settings.ts';
import { ensureSandbox } from './sandbox.ts';
import { vm } from './vm.ts';

export interface ClaudeLoginStartView {
  loginId: string;
  authorizeUrl: string;
  expiresAt: Date;
}

const unavailable = () =>
  new AppError(503, 'unavailable', 'Your agent is not reachable right now. Please try again.');

/** Busy server or vm-manager down → 503 (retry). Anything else is a real error. */
function mapVmError(err: unknown): never {
  if (
    err instanceof ConnectError &&
    [Code.Unavailable, Code.ResourceExhausted, Code.DeadlineExceeded].includes(err.code)
  )
    throw unavailable();
  throw err;
}

/** POST /v1/agent/claude/login: wakes the container and starts Claude Code's own sign-in. */
export async function startClaudeLogin(userId: string): Promise<ClaudeLoginStartView> {
  await enforce({ key: `claude-login:user:${userId}`, max: 10, windowSeconds: 3600 });
  try {
    await ensureSandbox(userId);
    const res = await vm().startClaudeLogin({ userId });
    return {
      loginId: res.loginId,
      authorizeUrl: res.authorizeUrl,
      expiresAt: new Date(Number(res.expiresAtUnixMs)),
    };
  } catch (err) {
    mapVmError(err);
  }
}

/**
 * POST /v1/agent/claude/login/{loginId}/complete. `code` is handed to the waiting sign-in and
 * dropped: it must never be logged, stored, audited or put in an event.
 */
export async function completeClaudeLogin(
  userId: string,
  loginId: string,
  code: string,
): Promise<AgentSettingsView> {
  let res: { connected: boolean; message: string };
  try {
    res = await vm().completeClaudeLogin({ userId, loginId, code });
  } catch (err) {
    if (err instanceof ConnectError) {
      if (err.code === Code.NotFound) throw notFound('Sign-in not found or already finished');
      if (err.code === Code.FailedPrecondition || err.code === Code.InvalidArgument)
        throw badRequest(err.rawMessage || 'That code did not work. Start again.');
    }
    mapVmError(err);
  }
  if (!res.connected) throw badRequest(res.message || 'That code did not work. Start again.');
  const settings = await markClaudeConnected(userId);
  await audit({
    userId,
    actor: 'user',
    action: 'claude_connected',
    summary: 'Connected Claude plan; Claude Code is now the agent',
  });
  return settings;
}

/** DELETE /v1/agent/claude: signs Claude Code out in the container, then back to Hermes. */
export async function disconnectClaude(userId: string): Promise<void> {
  try {
    await vm().claudeLogout({ userId });
  } catch (err) {
    // No container: nothing to sign out of.
    if (!(err instanceof ConnectError && err.code === Code.NotFound)) mapVmError(err);
  }
  await markClaudeDisconnected(userId);
  await audit({
    userId,
    actor: 'user',
    action: 'claude_disconnected',
    summary: 'Disconnected Claude plan; the agent is back on Hermes',
  });
}
