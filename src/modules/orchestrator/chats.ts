// What a user can do with their conversations: start a new one ("New chat"), open an earlier web
// conversation, rename one, delete one (never the Automations chat). A chat is a session key (`web`, `telegram:<chat id>`); a
// conversation is one stretch of it, and the channels module keeps them (channels/conversations.ts).
// Each conversation has a number in its chat (its epoch). Every delivery carries the number of the
// conversation it belongs to, and the Bridge keeps one engine conversation per number, so each has
// a context of its own. Shared memory is kept across all of them: it is not part of a chat.
import { conflict, notFound } from '../../shared/errors.ts';
import { enforce } from '../../shared/rate-limit.ts';
import { audit } from '../admin/audit.ts';
import {
  activateConversation,
  activeConversation,
  chatCounter,
  deleteConversation,
  getConversation,
  isAutomationsChat,
  renameConversation,
  startConversation,
  type ConversationRow,
} from '../channels/conversations.ts';
import type { Channel } from '../channels/types.ts';
import { forgetConversationEngines } from './turn-context.ts';

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
 * Starts a new conversation in a chat: it becomes the chat's active one, with the next number,
 * and the activity log says so with the channel (never any message text). With a `key` (the
 * event that asked for it), a second run for the same key changes nothing: `started` is then
 * false.
 */
export async function startNewChat(
  userId: string,
  sessionKey: string,
  opts: { channel: Channel; key?: string },
): Promise<{ conversation: ConversationRow; started: boolean }> {
  return startConversation(userId, sessionKey, {
    ...(opts.key ? { key: opts.key } : {}),
    onStarted: (tx, c) =>
      audit(
        {
          userId,
          actor: 'user',
          action: 'chat_started',
          summary: `Started a new chat ${IN_CHANNEL[opts.channel]}`,
          details: { channel: opts.channel, epoch: c.epoch, conversationId: c.id },
        },
        tx,
      ),
  });
}

/** POST /v1/conversations: a new web conversation, at most 30 an hour (429 after that). */
export async function startNewWebChat(userId: string): Promise<ConversationRow> {
  await enforce({ key: `new-chat:user:${userId}`, max: NEW_CHATS_PER_HOUR, windowSeconds: 3600 });
  return (await startNewChat(userId, 'web', { channel: 'web' })).conversation;
}

/**
 * For older clients (`chatStartedAt`): when web chat's newest conversation started, or null if
 * the user never started a new chat there (web chat is still on its first conversation, or has
 * none).
 */
export async function webChatStartedAt(userId: string): Promise<Date | null> {
  const counter = await chatCounter(userId, 'web');
  return counter && counter.epoch > 0 ? counter.startedAt : null;
}

const NOT_FOUND = 'Conversation not found';

/** The user's conversation, which must be a web one to be written in or opened from the web. */
async function webConversation(userId: string, id: string): Promise<ConversationRow> {
  const c = await getConversation(userId, id);
  if (!c) throw notFound(NOT_FOUND);
  if (c.channel !== 'web')
    throw conflict('Only a web conversation can be opened to write in from the web app');
  return c;
}

/**
 * Makes a web conversation the active one: web chat's next message goes there, and the agent
 * continues that conversation's own context. 404 if not this user's; 409 for another channel's,
 * and for the Automations chat, which is never the active one.
 */
export async function openWebConversation(userId: string, id: string): Promise<ConversationRow> {
  const c = await webConversation(userId, id);
  if (isAutomationsChat(c))
    throw conflict('The Automations chat is never the active one. Write in it to continue there');
  if (c.active) return c;
  const opened = await activateConversation(userId, id);
  if (!opened) throw notFound(NOT_FOUND);
  return opened;
}

/**
 * The web conversation a message is written in: the one named (made the active one first if it
 * isn't), or web chat's active one. The Automations chat is written in where it is: it never
 * becomes the active one, so the user's next message elsewhere does not go into it.
 */
export async function webConversationToWriteIn(
  userId: string,
  conversationId?: string,
): Promise<ConversationRow> {
  if (!conversationId) return activeConversation(userId, 'web');
  const c = await webConversation(userId, conversationId);
  return isAutomationsChat(c) ? c : openWebConversation(userId, conversationId);
}

/**
 * The user renames a conversation (any channel). 404 if not this user's; 409 for the Automations
 * chat, which keeps its name (a Telegram copy of a run points to it by that name).
 */
export async function renameUserConversation(
  userId: string,
  id: string,
  title: string,
): Promise<ConversationRow> {
  const found = await getConversation(userId, id);
  if (!found) throw notFound(NOT_FOUND);
  if (isAutomationsChat(found)) throw conflict('The Automations chat keeps its name');
  const renamed = await renameConversation(userId, id, title);
  if (!renamed) throw notFound(NOT_FOUND);
  return renamed;
}

/**
 * The user deletes a conversation: its messages and their files go with it, and the activity log
 * gets `conversation_deleted` with the channel (no title, no text). 404 if not this user's; 409
 * for the Automations chat, which stays for as long as the account does (every run answers
 * there). The Bridge is not told: the engine's own record of that conversation stays in the
 * container, unused, because the conversation's number is never given out again.
 */
export async function deleteUserConversation(userId: string, id: string): Promise<void> {
  // A conversation's kind never changes, so this holds until the delete below.
  const found = await getConversation(userId, id);
  if (!found) throw notFound(NOT_FOUND);
  if (isAutomationsChat(found)) throw conflict("The Automations chat can't be deleted");
  const result = await deleteConversation(userId, id, {
    onDeleted: (tx, c) =>
      audit(
        {
          userId,
          actor: 'user',
          action: 'conversation_deleted',
          summary: `Deleted a conversation ${IN_CHANNEL[c.channel]}`,
          details: { channel: c.channel, epoch: c.epoch, conversationId: c.id },
        },
        tx,
      ),
  });
  if (!result) throw notFound(NOT_FOUND);
  await forgetConversationEngines(userId, result.deleted.sessionKey, result.deleted.epoch);
}
