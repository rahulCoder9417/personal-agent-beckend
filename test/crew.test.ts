// The crew on the platform side (HLD 0.7): the list the apps show, and progress lines from a turn.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { channelLinks } from '../src/modules/auth/schema.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { subscribe, type StreamEvent } from '../src/modules/channels/stream.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { crewOfProgress } from '../src/modules/orchestrator/crew.ts';
import {
  CREW_LINES_PER_TURN,
  PROGRESS_MAX_CHARS,
  runTurn,
} from '../src/modules/orchestrator/turn.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeVm } from './fakes.ts';
import { call, chatUser, createUser, expectContract, waitFor } from './helpers.ts';

type Member = {
  id: string;
  name: string;
  kind: string;
  role: string;
  description: string;
  available: boolean;
  browser: { requiresPlan: string; available: boolean; enabled: boolean } | null;
};
type Progress = { text: string; crew: string | null; at: string };

let fake: ReturnType<typeof installFakeVm>;
beforeAll(() => wireModules());
afterAll(async () => {
  await closeQueues();
});
beforeEach(() => {
  fake = installFakeVm();
});
afterEach(() => {
  delete process.env.CREW_AVAILABLE;
  delete process.env.BROWSER_AVAILABLE;
  resetConfig();
});

const crew = async (token: string) =>
  (await expectContract<{ items: Member[] }>('listCrew', await call('/v1/crew', { token }), 200))
    .items;

/** Collects this user's `agent.progress` events from the live stream. */
async function listen(userId: string) {
  const seen: Progress[] = [];
  const stop = await subscribe(userId, (e: StreamEvent) => {
    if (e.type === 'agent.progress') seen.push(e.data as Progress);
  });
  return { seen, stop };
}

const turn = (userId: string, sessionKey = 'web') =>
  runTurn({
    userId,
    deliveryId: `evt_${randomUUID()}`,
    kind: 'message',
    sessionKey,
    channel: sessionKey === 'web' ? 'web' : 'telegram',
    text: 'look into it',
  });

describe('GET /v1/crew', () => {
  it('returns the lead and the three specialists, with Scout’s browser on Max and not there by default', async () => {
    await expectContract('listCrew', await call('/v1/crew'), 401);
    const u = await createUser();
    const items = await crew(u.token);
    expect(items.map((m) => [m.id, m.name, m.kind, m.role, m.available])).toEqual([
      ['tex', 'Tex', 'lead', 'Lead', true],
      ['byte', 'Byte', 'specialist', 'Coding', true],
      ['patch', 'Patch', 'specialist', 'Code review', true],
      ['scout', 'Scout', 'specialist', 'Research', true],
    ]);
    for (const m of items) expect(m.description.length).toBeGreaterThan(10);
    expect(items.filter((m) => m.browser).map((m) => m.id)).toEqual(['scout']);
    // BROWSER_AVAILABLE is off by default: the apps don't promise a browser yet.
    expect(items[3]!.browser).toEqual({ requiresPlan: 'max', available: false, enabled: false });
    // Scout's two platform services need Max; the search built into the user's own engine doesn't.
    expect(items[3]!.description).toBe(
      'Searches the web and reads pages. Web search through Textcrew and the real browser need ' +
        "the Max plan. On your own Claude plan, Scout uses Claude Code's built-in search instead: " +
        'any plan, no credits.',
    );
  });

  it('Scout’s browser: `available` follows the server setting, `enabled` also the user’s plan', async () => {
    const [free, pro, max] = await Promise.all(
      (['free', 'pro', 'max'] as const).map((plan) => createUser({ plan })),
    );
    const browserOf = async (token: string) => (await crew(token))[3]!.browser;
    // The default: the deployed image has no browser. Nothing is promised, not on Max either.
    for (const u of [free!, pro!, max!])
      expect(await browserOf(u.token)).toEqual({
        requiresPlan: 'max',
        available: false,
        enabled: false,
      });

    // The image with the browser is deployed: everyone sees that it exists, and Max has it.
    process.env.BROWSER_AVAILABLE = 'true';
    resetConfig();
    for (const u of [free!, pro!])
      expect(await browserOf(u.token)).toEqual({
        requiresPlan: 'max',
        available: true,
        enabled: false,
      });
    expect(await browserOf(max!.token)).toEqual({
      requiresPlan: 'max',
      available: true,
      enabled: true,
    });
    // Only Scout has one, and its description says the browser needs Max.
    const items = await crew(max!.token);
    expect(items.filter((m) => m.browser).map((m) => m.id)).toEqual(['scout']);
    expect(items[3]!.description).toMatch(/the real browser need the Max plan/);
  });

  it('CREW_AVAILABLE says which specialists are switched on; Tex always is', async () => {
    const u = await createUser();
    process.env.CREW_AVAILABLE = 'byte';
    resetConfig();
    expect((await crew(u.token)).map((m) => [m.id, m.available])).toEqual([
      ['tex', true],
      ['byte', true],
      ['patch', false],
      ['scout', false],
    ]);
    process.env.CREW_AVAILABLE = 'none';
    resetConfig();
    expect((await crew(u.token)).filter((m) => m.available).map((m) => m.id)).toEqual(['tex']);
  });
});

