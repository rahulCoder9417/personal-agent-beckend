// Live updates for the web app (SSE). The worker publishes to Redis; each api process keeps one
// pattern subscription and fans events out to its open connections. Every event but a draft also
// goes into a short record per user, so a connection that comes back is sent what it missed.
import type { Redis } from 'ioredis';
import { createRedis, redis } from '../../shared/redis.ts';

export type StreamEventType =
  | 'message.created'
  | 'message.status'
  | 'message.draft'
  | 'approval.created'
  | 'approval.resolved'
  | 'agent.status'
  | 'agent.progress'
  | 'credits.updated'
  | 'automation.updated'
  | 'automation_draft.updated'
  | 'automation_run.updated'
  | 'conversation.updated'
  | 'conversation.deleted';

export interface StreamEvent {
  type: StreamEventType;
  data: unknown;
  /**
   * The event's id in the user's record of recent events (a Redis stream id, like
   * `1760600000000-0`; ids only grow). Absent on a `message.draft`, which is live only.
   */
  id?: string;
  /**
   * A draft: the id of the newest event recorded before it was sent. A connection that has already
   * written a later event drops the draft, so no draft comes after the end of its turn, also when
   * missed events are replayed (the next draft brings the whole text back).
   */
  after?: string;
}

const channelFor = (userId: string) => `stream:user:${userId}`;

// --- the record of recent events, for a connection that comes back -----------------------------
// Each user's events but drafts are also kept in a Redis stream, the last STREAM_REPLAY_EVENTS of
// the last STREAM_REPLAY_SECONDS. A connection that gives the id of the last event it got is sent
// what came after it (eventsSince), so a dropped connection misses nothing.

const logFor = (userId: string) => `stream:log:${userId}`;
/** At most this many events are kept per user (Redis trims about this many: `MAXLEN ~`). */
export const STREAM_REPLAY_EVENTS = 500;
/** The record is dropped this long after its last event. */
export const STREAM_REPLAY_SECONDS = 15 * 60;
/** Live only: a draft holds the whole answer so far, so the next one brings it all back. */
const LIVE_ONLY: ReadonlySet<StreamEventType> = new Set<StreamEventType>(['message.draft']);

/**
 * Adds the event to the record and publishes it with its id, in one step, so the live order and
 * the record's order are the same also when several processes publish for one user. The message
 * on the channel is `id:<id> <json>`.
 */
const RECORD_AND_PUBLISH = `
local id = redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[3], '*', 'e', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('PUBLISH', ARGV[2], 'id:' .. id .. ' ' .. ARGV[1])
return id`;

/** A draft is not recorded; it is published as `after:<newest recorded id> <json>`, in one step. */
const PUBLISH_DRAFT = `
local last = redis.call('XREVRANGE', KEYS[1], '+', '-', 'COUNT', 1)
local after = '0-0'
if last[1] then after = last[1][1] end
redis.call('PUBLISH', ARGV[2], 'after:' .. after .. ' ' .. ARGV[1])
return after`;

const STREAM_ID = /^\d{1,20}-\d{1,20}$/;

/** Orders two stream ids: negative when `a` came first. */
export function compareStreamIds(a: string, b: string): number {
  const [am, as] = a.split('-').map(BigInt) as [bigint, bigint];
  const [bm, bs] = b.split('-').map(BigInt) as [bigint, bigint];
  if (am !== bm) return am < bm ? -1 : 1;
  return as === bs ? 0 : as < bs ? -1 : 1;
}

/**
 * Whether a connection that has written events up to `newest` writes `e`: not an event it has
 * written already (replayed, then heard live too), and not a draft sent before an event it has
 * written (a draft must never come after the events that followed it, the end of its turn among
 * them). Events without an id or `after` (sent before ids existed) are always written.
 */
export function writesNext(newest: string | undefined, e: StreamEvent): boolean {
  if (!newest) return true;
  if (e.id) return compareStreamIds(e.id, newest) > 0;
  if (e.after) return compareStreamIds(newest, e.after) <= 0;
  return true;
}

/** One message from the channel: `id:<id> <json>`, `after:<id> <json>` (a draft), or bare JSON. */
function parseMessage(message: string): StreamEvent {
  if (message.startsWith('{')) return JSON.parse(message) as StreamEvent;
  const space = message.indexOf(' ');
  const [tag, id] = message.slice(0, space).split(':') as [string, string];
  const event = JSON.parse(message.slice(space + 1)) as StreamEvent;
  return tag === 'after' ? { ...event, after: id } : { ...event, id };
}

/**
 * The user's events after `lastId`, in order, when the record still holds `lastId` itself (then
 * it holds everything after it too: it loses its oldest events first, or all of them at once).
 * Null when it doesn't (too old, never sent, not an id): what came after can't be known.
 */
export async function eventsSince(userId: string, lastId: string): Promise<StreamEvent[] | null> {
  if (!STREAM_ID.test(lastId)) return null;
  const rows = await redis().xrange(logFor(userId), lastId, '+');
  if (rows[0]?.[0] !== lastId) return null;
  return rows.slice(1).map(([id, fields]) => ({
    ...(JSON.parse(fields[fields.indexOf('e') + 1] ?? '{}') as StreamEvent),
    id,
  }));
}

const turnOf = (e: StreamEvent) => (e.data as { turnId?: unknown } | null)?.turnId;

/**
 * Adds an event to one connection's queue of events not yet written. A `message.draft` holds the
 * whole draft, so when one of the same turn is still waiting in the queue, the new one takes its
 * place: a slow connection gets the latest text, once, and never after the events that followed
 * the older one (the answer itself among them). Everything else is kept, in order.
 */
export function enqueueStreamEvent(queue: StreamEvent[], event: StreamEvent): void {
  if (event.type === 'message.draft') {
    const waiting = queue.findIndex(
      (e) => e.type === 'message.draft' && turnOf(e) === turnOf(event),
    );
    if (waiting !== -1) {
      queue[waiting] = event;
      return;
    }
  }
  queue.push(event);
}

export async function publish(userId: string, type: StreamEventType, data: unknown): Promise<void> {
  const json = JSON.stringify({ type, data } satisfies StreamEvent);
  if (LIVE_ONLY.has(type)) {
    await redis().eval(PUBLISH_DRAFT, 1, logFor(userId), json, channelFor(userId));
    return;
  }
  await redis().eval(
    RECORD_AND_PUBLISH,
    1,
    logFor(userId),
    json,
    channelFor(userId),
    STREAM_REPLAY_EVENTS,
    STREAM_REPLAY_SECONDS,
  );
}

type Listener = (e: StreamEvent) => void;
const listeners = new Map<string, Set<Listener>>();
let subscriber: Redis | undefined;
let ready: Promise<unknown> | undefined;

function ensureSubscriber(): Promise<unknown> {
  if (!subscriber) {
    subscriber = createRedis();
    subscriber.on('pmessage', (_pattern, channel, message) => {
      const userId = channel.slice('stream:user:'.length);
      const set = listeners.get(userId);
      if (!set) return;
      const event = parseMessage(message);
      for (const l of set) l(event);
    });
    ready = subscriber.psubscribe('stream:user:*');
  }
  return ready!;
}

/** Subscribes to one user's events. Returns an unsubscribe function. */
export async function subscribe(userId: string, listener: Listener): Promise<() => void> {
  await ensureSubscriber();
  let set = listeners.get(userId);
  if (!set) listeners.set(userId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(userId);
  };
}
