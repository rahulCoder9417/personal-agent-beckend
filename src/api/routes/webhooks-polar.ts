import { verifyPolarWebhook } from '../../modules/billing/polar.ts';
import { ingestEvent } from '../../modules/events/intake.ts';
import { route } from '../router.ts';

// Verify (Standard Webhooks) on the raw body → save the event (unique on webhook-id) → job → 200.
export const polarWebhookRoutes = [
  route('webhookPolar', async (c, { rawBody }) => {
    const headers = {
      'webhook-id': c.req.header('webhook-id'),
      'webhook-timestamp': c.req.header('webhook-timestamp'),
      'webhook-signature': c.req.header('webhook-signature'),
    };
    const payload = verifyPolarWebhook(rawBody, headers);
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const customer = (data.customer ?? {}) as Record<string, unknown>;
    const metadata = (data.metadata ?? {}) as Record<string, unknown>;
    const userId = [customer.external_id, metadata.user_id].find((v) => typeof v === 'string');
    await ingestEvent({
      source: 'polar',
      externalId: headers['webhook-id']!,
      type: payload.type ?? 'unknown',
      userId: (userId as string | undefined) ?? null,
      payload: payload as Record<string, unknown>,
      queue: 'system',
      jobName: 'polar-event',
    });
    return c.body(null, 200);
  }),
];
