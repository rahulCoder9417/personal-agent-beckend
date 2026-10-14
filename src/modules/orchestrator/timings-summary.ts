// Where turns spent their time over the last days, for the admins (`GET /v1/admin/timings/summary`).
// Read from `turn_timings` only, with the same stages as one turn's own report (`turnStages`): each
// stage as long as it kept the user waiting. Never any text: the table holds none.
import { desc, gte } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { turnTimings } from './schema.ts';
import { answeredAfter, turnStages, type TurnTimingRow } from './timings.ts';

/** At most this many turns are read (the newest); the summary says how many it used. */
export const SUMMARY_MAX_TURNS = 20_000;
export const SLOWEST_COUNT = 20;

/** The order a turn passes its stages in; a stage not listed comes after, by name. */
const STAGE_ORDER = [
  'queue',
  'prepare',
  'route',
  'reply',
  'wake warm',
  'wake cold',
  'wake capacity',
  'wake recreated',
  'context',
  'handover',
  'engine start',
  'first output',
  'work',
  'send answer',
  'wrap up',
  'total',
];

export interface StageStat {
  stage: string;
  count: number;
  p50Ms: number;
  p90Ms: number;
}

export interface SlowTurn {
  deliveryId: string;
  userId: string;
  startedAt: string;
  totalMs: number;
  biggestStage: string | null;
  biggestStageMs: number | null;
  route: string | null;
  engine: string | null;
  wake: string | null;
  outcome: string;
}

export interface TimingsSummary {
  days: number;
  since: string;
  turns: number;
  stages: StageStat[];
  routes: Array<{ name: string; count: number }>;
  engines: Array<{ name: string; count: number }>;
  outcomes: Array<{ name: string; count: number }>;
  slowest: SlowTurn[];
}

/**
 * The p-th percentile (0 to 1) of sorted values, read between the two nearest values as Postgres's
 * `percentile_cont` does: the median of 1, 2, 3, 4 is 2.5. Rounded to whole milliseconds.
 */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo));
}

const stageName = (name: string, row: Pick<TurnTimingRow, 'wake'>) =>
  name === 'wake' ? `wake ${row.wake ?? 'unknown'}` : name;

function tally(values: Array<string | null>): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v ?? 'none', (counts.get(v ?? 'none') ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** The summary of these turns (pure: the tests feed it rows). */
export function summarizeTimings(rows: TurnTimingRow[], days: number, since: Date): TimingsSummary {
  const byStage = new Map<string, number[]>();
  const add = (stage: string, ms: number) => {
    const list = byStage.get(stage) ?? [];
    list.push(ms);
    byStage.set(stage, list);
  };
  const slow: SlowTurn[] = [];
  for (const row of rows) {
    const stages = turnStages(row);
    for (const s of stages) add(stageName(s.name, row), s.ms);
    const total = answeredAfter(row);
    if (total === undefined) continue;
    add('total', total);
    const big = stages.length ? stages.reduce((a, b) => (b.ms > a.ms ? b : a)) : null;
    slow.push({
      deliveryId: row.deliveryId,
      userId: row.userId,
      startedAt: row.startedAt.toISOString(),
      totalMs: total,
      biggestStage: big ? stageName(big.name, row) : null,
      biggestStageMs: big ? big.ms : null,
      route: row.route,
      engine: row.engine,
      wake: row.wake,
      outcome: row.outcome,
    });
  }
  const rank = (s: string) => {
    const i = STAGE_ORDER.indexOf(s);
    return i === -1 ? STAGE_ORDER.length : i;
  };
  const stages = [...byStage]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([stage, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        stage,
        count: sorted.length,
        p50Ms: percentile(sorted, 0.5),
        p90Ms: percentile(sorted, 0.9),
      };
    });
  return {
    days,
    since: since.toISOString(),
    turns: rows.length,
    stages,
    routes: tally(rows.map((r) => r.route)),
    engines: tally(rows.map((r) => r.engine)),
    outcomes: tally(rows.map((r) => r.outcome)),
    slowest: slow.sort((a, b) => b.totalMs - a.totalMs).slice(0, SLOWEST_COUNT),
  };
}

/** The turns that started in the last `days` days, summed up. */
export async function timingsSummary(days: number, now = new Date()): Promise<TimingsSummary> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await db()
    .select()
    .from(turnTimings)
    .where(gte(turnTimings.startedAt, since))
    .orderBy(desc(turnTimings.startedAt))
    .limit(SUMMARY_MAX_TURNS);
  return summarizeTimings(rows, days, since);
}
