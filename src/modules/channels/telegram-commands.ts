// The Telegram bot's "/" menu: the commands Telegram lists when the user types "/" or presses
// the menu button. It is set with the Bot API's setMyCommands when the api starts, and only when
// Telegram's copy differs, so a restart changes nothing when nothing changed. `/clear` and
// `/reset` still work (they are the same as `/new`) but are left out of the menu.
import { config, isChannelEnabled } from '../../shared/config.ts';
import { logger } from '../../shared/logger.ts';
import { telegramApi } from './adapters/telegram.ts';

export interface BotCommand {
  command: string;
  description: string;
}

/** The menu, in order. */
export const BOT_COMMANDS: readonly BotCommand[] = [
  { command: 'new', description: 'Start a new conversation' },
  { command: 'help', description: 'How Textcrew works' },
];

function sameCommands(a: unknown, b: readonly BotCommand[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  return b.every((cmd, i) => {
    const got = a[i] as Partial<BotCommand> | undefined;
    return got?.command === cmd.command && got.description === cmd.description;
  });
}

/**
 * Makes the bot's menu match BOT_COMMANDS: reads Telegram's copy (getMyCommands) and sets it
 * (setMyCommands) only when it differs. Safe to run any number of times. Skipped when Telegram
 * is switched off or has no bot token.
 */
export async function syncTelegramCommands(): Promise<'set' | 'unchanged' | 'skipped'> {
  if (!isChannelEnabled('telegram') || !config().TELEGRAM_BOT_TOKEN) return 'skipped';
  const api = telegramApi();
  const current: unknown = await api('getMyCommands', {});
  if (sameCommands(current, BOT_COMMANDS)) return 'unchanged';
  await api('setMyCommands', { commands: BOT_COMMANDS.map((c) => ({ ...c })) });
  return 'set';
}

/** At api start: best effort. A failure is logged (never the token) and the api runs on. */
export async function syncTelegramCommandsAtStart(): Promise<void> {
  try {
    const outcome = await syncTelegramCommands();
    if (outcome !== 'skipped') logger().info({ outcome }, 'telegram command menu');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger().warn({ err: message }, 'telegram command menu not set');
  }
}
