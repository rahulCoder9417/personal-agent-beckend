// Waking the container before the message (HLD 5.2): POST /v1/agent/prewarm, its once-a-minute
// limit, the cases where nothing is woken, one user never waking another's container, and the
// first message after a prewarm skipping the wake.
import { randomUUID } from 'node:crypto';
import { Code, ConnectError } from '@connectrpc/connect';
import type { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setAccountStatus } from '../src/modules/auth/users.ts';
import { getEvent } from '../src/modules/events/intake.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import {
  PREWARM_EVERY_SECONDS,
  prewarmNow,
  requestPrewarm,
} from '../src/modules/orchestrator/prewarm.ts';
import { sendWebMessage } from '../src/modules/orchestrator/process-message.ts';
import {
  setChatCompleter,
  setJevClient,
  setRoutingAppsProvider,
} from '../src/modules/orchestrator/routing.ts';
import { ensureSandbox, getAgentStatus } from '../src/modules/orchestrator/sandbox.ts';
import { turnTimings } from '../src/modules/orchestrator/schema.ts';
import { turnStages } from '../src/modules/orchestrator/timings.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { redis } from '../src/shared/redis.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { installFakeVm } from './fakes.ts';
import { call, chatUser, createUser, expectContract, waitFor } from './helpers.ts';

/** A sleeping container takes this long to wake in these tests (2.5 to 3.5 s on the server). */
const COLD_WAKE_MS = 600;

type Prewarm = { started: boolean; reason: string };

let workers: Worker[];
let vmFake: ReturnType<typeof installFakeVm>;

beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  setJevClient(undefined);
  setChatCompleter(undefined);
});
beforeEach(() => {
  vmFake = installFakeVm();
  vmFake.state.sleepModel = { coldWakeMs: COLD_WAKE_MS };
  setJevClient({ decide: async () => ({ route: 'task', confidence: 0.9, apps: [] }) });
  setChatCompleter(async () => 'Hello!');
  setRoutingAppsProvider(async () => []);
});
afterEach(() => {
  delete process.env.AI_ACCESS_MODE;
  resetConfig();
});

/** A user whose container exists and is asleep. */
async function sleepingUser(overrides: Parameters<typeof chatUser>[0] = {}) {
  const user = await chatUser(overrides);
  await ensureSandbox(user.id);
  return user;
}

async function prewarm(token: string): Promise<Prewarm> {
  return expectContract<Prewarm>(
    'prewarmAgent',
    await call('/v1/agent/prewarm', { method: 'POST', token }),
    200,
  );
}

const wakesOf = (userId: string) => vmFake.wakes.filter((id) => id === userId).length;

/** The worker had time to run a prewarm job if one was added. */
const settle = () => new Promise((r) => setTimeout(r, 300));

