// Channels without buttons (iMessage, WhatsApp templates without quick replies): buttons are
// rendered as text, and the user answers with a plain "yes" / "no".
import type { Button } from './types.ts';

const YES = new Set([
  'yes',
  'y',
  'yep',
  'yeah',
  'yea',
  'ok',
  'okay',
  'approve',
  'approved',
  'confirm',
  '✅',
  '👍',
  '✔',
  '✔️',
]);
const NO = new Set([
  'no',
  'n',
  'nope',
  'nah',
  'reject',
  'rejected',
  'deny',
  'decline',
  '❌',
  '👎',
  '✖',
  '✖️',
]);

/**
 * Maps a plain text reply to a yes/no button answer, or null if it isn't one.
 * Approvals use this for iMessage (and any chat where the user types instead of tapping).
 */
export function textAsButtonReply(text: string): 'yes' | 'no' | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,\s]+$/u, '')
    .replace(/️/gu, '');
  if (!t) return null;
  if (YES.has(t)) return 'yes';
  if (NO.has(t)) return 'no';
  return null;
}

const isYesNo = (buttons: Button[]) =>
  buttons.length === 2 &&
  buttons.some((b) => /(:|^)(yes|approve)$/i.test(b.id)) &&
  buttons.some((b) => /(:|^)(no|reject)$/i.test(b.id));

/** The text line that replaces buttons on a channel that has none. */
export function buttonsAsText(buttons: Button[] | undefined): string {
  if (!buttons?.length) return '';
  if (isYesNo(buttons)) return 'Reply YES to approve or NO to deny.';
  return `Reply with one of: ${buttons.map((b) => b.title).join(', ')}`;
}

/** Appends the button line (if any) to a message. */
export function withButtonsAsText(text: string, buttons: Button[] | undefined): string {
  const line = buttonsAsText(buttons);
  return line ? `${text}\n\n${line}` : text;
}
