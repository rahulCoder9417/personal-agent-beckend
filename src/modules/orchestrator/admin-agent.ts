// Support's view of one user's agent and container, and the few things support may do to it
// (docs/backend-report.md, "Admin tools"). Everything goes through the vm-manager's existing calls
// and the orchestrator's own functions, the same ones a turn or the user's own settings use. Every
// change is written to the audit log with the admin's id and the reason. Nothing here returns a
// container token, a Bridge secret or a key.
import { Code, ConnectError } from '@connectrpc/connect';
import type { Sandbox } from '../../../proto-gen/vm/v1/vm_pb.ts';
import { conflict, notFound, unavailable } from '../../shared/errors.ts';
import { logger } from '../../shared/logger.ts';
import { audit } from '../admin/audit.ts';
import { getActiveUser, type PlanId } from '../auth/users.ts';
import { publish } from '../channels/stream.ts';
import {
  getAgentSettings,
  syncRuntimeAfterWake,
  updateAgentSettings,
  type AgentSettingsView,
  type RuntimeName,
} from './agent-settings.ts';
import { browserAvailable, browserWanted, syncBrowser, syncBrowserAfterWake } from './browser.ts';
import { agentStateOf, ensureSandbox, type AgentState } from './sandbox.ts';
import { userHasCredits } from './turn.ts';
import { AgentRuntime, planPriority, SandboxState, vm } from './vm.ts';

export interface AdminContainerView {
  /** False: the vm-manager could not be asked; the rest is unknown. */
  reachable: boolean;
  state: AgentState | 'unknown';
  busy: boolean | null;
  lastActiveAt: Date | null;
  imageVersion: string | null;
  memoryBytes: number | null;
  /** The engine the vm-manager has on record for the container. */
  engine: RuntimeName | null;
  claudeSignedIn: boolean | null;
  browserOn: boolean | null;
}

const NO_CONTAINER: AdminContainerView = {
  reachable: true,
  state: 'none',
  busy: false,
  lastActiveAt: null,
  imageVersion: null,
  memoryBytes: null,
  engine: null,
  claudeSignedIn: null,
  browserOn: null,
};

const UNREACHABLE: AdminContainerView = {
  ...NO_CONTAINER,
  reachable: false,
  state: 'unknown',
  busy: null,
};

/** The vm-manager's record, without the container id, its allowlist or anything secret. */
export function containerView(s: Sandbox | undefined): AdminContainerView {
  if (!s) return NO_CONTAINER;
  const lastActive = Number(s.lastActiveAtUnixMs ?? 0n);
  const memory = Number(s.memoryBytes ?? 0n);
  return {
    reachable: true,
    state: agentStateOf(s.state),
    busy: s.state === SandboxState.BUSY,
    lastActiveAt: lastActive > 0 ? new Date(lastActive) : null,
    imageVersion: s.imageVersion || null,
    memoryBytes: memory > 0 ? memory : null,
    engine: s.runtime === AgentRuntime.CLAUDE_CODE ? 'claude_code' : 'hermes',
    claudeSignedIn: s.claudeConnected ?? false,
    browserOn: s.browserEnabled ?? false,
  };
}

/** The container as the vm-manager reports it now. Never throws. */
export async function adminContainer(userId: string): Promise<AdminContainerView> {
  try {
    return containerView(await vm().getSandbox({ userId }));
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.NotFound) return NO_CONTAINER;
    logger().warn({ userId, err: String(err) }, 'admin view: vm-manager not reachable');
    return UNREACHABLE;
  }
}

export interface AdminAgentView {
  container: AdminContainerView;
  settings: AgentSettingsView;
  browser: { available: boolean; wanted: boolean; onRecord: boolean | null };
}

export async function adminAgentView(userId: string, plan: PlanId): Promise<AdminAgentView> {
  const [container, settings] = await Promise.all([
    adminContainer(userId),
    getAgentSettings(userId),
  ]);
  return {
    container,
    settings,
    browser: {
      available: browserAvailable(),
      wanted: browserWanted(plan),
      onRecord: container.browserOn,
    },
  };
}

export interface AdminAction {
  userId: string;
  adminId: string;
  /** Why: kept in the audit log's details, never in the summary the user sees. */
  reason: string;
}

async function activeUser(userId: string) {
  const user = await getActiveUser(userId);
  if (!user) throw notFound('User not found');
  return user;
}

/** A vm-manager error in support's words. */
function vmError(err: unknown, what: string): unknown {
  if (!(err instanceof ConnectError)) return err;
  if (err.code === Code.NotFound) return notFound('This user has no container');
  if (err.code === Code.ResourceExhausted)
    return unavailable(
      'The server is at its awake limit and no container can be stopped to make room. Try again shortly.',
    );
  return unavailable(`The vm-manager could not ${what} (${Code[err.code]})`);
}

