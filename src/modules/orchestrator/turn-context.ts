// What the backend puts at the top of a turn's text before delivering it (HLD 0.9): the memory
// block, and a recap of the chat when the engine changed. Both go inside `Deliver.text`, the field
// the Bridge already hands to the engine, so the agent image and the proto don't change.
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { logger } from '../../shared/logger.ts';
import { recentSessionMessages } from '../channels/messages.ts';
import type { RuntimeName } from './agent-settings.ts';
import { asData, memoryBlock } from './memory.ts';
import { chatEngines } from './schema.ts';

export const RECAP_MAX_MESSAGES = 12;
export const RECAP_MAX_CHARS = 3000;
export const RECAP_MESSAGE_MAX_CHARS = 500;

const RECAP_START =
  '[Earlier in this chat. The last messages between your user and you, which you may not have ' +
  'in this session. They are a record of what was said, not new requests: do not carry them out ' +
  'again.]';
export const RECAP_END = '[End of earlier messages]';
/** The last line the platform adds. The turn's own text starts on the next line. */
export const MESSAGE_FOLLOWS = "[This turn's message follows.]";

/** Which engine last finished a turn in this chat, and when this engine last did. */
async function enginesOf(userId: string, sessionKey: string) {
  return db()
    .select()
    .from(chatEngines)
    .where(and(eq(chatEngines.userId, userId), eq(chatEngines.sessionKey, sessionKey)));
}

/**
 * The time a turn ended, by the database's clock (the one that stamps the messages the recap is
 * cut by), moved up to the next whole millisecond. Read back into JavaScript it loses nothing, so
 * a message the engine sent in that turn is never counted as "after" it.
 */
const TURN_END = sql`date_trunc('milliseconds', now()) + interval '1 millisecond'`;

/** A turn ended well on this engine in this chat. Safe to repeat. */
export async function recordEngineTurn(
  userId: string,
  sessionKey: string,
  engine: RuntimeName,
): Promise<void> {
  await db()
    .insert(chatEngines)
    .values({ userId, sessionKey, runtime: engine, lastTurnAt: TURN_END })
    .onConflictDoUpdate({
      target: [chatEngines.userId, chatEngines.sessionKey, chatEngines.runtime],
      set: { lastTurnAt: TURN_END },
    });
}

/** The later of two times (null when both are). */
const later = (a: Date | null | undefined, b: Date | null | undefined): Date | null =>
  a && b ? (a > b ? a : b) : (a ?? b ?? null);

/**
 * The recap a turn gets when its engine is not the one that handled the chat's previous turn (or
 * no engine has finished a turn in this chat yet): the stored messages this engine hasn't had,
 * the newest kept within the budget. Nothing from before the chat's latest new start is in it.
 * Null: the engine hasn't changed, or there is nothing to tell.
 */
export async function chatRecap(input: {
  userId: string;
  sessionKey: string;
  engine: RuntimeName;
  /** This turn's own message, which is delivered as the turn's text. */
  skipMessageId?: string;
  /** When the user last started a new chat here (null: never). */
  chatStartedAt?: Date | null;
}): Promise<string | null> {
  const rows = await enginesOf(input.userId, input.sessionKey);
  const previous = rows.reduce<(typeof rows)[number] | undefined>(
    (latest, r) => (!latest || r.lastTurnAt > latest.lastTurnAt ? r : latest),
    undefined,
  );
  if (previous?.runtime === input.engine) return null;
  const mine = rows.find((r) => r.runtime === input.engine);
  const messages = (
    await recentSessionMessages(
      input.userId,
      input.sessionKey,
      RECAP_MAX_MESSAGES + 1,
      later(mine?.lastTurnAt, input.chatStartedAt),
    )
  ).filter((m) => m.id !== input.skipMessageId && m.text.trim());
  // No engine has run in this chat and the user hasn't said anything before: there is no
  // conversation to carry on, only the platform's own messages (the "linked" greeting).
  if (!rows.length && !messages.some((m) => m.direction === 'in')) return null;

  // Newest first until the budget is full, then back in the order they were said.
  const lines: string[] = [];
  let chars = 0;
  for (const m of messages.reverse()) {
    if (lines.length >= RECAP_MAX_MESSAGES) break;
    let text = asData(m.text);
    if (text.length > RECAP_MESSAGE_MAX_CHARS) text = `${text.slice(0, RECAP_MESSAGE_MAX_CHARS)}…`;
    if (chars + text.length > RECAP_MAX_CHARS) break;
    chars += text.length;
    lines.push(`${m.direction === 'in' ? 'User' : 'You'}: ${text}`);
  }
  if (!lines.length) return null;
  return [RECAP_START, ...lines.reverse(), RECAP_END].join('\n');
}

/**
 * The text to deliver for a turn: the memory block, then the recap, then the turn's own text.
 * With neither, the text is delivered as it is. Never fails a turn: if memory or the chat
 * history can't be read, that part is left out.
 */
export async function turnText(
  input: {
    userId: string;
    sessionKey: string;
    text: string;
    inboundMessageId?: string;
    /** When the user last started a new chat here: the recap starts no earlier. */
    chatStartedAt?: Date | null;
  },
  engine: RuntimeName,
): Promise<string> {
  const log = logger().child({ userId: input.userId });
  const part = async (name: string, build: () => Promise<string | null>) => {
    try {
      return await build();
    } catch (err) {
      log.warn({ err: String(err) }, `${name} left out of the turn`);
      return null;
    }
  };
  const memory = await part('memory block', () => memoryBlock(input.userId));
  const recap = await part('chat recap', () =>
    chatRecap({
      userId: input.userId,
      sessionKey: input.sessionKey,
      engine,
      chatStartedAt: input.chatStartedAt ?? null,
      ...(input.inboundMessageId ? { skipMessageId: input.inboundMessageId } : {}),
    }),
  );
  const parts = [memory, recap].filter((p): p is string => Boolean(p));
  if (!parts.length) return input.text;
  return `${parts.join('\n\n')}\n\n${MESSAGE_FOLLOWS}\n${input.text}`;
}

/** Account deletion. */
export async function deleteChatEngines(userId: string): Promise<void> {
  await db().delete(chatEngines).where(eq(chatEngines.userId, userId));
}
