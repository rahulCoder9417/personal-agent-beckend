// A turn's billing runs as a job of its own, after the user's lock is given back (backend report,
// sections 9, 25 and 26). The reply and the lock come first; the usage sync, the credit charge and
// the live balance come after, on the system queue. A turn on the user's Claude plan never asks
// LiteLLM. The check before a turn still sees the charges of all but the one turn before it.
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getBalance } from '../src/modules/billing/credits.ts';
import { setTurnRefundDelay } from '../src/modules/billing/jobs.ts';
import { ensureLiteLLMKey, setLiteLLMClient } from '../src/modules/billing/litellm.ts';
import { litellmKeys, usagePeriods } from '../src/modules/billing/schema.ts';
import {
  billTurnJobId,
  handleBillTurn,
  queueTurnBilling,
  unbilledTurns,
  UNBILLED_TURNS_ALLOWED,
} from '../src/modules/billing/turn-billing.ts';
import { syncAllUsage, syncUsageForUser } from '../src/modules/billing/usage.ts';
import { subscribe } from '../src/modules/channels/stream.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { markClaudeConnected } from '../src/modules/orchestrator/agent-settings.ts';
import { isUserLocked } from '../src/modules/orchestrator/lock.ts';
import { outOfCreditsText } from '../src/modules/orchestrator/turn.ts';
import { vm } from '../src/modules/orchestrator/vm.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { FakeLiteLLM, FakeVm } from './billing-fakes.ts';
import { fakeJob, ledgerMatchesGrants, ledgerOf, turnsBilled } from './billing-helpers.ts';
import { installFakeVm } from './fakes.ts';
import { call, chatUser, finishedJob, waitFor } from './helpers.ts';

const RETRY = { retryDelaysMs: [50, 50, 50, 50] };
/** The api's and the turn's queues. The system queue (billing) is started by each test. */
let chat: Worker[];
let system: Worker[] = [];
let fake: ReturnType<typeof installFakeVm>;
let llm: FakeLiteLLM;
/** Awake and browser seconds by time, so each sync gets only its own window (GetUsage). */
let usage: FakeVm;

beforeAll(() => {
  wireModules();
  setTurnRefundDelay(0);
  const all = processors();
  chat = startWorkers({ inbound: all.inbound, outbound: all.outbound }, RETRY);
});
afterAll(async () => {
  await Promise.all(chat.map((w) => w.close()));
  await closeQueues();
});
beforeEach(() => {
  fake = installFakeVm();
  llm = new FakeLiteLLM();
  setLiteLLMClient(llm);
  usage = new FakeVm();
  (vm() as unknown as { getUsage: unknown }).getUsage = usage.client().getUsage;
});
afterEach(async () => {
  await Promise.all(system.map((w) => w.close()));
  system = [];
  // Each test starts with an empty system queue: no job of another test's user runs in it.
  await queue('system').drain(true);
});

/** Billing starts running (the system queue's worker). */
function startBilling(): void {
  system = startWorkers({ system: processors().system }, RETRY);
}

/** A user with credits and a LiteLLM key from a minute ago (where their first period starts). */
async function customer(credits: number, plan: 'free' | 'pro' | 'max' = 'pro') {
  const u = await chatUser({ plan, credits });
  await ensureLiteLLMKey(u.id);
  await db()
    .update(litellmKeys)
    .set({ createdAt: new Date(Date.now() - 60_000) })
    .where(eq(litellmKeys.userId, u.id));
  return u;
}

type Customer = Awaited<ReturnType<typeof customer>>;

/** Sends a web chat message; returns the saved message's id. */
async function send(u: Customer, text: string): Promise<string> {
  const res = await call('/v1/messages', {
    method: 'POST',
    token: u.token,
    body: { text, clientMessageId: randomUUID() },
  });
  expect(res.status, await res.clone().text()).toBe(202);
  return ((await res.json()) as { id: string }).id;
}

