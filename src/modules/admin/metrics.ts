// Minimal Prometheus text metrics (no extra dependency).
import { QUEUES, queue } from '../events/queues.ts';

const counters = new Map<string, number>();

export function inc(name: string, labels: Record<string, string | number> = {}, by = 1): void {
  const key = `${name}{${Object.entries(labels)
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '')}"`)
    .join(',')}}`;
  counters.set(key, (counters.get(key) ?? 0) + by);
}

export async function renderMetrics(): Promise<string> {
  const lines: string[] = [];
  for (const [key, value] of counters) lines.push(`${key} ${value}`);
  for (const q of QUEUES) {
    const counts = await queue(q).getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
      'completed',
    );
    for (const [state, n] of Object.entries(counts))
      lines.push(`bullmq_jobs{queue="${q}",state="${state}"} ${n}`);
  }
  return `${lines.join('\n')}\n`;
}
