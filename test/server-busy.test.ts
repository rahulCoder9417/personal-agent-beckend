// Every awake place busy: the wake is tried 5 times; after the last one the user gets exactly one
// plain reply, the message is failed, an audit line is written, and a re-run sends no second reply.
import { randomUUID } from 'node:crypto';
import { Code, ConnectError } from '@connectrpc/connect';
import type { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { runTurn, serverBusyText } from '../src/modules/orchestrator/turn.ts';
import { db } from '../src/shared/db/client.ts';
import { runInJob } from '../src/shared/job-context.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { installFakeVm } from './fakes.ts';
import { call, chatUser, waitFor } from './helpers.ts';

let workers: Worker[];
beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});

const rows = (userId: string, direction: 'in' | 'out') =>
  db()
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.direction, direction)));

describe('server full', () => {
  it('after the last try: one busy reply, message failed, audit line; a re-run adds nothing', async () => {
    const vm = installFakeVm();
    const u = await chatUser();
    vm.state.wakeError = new ConnectError('no room', Code.ResourceExhausted);
    await call('/v1/messages', {
      method: 'POST',
      token: u.token,
      body: { text: 'hello', clientMessageId: randomUUID() },
    });
    await waitFor(async () => (await rows(u.id, 'out')).find((m) => m.text === serverBusyText()));
    await waitFor(async () => (await rows(u.id, 'in'))[0]?.status === 'failed');
    expect(vm.wakes.filter((w) => w === u.id)).toHaveLength(5);

    // The same job run once more on its last try (e.g. after a crash): no second reply or audit line.
    const inbound = (await rows(u.id, 'in'))[0]!;
    await runInJob(
      { queuedAt: Date.now(), pickedUpAt: Date.now(), attempt: 5, maxAttempts: 5 },
      () =>
        runTurn({
          userId: u.id,
          deliveryId: inbound.eventId!,
          kind: 'message',
          sessionKey: 'web',
          channel: 'web',
          text: inbound.text,
          attachments: [],
          inboundMessageId: inbound.id,
          conversationId: inbound.conversationId,
        }),
    );
    expect((await rows(u.id, 'out')).filter((m) => m.text === serverBusyText())).toHaveLength(1);
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, 'server_busy')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor).toBe('system');
  });
});
