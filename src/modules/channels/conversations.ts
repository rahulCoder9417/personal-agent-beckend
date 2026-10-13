// Conversations. A chat is one channel thread, named by its session key (`web`,
// `telegram:<chat id>`). A conversation is one stretch of a chat between two "New chat" actions,
// and every message belongs to one. Each has a number within its chat (its epoch), which the
// agent's engine keeps a context of its own for.
//
// One conversation per chat is the active one: the next message of that chat goes into it. Web
// chat: the one the user has open to write in (they can go back to an earlier one). Any other
// channel: the chat's latest. Everything that changes which conversations a chat has, or which is
// active, runs in a transaction that holds a lock for that chat.
//
// The Automations chat (`kind` automations) is where every run of every automation answers: one
// per user, a web conversation beside the others, titled "Automations". It is never the active
// one, so the user's next message never goes into it unless they write in it.
import { rm } from 'node:fs/promises';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { db, type Tx } from '../../shared/db/client.ts';
import { badRequest } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import {
  attachments,
  chatEpochs,
  conversations,
  messages,
  type ConversationKind,
} from './schema.ts';
import { publish } from './stream.ts';
import { parseSessionKey, type Channel } from './types.ts';

export type ConversationRow = typeof conversations.$inferSelect;

/** What a conversation is called while it has no title. */
export const NEW_CHAT_TITLE = 'New chat';
/** The Automations chat's name. It keeps it: the user cannot rename it. */
export const AUTOMATIONS_TITLE = 'Automations';
/** The chat the Automations chat belongs to: web chat, so the user can open it and write in it. */
const AUTOMATIONS_SESSION = 'web';

export const isAutomationsChat = (c: { kind: ConversationKind }) => c.kind === 'automations';
/** A title made from a message is cut to this many characters, at a word. */
export const TITLE_MAX_CHARS = 60;

/**
 * The title a message's text gives a conversation: its whitespace made single spaces, cut to 60
 * characters at the last word that fits (in the middle of the word only when the first word alone
 * is longer). Null when the text is empty. Migration 0015 cuts the same way.
 */
export function titleFromText(text: string): string | null {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  if (!chars.length) return null;
  if (chars.length <= TITLE_MAX_CHARS) return chars.join('');
  const head = chars.slice(0, TITLE_MAX_CHARS + 1).join('');
  const cut = head.lastIndexOf(' ');
  return cut > 0 ? head.slice(0, cut) : chars.slice(0, TITLE_MAX_CHARS).join('');
}

export function toApiConversation(c: ConversationRow) {
  return {
    id: c.id,
    channel: c.channel,
    kind: c.kind,
    epoch: c.epoch,
    startedAt: c.startedAt.toISOString(),
    lastMessageAt: c.lastMessageAt.toISOString(),
    title: c.title ?? NEW_CHAT_TITLE,
    active: c.active,
  };
}

/** Tells the web app (live stream) that a conversation started or changed. */
const announce = (c: ConversationRow) =>
  publish(c.userId, 'conversation.updated', toApiConversation(c));

/**
 * A start time: the database's clock, moved up to the next whole millisecond. Read back into
 * JavaScript it loses nothing, and nothing saved before the start carries a later time.
 */
const START = sql`date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond'`;

