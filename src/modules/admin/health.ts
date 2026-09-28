import { QUEUES, queue } from '../events/queues.ts';
import { vm } from '../orchestrator/vm.ts';
import { alert } from './alerts.ts';

/** system/health-check (every 5 min): failed jobs piling up, vm-manager unreachable, stuck queues. */
export async function handleHealthCheck(): Promise<unknown> {
  const problems: string[] = [];
  for (const q of QUEUES) {
    const c = await queue(q).getJobCounts('failed', 'waiting');
    if ((c.failed ?? 0) > 50) problems.push(`${q}: ${c.failed} failed jobs`);
    if ((c.waiting ?? 0) > 1000) problems.push(`${q}: ${c.waiting} waiting jobs`);
  }
  try {
    await vm().listSandboxes({ states: [] });
  } catch (err) {
    problems.push(`vm-manager unreachable: ${String(err)}`);
  }
  if (problems.length) await alert('Health check failed', { problems });
  return { problems };
}
