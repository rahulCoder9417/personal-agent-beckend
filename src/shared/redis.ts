import { Redis } from 'ioredis';
import { config } from './config.ts';

const connections: Redis[] = [];

/** A new connection (BullMQ needs maxRetriesPerRequest: null). */
export function createRedis(): Redis {
  const r = new Redis(config().REDIS_URL, { maxRetriesPerRequest: null });
  connections.push(r);
  return r;
}

let shared: Redis | undefined;

/** Shared connection for locks, rate limits and pub/sub publishing. */
export function redis(): Redis {
  shared ??= createRedis();
  return shared;
}

export async function closeRedis(): Promise<void> {
  shared = undefined;
  const all = connections.splice(0);
  await Promise.all(all.map((c) => c.quit().catch(() => c.disconnect())));
}