/** One at a time per chat, until the transaction ends. */
const lockChat = (tx: Tx, userId: string, sessionKey: string) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`chat:${userId}:${sessionKey}`}, 0))`,
  );

const mine = (userId: string, id: string) =>
  and(eq(conversations.userId, userId), eq(conversations.id, id));

export async function getConversation(
  userId: string,
  id: string,
  tx: Tx = db(),
): Promise<ConversationRow | undefined> {
  const [row] = await tx.select().from(conversations).where(mine(userId, id));
  return row;
}

/** The chat's active conversation, if it has one. Never starts one. */
export async function findActiveConversation(
  userId: string,
  sessionKey: string,
  tx: Tx = db(),
): Promise<ConversationRow | undefined> {
  const [row] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, userId),
        eq(conversations.sessionKey, sessionKey),
        eq(conversations.active, true),
      ),
    );
  return row;
}

/** The chat's counter: the highest number given out, and when that conversation started. */
export async function chatCounter(
  userId: string,
  sessionKey: string,
  tx: Tx = db(),
): Promise<typeof chatEpochs.$inferSelect | undefined> {
  const [row] = await tx
    .select()
    .from(chatEpochs)
    .where(and(eq(chatEpochs.userId, userId), eq(chatEpochs.sessionKey, sessionKey)));
  return row;
}

/**
 * Adds a conversation to a chat and makes it the active one. The caller holds the chat's lock.
 * Its number is one above the highest ever given out in this chat, or `first` when the chat never
 * had one, so a number is never used twice. Returns it with the conversations it replaced as the
 * active one.
 */
async function addConversation(
  tx: Tx,
  userId: string,
  sessionKey: string,
  first: number,
  key: string | null,
): Promise<{ conversation: ConversationRow; replaced: ConversationRow[] }> {
  const channel = parseSessionKey(sessionKey)?.channel;
  if (!channel) throw new Error(`bad session key ${sessionKey}`);
  const [counter] = await tx
    .insert(chatEpochs)
    .values({ userId, sessionKey, epoch: first, startedAt: START, startKey: key })
    .onConflictDoUpdate({
      target: [chatEpochs.userId, chatEpochs.sessionKey],
      set: {
        epoch: sql`greatest(${chatEpochs.epoch} + 1, excluded.epoch)`,
        startedAt: START,
        startKey: key,
      },
    })
    .returning();
  const replaced = await tx
    .update(conversations)
    .set({ active: false })
    .where(
      and(
        eq(conversations.userId, userId),
        eq(conversations.sessionKey, sessionKey),
        eq(conversations.active, true),
      ),
    )
    .returning();
  const [conversation] = await tx
    .insert(conversations)
    .values({
      id: newId('cnv'),
      userId,
      sessionKey,
      channel,
      epoch: counter!.epoch,
      active: true,
      startedAt: counter!.startedAt,
      lastMessageAt: counter!.startedAt,
    })
    .returning();
  return { conversation: conversation!, replaced };
}

/**
 * The conversation the chat's next message goes into. A chat that has none (its first message, or
 * its active one was deleted) gets one: number 0 for the chat's first, else the next number.
 */
export async function activeConversation(
  userId: string,
  sessionKey: string,
): Promise<ConversationRow> {
  const found = await findActiveConversation(userId, sessionKey);
  if (found) return found;
  const { conversation, added } = await db().transaction(async (tx) => {
    await lockChat(tx, userId, sessionKey);
    // Another request may have started it while this one waited for the lock.
    const now = await findActiveConversation(userId, sessionKey, tx);
    if (now) return { conversation: now, added: false };
    return { ...(await addConversation(tx, userId, sessionKey, 0, null)), added: true };
  });
  if (added) await announce(conversation);
  return conversation;
}

/**
 * The conversation a message to `sessionKey` is saved in: the one named, when it is this user's
 * and of that chat (a reply written during a turn stays in the turn's conversation even if the
 * user has opened another one since), else the chat's active one. With `automations` (the one
 * named is the Automations chat), else the Automations chat: when the user deleted it during a
 * run, the run's reply starts a new one rather than landing in the conversation they have open.
 */
export async function conversationFor(
  userId: string,
  sessionKey: string,
  conversationId?: string | null,
  opts: { automations?: boolean } = {},
): Promise<ConversationRow> {
  if (conversationId) {
    const named = await getConversation(userId, conversationId);
    if (named?.sessionKey === sessionKey) return named;
  }
  if (opts.automations && sessionKey === AUTOMATIONS_SESSION) return automationsChat(userId);
  return activeConversation(userId, sessionKey);
}

/**
 * "New chat": a new, empty conversation becomes the chat's active one. The first one a chat gets
 * this way is number 1 (number 0 is what was said before any new chat). With a `key` (the event
 * that asked for it), a second run for the same key starts nothing: `started` is then false.
 * `onStarted` runs inside the same transaction (the activity log entry).
 */
export async function startConversation(
  userId: string,
  sessionKey: string,
  opts: { key?: string; onStarted?: (tx: Tx, c: ConversationRow) => Promise<void> } = {},
): Promise<{ conversation: ConversationRow; started: boolean }> {
  const added = await db().transaction(async (tx) => {
    await lockChat(tx, userId, sessionKey);
    if (opts.key && (await chatCounter(userId, sessionKey, tx))?.startKey === opts.key) return null;
    const result = await addConversation(tx, userId, sessionKey, 1, opts.key ?? null);
    await opts.onStarted?.(tx, result.conversation);
    return result;
  });
  // This key started the chat's latest conversation already (the job ran again).
  if (!added) return { conversation: await activeConversation(userId, sessionKey), started: false };
  for (const c of added.replaced) await announce(c);
  await announce(added.conversation);
  return { conversation: added.conversation, started: true };
}

/**
 * A conversation of its own in a chat, beside the active one, which stays the active one: where
 * an automation's runs reply when the conversation it was made in is gone. It gets the chat's next
 * number, so the agent keeps a context of its own for it, and the title given. The chat's counter
 * keeps its start time and start key: those belong to the chat's latest "New chat". `onStarted`
 * runs inside the same transaction; if it fails, nothing is started.
 */
export async function startConversationAside(
  userId: string,
  sessionKey: string,
  opts: { title: string; onStarted?: (tx: Tx, c: ConversationRow) => Promise<void> },
): Promise<ConversationRow> {
  const conversation = await db().transaction(async (tx) => {
    await lockChat(tx, userId, sessionKey);
    const row = await addConversationAside(tx, userId, sessionKey, { title: opts.title });
    await opts.onStarted?.(tx, row);
    return row;
  });
  await announce(conversation);
  return conversation;
}

/**
 * Adds a conversation that is not the active one to a chat, with the chat's next number. The
 * caller holds the chat's lock. The chat's counter keeps its start time and start key: those
 * belong to the chat's latest "New chat".
 */
async function addConversationAside(
  tx: Tx,
  userId: string,
  sessionKey: string,
  values: { title: string; kind?: ConversationKind },
): Promise<ConversationRow> {
  const channel = parseSessionKey(sessionKey)?.channel;
  if (!channel) throw new Error(`bad session key ${sessionKey}`);
  // One start time for both columns (and the counter, when the chat had none).
  const { rows } = await tx.execute<{ ms: number }>(
    sql`select round(extract(epoch from ${START}) * 1000)::float8 as ms`,
  );
  const at = new Date(rows[0]!.ms);
  const [counter] = await tx
    .insert(chatEpochs)
    .values({ userId, sessionKey, epoch: 1, startedAt: at, startKey: null })
    .onConflictDoUpdate({
      target: [chatEpochs.userId, chatEpochs.sessionKey],
      set: { epoch: sql`${chatEpochs.epoch} + 1` },
    })
    .returning();
  const [row] = await tx
    .insert(conversations)
    .values({
      id: newId('cnv'),
      userId,
      sessionKey,
      channel,
      kind: values.kind ?? 'chat',
      epoch: counter!.epoch,
      title: values.title,
      active: false,
      startedAt: at,
      lastMessageAt: at,
    })
    .returning();
  return row!;
}

/** The user's Automations chat, if they have one. Never starts one. */
export async function findAutomationsChat(
  userId: string,
  tx: Tx = db(),
): Promise<ConversationRow | undefined> {
  const [row] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.userId, userId), eq(conversations.kind, 'automations')));
  return row;
}

/**
 * The user's Automations chat: where every run of every automation answers. Started the first
 * time it is needed (a run, or the first automation made), in web chat beside the active
 * conversation, which stays the active one. It gets web chat's next number, so the agent keeps a
 * context of its own for it, and it is never made the active one. One per user: two runs at the
 * same moment start one between them (the web chat's lock, and a unique index behind it). After
 * the user deletes it, the next call starts a new one, with a number never used before.
 */
export async function automationsChat(userId: string): Promise<ConversationRow> {
  const found = await findAutomationsChat(userId);
  if (found) return found;
  const { conversation, added } = await db().transaction(async (tx) => {
    await lockChat(tx, userId, AUTOMATIONS_SESSION);
    // Another run may have started it while this one waited for the lock.
    const now = await findAutomationsChat(userId, tx);
    if (now) return { conversation: now, added: false };
    const row = await addConversationAside(tx, userId, AUTOMATIONS_SESSION, {
      title: AUTOMATIONS_TITLE,
      kind: 'automations',
    });
    return { conversation: row, added: true };
  });
  if (added) await announce(conversation);
  return conversation;
}

/**
 * Makes a conversation its chat's active one. Null: not this user's. Whether a conversation of
 * that channel may be opened this way is the caller's rule.
 */
export async function activateConversation(
  userId: string,
  id: string,
): Promise<ConversationRow | null> {
  const changed = await db().transaction(async (tx) => {
    const found = await getConversation(userId, id, tx);
    if (!found) return null;
    if (found.active) return { conversation: found, replaced: [], switched: false };
    await lockChat(tx, userId, found.sessionKey);
    // Read again under the lock: it may have been deleted, or made active, meanwhile.
    const [current] = await tx.select().from(conversations).where(mine(userId, id)).for('update');
    if (!current) return null;
    if (current.active) return { conversation: current, replaced: [], switched: false };
    // The Automations chat is never the active one: it is written in where it is.
    if (isAutomationsChat(current)) return { conversation: current, replaced: [], switched: false };
    const replaced = await tx
      .update(conversations)
      .set({ active: false })
      .where(
        and(
          eq(conversations.userId, userId),
          eq(conversations.sessionKey, current.sessionKey),
          eq(conversations.active, true),
        ),
      )
      .returning();
    const [conversation] = await tx
      .update(conversations)
      .set({ active: true })
      .where(mine(userId, id))
      .returning();
    return { conversation: conversation!, replaced, switched: true };
  });
  if (!changed) return null;
  for (const c of changed.replaced) await announce(c);
  if (changed.switched) await announce(changed.conversation);
  return changed.conversation;
}

/** The user's own name for a conversation. Null: not this user's. */
export async function renameConversation(
  userId: string,
  id: string,
  title: string,
): Promise<ConversationRow | null> {
  const [row] = await db().update(conversations).set({ title }).where(mine(userId, id)).returning();
  if (!row) return null;
  await announce(row);
  return row;
}

/**
 * Deletes a conversation with its messages and their files (the user's own data). Null: not this
 * user's. When it was web chat's active one, the newest remaining web conversation becomes the
 * active one, or an empty one is started. On another channel the chat is left with no active
 * conversation: its next message starts one, with a new number, so the deleted one's context is
 * never continued. `onDeleted` runs inside the same transaction (the activity log entry).
 */
export async function deleteConversation(
  userId: string,
  id: string,
  opts: { onDeleted?: (tx: Tx, c: ConversationRow) => Promise<void> } = {},
): Promise<{ deleted: ConversationRow; nowActive: ConversationRow | null } | null> {
  const result = await db().transaction(async (tx) => {
    const found = await getConversation(userId, id, tx);
    if (!found) return null;
    await lockChat(tx, userId, found.sessionKey);
    // Locked: a message being saved into it right now waits, then fails and is saved again.
    const [deleted] = await tx.select().from(conversations).where(mine(userId, id)).for('update');
    if (!deleted) return null;

    const gone = await tx
      .delete(messages)
      .where(and(eq(messages.userId, userId), eq(messages.conversationId, id)))
      .returning({ mediaRef: messages.mediaRef });
    const fileIds = [...new Set(gone.flatMap((m) => (m.mediaRef ?? []).map((a) => a.id)))];
    // A file is kept only while a message of another conversation still shows it.
    const files = fileIds.length
      ? await tx
          .delete(attachments)
          .where(
            and(
              eq(attachments.userId, userId),
              inArray(attachments.id, fileIds),
              sql`not exists (
                select 1 from ${messages}
                where ${messages.userId} = ${userId}
                  and ${messages.mediaRef} @> jsonb_build_array(jsonb_build_object('id', ${attachments.id}))
              )`,
            ),
          )
          .returning({ path: attachments.path })
      : [];
    await tx.delete(conversations).where(mine(userId, id));

    let nowActive: ConversationRow | null = null;
    if (deleted.active && deleted.channel === 'web') {
      // Never the Automations chat: it is not a conversation the user's next message goes into.
      const [newest] = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.userId, userId),
            eq(conversations.sessionKey, deleted.sessionKey),
            eq(conversations.kind, 'chat'),
          ),
        )
        .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
        .limit(1);
      if (newest) {
        [nowActive = null] = await tx
          .update(conversations)
          .set({ active: true })
          .where(mine(userId, newest.id))
          .returning();
      } else {
        nowActive = (await addConversation(tx, userId, deleted.sessionKey, deleted.epoch + 1, null))
          .conversation;
      }
    }
    await opts.onDeleted?.(tx, deleted);
    return { deleted, nowActive, files };
  });
  if (!result) return null;
  for (const f of result.files) await rm(f.path, { force: true });
  await publish(userId, 'conversation.deleted', { id });
  if (result.nowActive) await announce(result.nowActive);
  return { deleted: result.deleted, nowActive: result.nowActive };
}

/** The list's cursor: where the last row of a page stands in the order (time, then id). */
const cursorOf = (c: ConversationRow) => `${c.lastMessageAt.getTime()}-${c.id}`;

function parseCursor(cursor: string): { at: Date; id: string } {
  const m = /^(\d{1,15})-([a-z0-9_]{1,64})$/.exec(cursor);
  if (!m) throw badRequest('Invalid cursor');
  return { at: new Date(Number(m[1])), id: m[2]! };
}

/** The user's conversations, the one with the newest message first. */
export async function listConversations(
  userId: string,
  opts: { channel?: Channel; kind?: ConversationKind; cursor?: string; limit: number },
) {
  const where = [eq(conversations.userId, userId)];
  if (opts.channel) where.push(eq(conversations.channel, opts.channel));
  if (opts.kind) where.push(eq(conversations.kind, opts.kind));
  if (opts.cursor) {
    const { at, id } = parseCursor(opts.cursor);
    where.push(
      sql`(${conversations.lastMessageAt}, ${conversations.id}) < (${at.toISOString()}::timestamptz, ${id})`,
    );
  }
  const rows = await db()
    .select()
    .from(conversations)
    .where(and(...where))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  return {
    items: page,
    nextCursor: rows.length > opts.limit ? cursorOf(page[page.length - 1]!) : null,
  };
}

/**
 * A message was saved in a conversation: its time becomes the conversation's `lastMessageAt`, and
 * the first incoming message with text gives the conversation its title.
 */
export async function noteMessage(message: {
  userId: string;
  conversationId: string;
  direction: 'in' | 'out';
  text: string;
  createdAt: Date;
}): Promise<void> {
  const title = message.direction === 'in' ? titleFromText(message.text) : null;
  const [row] = await db()
    .update(conversations)
    .set({
      lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${message.createdAt.toISOString()}::timestamptz)`,
      ...(title ? { title: sql`coalesce(${conversations.title}, ${title})` } : {}),
    })
    .where(mine(message.userId, message.conversationId))
    .returning();
  if (row) await announce(row);
}

/**
 * Chat history retention: a conversation that is not active, has had no message since `before`
 * and has none left is removed. Returns how many.
 */
export async function cleanupEmptyConversations(before: Date): Promise<number> {
  const rows = await db()
    .delete(conversations)
    .where(
      and(
        eq(conversations.active, false),
        lt(conversations.lastMessageAt, before),
        sql`not exists (select 1 from ${messages} where ${messages.conversationId} = ${conversations.id})`,
      ),
    )
    .returning({ id: conversations.id });
  return rows.length;
}

/** Account deletion: the user's conversations and chat counters. Their messages go first. */
export async function deleteUserConversations(userId: string): Promise<void> {
  await db().delete(conversations).where(eq(conversations.userId, userId));
  await db().delete(chatEpochs).where(eq(chatEpochs.userId, userId));
}
