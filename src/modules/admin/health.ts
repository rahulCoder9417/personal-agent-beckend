import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { config } from '../../shared/config.ts';
import { db } from '../../shared/db/client.ts';
import { redis } from '../../shared/redis.ts';
import { QUEUES, queue } from '../events/queues.ts';
import { SandboxState, vm } from '../orchestrator/vm.ts';
import { alert } from './alerts.ts';
import { firstLineScrubbed } from './redact.ts';

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

// --- The admin's health page (`GET /v1/admin/health`) ---------------------------------------------
//
// Each service the backend depends on is asked once, with a 3-second limit: ok, error, or off (not
// set up on this server). Messages are short and never hold a secret: an error keeps its first
// line, scrubbed.

export const SERVICE_NAMES = ['postgres', 'redis', 'vm-manager', 'litellm', 'composio'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

export interface ServiceHealth {
  name: ServiceName;
  status: 'ok' | 'error' | 'off';
  message: string;
  ms: number;
}

export const PROBE_TIMEOUT_MS = 3000;

type ProbeResult = { status?: 'ok' | 'off'; message: string };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function probe(name: ServiceName, fn: () => Promise<ProbeResult>): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const r = await withTimeout(fn(), PROBE_TIMEOUT_MS);
    return { name, status: r.status ?? 'ok', message: r.message, ms: Date.now() - start };
  } catch (err) {
    const message = firstLineScrubbed(err instanceof Error ? err.message : String(err), 200);
    return { name, status: 'error', message: message || 'failed', ms: Date.now() - start };
  }
}

/** An HTTP answer in a few words; a refused key says so. */
function httpProblem(res: Response): Error {
  return new Error(
    res.status === 401 || res.status === 403
      ? `reachable, but the key was refused (${res.status})`
      : `answered ${res.status}`,
  );
}

const PROBES: Record<ServiceName, () => Promise<ProbeResult>> = {
  postgres: async () => {
    await db().execute(sql`select 1`);
    return { message: 'reachable' };
  },
  redis: async () => {
    const pong = await redis().ping();
    return { message: pong === 'PONG' ? 'reachable' : `answered ${pong}` };
  },
  'vm-manager': async () => {
    const res = await vm().listSandboxes({ states: [] }, { timeoutMs: PROBE_TIMEOUT_MS });
    const awake = res.sandboxes.filter(
      (s) => s.state === SandboxState.AWAKE || s.state === SandboxState.BUSY,
    ).length;
    const broken = res.sandboxes.filter((s) => s.state === SandboxState.BROKEN).length;
    return {
      message: `reachable: ${res.sandboxes.length} containers, ${awake} awake${broken ? `, ${broken} broken` : ''}`,
    };
  },
  litellm: async () => {
    // LiteLLM's own liveness page needs no key.
    const res = await fetch(new URL('/health/liveliness', config().LITELLM_URL), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) throw httpProblem(res);
    return { message: 'reachable' };
  },
  composio: async () => {
    const key = config().COMPOSIO_API_KEY;
    if (!key) return { status: 'off', message: 'COMPOSIO_API_KEY is not set' };
    // The cheapest call that also checks the key: one app setup.
    const url = new URL('/api/v3/auth_configs?limit=1', config().COMPOSIO_API_URL);
    const res = await fetch(url, {
      headers: { 'x-api-key': key },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) throw httpProblem(res);
    return { message: 'reachable, key accepted' };
  },
};

/** The backend's version (package.json) and the deployed commit, when the deploy passed it on. */
function readVersion(): string {
  try {
    const pkg = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');
    return (JSON.parse(pkg) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
const VERSION = readVersion();

export interface HealthReport {
  ok: boolean;
  checkedAt: string;
  version: { version: string; commit: string | null; node: string };
  services: ServiceHealth[];
}

/** Asks every service at once. `ok` is false when any of them is in error. */
export async function healthReport(): Promise<HealthReport> {
  const checkedAt = new Date().toISOString();
  const services = await Promise.all(SERVICE_NAMES.map((name) => probe(name, PROBES[name])));
  return {
    ok: services.every((s) => s.status !== 'error'),
    checkedAt,
    version: { version: VERSION, commit: config().GIT_COMMIT ?? null, node: process.version },
    services,
  };
}
