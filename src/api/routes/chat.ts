import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { streamSSE } from 'hono/streaming';
import { getUserAttachments } from '../../modules/channels/files.ts';
import {
  listMessages,
  saveWebMessage,
  setMessageEvent,
  toApiMessage,
} from '../../modules/channels/messages.ts';
import { attachments } from '../../modules/channels/schema.ts';
import { subscribe } from '../../modules/channels/stream.ts';
import { ingestEvent } from '../../modules/events/intake.ts';
import { userHasCredits } from '../../modules/orchestrator/turn.ts';
import { config } from '../../shared/config.ts';
import { db } from '../../shared/db/client.ts';
import { AppError, badRequest, outOfCredits } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import { enforce } from '../../shared/rate-limit.ts';
import { route } from '../router.ts';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const chatRoutes = [
  route('listMessages', async (c, { query }) => {
    const page = await listMessages(c.get('user').id, {
      limit: query.limit ?? 30,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
    });
    return c.json({ items: page.items.map(toApiMessage), nextCursor: page.nextCursor }, 200);
  }),

  route('sendMessage', async (c, { body }) => {
    const user = c.get('user');
    await enforce({ key: `msg:user:${user.id}`, max: 30, windowSeconds: 60 });
    if (!(await userHasCredits(user.id))) throw outOfCredits();
    const files = await getUserAttachments(user.id, body.attachmentIds ?? []);
    if (files.length !== (body.attachmentIds ?? []).length) throw badRequest('Unknown attachment');
    const { message, created } = await saveWebMessage({
      userId: user.id,
      text: body.text,
      clientMessageId: body.clientMessageId,
      media: files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, path: f.path })),
    });
    const { eventId } = await ingestEvent({
      source: 'web',
      externalId: `${user.id}:${body.clientMessageId}`,
      type: 'message',
      userId: user.id,
      payload: { messageId: message.id },
      queue: 'inbound',
      jobName: 'web-message',
      jobData: { messageId: message.id },
    });
    if (created) await setMessageEvent(message.id, eventId);
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
      const queue: Array<{ type: string; data: unknown }> = [];
      let wake: (() => void) | undefined;
      const unsubscribe = await subscribe(userId, (e) => {
        queue.push(e);
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
