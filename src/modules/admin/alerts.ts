import { config } from '../../shared/config.ts';
import { logger } from '../../shared/logger.ts';
import { notifyFounderError } from './ops-alerts.ts';

/** Alerts: an `alert: true` error log (for log-based alerting) + an optional webhook post. */
export async function alert(message: string, details: Record<string, unknown> = {}): Promise<void> {
  logger().error({ alert: true, ...details }, message);
  await notifyFounderError(message, details);
  const url = config().ALERT_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: `🚨 ${message}\n${JSON.stringify(details)}` }),
  }).catch((err: unknown) => logger().warn({ err: String(err) }, 'alert webhook failed'));
}
