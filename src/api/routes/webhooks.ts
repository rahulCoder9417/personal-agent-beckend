import { verifyClerkWebhook } from '../../modules/auth/webhooks.ts';
import { ingestEvent } from '../../modules/events/intake.ts';
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
];
