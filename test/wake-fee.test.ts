// No wake fee (decided 18 Oct 2026): waking the container to do work costs nothing extra. The agent
// pays only its awake time (1 credit per 5 minutes). It was 1 credit per wake for a few hours the
// same day; these tests check that no wake charge is written any more, for any kind of wake.
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getBalance } from '../src/modules/billing/credits.ts';
import { setTurnRefundDelay } from '../src/modules/billing/jobs.ts';
import { ensureLiteLLMKey, setLiteLLMClient } from '../src/modules/billing/litellm.ts';
import { litellmKeys } from '../src/modules/billing/schema.ts';
import { WAKE_FEE_CREDITS, WAKE_FEE_DESCRIPTION } from '../src/modules/billing/wake-fee.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { isUserLocked } from '../src/modules/orchestrator/lock.ts';
import { prewarmNow } from '../src/modules/orchestrator/prewarm.ts';
import { vm } from '../src/modules/orchestrator/vm.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { FakeLiteLLM, FakeVm } from './billing-fakes.ts';
import { ledgerMatchesGrants, ledgerOf, turnsBilled } from './billing-helpers.ts';
import { installFakeVm } from './fakes.ts';
import { call, chatUser, waitFor } from './helpers.ts';

const RETRY = { retryDelaysMs: [50, 50, 50, 50] };
let workers: Worker[];
let fake: ReturnType<typeof installFakeVm>;
let usage: FakeVm;

beforeAll(() => {
  wireModules();
  setTurnRefundDelay(0);
  workers = startWorkers(processors(), RETRY);
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(() => {
  fake = installFakeVm(async (d, mcp) => {
    await mcp('send_message', { text: `echo: ${d.text}`, session_key: d.sessionKey });
  });
  setLiteLLMClient(new FakeLiteLLM());
  usage = new FakeVm();
  (vm() as unknown as { getUsage: unknown }).getUsage = usage.client().getUsage;
});
afterEach(async () => {
  await queue('system').drain(true);
});

async function customer(credits: number) {
  const u = await chatUser({ plan: 'pro', credits });
  await ensureLiteLLMKey(u.id);
  await db()
    .update(litellmKeys)
    .set({ createdAt: new Date(Date.now() - 60_000) })
    .where(eq(litellmKeys.userId, u.id));
  return u;
}
type Customer = Awaited<ReturnType<typeof customer>>;

/** Sends a web chat message and waits until its turn is over and billed. */
async function message(u: Customer, text: string): Promise<void> {
  const res = await call('/v1/messages', {
    method: 'POST',
    token: u.token,
    body: { text, clientMessageId: randomUUID() },
  });
  expect(res.status, await res.clone().text()).toBe(202);
  const { id } = (await res.json()) as { id: string };
  await waitFor(async () => {
    const [m] = await db().select().from(messages).where(eq(messages.id, id));
    return !!m && !['queued', 'processing'].includes(m.status) && !(await isUserLocked(u.id));
  });
  await turnsBilled(u.id);
}

const wakeFees = async (userId: string) =>
  (await ledgerOf(userId)).filter((l) => l.description === WAKE_FEE_DESCRIPTION);

describe('no wake fee: waking the container costs nothing extra', () => {
  it('the fee is 0', () => {
    expect(WAKE_FEE_CREDITS).toBe(0);
  });

  it('a wake to do work, and a second wake after it slept, charge no wake fee', async () => {
    const u = await customer(100);
    await message(u, 'morning'); // the container was asleep: this turn woke it
    await message(u, 'still awake');
    fake.asleep(u.id); // the idle stop
    await message(u, 'evening'); // woke again
    expect(await wakeFees(u.id)).toEqual([]);
    expect(await getBalance(u.id)).toBe(100);
    expect(fake.deliveries).toHaveLength(3);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it("the web app's prewarm, then a message, charges no wake fee", async () => {
    const u = await customer(100);
    expect(await prewarmNow(u.id)).toBe('woken');
    await message(u, 'hello');
    expect(await wakeFees(u.id)).toEqual([]);
    expect(await getBalance(u.id)).toBe(100);
  });
});
