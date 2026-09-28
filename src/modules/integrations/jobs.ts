import type { Job } from 'bullmq';
import { Code, ConnectError } from '@connectrpc/connect';
import { getEvent } from '../events/intake.ts';
import { vm } from '../orchestrator/vm.ts';
import { IGNORED } from '../../worker/ignored.ts';
import { setConnectionStatus } from './apps.ts';
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
