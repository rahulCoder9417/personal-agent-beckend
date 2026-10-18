// The wake fee (decided 18 Oct 2026): 1 credit each time the agent's container wakes from sleep to
// do work, on top of awake time. Once per awake period that runs work: a second message while it
// is awake pays none; a wake with no work (the web app's prewarm, a Claude sign-in) pays only its
// time, and the first message while it is awake pays the fee; a job run again charges nothing more.
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getBalance } from '../src/modules/billing/credits.ts';
import { setTurnRefundDelay } from '../src/modules/billing/jobs.ts';
import { ensureLiteLLMKey, setLiteLLMClient } from '../src/modules/billing/litellm.ts';
import { litellmKeys } from '../src/modules/billing/schema.ts';
import { handleBillTurn } from '../src/modules/billing/turn-billing.ts';
import { WAKE_FEE_CREDITS, WAKE_FEE_DESCRIPTION } from '../src/modules/billing/wake-fee.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { isUserLocked } from '../src/modules/orchestrator/lock.ts';
import { prewarmNow } from '../src/modules/orchestrator/prewarm.ts';
import { outOfCreditsText, runTurn } from '../src/modules/orchestrator/turn.ts';
import { vm } from '../src/modules/orchestrator/vm.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { FakeLiteLLM, FakeVm } from './billing-fakes.ts';
import { fakeJob, ledgerMatchesGrants, ledgerOf, turnsBilled } from './billing-helpers.ts';
import { installFakeVm } from './fakes.ts';
import { call, chatUser, expectContract, waitFor } from './helpers.ts';

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

describe('the wake fee: 1 credit each time the container wakes to do work', () => {
  it('a work wake charges 1, once; a second message while it is awake charges no fee', async () => {
    expect(WAKE_FEE_CREDITS).toBe(1);
    const u = await customer(100);
    await message(u, 'one'); // the container was asleep: this turn woke it
    expect((await wakeFees(u.id)).map((l) => l.delta)).toEqual([-1]);
    expect(await getBalance(u.id)).toBe(99);
    await message(u, 'two'); // still awake
    await message(u, 'three');
    expect(await wakeFees(u.id)).toHaveLength(1);
    expect(await getBalance(u.id)).toBe(99);
    expect(fake.deliveries).toHaveLength(3);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it('each new wake pays again: the container slept between two messages', async () => {
    const u = await customer(100);
    await message(u, 'morning');
    fake.asleep(u.id); // the idle stop
    await message(u, 'evening');
    expect((await wakeFees(u.id)).map((l) => l.delta)).toEqual([-1, -1]);
    expect(await getBalance(u.id)).toBe(98);
  });

  it("the web app's prewarm alone pays no fee; prewarm then a message pays it once", async () => {
    const alone = await customer(100);
    expect(await prewarmNow(alone.id)).toBe('woken');
    await new Promise((r) => setTimeout(r, 50));
    expect(await wakeFees(alone.id)).toEqual([]);
    expect(await getBalance(alone.id)).toBe(100);

    const then = await customer(100);
    expect(await prewarmNow(then.id)).toBe('woken');
    await message(then, 'hi'); // the container was already awake: the prewarm woke it
    await message(then, 'and this');
    expect((await wakeFees(then.id)).map((l) => l.delta)).toEqual([-1]);
    expect(await getBalance(then.id)).toBe(99);
  });

  it('a billing job run again, or queued again, charges the fee once', async () => {
    const u = await customer(100);
    const job = fakeJob({
      userId: u.id,
      turnId: 'evt_once',
      ai: true,
      wakePeriod: 'turn:evt_once',
    });
    await handleBillTurn(job);
    await handleBillTurn(job);
    // A second turn that names the same awake period (a job retried after the container slept).
    await handleBillTurn(
      fakeJob({ userId: u.id, turnId: 'evt_other', ai: true, wakePeriod: 'turn:evt_once' }),
    );
    expect((await wakeFees(u.id)).map((l) => l.delta)).toEqual([-1]);
    expect(await getBalance(u.id)).toBe(99);
  });

  it('at zero credits nothing wakes and no fee is charged', async () => {
    const u = await customer(0);
    // The web app's message is refused at once; a message from Telegram (or a run) gets the reply.
    const res = await call('/v1/messages', {
      method: 'POST',
      token: u.token,
      body: { text: 'hello', clientMessageId: randomUUID() },
    });
    expect(res.status).toBe(402);
    const outcome = await runTurn({
      userId: u.id,
      deliveryId: `evt_${randomUUID()}`,
      kind: 'message',
      sessionKey: 'web',
      channel: 'web',
      text: 'hello',
    });
    expect(outcome).toBe('out_of_credits');
    expect(fake.wakes).not.toContain(u.id);
    expect(fake.deliveries).toEqual([]);
    expect(await wakeFees(u.id)).toEqual([]);
    const out = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, u.id), eq(messages.direction, 'out')));
    expect(out.map((m) => m.text)).toEqual([outOfCreditsText('web')]);
  });

  it('a turn that fails on our side pays no fee; the next work in that awake period pays it', async () => {
    const u = await customer(100);
    fake.state.turnErrorAfterAgent = { message: 'bridge crashed', platformFault: true };
    await message(u, 'first');
    await waitFor(async () => (await getBalance(u.id)) === 100);
    expect(await wakeFees(u.id)).toEqual([]);
    await message(u, 'again');
    expect((await wakeFees(u.id)).map((l) => l.delta)).toEqual([-1]);
  });

  it('is its own line: the credit history says "Waking your agent", usage has wakeCredits', async () => {
    const u = await customer(100);
    usage.add(u.id, 300); // 5 minutes awake: 1 credit
    await message(u, 'work');
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const body = await expectContract<{
      items: Array<Record<string, number>>;
      totals: Record<string, number>;
    }>('getUsage', await call(`/v1/usage?from=${from}&to=${to}`, { token: u.token }), 200);
    expect(body.totals).toMatchObject({ awakeCredits: 1, wakeCredits: 1, totalCredits: 2 });
    expect(body.items[0]).toMatchObject({ awakeCredits: 1, wakeCredits: 1, totalCredits: 2 });
    const ledger = await expectContract<{ items: Array<{ description: string; delta: number }> }>(
      'listLedger',
      await call('/v1/credits/ledger', { token: u.token }),
      200,
    );
    expect(ledger.items.map((l) => [l.description, l.delta])).toContainEqual([
      'Waking your agent',
      -1,
    ]);
  });
});
