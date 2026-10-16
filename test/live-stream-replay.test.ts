// The live stream's event ids and catching up after a reconnect (openapi.yaml, GET /v1/stream):
// every event but a draft has an id, a connection that gives the last id it got is sent what came
// after it first (each event once), and `ready` says whether that was possible.
import { describe, expect, it } from 'vitest';
import {
  compareStreamIds,
  publish,
  STREAM_REPLAY_EVENTS,
  writesNext,
} from '../src/modules/channels/stream.ts';
import { chatUser, testApp } from './helpers.ts';

interface Frame {
  event: string;
  data: string;
  id?: string;
}

/** Opens the stream; `frames()` are the SSE events read so far, parsed. */
async function openStream(token: string, opts: { lastEventId?: string; query?: string } = {}) {
  const res = await testApp().request(`/v1/stream?token=${token}${opts.query ?? ''}`, {
    headers: opts.lastEventId ? { 'Last-Event-ID': opts.lastEventId } : {},
  });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames = (): Frame[] =>
    buf
      .split('\n\n')
      .slice(0, -1)
      .map((block) => {
        const f: Frame = { event: 'message', data: '' };
        for (const line of block.split('\n')) {
          const at = line.indexOf(': ');
          const [k, v] = [line.slice(0, at), line.slice(at + 2)];
          if (k === 'event') f.event = v;
          if (k === 'data') f.data = v;
          if (k === 'id') f.id = v;
        }
        return f;
      });
  return {
    frames,
    /** Reads until `n` frames other than pings have arrived. */
    async until(n: number) {
      while (frames().filter((f) => f.event !== 'ping').length < n) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buf += decoder.decode(value);
      }
      return frames().filter((f) => f.event !== 'ping');
    },
    close: () => reader.cancel(),
  };
}

const status = (marker: string) => ({ state: 'busy', lastActiveAt: null, marker });
const markerOf = (f: Frame) => (JSON.parse(f.data) as { data: { marker?: string } }).data.marker;

describe('event ids', () => {
  it('every event but a draft has an id, growing; ready says nothing was replayed', async () => {
    const u = await chatUser();
    const s = await openStream(u.token);
    await s.until(1);
    await publish(u.id, 'agent.status', status('a'));
    await publish(u.id, 'message.draft', { turnId: 't1', text: 'Hel' });
    await publish(u.id, 'agent.status', status('b'));
    const [ready, a, draft, b] = await s.until(4);
    await s.close();
    expect(ready).toEqual({ event: 'ready', data: '{"resumed":false}' });
    expect(a!.id).toMatch(/^\d+-\d+$/);
    expect(draft!.event).toBe('message.draft');
    expect(draft!.id).toBeUndefined();
    expect(compareStreamIds(a!.id!, b!.id!)).toBeLessThan(0);
    // The data is the event as before: its type and data, no id in it.
    expect(JSON.parse(b!.data)).toEqual({ type: 'agent.status', data: status('b') });
  });
});

