import { randomUUID } from 'node:crypto';
import { redis } from '../../shared/redis.ts';

/** One inbound run per user at a time (HLD 0.2). Longer than the 15-minute turn timeout. */
export const USER_LOCK_TTL_MS = 16 * 60 * 1000;

const key = (userId: string) => `lock:user:${userId}`;

export async function acquireUserLock(
  userId: string,
  ttlMs = USER_LOCK_TTL_MS,
): Promise<string | null> {
  const token = randomUUID();
  const ok = await redis().set(key(userId), token, 'PX', ttlMs, 'NX');
  return ok === 'OK' ? token : null;
}

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export async function releaseUserLock(userId: string, token: string): Promise<void> {
  await redis().eval(RELEASE, 1, key(userId), token);
}

export async function isUserLocked(userId: string): Promise<boolean> {
  return (await redis().exists(key(userId))) === 1;
}