describe('POST /v1/agent/prewarm', () => {
  it('wakes a sleeping container in the worker and answers at once', async () => {
    const user = await sleepingUser();
    expect((await getAgentStatus(user.id)).state).toBe('stopped');
    const started = Date.now();
    expect(await prewarm(user.token)).toEqual({ started: true, reason: 'started' });
    // The api did not wait for the wake.
    expect(Date.now() - started).toBeLessThan(COLD_WAKE_MS);
    await waitFor(async () => (await getAgentStatus(user.id)).state === 'awake');
    expect(wakesOf(user.id)).toBe(1);
  });

  it('needs a signed-in user', async () => {
    const res = await call('/v1/agent/prewarm', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('does something at most once a minute per user', async () => {
    const user = await sleepingUser();
    expect((await prewarm(user.token)).reason).toBe('started');
    await waitFor(async () => (await getAgentStatus(user.id)).state === 'awake');
    vmFake.asleep(user.id);
    // Asleep again, but asked within the minute: nothing.
    expect(await prewarm(user.token)).toEqual({ started: false, reason: 'recent' });
    expect(await prewarm(user.token)).toEqual({ started: false, reason: 'recent' });
    await settle();
    expect(wakesOf(user.id)).toBe(1);
    // The limit lasts a minute and no longer.
    const ttl = await redis().ttl(`prewarm:user:${user.id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(PREWARM_EVERY_SECONDS);
    // A minute later (the key ran out) it works again.
    await redis().del(`prewarm:user:${user.id}`);
    expect((await prewarm(user.token)).reason).toBe('started');
    await waitFor(async () => wakesOf(user.id) === 2);
  });

  it('does nothing when the container is already awake', async () => {
    const user = await sleepingUser();
    expect((await prewarm(user.token)).reason).toBe('started');
    await waitFor(async () => (await getAgentStatus(user.id)).state === 'awake');
    await redis().del(`prewarm:user:${user.id}`);
    expect(await prewarm(user.token)).toEqual({ started: false, reason: 'awake' });
    await settle();
    expect(wakesOf(user.id)).toBe(1);
  });

  it('does nothing at zero credits', async () => {
    const user = await createUser(); // no credits
    await ensureSandbox(user.id);
    expect(await prewarm(user.token)).toEqual({ started: false, reason: 'no_credits' });
    await settle();
    expect(wakesOf(user.id)).toBe(0);
  });

  it('does nothing when no AI is connected', async () => {
    process.env.AI_ACCESS_MODE = 'own_only';
    resetConfig();
    const user = await sleepingUser(); // no own key, no Claude plan
    expect(await prewarm(user.token)).toEqual({ started: false, reason: 'no_ai' });
    await settle();
    expect(wakesOf(user.id)).toBe(0);
  });

  it('does nothing for a suspended account, also when it was suspended after the job was added', async () => {
    const user = await sleepingUser();
    await setAccountStatus(user.id, 'suspended');
    // A suspended user's session is refused by the api; the module says the same on its own.
    expect(await requestPrewarm(user.id)).toEqual({ started: false, reason: 'suspended' });
    // The worker's half checks again.
    expect(await prewarmNow(user.id)).toBe('skipped');
    await settle();
    expect(wakesOf(user.id)).toBe(0);
  });

  it("one user's call never wakes, or counts against, another user's container", async () => {
    const a = await sleepingUser();
    const b = await sleepingUser();
    expect((await prewarm(a.token)).reason).toBe('started');
    await waitFor(async () => (await getAgentStatus(a.id)).state === 'awake');
    await settle();
    expect(wakesOf(a.id)).toBe(1);
    expect(wakesOf(b.id)).toBe(0);
    expect((await getAgentStatus(b.id)).state).toBe('stopped');
    // A's minute is A's own: B's first call goes through, and wakes B only.
    expect((await prewarm(b.token)).reason).toBe('started');
    await waitFor(async () => (await getAgentStatus(b.id)).state === 'awake');
    expect(wakesOf(a.id)).toBe(1);
    expect(wakesOf(b.id)).toBe(1);
  });

  it('a wake the server refuses (full, or the vm-manager down) is dropped, never retried', async () => {
    const user = await sleepingUser();
    vmFake.state.wakeError = new ConnectError('awake cap reached', Code.ResourceExhausted);
    expect(await prewarmNow(user.id)).toBe('skipped');
    expect(wakesOf(user.id)).toBe(1);
  });
});

describe('the first message after a prewarm skips the wake', () => {
  async function send(userId: string, text: string): Promise<string> {
    const { eventId } = await sendWebMessage(userId, { text, clientMessageId: randomUUID() });
    await waitFor(async () => {
      const status = (await getEvent(eventId))?.status;
      return status === 'done' || status === 'failed';
    });
    return eventId;
  }

  async function wakeStage(deliveryId: string) {
    const row = await waitFor(async () => {
      const [r] = await db()
        .select()
        .from(turnTimings)
        .where(eq(turnTimings.deliveryId, deliveryId));
      return r?.outcome === 'done' ? r : undefined;
    });
    const s = row.stages;
    return {
      kind: row.wake,
      /** From asking the vm-manager to wake to it answering, as the turn saw it. */
      ms: (s.woken ?? 0) - (s.wake_started ?? 0),
      stage: turnStages(row).find((st) => st.name === 'wake')?.ms ?? 0,
    };
  }

  it('without a prewarm the turn waits for a cold wake; after one the container is warm', async () => {
    const before = await sleepingUser();
    const cold = await wakeStage(await send(before.id, 'check my mail please'));

    const after = await sleepingUser();
    expect((await prewarm(after.token)).reason).toBe('started');
    await waitFor(async () => (await getAgentStatus(after.id)).state === 'awake');
    const warm = await wakeStage(await send(after.id, 'check my mail please'));

    expect(cold.kind).toBe('cold');
    expect(cold.ms).toBeGreaterThanOrEqual(COLD_WAKE_MS - 20);
    expect(warm.kind).toBe('warm');
    expect(warm.ms).toBeLessThan(100);
    expect(warm.stage).toBeLessThan(100);
    // The numbers, for the log entry.
    console.info(
      `prewarm: wake stage without prewarm ${cold.stage} ms (wake call ${cold.ms} ms, ${cold.kind}); ` +
        `after prewarm ${warm.stage} ms (wake call ${warm.ms} ms, ${warm.kind})`,
    );
  });
});
