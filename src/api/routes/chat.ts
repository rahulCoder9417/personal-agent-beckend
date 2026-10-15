import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { streamSSE } from 'hono/streaming';
import {
  findActiveConversation,
  getConversation,
  listConversations,
  toApiConversation,
} from '../../modules/channels/conversations.ts';
import { listMessages, toApiMessage } from '../../modules/channels/messages.ts';
import { attachments } from '../../modules/channels/schema.ts';
import { enqueueStreamEvent, subscribe, type StreamEvent } from '../../modules/channels/stream.ts';
import {
  deleteUserConversation,
  openWebConversation,
  renameUserConversation,
  startNewWebChat,
  webChatStartedAt,
} from '../../modules/orchestrator/chats.ts';
import { sendWebMessage } from '../../modules/orchestrator/process-message.ts';
import { config } from '../../shared/config.ts';
import { db } from '../../shared/db/client.ts';
import { AppError, badRequest, notFound } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import { iso } from '../presenters.ts';
import { route } from '../router.ts';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const chatRoutes = [
  // Which messages: one conversation's; web chat's active conversation (`channel=web`); another
  // channel's; or all of them.
  route('listMessages', async (c, { query }) => {
    const userId = c.get('user').id;
    let conversationId = query.conversationId;
    let nothingToList = false;
    if (!conversationId && query.channel === 'web') {
      const active = await findActiveConversation(userId, 'web');
      if (active) conversationId = active.id;
      // Web chat has no conversation yet, so it has no message either.
      else nothingToList = true;
    }
    // A named conversation must be this user's (404 otherwise). The check runs beside the reads,
    // which are filtered by the user too, so a page waits for one round trip instead of two.
    const [found, page, chatStartedAt] = await Promise.all([
      query.conversationId ? getConversation(userId, query.conversationId) : true,
      nothingToList
        ? { items: [], nextCursor: null }
        : listMessages(userId, {
            limit: query.limit ?? 30,
            ...(query.cursor ? { cursor: query.cursor } : {}),
            ...(query.channel ? { channel: query.channel } : {}),
            ...(conversationId ? { conversationId } : {}),
          }),
      webChatStartedAt(userId),
    ]);
    if (!found) throw notFound('Conversation not found');
    return c.json(
      {
        items: page.items.map(toApiMessage),
        nextCursor: page.nextCursor,
        chatStartedAt: iso(chatStartedAt),
      },
      200,
    );
  }),

  route('listConversations', async (c, { query }) => {
    const page = await listConversations(c.get('user').id, {
      limit: query.limit ?? 30,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
    });
    return c.json({ items: page.items.map(toApiConversation), nextCursor: page.nextCursor }, 200);
  }),

  // A new web conversation: the agent starts with a fresh context there; saved memories stay.
  route('createConversation', async (c) => {
    return c.json(toApiConversation(await startNewWebChat(c.get('user').id)), 201);
  }),

  // The older name of the same action (and the same limit of 30 an hour).
  route('startNewChat', async (c) => {
    const conversation = await startNewWebChat(c.get('user').id);
    return c.json({ chatStartedAt: conversation.startedAt.toISOString() }, 200);
  }),

  // Rename it, or make a web conversation the one web chat writes in. Both at once: both happen.
  route('updateConversation', async (c, { params, body }) => {
    const userId = c.get('user').id;
    const title = body.title?.trim();
    if (body.title !== undefined && !title) throw badRequest('The title cannot be empty');
    let conversation = body.active
      ? await openWebConversation(userId, params.conversationId)
      : undefined;
    if (title) conversation = await renameUserConversation(userId, params.conversationId, title);
    // The contract asks for at least one of the two fields.
    if (!conversation) throw badRequest('Nothing to change');
    return c.json(toApiConversation(conversation), 200);
  }),

  route('deleteConversation', async (c, { params }) => {
    await deleteUserConversation(c.get('user').id, params.conversationId);
    return c.body(null, 204);
  }),

  // The checks, the save and the job are one function, shared with the dev script's `send`.
  route('sendMessage', async (c, { body }) => {
    const { message } = await sendWebMessage(c.get('user').id, {
      text: body.text,
      clientMessageId: body.clientMessageId,
      ...(body.attachmentIds ? { attachmentIds: body.attachmentIds } : {}),
      ...(body.conversationId ? { conversationId: body.conversationId } : {}),
    });
    return c.json(toApiMessage(message), 202);
  }),

  route('uploadAttachment', async (c) => {
    const user = c.get('user');
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > MAX_ATTACHMENT_BYTES + 64 * 1024)
      throw new AppError(413, 'invalid_request', 'File too large (max 10 MB)');
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const file = form.file;
    if (!(file instanceof File)) throw badRequest('A `file` field is required');
    if (file.size > MAX_ATTACHMENT_BYTES)
      throw new AppError(413, 'invalid_request', 'File too large (max 10 MB)');
    const id = newId('att');
    const dir = resolve(config().ATTACHMENTS_DIR, user.id);
    await mkdir(dir, { recursive: true });
    const path = join(dir, id);
    await writeFile(path, Buffer.from(await file.arrayBuffer()));
    const name = file.name.slice(0, 200) || 'file';
    const mimeType = file.type || 'application/octet-stream';
    await db()
      .insert(attachments)
      .values({ id, userId: user.id, name, mimeType, sizeBytes: file.size, path });
    return c.json({ id, name, sizeBytes: file.size, mimeType }, 201);
  }),

  route('streamEvents', (c) => {
    const userId = c.get('user').id;
    return streamSSE(c, async (stream) => {
      const queue: StreamEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = await subscribe(userId, (e) => {
        enqueueStreamEvent(queue, e);
        wake?.();
      });
      stream.onAbort(unsubscribe);
      await stream.writeSSE({ event: 'ready', data: '{}' });
      while (!stream.aborted) {
        const next = queue.shift();
        if (next) {
          await stream.writeSSE({ event: next.type, data: JSON.stringify(next) });
          continue;
        }
        await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(25_000)]);
        wake = undefined;
        if (queue.length === 0 && !stream.aborted)
          await stream.writeSSE({ event: 'ping', data: '{}' });
      }
      unsubscribe();
    });
  }),
];
