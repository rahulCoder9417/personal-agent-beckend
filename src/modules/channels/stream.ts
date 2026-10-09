// Live updates for the web app (SSE). The worker publishes to Redis; each api process keeps one
// pattern subscription and fans events out to its open connections.
import type { Redis } from 'ioredis';
import { createRedis, redis } from '../../shared/redis.ts';

export type StreamEventType =
  | 'message.created'
  | 'message.status'
  | 'approval.created'
  | 'approval.resolved'
  | 'agent.status'
  | 'agent.progress'
  | 'credits.updated'
  | 'automation.updated'
  | 'conversation.updated'
  | 'conversation.deleted';

export interface StreamEvent {
  type: StreamEventType;
  data: unknown;
}

const channelFor = (userId: string) => `stream:user:${userId}`;

export async function publish(userId: string, type: StreamEventType, data: unknown): Promise<void> {
  await redis().publish(channelFor(userId), JSON.stringify({ type, data } satisfies StreamEvent));
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
      const event = JSON.parse(message) as StreamEvent;
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
