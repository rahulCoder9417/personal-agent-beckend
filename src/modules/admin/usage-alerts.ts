// Server usage alerts: every minute the disk, the memory and the awake agent places are measured.
// Each metric alerts when it climbs into a new 10% band (10, 20 ... 100). It does not alert for
// the same band again until the metric has fallen to below the band under it (so 20 -> 15 -> 20 is
// quiet, 20 -> 5 -> 20 alerts again). After 80% or more, a drop under 50% says "back to normal".
import { readFile, statfs } from 'node:fs/promises';
import { config } from '../../shared/config.ts';
import { logger } from '../../shared/logger.ts';
import { redis } from '../../shared/redis.ts';
import { SandboxState, vm } from '../orchestrator/vm.ts';
import { founderAlertOn, notifyFounder } from './ops-alerts.ts';

export type Metric = 'disk' | 'memory' | 'agents';
export interface BandState {
  band: number;
  high: boolean;
}

export const bandOf = (pct: number): number =>
  Math.min(100, Math.max(0, Math.floor(pct / 10) * 10));

/** What to do for a new reading: the next state and what to say (if anything). */
export function nextBandState(
  prev: BandState,
  pct: number,
): { state: BandState; alert: 'band' | 'normal' | null } {
  const band = bandOf(pct);
  let state = { ...prev };
  let alert: 'band' | 'normal' | null = null;
  if (band > prev.band) {
    state = { band, high: prev.high || band >= 80 };
    alert = 'band';
  } else if (pct < prev.band - 10) {
    // Fell more than a band below the mark: re-arm at the lower band.
    state.band = band;
  }
  if (state.high && pct < 50) {
    state.high = false;
    if (alert === null) alert = 'normal';
  }
  return { state, alert };
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0);
const round = (n: number) => Math.round(n);

export interface Reading {
  pct: number;
  label: string;
}

async function readDisk(): Promise<Reading> {
  const st = await statfs(config().ATTACHMENTS_DIR);
  const total = st.blocks * st.bsize;
  const used = total - st.bfree * st.bsize;
  return { pct: (used / total) * 100, label: `${gb(used)} of ${gb(total)} GB` };
}

async function readMemory(): Promise<Reading> {
  const text = await readFile('/proc/meminfo', 'utf8');
  const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)?.[1]);
  const total = kb('MemTotal') * 1024;
  const used = total - kb('MemAvailable') * 1024;
  if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0) throw new Error('meminfo');
  return { pct: (used / total) * 100, label: `${gb(used)} of ${gb(total)} GB` };
}

async function readAgents(): Promise<Reading> {
  const res = await vm().listSandboxes({ states: [] });
  const awake = res.sandboxes.filter(
    (s) => s.state === SandboxState.AWAKE || s.state === SandboxState.BUSY,
  ).length;
  const cap = config().AWAKE_CAP;
  return { pct: (awake / cap) * 100, label: `${awake}/${cap}` };
}

export const READERS: Record<Metric, () => Promise<Reading>> = {
  disk: readDisk,
  memory: readMemory,
  agents: readAgents,
};

const TITLE: Record<Metric, string> = { disk: 'Disk', memory: 'Memory', agents: 'Agents awake' };

function sentence(metric: Metric, r: Reading, band: number): string {
  const pct = round(r.pct);
  return metric === 'agents'
    ? `Agents awake ${r.label} = ${pct}% (band ${band}%)`
    : `${TITLE[metric]} ${pct}% (${r.label}), band ${band}%`;
}

const stateKey = (metric: Metric) => `founder-usage:${metric}`;

async function loadState(metric: Metric): Promise<BandState> {
  const raw = await redis().get(stateKey(metric));
  if (!raw) return { band: 0, high: false };
  try {
    return JSON.parse(raw) as BandState;
  } catch {
    return { band: 0, high: false };
  }
}

/** system/usage-check (every minute). One metric failing to read does not stop the others. */
export async function handleUsageCheck(
  readers: Record<Metric, () => Promise<Reading>> = READERS,
): Promise<unknown> {
  if (!founderAlertOn('usage')) return { muted: true };
  const out: Record<string, number | string> = {};
  for (const metric of Object.keys(readers) as Metric[]) {
    try {
      const reading = await readers[metric]();
      out[metric] = round(reading.pct);
      const { state, alert } = nextBandState(await loadState(metric), reading.pct);
      await redis().set(stateKey(metric), JSON.stringify(state));
      if (alert === 'band') {
        await notifyFounder('usage', sentence(metric, reading, state.band));
      } else if (alert === 'normal') {
        await notifyFounder(
          'usage',
          `${TITLE[metric]} back to normal: ${round(reading.pct)}% (${reading.label})`,
        );
      }
    } catch (err) {
      out[metric] = 'unreadable';
      logger().warn({ err: String(err), metric }, 'usage check: could not read metric');
    }
  }
  return out;
}
