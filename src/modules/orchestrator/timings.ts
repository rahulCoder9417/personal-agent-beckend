// Where a turn's time goes (docs/backend-report.md, "Where a turn's time goes"). Each turn notes the
// moment of each stage as it passes it, and writes one row to `turn_timings` when it ends: the
// queue, the routing (Jev, the quick reply), the wake (warm, cold, room made under the awake cap),
// the hand-over to the container, and the Bridge's own report of the engine (its start, the model's
// first words, tools, the crew, the answer sent). Never any text the user or the agent wrote: only
// stage names, times, ids and counts. Writing the row never fails the turn.
import { desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../shared/db/client.ts';
import { currentJob } from '../../shared/job-context.ts';
import { logger } from '../../shared/logger.ts';
import type { RuntimeName } from './agent-settings.ts';
import { turnTimings } from './schema.ts';

/** How long the routing took, part by part (milliseconds). Never any text. */
export interface RouteTimes {
  /** Reading the chat's last messages and the user's apps. */
  contextMs?: number;
  /** Jev's decision. */
  jevMs?: number;
  /** The quick reply, from its start until the model answered. */
  quickReplyMs?: number;
  /** How long the turn still waited for the quick reply after Jev had decided. */
  quickReplyWaitMs?: number;
  /** The quick reply was started together with Jev's decision (a short message). */
  quickReplyEarly?: boolean;
  /** The quick reply model said ESCALATE: the message went to the agent. */
  escalated?: boolean;
  /** Jev or the quick reply failed: the message went to the agent. */
  failed?: boolean;
}

/** How one WakeSandbox call went (the vm-manager's WakeTimings, in milliseconds). */
export interface WakeDetail {
  wasStopped: boolean;
  lockWaitMs?: number;
  capacityWaitMs?: number;
  evicted?: boolean;
  recreated?: boolean;
  containerStartMs?: number;
  bridgeReadyMs?: number;
}

const markName = z.string().regex(/^[a-z_]{1,40}$/);
const ms = z.number().int().nonnegative();

/**
 * The Bridge's report of a turn (the vm-manager's README, "Stage times"): milliseconds since the
 * Bridge took the delivery. Read strictly: names must look like names and values like numbers, so
 * nothing written by the user or the agent can be stored through it. Unknown fields are dropped.
 */
export const BridgeReport = z.object({
  v: z.number().int(),
  engine: z.enum(['hermes', 'claude_code', '']).optional(),
  runs: ms.optional(),
  marks: z.record(markName, ms).optional(),
  tools_ms: ms.optional(),
  crew_ms: ms.optional(),
  crew: z
    .array(z.object({ member: z.string().regex(/^[a-z]{1,20}$/), start: ms, end: ms.optional() }))
    .max(20)
    .optional(),
  cli: z.record(markName, ms).optional(),
});
export type BridgeReport = z.infer<typeof BridgeReport>;

/** The Bridge's report from a DeliverEvent's `timings_json`, or undefined when there is none or it is not one. */
export function parseBridgeReport(json: string | undefined): BridgeReport | undefined {
  if (!json) return undefined;
  try {
    const parsed = BridgeReport.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The Bridge's marks, in the order they happen in a turn. */
export const BRIDGE_MARKS = [
  'engine_start',
  'engine_ready',
  'first_response',
  'first_thinking',
  'first_tool',
  'first_text',
  'engine_done',
  'answer_sent',
] as const;

/**
 * The stage times of one turn, noted as it runs and written once at its end (`save`). Every moment
 * is an epoch millisecond on the worker's clock; the Bridge's marks are placed after the moment the
 * worker heard the Bridge accept the delivery.
 */
export class TurnTimer {
  private readonly at = new Map<string, number>();
  route: string | null = null;
  engine: RuntimeName | null = null;
  outcome = 'failed';
  readonly attempt: number;
  readonly routeTimes: RouteTimes = {};
  wakeDetail: WakeDetail | null = null;
  bridge: BridgeReport | null = null;

  constructor(
    readonly turn: { deliveryId: string; userId: string; kind: string; channel: string },
    now = Date.now(),
  ) {
    const job = currentJob();
    this.attempt = job?.attempt ?? 1;
    this.at.set('queued', Math.min(job?.queuedAt ?? now, now));
    if (job) this.at.set('picked_up', Math.min(Math.max(job.pickedUpAt, job.queuedAt), now));
    this.at.set('turn_started', now);
  }

  /** Notes that `stage` was reached now (the first time counts). */
  mark(stage: string, at = Date.now()): void {
    if (!this.at.has(stage)) this.at.set(stage, at);
  }

  has(stage: string): boolean {
    return this.at.has(stage);
  }

  /** The vm-manager's answer to WakeSandbox. */
  noteWake(res: {
    wasStopped: boolean;
    timings?: {
      lockWaitMs: bigint;
      capacityWaitMs: bigint;
      evicted: boolean;
      recreated: boolean;
      containerStartMs: bigint;
      bridgeReadyMs: bigint;
    };
  }): void {
    const t = res.timings;
    this.wakeDetail = {
      wasStopped: res.wasStopped,
      ...(t
        ? {
            lockWaitMs: Number(t.lockWaitMs),
            capacityWaitMs: Number(t.capacityWaitMs),
            evicted: t.evicted,
            recreated: t.recreated,
            containerStartMs: Number(t.containerStartMs),
            bridgeReadyMs: Number(t.bridgeReadyMs),
          }
        : {}),
    };
  }

  /** How the wake went, in one word: warm, cold, capacity (another container stopped first), recreated. */
  wakeKind(): string | null {
    const w = this.wakeDetail;
    if (!w) return null;
    if (w.evicted) return 'capacity';
    if (w.recreated) return 'recreated';
    return w.wasStopped ? 'cold' : 'warm';
  }

  /** The Bridge's report from the turn's last event. */
  noteBridge(json: string | undefined): void {
    const report = parseBridgeReport(json);
    if (report) this.bridge = report;
  }

  /** The row: every stage in milliseconds after the moment the job was queued. */
  row(): typeof turnTimings.$inferInsert {
    const start = this.at.get('queued')!;
    const stages: Record<string, number> = {};
    for (const [name, at] of this.at) stages[name] = Math.max(at - start, 0);
    const accepted = stages.accepted;
    if (this.bridge?.marks && accepted !== undefined)
      for (const name of BRIDGE_MARKS) {
        const offset = this.bridge.marks[name];
        if (offset !== undefined) stages[name] = accepted + offset;
      }
    return {
      deliveryId: this.turn.deliveryId,
      userId: this.turn.userId,
      kind: this.turn.kind,
      channel: this.turn.channel,
      route: this.route,
      engine: this.engine,
      wake: this.wakeKind(),
      outcome: this.outcome,
      attempt: this.attempt,
      startedAt: new Date(start),
      stages,
      details: {
        ...(Object.keys(this.routeTimes).length ? { routing: this.routeTimes } : {}),
        ...(this.wakeDetail ? { wake: this.wakeDetail } : {}),
        ...(this.bridge ? { bridge: this.bridge } : {}),
      },
    };
  }

  /** Writes the row (a later try of the same turn replaces it). Never throws. */
  async save(): Promise<void> {
    try {
      const row = this.row();
      const { deliveryId: _id, ...rest } = row;
      await db()
        .insert(turnTimings)
        .values(row)
        .onConflictDoUpdate({ target: turnTimings.deliveryId, set: rest });
    } catch (err) {
      logger().warn(
        { userId: this.turn.userId, deliveryId: this.turn.deliveryId, err: String(err) },
        'turn timings not saved',
      );
    }
  }
}

// --- reading them back ----------------------------------------------------------------------------

export type TurnTimingRow = typeof turnTimings.$inferSelect;

/** The user's last `limit` turns, the newest first. */
export async function recentTurnTimings(userId: string, limit: number): Promise<TurnTimingRow[]> {
  return db()
    .select()
    .from(turnTimings)
    .where(eq(turnTimings.userId, userId))
    .orderBy(desc(turnTimings.startedAt))
    .limit(limit);
}

/**
 * Admin overview: turns that started since each moment, and how many of them ended in an error or
 * failed. Timings are kept 30 days, so a window longer than that is cut short.
 */
export async function turnCounts(
  dayStart: Date,
  weekStart: Date,
): Promise<{ today: number; last7d: number; failedToday: number; failed7d: number }> {
  const failed = sql`${turnTimings.outcome} in ('error', 'failed')`;
  const n = (where: SQL) => sql<number>`count(*) filter (where ${where})`.mapWith(Number);
  const [row] = await db()
    .select({
      today: n(sql`${turnTimings.startedAt} >= ${dayStart}`),
      last7d: n(sql`${turnTimings.startedAt} >= ${weekStart}`),
      failedToday: n(sql`${turnTimings.startedAt} >= ${dayStart} and ${failed}`),
      failed7d: n(sql`${turnTimings.startedAt} >= ${weekStart} and ${failed}`),
    })
    .from(turnTimings)
    .where(gte(turnTimings.startedAt, dayStart < weekStart ? dayStart : weekStart));
  return {
    today: row?.today ?? 0,
    last7d: row?.last7d ?? 0,
    failedToday: row?.failedToday ?? 0,
    failed7d: row?.failed7d ?? 0,
  };
}

/** One stage of a turn as a person reads it: its name, how long it took, and a note. */
export interface Stage {
  name: string;
  ms: number;
  note?: string;
}

const span = (s: Record<string, number>, from: string, to: string): number | undefined =>
  s[from] !== undefined && s[to] !== undefined ? Math.max(s[to]! - s[from]!, 0) : undefined;

/** Seconds as a person reads them: `0.42 s`, `6.1 s`, `4 min 16 s`. */
export function seconds(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function firstOf(s: Record<string, number>, names: string[]): number | undefined {
  const found = names.map((n) => s[n]).filter((v): v is number => v !== undefined);
  return found.length ? Math.min(...found) : undefined;
}

/**
 * The stages of a turn in the order they happen, as long as each kept the user waiting (a wake that
 * ran while the routing was decided counts only for what was left after it). Stages a turn did not
 * have are left out.
 */
export function turnStages(row: TurnTimingRow): Stage[] {
  const s = row.stages;
  const details = row.details as {
    routing?: RouteTimes;
    wake?: WakeDetail;
    bridge?: BridgeReport;
  };
  const out: Stage[] = [];
  const add = (name: string, ms: number | undefined, note?: string) => {
    if (ms !== undefined) out.push({ name, ms, ...(note ? { note } : {}) });
  };
  add(
    'queue',
    span(s, 'queued', 'picked_up'),
    'waiting for the worker, and for your turn before it',
  );
  add('prepare', span(s, 'picked_up', 'turn_started'), 'reading the message, files and voice');
  const r = details.routing;
  const routeNote = r
    ? [
        r.jevMs !== undefined ? `Jev ${seconds(r.jevMs)}` : '',
        r.quickReplyMs !== undefined
          ? `quick reply ${seconds(r.quickReplyMs)}${r.quickReplyEarly ? ', started with Jev' : ''}`
          : '',
        r.escalated ? 'the quick reply model passed it on' : '',
        r.failed ? 'routing failed' : '',
      ]
        .filter(Boolean)
        .join(', ')
    : '';
  add('route', span(s, 'turn_started', 'routed'), routeNote || 'credits and the route');
  if (s.answered !== undefined && s.accepted === undefined) {
    add(
      'reply',
      span(s, s.routed !== undefined ? 'routed' : 'turn_started', 'answered'),
      'saving and sending the reply',
    );
    return out;
  }
  if (s.woken !== undefined && s.routed !== undefined) {
    // A wake that started while the route was decided keeps the user waiting only for what is
    // left of it once the route is known.
    const w = details.wake;
    const parts = w
      ? [
          row.wake ?? '',
          w.evicted || (w.capacityWaitMs ?? 0) >= 100
            ? `making room ${seconds(w.capacityWaitMs ?? 0)}`
            : '',
          w.containerStartMs ? `container start ${seconds(w.containerStartMs)}` : '',
          w.bridgeReadyMs ? `Bridge ready ${seconds(w.bridgeReadyMs)}` : '',
          w.lockWaitMs ? `waited for another operation ${seconds(w.lockWaitMs)}` : '',
        ].filter(Boolean)
      : [];
    const during = s.wake_started !== undefined ? Math.min(s.routed, s.woken) - s.wake_started : 0;
    if (during > 0) parts.push(`${seconds(during)} of it while routing`);
    add('wake', Math.max(s.woken - s.routed, 0), parts.join(', '));
  }
  const ready =
    s.woken !== undefined && s.routed !== undefined ? Math.max(s.woken, s.routed) : undefined;
  if (ready !== undefined && s.deliver_sent !== undefined)
    add('context', Math.max(s.deliver_sent - ready, 0), 'engine check, memory and recap');
  add(
    'handover',
    span(s, 'deliver_sent', 'accepted'),
    'the vm-manager and the Bridge take the message',
  );
  const b = details.bridge;
  const engine =
    row.engine === 'claude_code'
      ? 'Claude Code'
      : row.engine === 'hermes'
        ? 'Hermes'
        : 'the engine';
  add(
    'engine start',
    span(s, 'accepted', 'engine_ready'),
    row.engine === 'claude_code'
      ? 'the Bridge starts Claude Code, which connects its tool servers'
      : `the Bridge starts ${engine}'s run`,
  );
  const firstOut = firstOf(s, ['first_text', 'first_tool']);
  if (s.engine_ready !== undefined && firstOut !== undefined) {
    // Thinking: from the model's first thinking to its first words or tool call (web chat turns,
    // where the Bridge sees the model's own stream).
    const thinking =
      s.first_thinking !== undefined && firstOut > s.first_thinking
        ? `, thinking ${seconds(firstOut - s.first_thinking)}`
        : '';
    const response =
      s.first_response !== undefined
        ? `, first response after ${seconds(Math.max(s.first_response - s.engine_ready, 0))}`
        : '';
    const cli = b?.cli;
    const cache =
      cli?.cache_read_input_tokens !== undefined || cli?.cache_creation_input_tokens !== undefined
        ? `, prompt cache ${cli.cache_read_input_tokens ?? 0} tokens read and ${cli.cache_creation_input_tokens ?? 0} written in the run`
        : '';
    add(
      'first output',
      Math.max(firstOut - s.engine_ready, 0),
      `the model's first words or tool call${response}${thinking}${cache}`,
    );
  }
  if (firstOut !== undefined && s.engine_done !== undefined) {
    const work = Math.max(s.engine_done - firstOut, 0);
    const notes: string[] = [];
    if (b?.tools_ms) notes.push(`tools ${seconds(b.tools_ms)}`);
    if (b?.crew_ms) {
      const members = [...new Set((b.crew ?? []).map((c) => c.member))].join(', ');
      notes.push(`crew ${seconds(b.crew_ms)}${members ? ` (${members})` : ''}`);
    }
    if (b?.cli?.num_turns !== undefined) notes.push(`${b.cli.num_turns} model rounds`);
    if (b?.cli?.duration_api_ms !== undefined)
      notes.push(`model ${seconds(b.cli.duration_api_ms)} in the whole run`);
    add('work', work, notes.join(', ') || 'the model, its tools and the crew');
  }
  add(
    'send answer',
    span(s, 'engine_done', 'answer_sent'),
    'send_message saves it and it reaches you',
  );
  add('wrap up', span(s, 'answer_sent', 'turn_done'), 'the Bridge and the vm-manager end the turn');
  return out;
}

/** When the user had the answer, in milliseconds after the message was queued. */
export function answeredAfter(row: TurnTimingRow): number | undefined {
  const s = row.stages;
  return s.answered ?? s.answer_sent ?? s.turn_done;
}

/** One line on the biggest stage, in words. */
export function verdict(row: TurnTimingRow, stages = turnStages(row)): string {
  const total = answeredAfter(row);
  if (!stages.length || total === undefined) return 'no answer recorded';
  const big = stages.reduce((a, b) => (b.ms > a.ms ? b : a));
  const share = total > 0 ? ` (${Math.round((big.ms / total) * 100)}% of ${seconds(total)})` : '';
  const b = (row.details as { bridge?: BridgeReport }).bridge;
  const what: Record<string, string> = {
    queue: 'waiting in the queue: another turn of yours was still running, or the worker was busy',
    prepare: 'reading the message before routing (files, voice)',
    route: 'deciding the route: Jev and the quick-reply model',
    reply: 'saving and sending the quick reply',
    wake:
      row.wake === 'capacity'
        ? 'making room on the server, then starting the container'
        : row.wake === 'recreated'
          ? 'making the container again (a new image), then starting it'
          : row.wake === 'cold'
            ? 'starting the container (a cold start: it was asleep)'
            : 'waking the container',
    context: 'building the turn: engine check, memory and recap',
    handover: 'handing the message to the container',
    'engine start':
      row.engine === 'claude_code'
        ? 'starting Claude Code and its tool servers'
        : 'starting the engine',
    'first output': "the model's first answer: thinking before its first words or tool call",
    'send answer': 'sending the answer through the platform',
    'wrap up': 'ending the turn after the answer',
  };
  let words = what[big.name];
  if (big.name === 'work') {
    const crew = b?.crew_ms ?? 0;
    const tools = b?.tools_ms ?? 0;
    const model = Math.max(big.ms - crew - tools, 0);
    words =
      crew >= tools && crew >= model
        ? 'the crew at work'
        : tools >= model
          ? "the agent's tool calls (apps, web, files)"
          : "the model's later rounds (after its first tool call)";
  }
  return `biggest: ${big.name}${share}: ${words}`;
}

// --- housekeeping ---------------------------------------------------------------------------------

/** Timings are kept 30 days (the daily cleanup). */
export async function cleanupTurnTimings(olderThanDays = 30): Promise<number> {
  const rows = await db()
    .delete(turnTimings)
    .where(lt(turnTimings.createdAt, new Date(Date.now() - olderThanDays * 86400_000)))
    .returning({ id: turnTimings.deliveryId });
  return rows.length;
}

/** Account deletion. */
export async function deleteTurnTimings(userId: string): Promise<void> {
  await db().delete(turnTimings).where(eq(turnTimings.userId, userId));
}
