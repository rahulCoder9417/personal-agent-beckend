import { Webhook } from 'svix';
import { config } from '../../shared/config.ts';
import { AppError } from '../../shared/errors.ts';

export const webhookUnauthorized = () =>
  new AppError(401, 'unauthorized', 'Invalid webhook signature');

/** Verifies a Clerk (Svix) webhook on the raw body. Returns the parsed payload. */
export function verifyClerkWebhook(rawBody: string, headers: Record<string, string | undefined>) {
  const secret = config().CLERK_WEBHOOK_SECRET;
  if (!secret) throw webhookUnauthorized();
  try {
    new Webhook(secret).verify(rawBody, {
      'svix-id': headers['svix-id'] ?? '',
      'svix-timestamp': headers['svix-timestamp'] ?? '',
      'svix-signature': headers['svix-signature'] ?? '',
    });
  } catch {
    throw webhookUnauthorized();
  }
  return JSON.parse(rawBody) as { type?: string; data?: Record<string, unknown> };
}