describe('progress lines', () => {
  it('a line names a crew member only when it starts with the name and a colon', () => {
    expect(crewOfProgress('Scout: reading 4 pages')).toBe('scout');
    expect(crewOfProgress('Byte: started')).toBe('byte');
    expect(crewOfProgress('patch: 3 reviewers done')).toBe('patch');
    expect(crewOfProgress('using web_search')).toBeNull();
    expect(crewOfProgress('Asking Scout: what now')).toBeNull();
    expect(crewOfProgress('Scout:reading')).toBeNull();
    expect(crewOfProgress('Tex: thinking')).toBeNull();
    expect(crewOfProgress('Scouting: around')).toBeNull();
  });

  it('reach the web chat’s live stream; crew lines are also in the activity log', async () => {
    const u = await chatUser();
    fake.state.agent = async (d, mcp, progress) => {
      progress('Scout: reading 4 pages');
      progress('using web_search');
      progress('   ');
      progress('Patch: 2 reviewers started');
      await mcp('send_message', { text: 'done', session_key: d.sessionKey });
    };
    const { seen, stop } = await listen(u.id);
    expect(await turn(u.id)).toBe('done');
    await waitFor(async () => seen.length >= 3);
    stop();
    expect(seen.map((p) => [p.text, p.crew])).toEqual([
      ['Scout: reading 4 pages', 'scout'],
      ['using web_search', null],
      ['Patch: 2 reviewers started', 'patch'],
    ]);
    for (const p of seen) expect(Number.isNaN(Date.parse(p.at))).toBe(false);

    const saved = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, 'crew_progress')));
    expect(saved.map((a) => [a.summary, a.details?.crew, a.actor]).sort()).toEqual([
      ['Patch: 2 reviewers started', 'patch', 'agent'],
      ['Scout: reading 4 pages', 'scout', 'agent'],
    ]);

    const activity = await expectContract<{
      items: Array<{ action: string; summary: string; crew: string | null }>;
    }>('listActivity', await call('/v1/activity', { token: u.token }), 200);
    const byAction = (a: string) => activity.items.filter((i) => i.action === a);
    expect(
      byAction('crew_progress')
        .map((i) => i.crew)
        .sort(),
    ).toEqual(['patch', 'scout']);
    // Other entries carry no crew member.
    expect(byAction('send_message').map((i) => i.crew)).toEqual([null]);
  });

  it('send nothing to Telegram: the chat only gets what the agent itself sends', async () => {
    const u = await chatUser();
    const chatId = String(Math.floor(Math.random() * 1e9));
    await db()
      .insert(channelLinks)
      .values({
        id: newId('chl'),
        userId: u.id,
        channel: 'telegram',
        externalId: chatId,
        displayId: '@dev',
      });
    fake.state.agent = async (d, mcp, progress) => {
      progress('Byte: started');
      progress('Byte: opened a pull request');
      progress('using run_app_action');
      await mcp('send_message', { text: 'The pull request is up.', session_key: d.sessionKey });
    };
    const { seen, stop } = await listen(u.id);
    expect(await turn(u.id, `telegram:${chatId}`)).toBe('done');
    // The web app's stream still shows them, whichever chat the turn came from.
    await waitFor(async () => seen.length >= 3);
    stop();
    const out = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, u.id), eq(messages.direction, 'out')));
    expect(out.map((m) => [m.channel, m.text])).toEqual([['telegram', 'The pull request is up.']]);
  });

  it('are cut when long, and only the first crew lines of a turn are saved', async () => {
    const u = await chatUser();
    const long = `Scout: ${'x'.repeat(1000)}`;
    fake.state.agent = async (_d, _mcp, progress) => {
      progress(long);
      for (let i = 0; i < CREW_LINES_PER_TURN + 5; i++) progress(`Byte: step ${i}`);
    };
    const { seen, stop } = await listen(u.id);
    await turn(u.id);
    await waitFor(async () => seen.length >= CREW_LINES_PER_TURN + 6);
    stop();
    expect(seen[0]!.text).toHaveLength(PROGRESS_MAX_CHARS);
    const saved = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, 'crew_progress')));
    expect(saved).toHaveLength(CREW_LINES_PER_TURN);
    expect(Math.max(...saved.map((a) => a.summary.length))).toBe(PROGRESS_MAX_CHARS);
  });
});
