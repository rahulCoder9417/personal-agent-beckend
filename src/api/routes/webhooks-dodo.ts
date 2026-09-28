import { verifyDodoWebhook } from '../../modules/billing/dodo.ts';
import { ingestEvent } from '../../modules/events/intake.ts';
import { route } from '../router.ts';

// Verify (Standard Webhooks) on the raw body → save the event (unique on webhook-id) → job → 200.
export const dodoWebhookRoutes = [
  route('webhookDodo', async (c, { rawBody }) => {
    const headers = {
      'webhook-id': c.req.header('webhook-id'),
      'webhook-timestamp': c.req.header('webhook-timestamp'),
      'webhook-signature': c.req.header('webhook-signature'),
    };
    const payload = verifyDodoWebhook(rawBody, headers);
    const metadata = (payload.data?.metadata ?? {}) as Record<string, unknown>;
    await ingestEvent({
      source: 'dodo',
      externalId: headers['webhook-id']!,
      type: payload.type ?? 'unknown',
      userId: typeof metadata.user_id === 'string' ? metadata.user_id : null,
      payload: payload as Record<string, unknown>,
      queue: 'system',
      jobName: 'dodo-event',
    });
    return c.body(null, 200);
  }),
];