/**
 * Stops the container now. Polite unless `force`: the vm-manager refuses a polite stop while a
 * turn runs, a delivery is in flight or a Claude sign-in waits (409). A forced stop ends a turn in
 * the middle: that turn fails as our fault, so the user is told and given the credits back.
 */
export async function adminStopContainer(
  input: AdminAction & { force: boolean },
): Promise<AdminContainerView> {
  await activeUser(input.userId);
  let stopped;
  try {
    stopped = await vm().stopSandbox({
      userId: input.userId,
      force: input.force,
      // The vm-manager logs this: the admin's id, never the admin's own words.
      reason: `admin ${input.adminId}${input.force ? ' (force)' : ''}`,
    });
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.FailedPrecondition)
      throw conflict(
        'The container is in use: a turn runs, a message is being delivered or a Claude sign-in waits for its code. Try again when it is quiet, or stop it by force.',
      );
    throw vmError(err, 'stop it');
  }
  await audit({
    userId: input.userId,
    actor: 'admin',
    action: 'container_stopped',
    summary: input.force
      ? "Textcrew support stopped the agent's container by force"
      : "Textcrew support stopped the agent's container",
    details: { adminId: input.adminId, reason: input.reason, force: input.force },
  });
  const container = containerView(stopped.sandbox);
  await publish(input.userId, 'agent.status', {
    state: container.state === 'broken' ? 'broken' : 'stopped',
    lastActiveAt: container.lastActiveAt?.toISOString() ?? null,
  });
  return container;
}

/**
 * Wakes the container the way a turn does: made first if there is none, started, then the engine
 * and the browser switch set again if they differ. Awake time is charged to the user, so a user
 * with no credits is not woken (409).
 */
export async function adminWakeContainer(
  input: AdminAction,
): Promise<{ container: AdminContainerView; wasStopped: boolean }> {
  const user = await activeUser(input.userId);
  if (!(await userHasCredits(user.id)))
    throw conflict(
      'This user is out of credits, and awake time is charged to them. Add credits first.',
    );
  let woke;
  try {
    await ensureSandbox(user.id);
    woke = await vm().wakeSandbox({ userId: user.id, priority: planPriority(user.plan) });
  } catch (err) {
    throw vmError(err, 'wake it');
  }
  await syncRuntimeAfterWake(user.id, woke.sandbox);
  await syncBrowserAfterWake(user.id, user.plan, woke.sandbox);
  await audit({
    userId: user.id,
    actor: 'admin',
    action: 'container_woken',
    summary: "Textcrew support woke the agent's container",
    details: { adminId: input.adminId, reason: input.reason, wasStopped: woke.wasStopped },
  });
  const container = await adminContainer(user.id);
  await publish(user.id, 'agent.status', {
    state: 'awake',
    lastActiveAt: container.lastActiveAt?.toISOString() ?? null,
  });
  return { container, wasStopped: woke.wasStopped };
}

export const RESETTABLE = ['engine', 'model', 'effort', 'browser'] as const;
export type Resettable = (typeof RESETTABLE)[number];

const RESET_WORDS: Record<Resettable, string> = {
  engine: 'engine (back to Hermes)',
  model: 'Claude model (back to Default)',
  effort: 'thinking effort (back to Default)',
  browser: 'browser switch (set again from the plan)',
};

/**
 * Puts the chosen settings back to their defaults with the orchestrator's own functions: the
 * engine to Hermes, Claude Code's model and effort to Default (Sonnet 5.5, quick), and Scout's
 * browser switch to what the plan and the deployment say. The settings change is logged as the
 * admin's; the reset itself is audited with the admin's id and the reason. If the browser switch
 * can't be sent, the rest is kept and the call answers 503.
 */
export async function adminResetAgent(input: AdminAction & { what: Resettable[] }): Promise<void> {
  const user = await activeUser(input.userId);
  const what = RESETTABLE.filter((w) => input.what.includes(w));
  const patch = {
    ...(what.includes('engine') ? { runtime: 'hermes' as const } : {}),
    ...(what.includes('model') ? { claudeModel: null } : {}),
    ...(what.includes('effort') ? { claudeEffort: null } : {}),
  };
  if (Object.keys(patch).length) await updateAgentSettings(user.id, patch, 'admin');
  let browserFailed = false;
  if (what.includes('browser')) {
    try {
      await syncBrowser(user.id, 'admin_reset');
    } catch (err) {
      logger().warn({ userId: user.id, err: String(err) }, 'admin reset: browser switch not sent');
      browserFailed = true;
    }
  }
  await audit({
    userId: user.id,
    actor: 'admin',
    action: 'agent_reset',
    summary: `Textcrew support reset the agent's ${what.map((w) => RESET_WORDS[w]).join(', ')}`,
    details: {
      adminId: input.adminId,
      reason: input.reason,
      what,
      ...(browserFailed ? { browserFailed: true } : {}),
    },
  });
  if (browserFailed)
    throw unavailable(
      "The browser switch couldn't be sent to the vm-manager. The other settings were reset; try again.",
    );
}
