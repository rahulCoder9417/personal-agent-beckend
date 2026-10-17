// When the agent accepts a web message, the web app hears "busy" at once: a note in Redis, sent
// before the message's `processing`, which is a database write first (about 260 ms from the
// server to Neon). Before 17 October "busy" waited for that write.
import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { subscribe, type StreamEvent } from '../src/modules/channels/stream.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { handleWebMessage, sendWebMessage } from '../src/modules/orchestrator/process-message.ts';
import { wireModules } from '../src/wiring.ts';
import { installDbMeter, setDbDelays } from './db-meter.ts';
import { installFakeVm } from './fakes.ts';
import { chatUser, waitFor } from './helpers.ts';

const RTT_MS = 200;

let vm: ReturnType<typeof installFakeVm>;
beforeAll(() => {
  installDbMeter();
  wireModules();
});
afterAll(async () => {
  setDbDelays({});
  await closeQueues();
});
beforeEach(() => {
  vm = installFakeVm();
});

describe('the agent accepts a web message', () => {
  it('sends busy first, without waiting for the database, then the message as processing', async () => {
    const user = await chatUser();
    vm.state.agent = async (d, mcp) => {
      await mcp('send_message', { text: 'Done.', session_key: d.sessionKey });
    };
    const { message, eventId } = await sendWebMessage(user.id, {
      text: 'hello',
      clientMessageId: randomUUID(),
    });
    const seen: Array<{ e: StreamEvent; at: number }> = [];
    const stop = await subscribe(user.id, (e) => void seen.push({ e, at: Date.now() }));

    setDbDelays({ rttMs: RTT_MS });
    try {
      await handleWebMessage({ data: { messageId: message.id, eventId, userId: user.id } } as Job);
      await waitFor(async () =>
        seen.some(
          (s) => s.e.type === 'agent.status' && (s.e.data as { state: string }).state === 'awake',
        ),
      );
    } finally {
      setDbDelays({});
      await stop();
    }

    const busy = seen.findIndex(
      (s) => s.e.type === 'agent.status' && (s.e.data as { state: string }).state === 'busy',
    );
    const processing = seen.findIndex(
      (s) =>
        s.e.type === 'message.status' && (s.e.data as { status: string }).status === 'processing',
    );
    expect(busy).toBeGreaterThanOrEqual(0);
    expect(processing).toBeGreaterThan(busy);
    // Busy did not wait for the write: the processing event came a database trip later.
    expect(seen[processing]!.at - seen[busy]!.at).toBeGreaterThanOrEqual(RTT_MS - 20);
  });
});
