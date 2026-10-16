// The live stream's log: one line when a connection closes, saying how long it was open, what the
// api wrote to it and how long before the close it last wrote, so a stream that stopped getting
// through (16 October: a web turn's last events never reached the page) can be told from one the
// api kept writing to. Never what the events say.
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setStreamWriteSlowMs } from '../src/api/routes/chat.ts';
import { publish } from '../src/modules/channels/stream.ts';
import { buildLogger, setLogger } from '../src/shared/logger.ts';
import { chatUser, testApp, waitFor } from './helpers.ts';

type Line = Record<string, unknown> & { level: number; msg: string };

let raw: string[] = [];
const lines = (): Line[] => raw.map((l) => JSON.parse(l) as Line);
const closedLines = () => lines().filter((l) => l.msg === 'live stream closed');

beforeEach(() => {
  raw = [];
  setLogger(
    buildLogger(
      new Writable({
        write(chunk, _enc, cb) {
          raw.push(String(chunk));
          cb();
        },
      }),
      'trace',
    ),
  );
});
afterEach(() => setLogger(undefined));

async function openStream(token: string) {
  const res = await testApp().request(`/v1/stream?token=${token}`);
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  return {
    async readUntil(needle: string) {
      while (!buf.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buf += decoder.decode(value);
      }
    },
    close: () => reader.cancel(),
  };
}

describe('the live stream log', () => {
  it('says, as a connection closes, what was written to it and when it last was', async () => {
    const user = await chatUser();
    const stream = await openStream(user.token);
    await stream.readUntil('event: ready');
    await publish(user.id, 'message.status', { id: 'msg_1', status: 'delivered', text: 'hlo' });
    await publish(user.id, 'agent.status', { state: 'awake', lastActiveAt: null });
    await stream.readUntil('event: agent.status');
    expect(closedLines()).toHaveLength(0);

    await stream.close();
    await waitFor(async () => closedLines().length === 1);
    const line = closedLines()[0]!;
    expect(line).toMatchObject({
      level: 30,
      userId: user.id,
      events: 2,
      pings: 0,
      lastEvent: 'agent.status',
      waiting: 0,
    });
    expect(line.openSeconds).toBeTypeOf('number');
    expect(line.quietSeconds).toBeLessThan(5);
    expect(line.lastEventSecondsAgo).toBeLessThan(5);
    // What the events say stays out of the log.
    expect(raw.join('')).not.toContain('hlo');
  });

  it('warns when a write waits because nothing reads the connection', async () => {
    setStreamWriteSlowMs(200);
    try {
      const user = await chatUser();
      const res = await testApp().request(`/v1/stream?token=${user.token}`);
      const reader = res.body!.getReader();
      await reader.read(); // `ready`
      // Nobody reads on: the second event waits for the first to be taken.
      for (let i = 0; i < 3; i++) await publish(user.id, 'agent.status', { state: 'busy', i });
      await new Promise((r) => setTimeout(r, 400));
      for (;;) {
        const { value } = await reader.read();
        if (new TextDecoder().decode(value).includes('"i":2')) break;
      }
      await waitFor(async () => lines().some((l) => l.msg === 'live stream write held up'));
      const warn = lines().find((l) => l.msg === 'live stream write held up')!;
      expect(warn).toMatchObject({ level: 40, userId: user.id, event: 'agent.status' });
      expect(warn.waitedSeconds).toBeGreaterThanOrEqual(0.2);
      await reader.cancel();
    } finally {
      setStreamWriteSlowMs(undefined);
    }
  });

  it('writes one line per connection, and none for another user', async () => {
    const user = await chatUser();
    const other = await chatUser();
    const mine = await openStream(user.token);
    const theirs = await openStream(other.token);
    await mine.readUntil('event: ready');
    await theirs.readUntil('event: ready');
    await mine.close();
    await waitFor(async () => closedLines().length === 1);
    expect(closedLines()[0]).toMatchObject({ userId: user.id, events: 0 });
    await theirs.close();
    await waitFor(async () => closedLines().length === 2);
    expect(closedLines()[1]).toMatchObject({ userId: other.id });
  });
});
