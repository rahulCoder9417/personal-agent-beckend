import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { publish } from '../src/modules/channels/stream.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { setTurnHooks } from '../src/modules/orchestrator/turn.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { installFakeVm } from './fakes.ts';
import { call, chatUser, expectContract, testApp, waitFor } from './helpers.ts';

let workers: Worker[];
beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(() => {
  installFakeVm();
  setTurnHooks({ hasCredits: async () => true });
});

describe('web chat', () => {
  it('POST /v1/messages queues once per clientMessageId and the reply arrives', async () => {
    const user = await chatUser();
    const clientMessageId = randomUUID();
    const first = await expectContract<{ id: string; status: string }>(
      'sendMessage',
      await call('/v1/messages', {
        method: 'POST',
        token: user.token,
        body: { text: 'hello web', clientMessageId },
      }),
      202,
    );
    const again = await expectContract<{ id: string }>(
      'sendMessage',
      await call('/v1/messages', {
        method: 'POST',
        token: user.token,
        body: { text: 'hello web', clientMessageId },
      }),
      202,
    );
    expect(again.id).toBe(first.id);
    const page = await waitFor(async () => {
      const res = await call('/v1/messages?limit=10', { token: user.token });
      const body = (await res.json()) as { items: Array<{ text: string; direction: string }> };
      return body.items.find((m) => m.text === 'echo: hello web') ? body : undefined;
    });
    expect(page.items.filter((m) => m.direction === 'in')).toHaveLength(1);
  });

  it('validates the body and returns 402 when out of credits', async () => {
    const user = await chatUser();
    await expectContract(
      'sendMessage',
      await call('/v1/messages', {
        method: 'POST',
        token: user.token,
        body: { text: '', clientMessageId: randomUUID() },
      }),
      400,
    );
    await expectContract(
      'sendMessage',
      await call('/v1/messages', {
        method: 'POST',
        token: user.token,
        body: { text: 'x', clientMessageId: 'not-a-uuid' },
      }),
      400,
    );
    setTurnHooks({ hasCredits: async () => false });
    const body = await expectContract<{ error: { code: string } }>(
      'sendMessage',
      await call('/v1/messages', {
        method: 'POST',
        token: user.token,
        body: { text: 'x', clientMessageId: randomUUID() },
      }),
      402,
    );
    expect(body.error.code).toBe('out_of_credits');
  });

  it('pagination uses cursor/nextCursor', async () => {
    const user = await chatUser();
    for (let i = 0; i < 3; i++) {
      await call('/v1/messages', {
        method: 'POST',
        token: user.token,
        body: { text: `m${i}`, clientMessageId: randomUUID() },
      });
    }
    const p1 = await expectContract<{ items: unknown[]; nextCursor: string | null }>(
      'listMessages',
      await call('/v1/messages?limit=2&channel=web', { token: user.token }),
      200,
    );
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await expectContract<{ items: unknown[] }>(
      'listMessages',
      await call(`/v1/messages?limit=2&cursor=${p1.nextCursor}`, { token: user.token }),
      200,
    );
    expect(p2.items.length).toBeGreaterThan(0);
    await expectContract(
      'listMessages',
      await call('/v1/messages?limit=500', { token: user.token }),
      400,
    );
  });

  it('uploads an attachment and rejects foreign attachment ids', async () => {
    const user = await chatUser();
    const form = new FormData();
    form.append('file', new File(['hello'], 'note.txt', { type: 'text/plain' }));
    const res = await testApp().request('/v1/attachments', {
      method: 'POST',
      headers: { authorization: `Bearer ${user.token}` },
      body: form,
    });
    const att = await expectContract<{ id: string }>('uploadAttachment', res, 201);
    await expectContract(
      'sendMessage',
      await call('/v1/messages', {
        method: 'POST',
        token: user.token,
        body: { text: 'see file', clientMessageId: randomUUID(), attachmentIds: [att.id] },
      }),
      202,
    );
    const other = await chatUser();
    await expectContract(
      'sendMessage',
      await call('/v1/messages', {
        method: 'POST',
        token: other.token,
        body: { text: 'x', clientMessageId: randomUUID(), attachmentIds: [att.id] },
      }),
      400,
    );
  });

  it('GET /v1/agent/status', async () => {
    const user = await chatUser();
    await expectContract(
      'getAgentStatus',
      await call('/v1/agent/status', { token: user.token }),
      200,
    );
  });

  it('SSE stream delivers events for this user only', async () => {
    const user = await chatUser();
    const other = await chatUser();
    const res = await testApp().request(`/v1/stream?token=${user.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const readUntil = async (needle: string) => {
      while (!buf.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buf += decoder.decode(value);
      }
    };
    await readUntil('event: ready');
    await publish(other.id, 'agent.status', { state: 'busy', lastActiveAt: null, marker: 'other' });
    await publish(user.id, 'agent.status', { state: 'busy', lastActiveAt: null, marker: 'mine' });
    await readUntil('mine');
    expect(buf).not.toContain('"other"');
    await reader.cancel();
  });
});
