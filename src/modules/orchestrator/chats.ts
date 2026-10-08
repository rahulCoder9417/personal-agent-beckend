// Starting a new chat: the agent no longer sees what was said before in that chat. A chat is a
// session key (`web`, `telegram:<chat id>`). Shared memory is kept: it is not part of a chat.
// The chat's epoch goes up by one; every delivery carries it, and the Bridge starts a fresh engine
// conversation for that chat when it sees a higher one. The recap leaves out what came before.
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { enforce } from '../../shared/rate-limit.ts';
import { audit } from '../admin/audit.ts';
import type { Channel } from '../channels/types.ts';
import { chatEpochs } from './schema.ts';

/** The bot's answer to `/new` in a chat app. */
export const NEW_CHAT_TEXT =
  "Started a new chat. I won't use what we talked about before here. Your saved memories stay.";

/** `/new`, `/clear` or `/reset` on its own (Telegram adds `@<bot name>` in a group). */
const NEW_CHAT_COMMAND = /^\/(new|clear|reset)(@\w+)?$/i;

export function isNewChatCommand(text: string): boolean {
  return NEW_CHAT_COMMAND.test(text.trim());
}

/** At most this many new web chats an hour per user. */
export const NEW_CHATS_PER_HOUR = 30;

const IN_CHANNEL: Record<Channel, string> = {
  web: 'in web chat',
  telegram: 'on Telegram',
  whatsapp: 'on WhatsApp',
  imessage: 'on iMessage',
};

/**
 * The start time, by the database's clock (the one that stamps the messages), moved up to the
 * next whole millisecond. Read back into JavaScript it loses nothing, so a message saved before
 * the start is never counted as after it.
 */
const START = sql`date_trunc('milliseconds', now()) + interval '1 millisecond'`;

export interface ChatEpoch {
  /** 0 until the first new chat. */
  epoch: number;
  /** When the latest new chat started; null if never. */
  startedAt: Date | null;
}

async function epochRow(userId: string, sessionKey: string) {
  const [row] = await db()
    .select()
    .from(chatEpochs)
    .where(and(eq(chatEpochs.userId, userId), eq(chatEpochs.sessionKey, sessionKey)));
  return row;
}

/** The chat's epoch and when its latest new chat started. */
export async function chatEpoch(userId: string, sessionKey: string): Promise<ChatEpoch> {
  const row = await epochRow(userId, sessionKey);
  return row ? { epoch: row.epoch, startedAt: row.startedAt } : { epoch: 0, startedAt: null };
}

/**
 * Starts a new chat: the epoch goes up by one and the time is recorded, with an activity entry
 * that names the channel (never any message text). With a `key` (the event that asked for it),
 * a second run for the same key changes nothing: `started` is then false.
 */
export async function startNewChat(
  userId: string,
  sessionKey: string,
  opts: { channel: Channel; key?: string },
): Promise<{ epoch: number; startedAt: Date; started: boolean }> {
  const key = opts.key ?? null;
  const row = await db().transaction(async (tx) => {
    const [updated] = await tx
      .insert(chatEpochs)
      .values({ userId, sessionKey, epoch: 1, startedAt: START, startKey: key })
      .onConflictDoUpdate({
        target: [chatEpochs.userId, chatEpochs.sessionKey],
        set: { epoch: sql`${chatEpochs.epoch} + 1`, startedAt: START, startKey: key },
        ...(key ? { setWhere: sql`${chatEpochs.startKey} is distinct from ${key}` } : {}),
      })
      .returning();
    if (!updated) return undefined;
    await audit(
      {
        userId,
        actor: 'user',
        action: 'chat_started',
        summary: `Started a new chat ${IN_CHANNEL[opts.channel]}`,
        details: { channel: opts.channel, epoch: updated.epoch },
      },
      tx,
    );
    return updated;
  });
  if (row) return { epoch: row.epoch, startedAt: row.startedAt, started: true };
  // This key started the latest chat already (the job ran again).
  const current = (await epochRow(userId, sessionKey))!;
  return { epoch: current.epoch, startedAt: current.startedAt, started: false };
}

/** POST /v1/chats/new: a new web chat, at most 30 an hour (429 after that). */
export async function startNewWebChat(userId: string): Promise<Date> {
  await enforce({ key: `new-chat:user:${userId}`, max: NEW_CHATS_PER_HOUR, windowSeconds: 3600 });
  return (await startNewChat(userId, 'web', { channel: 'web' })).startedAt;
}

/** Account deletion. */
export async function deleteChatEpochs(userId: string): Promise<void> {
  await db().delete(chatEpochs).where(eq(chatEpochs.userId, userId));
}
