// What the user is shown when the agent asks for their OK (docs/backend-report.md, "Approvals"):
// the approval's own summary, written as Tex's sentence, and how to answer. It is made from the
// summary the agent gave, so it is there at once and costs nothing: no model is asked.
import type { Channel } from '../channels/types.ts';

/** The buttons under the question, where the chat has buttons. */
export const APPROVE_TITLE = '✅ Approve';
export const DENY_TITLE = '❌ Deny';

/**
 * Words a summary starts with when it says what the agent will do ("Send an email to …"). Such a
 * summary reads as "I'd like to send an email to …". Any other start keeps the summary as it is.
 */
const VERBS = new Set([
  'accept',
  'add',
  'archive',
  'assign',
  'block',
  'book',
  'buy',
  'cancel',
  'change',
  'charge',
  'close',
  'comment',
  'create',
  'decline',
  'delete',
  'edit',
  'email',
  'force',
  'forward',
  'invite',
  'label',
  'mark',
  'merge',
  'message',
  'move',
  'open',
  'order',
  'pay',
  'post',
  'publish',
  'purchase',
  'push',
  'refund',
  'remove',
  'rename',
  'renew',
  'reply',
  'reschedule',
  'respond',
  'review',
  'run',
  'schedule',
  'send',
  'set',
  'share',
  'start',
  'submit',
  'subscribe',
  'transfer',
  'trash',
  'tweet',
  'unsubscribe',
  'update',
  'upload',
  'write',
]);

/** Chats that show the Approve and Deny buttons under the question. iMessage has none (below). */
const HAS_BUTTONS: ReadonlySet<Channel> = new Set<Channel>(['web', 'telegram', 'whatsapp']);

/** The chat a session key names: `web`, or the part before the first colon (`telegram:123`). */
export function channelOfSession(sessionKey: string): Channel {
  return sessionKey === 'web' ? 'web' : (sessionKey.split(':')[0] as Channel);
}

/**
 * The question, as Tex says it: what it wants to do, then how to answer. Example: the summary
 * `Send an email to priya@acme.com with subject "Test"` in web chat or on Telegram becomes
 * `I'd like to send an email to priya@acme.com with subject "Test". Approve or Deny below.`
 * A summary that doesn't start with a verb is kept as written: `I'd like your OK for this: …`.
 * iMessage has no buttons: its sender adds "Reply YES to approve or NO to deny." itself.
 */
export function approvalAskText(summary: string, channel: Channel): string {
  let what = summary.trim().replace(/[\s.]+$/u, '') || summary.trim();
  const first = /^[A-Za-z]+/.exec(what)?.[0] ?? '';
  const isVerb = VERBS.has(first.toLowerCase()) && /^\s/u.test(what.slice(first.length));
  if (isVerb) what = `${first.toLowerCase()}${what.slice(first.length)}`;
  const sentence = isVerb ? `I'd like to ${what}` : `I'd like your OK for this: ${what}`;
  const ended = /[!?]$/u.test(sentence) ? sentence : `${sentence}.`;
  return HAS_BUTTONS.has(channel) ? `${ended} Approve or Deny below.` : ended;
}

/** Where an answer came from (`decidedVia`: `web`, `telegram:button`, …), as the user says it. */
function placeOf(via: string | null | undefined): string | null {
  const channel = (via ?? '').split(':')[0];
  if (channel === 'web') return 'web';
  if (channel === 'telegram') return 'Telegram';
  if (channel === 'whatsapp') return 'WhatsApp';
  if (channel === 'imessage') return 'iMessage';
  return null;
}

/**
 * The line put under an approval's question on Telegram once it can no longer be answered, in
 * place of its buttons: "✅ Approved on web", "❌ Denied on Telegram", or how it ended otherwise.
 */
export function approvalEndNote(
  status: 'approved' | 'rejected' | 'replaced' | 'expired',
  via?: string | null,
): string {
  const place = placeOf(via);
  const on = place ? ` on ${place}` : '';
  if (status === 'approved') return `✅ Approved${on}`;
  if (status === 'rejected') return `❌ Denied${on}`;
  if (status === 'replaced') return 'Replaced by a newer request.';
  return via === 'admin' ? 'Cancelled by Textcrew support.' : 'Expired: no answer came in time.';
}
