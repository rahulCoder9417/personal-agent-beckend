import type { Job } from 'bullmq';
import { Code, ConnectError } from '@connectrpc/connect';
import { getEvent } from '../events/intake.ts';
import { vm } from '../orchestrator/vm.ts';
import { IGNORED } from '../../worker/ignored.ts';
import {
  getConnection,
  refreshPendingConnections,
  scheduleConnectionCheck,
  setConnectionStatus,
} from './apps.ts';
import { sandboxMcpConfig } from './mcp-servers.ts';

/** system/sync-allowlist: push the user's MCP domains + servers to the vm-manager. Recomputed from the DB. */
export async function handleSyncAllowlist(job: Job): Promise<unknown> {
  const { userId } = job.data as { userId: string };
  const cfg = await sandboxMcpConfig(userId);
  try {
    await vm().setEgressAllowlist({ userId, domains: cfg.domains, mcpServers: cfg.servers });
  } catch (err) {
    // No sandbox yet: it gets the current list when it's created.
    if (err instanceof ConnectError && err.code === Code.NotFound) return null;
    throw err;
  }
  return null;
}

/** system/composio-event: connection status changes. */
export async function handleComposioEvent(job: Job): Promise<unknown> {
  const event = await getEvent((job.data as { eventId: string }).eventId);
  if (!event) return IGNORED;
  const p = event.payload as {
    kind?: string;
    accountId?: string;
    status?: 'active' | 'expired' | 'error';
  };
  if (p.kind !== 'connection' || !p.accountId || !p.status) return IGNORED;
  await setConnectionStatus(p.accountId, p.status);
  return null;
}

/**
 * system/check-connection: added when a connect link is created. Asks Composio whether the
 * connection is finished, and queues the next check while it isn't (a few times over about 16
 * minutes). Safe to re-run: it only copies Composio's status, and the next check's job id is fixed.
 */
export async function handleCheckConnection(job: Job): Promise<unknown> {
  const { userId, connectionId, run, attempt } = job.data as {
    userId: string;
    connectionId: string;
    run: number;
    attempt: number;
  };
  const before = await getConnection(userId, connectionId);
  // Disconnected, or already finished by the webhook or the app list.
  if (!before || before.status !== 'pending') return IGNORED;
  await refreshPendingConnections(userId);
  const after = await getConnection(userId, connectionId);
  if (after?.status !== 'pending') return { status: after?.status ?? 'gone' };
  const again = await scheduleConnectionCheck({ userId, connectionId, run, attempt: attempt + 1 });
  // Out of checks: it stays pending. The webhook or the app list can still finish it later.
  return { status: 'pending', nextCheck: again };
}
