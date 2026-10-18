// Waking the container before the message (HLD 5.2): the web app asks when the user opens the chat
// or starts typing, so the first message after the idle stop doesn't wait 2.5 to 3.5 s for the
// wake. The api only checks and adds a job; the worker asks the vm-manager to wake the container.
import type { Job } from 'bullmq';
import { logger } from '../../shared/logger.ts';
import { redis } from '../../shared/redis.ts';
import { getActiveUserCached } from '../auth/users.ts';
import { publish } from '../channels/stream.ts';
import { addJob } from '../events/queues.ts';
import { newId } from '../../shared/ids.ts';
import { getAgentSettings } from './agent-settings.ts';
import { noteWake } from './awake-periods.ts';
import { ensureSandbox, getAgentStatus } from './sandbox.ts';
import { userHasCredits } from './turn.ts';
import { planPriority, vm } from './vm.ts';

export type PrewarmReason = 'started' | 'recent' | 'awake' | 'no_credits' | 'no_ai' | 'suspended';

/** At most one prewarm per user in this many seconds. */
export const PREWARM_EVERY_SECONDS = 60;

const recentKey = (userId: string) => `prewarm:user:${userId}`;

/**
 * The first call of the minute for this user? Counts the call. Redis down: no (nothing is woken,
 * the message wakes the container as before).
 */
async function firstThisMinute(userId: string): Promise<boolean> {
  try {
    return (await redis().set(recentKey(userId), '1', 'EX', PREWARM_EVERY_SECONDS, 'NX')) === 'OK';
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'prewarm not counted; skipped');
    return false;
  }
}

/** Already waking, awake or busy (or not known: then a wake would only repeat itself). */
async function alreadyUp(userId: string): Promise<boolean> {
  try {
    const { state } = await getAgentStatus(userId);
    return state === 'waking' || state === 'awake' || state === 'busy';
  } catch (err) {
    logger().debug({ userId, err: String(err) }, 'container state not read for prewarm');
    return true;
  }
}

/**
 * POST /v1/agent/prewarm. Decides whether to wake the container, and if so adds the job that does
 * it. Never wakes for a suspended account, a user with no credits or no AI connected, or a
 * container that is already up; at most once a minute per user. Never fails the request: a read
 * that fails means "don't wake".
 */
export async function requestPrewarm(
  userId: string,
): Promise<{ started: boolean; reason: PrewarmReason }> {
  const no = (reason: PrewarmReason) => ({ started: false, reason });
  const user = await getActiveUserCached(userId);
  if (!user || user.status === 'suspended') return no('suspended');
  if (!(await firstThisMinute(userId))) return no('recent');
  const [settings, credits, up] = await Promise.all([
    getAgentSettings(userId).catch(() => null),
    userHasCredits(userId).catch(() => false),
    alreadyUp(userId),
  ]);
  if (!settings || settings.aiAccess === 'none') return no('no_ai');
  if (!credits) return no('no_credits');
  if (up) return no('awake');
  await addJob(
    'system',
    'prewarm',
    { userId },
    {
      jobId: `prewarm-${userId}-${Date.now()}`,
      // A wake that comes late is of no use: no retries, and nothing kept once done.
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { age: 24 * 3600 },
    },
  );
  return { started: true, reason: 'started' };
}

/**
 * The worker's half: wakes the container. The account is checked again (it may have been suspended
 * meanwhile). Never throws: a server that is full, or a vm-manager that can't be reached, means the
 * message wakes the container as before. `woken`: it was asleep and is awake now.
 */
export async function prewarmNow(userId: string): Promise<'woken' | 'already_awake' | 'skipped'> {
  const user = await getActiveUserCached(userId);
  if (!user || user.status === 'suspended') return 'skipped';
  try {
    await ensureSandbox(userId);
    const woke = await vm().wakeSandbox({ userId, priority: planPriority(user.plan) });
    // A new awake period with no work yet: no wake fee now; the first message in it pays it.
    await noteWake(userId, woke.wasStopped, `prewarm:${newId('wake')}`);
    if (!woke.wasStopped) return 'already_awake';
    await publish(userId, 'agent.status', {
      state: 'awake',
      lastActiveAt: new Date().toISOString(),
    }).catch(() => {});
    logger().info({ userId }, 'container woken ahead of the message');
    return 'woken';
  } catch (err) {
    logger().info({ userId, err: String(err) }, 'prewarm wake not done; the message wakes it');
    return 'skipped';
  }
}

/** system/prewarm. */
export async function handlePrewarm(job: Job): Promise<unknown> {
  return prewarmNow((job.data as { userId: string }).userId);
}
