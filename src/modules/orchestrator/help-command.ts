// `/help` in Telegram, and the "Linked!" reply that points to it. `/help` is answered by us, like
// `/new` (chats.ts): no turn, no credits, and neither the command nor the answer is saved as a
// message.
import { config } from '../../shared/config.ts';
import type { Channel } from '../channels/types.ts';

/** `/help` on its own (Telegram adds `@<bot name>` in a group). */
const HELP_COMMAND = /^\/help(@\w+)?$/i;

export function isHelpCommand(text: string): boolean {
  return HELP_COMMAND.test(text.trim());
}

/** The web app's Help page. */
export function helpPageUrl(): string {
  return `${config().WEB_APP_URL.replace(/\/+$/, '')}/help`;
}

/** The bot's answer to `/help`. */
export function helpText(): string {
  return [
    "I'm Tex, your own AI agent on Textcrew. Text me what you need in plain words, like you would a person.",
    '',
    'I can:',
    '• answer questions and look things up on the web',
    '• work in the apps you connect (Gmail, Calendar, GitHub and more). I ask you first before I send, delete or pay for anything',
    '• set up automations that run on a schedule or when something happens',
    '• remember what you ask me to',
    '• read photos, files and voice notes',
    '',
    'Commands:',
    '/new: start a new conversation. Your saved memories stay.',
    '/help: this message',
    'Both are free.',
    '',
    `More help: ${helpPageUrl()}`,
  ].join('\n');
}

/** The reply once a chat is linked: what to do now, `/new` where it works, and the Help page. */
export function linkedText(channel: Channel): string {
  const next =
    channel === 'telegram'
      ? `Send /new any time to start a fresh conversation. How Textcrew works: ${helpPageUrl()}`
      : `How Textcrew works: ${helpPageUrl()}`;
  return `✅ Linked! You can chat with your agent right here. What can I do for you?\n\n${next}`;
}
