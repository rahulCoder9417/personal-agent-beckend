// A wake refused because the user's folder is over its limit ends the turn with one clear reply a
// hour and an audit line; a wake refused because the server disk is nearly full is retried.
import { randomUUID } from 'node:crypto';
import { Code, ConnectError } from '@connectrpc/connect';
import type { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { storageFullText } from '../src/modules/orchestrator/turn.ts';
import { db } from '../src/shared/db/client.ts';
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
const send = (token: string) =>
  call('/v1/messages', {
    method: 'POST',
    token,
    body: { text: 'hello', clientMessageId: randomUUID() },
  });

describe('a wake refused for disk reasons', () => {
  it('over the user limit: no retry, one reply an hour, an audit line each time', async () => {
    const vm = installFakeVm();
    const u = await chatUser();
    vm.state.wakeError = new ConnectError(
      'disk_limit: storage limit reached',
      Code.ResourceExhausted,
    );
    await send(u.token);
    await waitFor(async () => (await rows(u.id, 'out')).find((m) => m.text === storageFullText()));
    await waitFor(async () => (await rows(u.id, 'in'))[0]?.status === 'failed');
    await new Promise((r) => setTimeout(r, 400)); // a retry would show by now
    expect(vm.wakes.filter((w) => w === u.id)).toHaveLength(1);

    await send(u.token); // a second message within the hour: failed and audited, no second reply
    await waitFor(
      async () =>
        (await rows(u.id, 'in')).every((m) => m.status === 'failed') &&
        (await rows(u.id, 'in')).length === 2,
    );
    expect((await rows(u.id, 'out')).filter((m) => m.text === storageFullText())).toHaveLength(1);
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, 'storage_full')));
    expect(audits).toHaveLength(2);
    expect(audits[0]!.actor).toBe('system');
  });

  it('server disk guard: the wake is retried, and the user is not told "storage full"', async () => {
    const vm = installFakeVm();
    const u = await chatUser();
    vm.state.wakeError = new ConnectError(
      'disk_guard: server disk is nearly full',
      Code.ResourceExhausted,
    );
    await send(u.token);
    await waitFor(async () => vm.wakes.filter((w) => w === u.id).length >= 2);
    expect((await rows(u.id, 'out')).filter((m) => m.text === storageFullText())).toHaveLength(0);
  });
});
