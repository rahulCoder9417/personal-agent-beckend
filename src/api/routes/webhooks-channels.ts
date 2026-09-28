// WhatsApp + Sendblue (iMessage) webhooks. Same rule as every webhook: verify the signature on
// the raw body → save the event (unique key) → add a job → 200.
import { findLink } from '../../modules/auth/links.ts';
import { webhookUnauthorized } from '../../modules/auth/webhooks.ts';
import {
  isSendblueInbound,
  verifySendblueSecret,
  type SendbluePayload,
} from '../../modules/channels/adapters/sendblue.ts';
import {
  extractWhatsapp,
  verifyWhatsappSignature,
  whatsappVerifyChallenge,
  type WhatsappWebhook,
} from '../../modules/channels/adapters/whatsapp.ts';
import { ingestStatusEvent } from '../../modules/channels/status.ts';
import { ingestEvent } from '../../modules/events/intake.ts';
import { route } from '../router.ts';

function parseJson<T>(raw: string): T | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as T) : null;
  } catch {
    return null;
  }
}

export const channelWebhookRoutes = [
  route('webhookWhatsappVerify', (c, { query }) => {
    const challenge = whatsappVerifyChallenge(
      query['hub.mode'],
      query['hub.verify_token'],
      query['hub.challenge'],
    );
    if (challenge === null) return c.body(null, 403);
    return c.text(challenge, 200);
  }),

  route('webhookWhatsapp', async (c, { rawBody }) => {
    if (!verifyWhatsappSignature(rawBody, c.req.header('x-hub-signature-256')))
      throw webhookUnauthorized();
    const body = parseJson<WhatsappWebhook>(rawBody);
    if (!body) return c.body(null, 200);
    const { messages, statuses } = extractWhatsapp(body);
    // One event (and one inbound job) per message, unique on WhatsApp's message id.
    for (const item of messages) {
      const link = await findLink('whatsapp', item.message.from);
      const isButton = item.message.type === 'interactive' || item.message.type === 'button';
      await ingestEvent({
        source: 'whatsapp',
        externalId: item.message.id,
        type: isButton ? 'button' : 'message',
        userId: link?.userId ?? null,
        payload: item as unknown as Record<string, unknown>,
        queue: 'inbound',
        jobName: 'process-message',
      });
    }
    // Delivery receipts only update message status (outbound/message-status, no agent turn).
    for (const s of statuses) {
      await ingestStatusEvent({
        source: 'whatsapp',
        externalId: s.id,
        status: s.status,
        payload: s as unknown as Record<string, unknown>,
      });
    }
    return c.body(null, 200);
  }),

  route('webhookSendblue', async (c, { rawBody }) => {
    if (!verifySendblueSecret(c.req.header('sb-signing-secret'))) throw webhookUnauthorized();
    const p = parseJson<SendbluePayload>(rawBody);
    if (!p?.message_handle) return c.body(null, 200);
    if (p.is_outbound) {
      if (p.status)
        await ingestStatusEvent({
          source: 'sendblue',
          externalId: p.message_handle,
          status: p.status.toUpperCase(),
          payload: p as Record<string, unknown>,
        });
      return c.body(null, 200);
    }
    if (!isSendblueInbound(p)) return c.body(null, 200); // group chats are not supported
    const link = await findLink('imessage', p.from_number!);
    await ingestEvent({
      source: 'sendblue',
      externalId: p.message_handle,
      type: 'message',
      userId: link?.userId ?? null,
      payload: p as Record<string, unknown>,
      queue: 'inbound',
      jobName: 'process-message',
    });
    return c.body(null, 200);
  }),
];
