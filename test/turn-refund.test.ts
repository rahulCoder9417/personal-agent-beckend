// A turn that fails on our side (backend report, section 25): the user is told at once and the
// message ends, whatever happens to the refund. The refund is a system job of its own: retried
// when it fails, and given exactly once. On the server LiteLLM answered 500 to the spend-log read,
// the refund threw inside the turn, and the user got no reply and no refund.
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBalance } from '../src/modules/billing/credits.ts';
import { queueTurnRefund, setTurnRefundDelay } from '../src/modules/billing/jobs.ts';
import { ensureLiteLLMKey, setLiteLLMClient } from '../src/modules/billing/litellm.ts';
import { syncUsageForUser } from '../src/modules/billing/usage.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { PLATFORM_FAULT_TEXT, setTurnHooks } from '../src/modules/orchestrator/turn.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { FakeLiteLLM, installFakes, member } from './billing-fakes.ts';
import { ledgerMatchesGrants, ledgerOf } from './billing-helpers.ts';
import { installFakeVm } from './fakes.ts';
import { call, chatUser, expectContract, finishedJob, waitFor } from './helpers.ts';

const APOLOGY =
  "Sorry, something went wrong on our side and I couldn't finish that. You weren't charged for it. Please try again.";

let workers: Worker[];

beforeAll(() => {
  wireModules();
  setTurnRefundDelay(0);
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});

const messagesOf = (userId: string, direction: 'in' | 'out') =>
  db()
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.direction, direction)));

const reversalsOf = async (userId: string) =>
  (await ledgerOf(userId)).filter((l) => l.reason === 'reversal');

/** The refund job, once it has finished (read after its state says so: helpers.finishedJob). */
const refundJobDone = (key: string) =>
  finishedJob(queue('system'), `refund-${key.replaceAll(':', '-')}`);

describe('a turn that fails on our side', () => {
  it("LiteLLM's spend log fails: the user still gets the apology and the message ends", async () => {
    const vm = installFakeVm();
    const llm = new FakeLiteLLM();
    setLiteLLMClient(llm);
    llm.spendLogFailures = 'always';
    const u = await chatUser();
    await ensureLiteLLMKey(u.id);
    vm.state.turnError = { message: 'Claude Code could not finish', platformFault: true };

    await expectContract(
      'sendMessage',
      await call('/v1/messages', {
        method: 'POST',
        token: u.token,
        body: { text: 'Ask Scout to read a page', clientMessageId: randomUUID() },
      }),
      202,
    );

    const apology = await waitFor(async () =>
      (await messagesOf(u.id, 'out')).find((m) => m.text === APOLOGY),
    );
    expect(apology.sessionKey).toBe('web');
    const [inbound] = await waitFor(async () => {
      const rows = await messagesOf(u.id, 'in');
      return rows[0]?.status === 'failed' ? rows : null;
    });
    expect(inbound!.status).toBe('failed');
    expect((await messagesOf(u.id, 'out')).filter((m) => m.text === APOLOGY)).toHaveLength(1);
    expect(PLATFORM_FAULT_TEXT).toBe(APOLOGY);

    // The refund ran as its own job: every try read the spend log, the last one gave back the rest.
    const key = `fault:${vm.deliveries[0]!.deliveryId}`;
    const done = await refundJobDone(key);
    expect(done.state).toBe('completed');
    expect(done.job.returnvalue).toEqual({ restored: 0, aiSkipped: true });
    expect(llm.spendLogReads).toBe(5);
  });

  it('adding the refund job fails: the user is still told and the message still ends', async () => {
    const vm = installFakeVm();
    const u = await chatUser();
    setTurnHooks({
      onPlatformFault: async () => {
        throw new Error('redis is down');
      },
    });
    try {
      vm.state.turnError = { message: 'bridge crashed', platformFault: true };
      await call('/v1/messages', {
        method: 'POST',
        token: u.token,
        body: { text: 'hello', clientMessageId: randomUUID() },
      });
      await waitFor(async () => (await messagesOf(u.id, 'out')).find((m) => m.text === APOLOGY));
      await waitFor(async () => (await messagesOf(u.id, 'in'))[0]?.status === 'failed');
    } finally {
      setTurnHooks({ onPlatformFault: queueTurnRefund });
    }
  });
});

describe('the refund job', () => {
  it('a failed spend-log read is retried; the refund is given once, even if queued twice', async () => {
    const { llm, vm } = installFakes();
    const u = await member(100);
    const startedAt = new Date(Date.now() - 30_000);
    llm.spend(u.id, 'cheap', 0.02, Date.now() - 20_000); // 5 credits inside the turn
    vm.add(u.id, 600, 0, Date.now() - 10_000); // 1 credit inside the turn
    const endedAt = new Date();
    await syncUsageForUser(u.id);
    expect(await getBalance(u.id)).toBe(94);

    llm.spendLogFailures = 2; // the first two tries fail, as on the server
    const turn = { startedAt, endedAt, idempotencyKey: `fault:evt_${randomUUID()}` };
    await queueTurnRefund(u.id, turn);
    await queueTurnRefund(u.id, turn); // same job id: not added again

    const done = await refundJobDone(turn.idempotencyKey);
    expect(done.state).toBe('completed');
    expect(done.job.attemptsMade).toBe(3);
    expect(done.job.returnvalue).toEqual({ restored: 6 });
    expect(llm.spendLogReads).toBe(3);
    expect(await getBalance(u.id)).toBe(100);
    expect((await reversalsOf(u.id)).reduce((n, r) => n + r.delta, 0)).toBe(6);

    // Queued again later (the old job gone): the idempotency keys give nothing more.
    await done.job.remove();
    await queueTurnRefund(u.id, turn);
    const again = await refundJobDone(turn.idempotencyKey);
    expect(again.job.returnvalue).toEqual({ restored: 0 });
    expect(await getBalance(u.id)).toBe(100);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it("LiteLLM can't say what the AI cost on any try: the last try gives back the rest, once", async () => {
    const { llm, vm } = installFakes();
    const u = await member(100, 'max');
    const startedAt = new Date(Date.now() - 30_000);
    llm.spend(u.id, 'cheap', 0.02, Date.now() - 20_000); // 5 credits of AI: not given back
    vm.add(u.id, 600, 90, Date.now() - 10_000); // 1 awake + 3 browser: given back
    const endedAt = new Date();
    await syncUsageForUser(u.id);
    expect(await getBalance(u.id)).toBe(91);

    llm.spendLogFailures = 'always';
    const turn = { startedAt, endedAt, idempotencyKey: `fault:evt_${randomUUID()}` };
    await queueTurnRefund(u.id, turn);
    const done = await refundJobDone(turn.idempotencyKey);
    expect(done.state).toBe('completed');
    expect(done.job.attemptsMade).toBe(5);
    expect(done.job.returnvalue).toEqual({ restored: 4, aiSkipped: true });
    expect(await getBalance(u.id)).toBe(95);
    expect(await reversalsOf(u.id)).toHaveLength(1);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });
});
