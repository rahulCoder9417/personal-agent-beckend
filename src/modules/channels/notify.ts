// Notices on Telegram (docs/backend-report.md, "Notices on Telegram"). What the user asked for in
// the web app (a crew job, a pull-request review, an automation made there) is answered where it
// was asked; a short notice can go to their linked Telegram chat as well, never instead. An
// approval asked by an automation's run is sent to Telegram too (the user's switch, on at first);
// one asked in the web app stays there. Once it is answered (anywhere) every copy on Telegram
// loses its buttons and says how it ended. During the user's quiet hours Telegram messages are
// sent silently: nothing is held back.
import type { Job } from 'bullmq';
import { config, isChannelEnabled } from '../../shared/config.ts';
import { logger } from '../../shared/logger.ts';
import { listLinks } from '../auth/links.ts';
import {
  getUserCached,
  isValidTimezone,
  notificationSettingsOf,
  type NotificationSettings,
} from '../auth/users.ts';
import { addJob } from '../events/queues.ts';
import { editTelegramText } from './adapters/telegram.ts';
import { approvalMessagesOn, type MessageRow } from './messages.ts';
import { queueOutbound } from './outbound.ts';
import { markdownToPlainText } from './plain-text.ts';
import { withoutPurchaseLinks } from './purchase-links.ts';
import {
  parseSessionKey,
  RecipientBlockedError,
  sessionKeyFor,
  splitText,
  type Button,
} from './types.ts';

/** The kinds of work a user can be told about on Telegram, each with its own switch. */
export type NoticeKind = 'crew_job' | 'pr_review' | 'automation_run' | 'automation_approval';

const SWITCH: Record<NoticeKind, keyof Omit<NotificationSettings, 'quietHours'>> = {
  crew_job: 'crewJobs',
  pr_review: 'prReviews',
  automation_run: 'automationRuns',
  automation_approval: 'automationApprovals',
};

/**
 * The session key of the user's linked Telegram chat a notice may go to, or null: Telegram is
 * switched off, not linked, or the user blocked the bot.
 */
export async function telegramChatOf(userId: string): Promise<string | null> {
  if (!isChannelEnabled('telegram')) return null;
  const link = (await listLinks(userId)).find((l) => l.channel === 'telegram' && !l.blocked);
  return link ? sessionKeyFor('telegram', link.externalId) : null;
}

/** Whether the user wants to be told on Telegram about this kind of work (their switch). */
export async function wantsNotice(userId: string, kind: NoticeKind): Promise<boolean> {
  const user = await getUserCached(userId);
  return user ? notificationSettingsOf(user)[SWITCH[kind]] : false;
}

/**
 * Where a notice of this kind goes: the user's Telegram chat when they want it and it is linked,
 * else null (nothing is sent).
 */
export async function noticeTarget(userId: string, kind: NoticeKind): Promise<string | null> {
  if (!(await wantsNotice(userId, kind))) return null;
  return telegramChatOf(userId);
}

/** The web app's address that opens one conversation (the web app reads `?conversation=`). */
export function conversationLink(conversationId: string | null | undefined): string {
  const base = config().WEB_APP_URL;
  return conversationId
    ? `${base}/?conversation=${encodeURIComponent(conversationId)}`
    : `${base}/`;
}

/**
 * Sends a notice of this kind to the user's Telegram chat, when they want it and Telegram is
 * linked. `key` names what it is about (a message's id, or a key of the notice's own): one notice
 * per key, so a job that runs again sends no second one. The notice is shown in the Telegram
 * conversation but is not part of its context. Returns the saved message, or null when nothing
 * was sent.
 */
export async function sendTelegramNotice(input: {
  userId: string;
  kind: NoticeKind;
  text: string;
  key: string;
}): Promise<MessageRow | null> {
  const target = await noticeTarget(input.userId, input.kind);
  if (!target) return null;
  return queueOutbound({
    userId: input.userId,
    sessionKey: target,
    text: input.text,
    copyOf: input.key,
  });
}