describe('a connection that comes back', () => {
  it('gets what it missed, in order, then the live events, each once', async () => {
    const u = await chatUser();
    const other = await chatUser();
    const first = await openStream(u.token);
    await first.until(1);
    await publish(u.id, 'agent.status', status('seen'));
    const [, seen] = await first.until(2);
    await first.close();

    // While it is away: two events for this user (and a draft, which is live only), one for another.
    await publish(u.id, 'agent.status', status('missed 1'));
    await publish(u.id, 'message.draft', { turnId: 't1', text: 'Hel' });
    await publish(other.id, 'agent.status', status('not mine'));
    await publish(u.id, 'agent.status', status('missed 2'));

    const again = await openStream(u.token, { lastEventId: seen!.id! });
    const [ready, m1, m2] = await again.until(3);
    expect(ready).toEqual({ event: 'ready', data: '{"resumed":true}' });
    expect([m1!, m2!].map(markerOf)).toEqual(['missed 1', 'missed 2']);
    await publish(u.id, 'agent.status', status('live'));
    const all = await again.until(4);
    await again.close();
    expect(all.slice(1).map(markerOf)).toEqual(['missed 1', 'missed 2', 'live']);
    expect(new Set(all.slice(1).map((f) => f.id)).size).toBe(3);
  });

  it('?lastEventId= does the same for a new EventSource; the header wins', async () => {
    const u = await chatUser();
    const s = await openStream(u.token);
    await s.until(1);
    await publish(u.id, 'agent.status', status('three'));
    const [, three] = await s.until(2);
    await s.close();
    await publish(u.id, 'agent.status', status('four'));
    const q = await openStream(u.token, { query: `&lastEventId=${three!.id}` });
    const [ready, four] = await q.until(2);
    await q.close();
    expect(JSON.parse(ready!.data)).toEqual({ resumed: true });
    expect(markerOf(four!)).toBe('four');

    const both = await openStream(u.token, {
      lastEventId: four!.id!,
      query: `&lastEventId=${three!.id}`,
    });
    const [r2] = await both.until(1);
    await publish(u.id, 'agent.status', status('five'));
    const [, next] = await both.until(2);
    await both.close();
    expect(JSON.parse(r2!.data)).toEqual({ resumed: true });
    expect(markerOf(next!)).toBe('five'); // not 'four' again
  });

  it('an id the record does not hold: nothing replayed, and ready says so', async () => {
    const u = await chatUser();
    await publish(u.id, 'agent.status', status('kept'));
    for (const id of ['1-0', 'not-an-id', '99999999999999-0']) {
      const s = await openStream(u.token, { lastEventId: id });
      const [ready] = await s.until(1);
      await publish(u.id, 'agent.status', status(`live ${id}`));
      const [, live] = await s.until(2);
      await s.close();
      expect(JSON.parse(ready!.data), id).toEqual({ resumed: false });
      expect(markerOf(live!)).toBe(`live ${id}`);
    }
    // An invalid query value is refused by the contract (too long).
    const res = await testApp().request(
      `/v1/stream?token=${u.token}&lastEventId=${'9'.repeat(65)}`,
    );
    expect(res.status).toBe(400);
  });

  it(`keeps about the last ${STREAM_REPLAY_EVENTS} events: an id older than those is not resumed`, async () => {
    const u = await chatUser();
    const s = await openStream(u.token);
    await s.until(1);
    await publish(u.id, 'agent.status', status('oldest'));
    const [, oldest] = await s.until(2);
    await s.close();
    for (let i = 0; i < STREAM_REPLAY_EVENTS + 300; i++)
      await publish(u.id, 'credits.updated', { balance: i });
    const again = await openStream(u.token, { lastEventId: oldest!.id! });
    const [ready] = await again.until(1);
    await again.close();
    expect(JSON.parse(ready!.data)).toEqual({ resumed: false });
  });
});

describe('the order of what a connection writes (writesNext)', () => {
  it('skips an event written already, and a draft sent before an event written already', () => {
    expect(writesNext(undefined, { type: 'agent.status', data: {}, id: '5-0' })).toBe(true);
    expect(writesNext('5-0', { type: 'agent.status', data: {}, id: '5-0' })).toBe(false);
    expect(writesNext('5-0', { type: 'agent.status', data: {}, id: '4-9' })).toBe(false);
    expect(writesNext('5-0', { type: 'agent.status', data: {}, id: '5-1' })).toBe(true);
    // A draft sent when 5-0 was the newest event: fine after 5-0, dropped after 6-0.
    expect(writesNext('5-0', { type: 'message.draft', data: {}, after: '5-0' })).toBe(true);
    expect(writesNext('6-0', { type: 'message.draft', data: {}, after: '5-0' })).toBe(false);
    // Sent before ids existed.
    expect(writesNext('6-0', { type: 'agent.status', data: {} })).toBe(true);
    expect(compareStreamIds('1760600000000-2', '1760600000000-10')).toBeLessThan(0);
    expect(compareStreamIds('1760600000001-0', '1760600000000-10')).toBeGreaterThan(0);
  });
});
