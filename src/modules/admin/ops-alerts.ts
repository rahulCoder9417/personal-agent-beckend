// Founder alerts: short plain messages to the founder's own Telegram (docs/backend-report.md,
// "Founder alerts"). Four kinds: a new sign-up, server usage, a paying-client event, an error.
// notifyFounder only adds a job on the system queue; the worker sends it. It never throws, so a
// failed alert can never break the flow that raised it. No secrets and no message contents:
// a user's name and email are fine, their chats never.
import type { Job } from 'bullmq';
import { config } from '../../shared/config.ts';
import { logger } from '../../shared/logger.ts';
import { redis } from '../../shared/redis.ts';
import { adminTelegramChatIds } from '../auth/links.ts';
import { telegramAdapter } from '../channels/adapters/telegram.ts';
import { addJob } from '../events/queues.ts';
import { firstLineScrubbed } from './redact.ts';

export type FounderAlertKind = 'signup' | 'usage' | 'payment' | 'error';

const MUTE_FLAG = {
  signup: 'FOUNDER_ALERT_SIGNUPS',
  usage: 'FOUNDER_ALERT_USAGE',
  payment: 'FOUNDER_ALERT_PAYMENTS',
  error: 'FOUNDER_ALERT_ERRORS',
} as const;

const PREFIX = 'founder-alert:';
const DEDUPE_TTL_S = 7 * 24 * 3600;
export const ERROR_ALERT_EVERY_S = 10 * 60;

export function founderAlertOn(kind: FounderAlertKind): boolean {
  return config()[MUTE_FLAG[kind]];
}

/**
 * Queues one alert. With a dedupe key the same key is sent once (kept 7 days). Safe to call
 * again and again; never throws.
 */
export async function notifyFounder(
  kind: FounderAlertKind,
  text: string,
  dedupeKey?: string,
): Promise<void> {
  if (!founderAlertOn(kind)) return;
  let claimed: string | undefined;
  try {
    if (dedupeKey) {
      const key = `${PREFIX}${dedupeKey}`;
      const first = await redis().set(key, '1', 'EX', DEDUPE_TTL_S, 'NX');
      if (first !== 'OK') return;
      claimed = key;
    }
    await addJob('system', 'founder-alert', { kind, text });
  } catch (err) {
    if (claimed)
      await redis()
        .del(claimed)
        .catch(() => {});
    logger().warn({ err: String(err), kind }, 'founder alert could not be queued');
  }
}

/** An error for the founder: at most one per error kind (its title) every 10 minutes. */
export async function notifyFounderError(
  title: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  if (!founderAlertOn('error')) return;
  try {
    const first = await redis().set(`${PREFIX}rl:${title}`, '1', 'EX', ERROR_ALERT_EVERY_S, 'NX');
    if (first !== 'OK') return;
    const extra = firstLineScrubbed(JSON.stringify(details), 300);
    await notifyFounder('error', `Problem: ${title}${extra && extra !== '{}' ? `\n${extra}` : ''}`);
  } catch (err) {
    logger().warn({ err: String(err) }, 'founder error alert failed');
  }
}

/** Where alerts go: the configured chat ids, else the linked Telegram chats of admins. */
export async function founderChatIds(): Promise<string[]> {
  const configured = config().FOUNDER_TELEGRAM_CHAT_IDS;
  return configured.length ? configured : adminTelegramChatIds();
}

/** system/founder-alert: sends the text to every chat. Retries only when no chat got it. */
export async function handleFounderAlert(job: Job): Promise<unknown> {
  const { text } = job.data as { kind: FounderAlertKind; text: string };
  const chats = await founderChatIds();
  if (!chats.length) {
    logger().warn(
      'founder alert: no chat to send to (set FOUNDER_TELEGRAM_CHAT_IDS or link an admin)',
    );
    return { sent: 0 };
  }
  let sent = 0;
  let lastError = '';
  for (const chat of chats) {
    try {
      await telegramAdapter.send(chat, { text });
      sent += 1;
    } catch (err) {
      lastError = String(err);
      logger().warn({ err: lastError }, 'founder alert: send failed');
    }
  }
  if (sent === 0) throw new Error(`founder alert not sent: ${lastError}`);
  return { sent };
}