// --- quiet hours ---------------------------------------------------------------------------------

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm: string): number | null => {
  const m = CLOCK.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * Is `now` inside the quiet hours, in the user's time zone? A start after the end runs over
 * midnight (22:00 to 08:00). Switched off, or a start equal to the end: never.
 */
export function isQuietTime(
  quiet: NotificationSettings['quietHours'],
  timeZone: string,
  now: Date = new Date(),
): boolean {
  if (!quiet.enabled) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === null || end === null || start === end) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: isValidTimezone(timeZone) ? timeZone : 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const t = hour * 60 + minute;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/** Is it the user's quiet hours now? (A Telegram message is then sent silently.) */
export async function inQuietHours(userId: string, now: Date = new Date()): Promise<boolean> {
  const user = await getUserCached(userId);
  if (!user) return false;
  return isQuietTime(notificationSettingsOf(user).quietHours, user.timezone, now);
}

// --- approvals on Telegram -----------------------------------------------------------------------

/** The last line of an approval's copy on Telegram: who asked, and where Tex goes on. */
export const ASKED_BY_AUTOMATION =
  'Asked by one of your automations. Tex carries on in the web app after your answer.';

/**
 * The approval's question was asked in `asked` (its message, in the asking chat), for the work of
 * `automationId` (null: the user's own chat asked). Only an automation's question goes to Telegram
 * too, with the same buttons, while the user's "An automation needs my OK" switch is on and
 * Telegram is linked. One asked in the web app stays there; one asked on Telegram is there
 * already. Once per question. Returns the copy, or null when none was sent.
 */
export async function copyApprovalQuestion(
  userId: string,
  asked: MessageRow,
  content: { text: string; buttons: Button[] },
  automationId: string | null,
): Promise<MessageRow | null> {
  if (!asked.approvalId || asked.channel === 'telegram' || !automationId) return null;
  const target = await noticeTarget(userId, 'automation_approval');
  if (!target) return null;
  return queueOutbound({
    userId,
    sessionKey: target,
    text: `${content.text}\n\n${ASKED_BY_AUTOMATION}`,
    approvalId: asked.approvalId,
    copyOf: asked.id,
    template: 'approval',
    buttons: content.buttons,
  });
}

/**
 * The approval was answered, replaced or ended (`outcome`; `note` says how for the user, e.g.
 * "✅ Approved on web"). A job then takes the buttons off every message of it on Telegram (the
 * question asked there, and the copy of one asked elsewhere) and adds the note under it. Only the
 * job is added here (the api calls this too). Never fails the caller: the answer is saved already.
 */
export async function settleApprovalMessages(
  userId: string,
  approvalId: string,
  outcome: string,
  note: string,
): Promise<void> {
  await addJob(
    'outbound',
    'settle-approval',
    { userId, approvalId, note },
    // One per approval and outcome: an approved one may be replaced later.
    { jobId: `settle-${approvalId}-${outcome}` },
  ).catch((err: unknown) =>
    logger().warn({ userId, approvalId, err: String(err) }, 'approval buttons not settled'),
  );
}

/** The part of a text Telegram shows last (where the buttons are), as the adapter sends it. */
export function lastTelegramPart(text: string): string {
  return splitText(withoutPurchaseLinks(markdownToPlainText(text))).at(-1) ?? '';
}

/** Telegram's answer to an edit that changes nothing, or to a message it no longer has. */
const NOTHING_TO_EDIT = /\b400\b/;

/**
 * outbound/settle-approval. Safe to re-run: an edit made already is refused by Telegram as "not
 * modified" and passed over. A message still waiting to go is waited for (the job is tried again).
 */
export async function handleSettleApproval(job: Job): Promise<unknown> {
  const { userId, approvalId, note } = job.data as {
    userId: string;
    approvalId: string;
    note: string;
  };
  const rows = await approvalMessagesOn(userId, approvalId, 'telegram');
  if (rows.some((r) => r.status === 'queued'))
    throw new Error('an approval message on Telegram is not sent yet');
  for (const row of rows) {
    const chat = parseSessionKey(row.sessionKey ?? '');
    if (!row.externalId || !chat?.externalChatId) continue;
    try {
      await editTelegramText(
        chat.externalChatId,
        row.externalId,
        `${lastTelegramPart(row.text)}\n\n${note}`,
      );
    } catch (err) {
      // Changed already, deleted, or the user blocked the bot: nothing more to do for it.
      if (err instanceof RecipientBlockedError || NOTHING_TO_EDIT.test(String(err))) continue;
      throw err;
    }
  }
  return null;
}
