// What the backend puts at the top of a turn's text before delivering it (HLD 0.9): the memory
// block, and a recap of the conversation when the engine changed. Both go inside `Deliver.text`,
// the field the Bridge already hands to the engine, so the agent image and the proto don't change.
// The memory block is the user's and the same in every conversation; the recap holds only the
// turn's own conversation.
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { logger } from '../../shared/logger.ts';
import { recentConversationMessages } from '../channels/messages.ts';
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

/** A conversation as a delivery names it: its chat (the session key) and its number there. */
export interface ConversationRef {
  sessionKey: string;
  epoch: number;
}

type EngineRow = typeof chatEngines.$inferSelect;

/** Which engines finished a turn in this conversation, and when each last did. */
async function enginesOf(userId: string, c: ConversationRef): Promise<EngineRow[]> {
  return db()
    .select()
    .from(chatEngines)
    .where(
      and(
        eq(chatEngines.userId, userId),
        eq(chatEngines.sessionKey, c.sessionKey),
        eq(chatEngines.epoch, c.epoch),
      ),
    );
}

/**
 * The time a turn ended, by the database's clock (the one that stamps the messages the recap is
 * cut by), moved up to the next whole millisecond. Read back into JavaScript it loses nothing, so
 * a message the engine sent in that turn is never counted as "after" it.
 */
const TURN_END = sql`date_trunc('milliseconds', now()) + interval '1 millisecond'`;

/** A turn ended well on this engine in this conversation. Safe to repeat. */
export async function recordEngineTurn(
  userId: string,
  c: ConversationRef,
  engine: RuntimeName,
): Promise<void> {
  await db()
    .insert(chatEngines)
    .values({
      userId,
      sessionKey: c.sessionKey,
      epoch: c.epoch,
      runtime: engine,
      lastTurnAt: TURN_END,
    })
    .onConflictDoUpdate({
      target: [chatEngines.userId, chatEngines.sessionKey, chatEngines.epoch, chatEngines.runtime],
      set: { lastTurnAt: TURN_END },
    });
}

/** The conversation of a turn: where its messages are, and how a delivery names it. */
export interface TurnConversation extends ConversationRef {
  id: string;
}

/**
 * The recap a turn gets when its engine is not the one that handled the conversation's previous
 * turn (or no engine has finished a turn in this conversation yet): the conversation's stored
 * messages this engine hasn't had, the newest kept within the budget. Nothing said in another
 * conversation is ever in it. Null: the engine hasn't changed, or there is nothing to tell.
 */
export async function chatRecap(input: {
  userId: string;
  conversation: TurnConversation;
  engine: RuntimeName;
  /** This turn's own message, which is delivered as the turn's text. */
  skipMessageId?: string;
  /** The conversation's engine record, read already (readTurnContext). */
  engines?: Promise<EngineRow[]>;
}): Promise<string | null> {
  const rows = await (input.engines ?? enginesOf(input.userId, input.conversation));
  const previous = rows.reduce<(typeof rows)[number] | undefined>(
    (latest, r) => (!latest || r.lastTurnAt > latest.lastTurnAt ? r : latest),
    undefined,
  );
  if (previous?.runtime === input.engine) return null;
  const mine = rows.find((r) => r.runtime === input.engine);
  const messages = (
    await recentConversationMessages(
      input.userId,
      input.conversation.id,
      RECAP_MAX_MESSAGES + 1,
      mine?.lastTurnAt,
    )
  ).filter((m) => m.id !== input.skipMessageId && m.text.trim());
  // No engine has run in this conversation and the user hasn't said anything in it before: there
  // is nothing to carry on, only the platform's own messages (the "linked" greeting).
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

/** What a turn's text is made from, read before the engine is known (while the container wakes). */
export interface TurnContextReads {
  /** The memory block (memoryBlock). */
  memory: Promise<string | null>;
  /** Which engines finished a turn in the conversation (for the recap). */
  engines: Promise<EngineRow[]>;
}

/**
 * Starts the reads `turnText` needs that don't depend on the engine, both at once, so they run
 * while the container wakes. Only reads. A failed read leaves its part out, as in `turnText`.
 */
export function readTurnContext(userId: string, conversation: ConversationRef): TurnContextReads {
  const memory = memoryBlock(userId);
  const engines = enginesOf(userId, conversation);
  // Awaited by turnText; a turn that ends before it (the wake failed) must not leave an
  // unhandled error behind.
  memory.catch(() => {});
  engines.catch(() => {});
  return { memory, engines };
}

/**
 * The text to deliver for a turn: the memory block, then the recap, then the turn's own text.
 * With neither, the text is delivered as it is. Never fails a turn: if memory or the chat
 * history can't be read, that part is left out. `reads`: what readTurnContext started earlier;
 * without it, everything is read here.
 */
export async function turnText(
  input: {
    userId: string;
    text: string;
    inboundMessageId?: string;
    /** The turn's conversation: the recap holds only its messages. */
    conversation: TurnConversation;
  },
  engine: RuntimeName,
  reads?: TurnContextReads,
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
  // Both at once: neither needs the other.
  const [memory, recap] = await Promise.all([
    part('memory block', () => reads?.memory ?? memoryBlock(input.userId)),
    part('chat recap', () =>
      chatRecap({
        userId: input.userId,
        conversation: input.conversation,
        engine,
        ...(input.inboundMessageId ? { skipMessageId: input.inboundMessageId } : {}),
        ...(reads ? { engines: reads.engines } : {}),
      }),
    ),
  ]);
  const parts = [memory, recap].filter((p): p is string => Boolean(p));
  if (!parts.length) return input.text;
  return `${parts.join('\n\n')}\n\n${MESSAGE_FOLLOWS}\n${input.text}`;
}

/** A conversation was deleted: the record of which engines ran in it goes too. */
export async function forgetConversationEngines(
  userId: string,
  sessionKey: string,
  epoch: number,
): Promise<void> {
  await db()
    .delete(chatEngines)
    .where(
      and(
        eq(chatEngines.userId, userId),
        eq(chatEngines.sessionKey, sessionKey),
        eq(chatEngines.epoch, epoch),
      ),
    );
}

/** Account deletion. */
export async function deleteChatEngines(userId: string): Promise<void> {
  await db().delete(chatEngines).where(eq(chatEngines.userId, userId));
}
