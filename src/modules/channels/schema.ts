import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export type MediaRef = {
  id: string;
  name: string;
  mimeType: string;
  providerId?: string;
  path?: string;
};

const CHANNELS = ['whatsapp', 'telegram', 'imessage', 'web'] as const;

/**
 * `chat`: a conversation of a chat. `automations`: the Automations chat, where every run of every
 * automation answers (one per user, in web chat, never the active one).
 */
export const CONVERSATION_KINDS = ['chat', 'automations'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/**
 * A chat is one channel thread, named by its session key (`web`, `telegram:<chat id>`). This is
 * the chat's counter: `epoch` is the highest conversation number given out in it so far, and it
 * only goes up, so a number is never used again (not even after its conversation is deleted: the
 * engine may still hold that number's context). A chat with no row has had no conversation yet.
 */
export const chatEpochs = pgTable(
  'chat_epochs',
  {
    userId: text().notNull(),
    sessionKey: text().notNull(),
    epoch: integer().notNull(),
    /** When the conversation with that number started. */
    startedAt: timestamp({ withTimezone: true }).notNull(),
    /** What started it (a Telegram event id): the same event never starts two. */
    startKey: text(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sessionKey] })],
);

/**
 * A conversation: one stretch of a chat between two "New chat" actions. Every message belongs to
 * one. `epoch` is its number within the chat; every delivery to the agent carries it, and the
 * engine keeps a context of its own per number.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    sessionKey: text().notNull(),
    channel: text({ enum: CHANNELS }).notNull(),
    /**
     * `automations`: the user's Automations chat. A web conversation with a number of its own in
     * web chat (so the agent keeps its own context), titled "Automations", never the active one.
     */
    kind: text({ enum: CONVERSATION_KINDS }).notNull().default('chat'),
    epoch: integer().notNull(),
    /** The user's name for it, else the first incoming message's text, cut. Null: "New chat". */
    title: text(),
    /** The one conversation of its chat that the next message goes into. */
    active: boolean().notNull().default(false),
    /** Whole milliseconds, like `lastMessageAt` (the list's cursor is built from it). */
    startedAt: timestamp({ withTimezone: true }).notNull(),
    /** When its newest message was saved; `startedAt` while it has none. */
    lastMessageAt: timestamp({ withTimezone: true }).notNull(),
    /**
     * When the agent's newest message in it was saved (`direction` out: a reply, an approval
     * request, a run's answer, a copy). Null while there is none. With `lastReadAt` it says
     * whether the conversation is unread.
     */
    lastAgentMessageAt: timestamp({ withTimezone: true }),
    /**
     * Up to when the user has seen it: marked read from the web app, or the time of the newest
     * message the user wrote in it. Null: never read. Unread means the agent's newest message is
     * later than this.
     */
    lastReadAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex().on(t.userId, t.sessionKey, t.epoch),
    uniqueIndex('conversations_one_active_per_chat')
      .on(t.userId, t.sessionKey)
      .where(sql`${t.active}`),
    uniqueIndex('conversations_one_automations_chat')
      .on(t.userId)
      .where(sql`${t.kind} = 'automations'`),
    index().on(t.userId, t.lastMessageAt, t.id),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    /** Deleting a conversation deletes its messages. */
    conversationId: text()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    channel: text({ enum: CHANNELS }).notNull(),
    direction: text({ enum: ['in', 'out'] }).notNull(),
    text: text().notNull().default(''),
    mediaRef: jsonb().$type<MediaRef[]>(),
    status: text({ enum: ['queued', 'processing', 'sent', 'delivered', 'read', 'failed'] })
      .notNull()
      .default('queued'),
    /**
     * Incoming: the event it came with, which is also its turn's delivery id. Outgoing: the turn
     * it was written in (its delivery id), when it was written during one.
     */
    eventId: text(),
    approvalId: text(),
    /**
     * The agent proposed an automation in this message: the draft's id (the automations module's
     * `automation_drafts`; no foreign key). The web app draws the draft's card under it.
     */
    automationDraftId: text(),
    /** Web idempotency key. */
    clientMessageId: text(),
    /** Provider message id (for status updates). */
    externalId: text(),
    /** Where outbound messages go, e.g. telegram chat id. */
    sessionKey: text(),
    /**
     * A copy, sent to a chat app, of a message kept in another conversation: that message's id.
     * An automation made in a Telegram chat answers in the Automations chat, and its answer is
     * also sent to the Telegram chat this way. A copy is shown with its chat's messages, but it is
     * never part of the agent's context there (the recap, the router). One copy per message.
     */
    copyOf: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.userId, t.id),
    index().on(t.conversationId, t.id),
    uniqueIndex().on(t.userId, t.clientMessageId),
    uniqueIndex().on(t.userId, t.copyOf),
    /** A turn's messages (its reply is found by the turn's id). */
    index().on(t.userId, t.eventId),
    /**
     * The message an event brought (a chat app's message is looked up by its event alone, before
     * anything else is known): without it, every incoming message read the whole table.
     */
    index().on(t.eventId),
    index().on(t.channel, t.externalId),
  ],
);

/** Files uploaded from the web app (and downloaded channel media). */
export const attachments = pgTable(
  'attachments',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    name: text().notNull(),
    mimeType: text().notNull(),
    sizeBytes: integer().notNull(),
    path: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)],
);