/** Waits until the message's turn is over and the user's lock is free again. */
async function turnOver(u: Customer, messageId: string): Promise<void> {
  await waitFor(async () => {
    const [m] = await db().select().from(messages).where(eq(messages.id, messageId));
    return !!m && !['queued', 'processing'].includes(m.status) && !(await isUserLocked(u.id));
  });
}

const repliesOf = async (userId: string) =>
  (
    await db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.direction, 'out')))
  )
    .map((m) => m.text)
    .sort();

const periodsOf = (userId: string) =>
  db().select().from(usagePeriods).where(eq(usagePeriods.userId, userId));

const usageCharges = async (userId: string) =>
  (await ledgerOf(userId)).filter((l) => l.description.startsWith('Usage:'));
/** The wake fees charged (1 credit each time the container woke to do work). */
const wakeFees = async (userId: string) =>
  (await ledgerOf(userId)).filter((l) => l.description === 'Waking your agent').map((l) => l.delta);

async function jobState(turnId: string) {
  return (await queue('system').getJob(billTurnJobId(turnId)))?.getState();
}

describe('the reply and the lock come first', () => {
  it("a second message starts while the first turn's billing still waits", async () => {
    const u = await customer(100);
    // Each turn keeps the container awake 5 minutes: 1 credit.
    fake.state.agent = async (d, mcp) => {
      usage.add(d.userId, 300);
      await mcp('send_message', { text: `echo: ${d.text}`, session_key: d.sessionKey });
    };

    const first = await send(u, 'one');
    await turnOver(u, first);
    expect(await repliesOf(u.id)).toEqual(['echo: one']);
    const [turn1] = fake.deliveries.map((d) => d.deliveryId);
    // The lock is free, the billing job waits, and nothing is charged yet.
    expect(await jobState(turn1!)).toBe('waiting');
    expect(await periodsOf(u.id)).toEqual([]);
    expect(await getBalance(u.id)).toBe(100);

    // The next message runs at once: its turn does not wait for the first one's billing.
    const second = await send(u, 'two');
    await turnOver(u, second);
    expect(await repliesOf(u.id)).toEqual(['echo: one', 'echo: two'].sort());
    const turn2 = fake.deliveries[1]!.deliveryId;
    expect(await jobState(turn1!)).toBe('waiting');
    expect(await periodsOf(u.id)).toEqual([]); // one turn waiting was allowed: no billing in turn 2
    expect(Object.keys(await unbilledTurns(u.id)).sort()).toEqual([turn1, turn2].sort());

    // Billing runs: both turns charged, once, and the web app gets the new balance. The first
    // turn woke the container: its wake fee too; the second ran while it was awake: none.
    const balances: number[] = [];
    const stop = await subscribe(u.id, (e) => {
      if (e.type === 'credits.updated') balances.push((e.data as { balance: number }).balance);
    });
    startBilling();
    await turnsBilled(u.id);
    await waitFor(async () => balances.includes(97));
    stop();
    expect(await jobState(turn1!)).toBe('completed');
    expect(await jobState(turn2)).toBe('completed');
    expect(await getBalance(u.id)).toBe(97);
    expect((await usageCharges(u.id)).reduce((n, l) => n + l.delta, 0)).toBe(-2);
    expect(await wakeFees(u.id)).toEqual([-1]);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });
});

