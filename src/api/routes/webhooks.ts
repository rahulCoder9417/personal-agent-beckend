import { findLink } from '../../modules/auth/links.ts';
import { verifyClerkWebhook, webhookUnauthorized } from '../../modules/auth/webhooks.ts';
import {
  telegramChatId,
  verifyTelegramSecret,
  type TelegramUpdate,
} from '../../modules/channels/adapters/telegram.ts';
import { ingestEvent, recordEventOnce } from '../../modules/events/intake.ts';
import { route } from '../router.ts';

// Every webhook: verify the signature on the raw body → save the event → add a job → 200.
export const webhookRoutes = [
  route('webhookClerk', async (c, { rawBody }) => {
    const payload = verifyClerkWebhook(rawBody, {
      'svix-id': c.req.header('svix-id'),
      'svix-timestamp': c.req.header('svix-timestamp'),
      'svix-signature': c.req.header('svix-signature'),
    });
    await ingestEvent({
      source: 'clerk',
      externalId: c.req.header('svix-id')!,
      type: payload.type ?? 'unknown',
      payload: payload as Record<string, unknown>,
      queue: 'system',
      jobName: 'clerk-event',
    });
    return c.body(null, 200);
  }),

  route('webhookTelegram', async (c, { rawBody }) => {
    if (!verifyTelegramSecret(c.req.header('x-telegram-bot-api-secret-token')))
      throw webhookUnauthorized();
    const update = JSON.parse(rawBody) as TelegramUpdate;
    if (typeof update.update_id !== 'number') return c.body(null, 200);
    const chatId = telegramChatId(update);
    const relevant = Boolean(update.message || update.callback_query);
    if (!relevant || !chatId) {
      await recordEventOnce({
        source: 'telegram',
        externalId: String(update.update_id),
        type: 'other',
        payload: update,
      });
      return c.body(null, 200);
    }
    const link = await findLink('telegram', chatId);
    await ingestEvent({
      source: 'telegram',
      externalId: String(update.update_id),
      type: update.callback_query ? 'button' : 'message',
      userId: link?.userId ?? null,
      payload: update as unknown as Record<string, unknown>,
      queue: 'inbound',
      jobName: 'process-message',
    });
    return c.body(null, 200);
  }),
];
