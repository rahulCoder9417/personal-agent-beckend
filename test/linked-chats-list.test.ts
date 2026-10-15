// The user's own list of linked chats (GET /v1/channels) shows what an admin sees for each chat:
// the masked chat id, when the chat last wrote, and whether the user blocked the bot. Never the
// full chat id (docs/backend-report.md, section 7).
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markBlocked, touchInbound } from '../src/modules/auth/links.ts';
import { channelLinks } from '../src/modules/auth/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { call, chatUser, createUser, expectContract } from './helpers.ts';

interface Item {
  id: string;
  channel: string;
  displayId: string;
  linkedAt: string;
  maskedChatId?: string;
  lastInboundAt?: string | null;
  blocked?: boolean;
  within24hWindow?: boolean;
}

beforeAll(() => wireModules());
afterAll(async () => {
  await closeQueues();
});

async function link(
  userId: string,
  channel: 'telegram' | 'whatsapp',
  externalId: string,
  extra: { displayId?: string; lastInboundAt?: Date | null; blocked?: boolean } = {},
) {
  const [row] = await db()
    .insert(channelLinks)
    .values({
      id: newId('chl'),
      userId,
      channel,
      externalId,
      displayId: extra.displayId ?? (channel === 'telegram' ? '@rahul' : `+${externalId}`),
      lastInboundAt: extra.lastInboundAt ?? null,
      blocked: extra.blocked ?? false,
    })
    .returning();
  return row!;
}

async function list(token: string) {
  return expectContract<{ items: Item[]; available: string[] }>(
    'listChannels',
    await call('/v1/channels', { token }),
    200,
  );
}

describe('GET /v1/channels: what the user sees for each linked chat', () => {
  it('the masked chat id, the last message and blocked, the same as an admin sees', async () => {
    const user = await chatUser();
    const admin = await createUser({ role: 'admin' });
    const wrote = new Date('2026-10-15T08:30:00.000Z');
    const tg = await link(user.id, 'telegram', '918273645', { lastInboundAt: wrote });
    const wa = await link(user.id, 'whatsapp', '919876543210', { blocked: true });

    const body = await list(user.token);
    const byId = new Map(body.items.map((i) => [i.id, i]));
    expect(byId.get(tg.id)).toEqual({
      id: tg.id,
      channel: 'telegram',
      displayId: '@rahul',
      linkedAt: tg.createdAt.toISOString(),
      maskedChatId: '•••• 3645',
      lastInboundAt: '2026-10-15T08:30:00.000Z',
      blocked: false,
    });
    expect(byId.get(wa.id)).toMatchObject({
      channel: 'whatsapp',
      maskedChatId: '+91 •••• ••32 10',
      lastInboundAt: null,
      blocked: true,
      within24hWindow: false,
    });

    // The admin's list says the same about the same chats.
    const adminView = await expectContract<{
      items: Array<{
        id: string;
        maskedChatId: string;
        lastInboundAt: string | null;
        blocked: boolean;
      }>;
    }>(
      'adminListUserChannels',
      await call(`/v1/admin/users/${user.id}/channels`, { token: admin.token }),
      200,
    );
    for (const a of adminView.items) {
      const mine = byId.get(a.id)!;
      expect({
        maskedChatId: mine.maskedChatId,
        lastInboundAt: mine.lastInboundAt,
        blocked: mine.blocked,
      }).toEqual({
        maskedChatId: a.maskedChatId,
        lastInboundAt: a.lastInboundAt,
        blocked: a.blocked,
      });
    }

    // Never the full chat id or number.
    const text = JSON.stringify(body);
    expect(text).not.toContain('918273645');
    expect(text).not.toContain('919876543210');
  });

  it('a short chat id shows nothing of itself', async () => {
    const user = await chatUser();
    await link(user.id, 'telegram', '42', { displayId: 'Telegram' });
    const [item] = (await list(user.token)).items;
    expect(item!.maskedChatId).toBe('••••');
  });

  it('blocking the bot shows; writing again clears it and moves the last message on', async () => {
    const user = await chatUser();
    const chatId = String(Math.floor(1e8 + Math.random() * 8e8));
    const row = await link(user.id, 'telegram', chatId, {
      lastInboundAt: new Date('2026-10-01T00:00:00.000Z'),
    });

    await markBlocked(user.id, 'telegram', chatId);
    expect((await list(user.token)).items[0]).toMatchObject({ id: row.id, blocked: true });

    const before = Date.now();
    await touchInbound(row.id);
    const [item] = (await list(user.token)).items;
    expect(item!.blocked).toBe(false);
    expect(Date.parse(item!.lastInboundAt!)).toBeGreaterThanOrEqual(before - 1000);
  });

  it("only the user's own chats are listed", async () => {
    const user = await chatUser();
    const other = await chatUser();
    await link(other.id, 'telegram', String(Math.floor(1e8 + Math.random() * 8e8)));
    expect((await list(user.token)).items).toEqual([]);
    const [row] = await db().select().from(channelLinks).where(eq(channelLinks.userId, other.id));
    expect((await list(other.token)).items.map((i) => i.id)).toEqual([row!.id]);
  });
});