describe('the billing job', () => {
  it('runs twice, charges once; queued twice, runs once', async () => {
    const u = await customer(100);
    llm.spend(u.id, 'claude', 0.02, Date.now() - 2000); // 5 credits
    usage.add(u.id, 300, 0, Date.now() - 2000); // 1 credit
    const job = fakeJob({ userId: u.id, turnId: 'evt_twice', ai: true });

    expect((await handleBillTurn(job)).charged).toBe(6);
    expect((await handleBillTurn(job)).charged).toBe(0);
    expect(await getBalance(u.id)).toBe(94);
    expect(await usageCharges(u.id)).toHaveLength(1);

    const turnId = `evt_${randomUUID()}`;
    await queueTurnBilling(u.id, { turnId, ai: true });
    await queueTurnBilling(u.id, { turnId, ai: true });
    const queued = (await queue('system').getJobs(['waiting', 'delayed'])).filter(
      (j) => j.name === 'bill-turn' && j.data.userId === u.id,
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]!.id).toBe(billTurnJobId(turnId));
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it('fails, is tried again, and charges the turn exactly once', async () => {
    const u = await customer(100);
    fake.state.agent = async (d, mcp) => {
      llm.spend(d.userId, 'claude', 0.031); // 7.75 → 8 credits
      usage.add(d.userId, 300); // 1 credit
      await mcp('send_message', { text: 'done', session_key: d.sessionKey });
    };
    // The vm-manager doesn't answer the first time the billing asks.
    const getUsage = usage.client().getUsage;
    let calls = 0;
    (vm() as unknown as { getUsage: unknown }).getUsage = async (
      req: Parameters<typeof getUsage>[0],
    ) => {
      if (req.userId === u.id && ++calls === 1) throw new Error('vm-manager unavailable');
      return getUsage(req);
    };
    startBilling();

    const id = await send(u, 'work');
    await turnOver(u, id);
    await turnsBilled(u.id);
    const { job, state } = await finishedJob(
      queue('system'),
      billTurnJobId(fake.deliveries[0]!.deliveryId),
    );
    expect(state).toBe('completed');
    expect(job.attemptsMade).toBe(2);
    expect((await usageCharges(u.id)).map((l) => l.delta)).toEqual([-9]);
    // The wake fee was charged on the first try; the second try charged it no more.
    expect(await wakeFees(u.id)).toEqual([-1]);
    expect(await getBalance(u.id)).toBe(90);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it('never runs (the worker died after the reply): the 5-minute sync charges the turn, once', async () => {
    const u = await customer(100);
    fake.state.agent = async (d, mcp) => {
      usage.add(d.userId, 300);
      await mcp('send_message', { text: 'done', session_key: d.sessionKey });
    };
    const id = await send(u, 'work');
    await turnOver(u, id);
    await syncAllUsage();
    expect(await getBalance(u.id)).toBe(99);
    // Its job runs after all, later: the usage is not charged again; only the wake fee, which
    // only the turn's job charges.
    startBilling();
    await turnsBilled(u.id);
    expect(await getBalance(u.id)).toBe(98);
    expect(await usageCharges(u.id)).toHaveLength(1);
    expect(await wakeFees(u.id)).toEqual([-1]);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });
});

describe('what a turn costs, by who pays for the AI', () => {
  it('Textcrew AI: charged exactly what the sync after the turn charged before', async () => {
    // Backend report section 25's example: AI $0.031 is 8 credits; 200 awake seconds carried
    // over and 150 more reach one block of 5 minutes: 1 credit. 9 in all.
    const before = await customer(100);
    const now = await customer(100);
    for (const u of [before, now]) {
      usage.add(u.id, 200, 0, Date.now() - 5000);
      await syncUsageForUser(u.id); // 200 s carried over, nothing charged
    }
    // Before: the same usage, charged by the sync the turn used to run itself.
    llm.spend(before.id, 'claude', 0.031);
    usage.add(before.id, 150);
    await syncUsageForUser(before.id);

    // Now: a real turn, billed by its job.
    llm.keySpendReads = 0;
    fake.state.agent = async (d, mcp) => {
      llm.spend(d.userId, 'claude', 0.031);
      usage.add(d.userId, 150);
      await mcp('send_message', { text: 'done', session_key: d.sessionKey });
    };
    startBilling();
    await turnOver(now, await send(now, 'email Priya the notes'));
    await turnsBilled(now.id);
    expect(llm.keySpendReads).toBeGreaterThan(0);

    const charge = async (userId: string) =>
      (await usageCharges(userId)).map((l) => [l.delta, l.description]);
    expect(await charge(before.id)).toEqual([[-9, 'Usage: AI 8, awake time 1']]);
    expect(await charge(now.id)).toEqual(await charge(before.id));
    // And the real turn woke the container: its wake fee.
    expect(await wakeFees(now.id)).toEqual([-1]);
    expect(await getBalance(now.id)).toBe(90);
  });

  it("the user's Claude plan: LiteLLM is never asked; awake time is still charged", async () => {
    const u = await customer(100);
    await markClaudeConnected(u.id);
    // Connecting settled the AI and the key; from here on LiteLLM must not be asked.
    llm.keySpendReads = 0;
    llm.spendLogReads = 0;
    llm.calls = [];
    fake.state.agent = async (d, mcp) => {
      usage.add(d.userId, 600); // 2 credits
      await mcp('send_message', { text: 'planned', session_key: d.sessionKey });
    };
    startBilling();

    await turnOver(u, await send(u, 'plan my week'));
    await turnsBilled(u.id);
    const turnId = fake.deliveries[0]!.deliveryId;
    expect((await queue('system').getJob(billTurnJobId(turnId)))!.data.ai).toBe(false);
    expect(await getBalance(u.id)).toBe(97); // 2 for awake time, 1 for the wake
    const [period] = await periodsOf(u.id);
    expect(period).toMatchObject({ aiCostMicroUsd: 0, aiCredits: 0, awakeCredits: 2 });

    // A turn that fails on our side: its refund doesn't ask LiteLLM either.
    fake.state.agent = async (d) => {
      usage.add(d.userId, 300, 0, Date.now());
      await new Promise((r) => setTimeout(r, 5)); // the turn ends after it
    };
    fake.state.turnErrorAfterAgent = { message: 'bridge crashed', platformFault: true };
    await turnOver(u, await send(u, 'again'));
    const { job: refund, state } = await finishedJob(
      queue('system'),
      `refund-fault-${fake.deliveries[1]!.deliveryId.replaceAll(':', '-')}`,
    );
    expect(state).toBe('completed');
    expect(refund.returnvalue).toEqual({ restored: 1 });
    await turnsBilled(u.id);
    expect(await getBalance(u.id)).toBe(97);

    expect(llm.keySpendReads).toBe(0);
    expect(llm.spendLogReads).toBe(0);
    expect(llm.calls).toEqual([]);
  });
});

describe('out of credits still holds', () => {
  it('a user cannot race the billing: the turn after two unbilled ones bills them first', async () => {
    expect(UNBILLED_TURNS_ALLOWED).toBe(1);
    const u = await customer(1);
    fake.state.agent = async (d, mcp) => {
      usage.add(d.userId, 300); // 1 credit a turn
      await mcp('send_message', { text: `echo: ${d.text}`, session_key: d.sessionKey });
    };
    // No billing runs at all (the system queue is stuck).
    await turnOver(u, await send(u, 'one')); // balance 1: runs
    await turnOver(u, await send(u, 'two')); // one turn unbilled: runs
    expect(fake.deliveries).toHaveLength(2);
    await turnOver(u, await send(u, 'three')); // two unbilled: billed first (with the wake fee), then refused

    expect(fake.deliveries).toHaveLength(2);
    expect(await repliesOf(u.id)).toEqual(
      ['echo: one', 'echo: two', outOfCreditsText('web')].sort(),
    );
    expect(await getBalance(u.id)).toBe(-2); // 2 for awake time, 1 for the first turn's wake
    expect(await unbilledTurns(u.id)).toEqual({});

    // The two billing jobs run later and charge nothing more.
    startBilling();
    for (const d of fake.deliveries)
      await waitFor(async () => (await jobState(d.deliveryId)) === 'completed');
    expect(await getBalance(u.id)).toBe(-2);
    expect(await wakeFees(u.id)).toEqual([-1]);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });
});
