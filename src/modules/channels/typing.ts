// "typing…" in a chat app while the agent works on a message from it. Telegram only: the Bot API's
// sendChatAction shows "typing…" under the bot's name for about 5 seconds, or until the bot's next
// message arrives, so it is sent again every few seconds while the work goes on. The other chat
// apps get nothing here (WhatsApp and iMessage have no such call wired in).
//
// After a message went to the chat it is not sent again for a while (TYPING_QUIET_MS): the agent's
// answer clears "typing…" in the app, and the turn ends a moment later. Sending it once more in that
// moment would show "typing…" again under the answer for 5 seconds. If the turn goes on after a
// message (a step's update, then more work), "typing…" comes back once that while is over.
import { config, isChannelEnabled } from '../../shared/config.ts';
import { logger } from '../../shared/logger.ts';
import { redis } from '../../shared/redis.ts';
import { telegramApi } from './adapters/telegram.ts';
import { parseSessionKey, type Channel } from './types.ts';

/** Telegram shows "typing…" for about 5 seconds: it is sent again this often. */
export const TYPING_REFRESH_MS = 4000;
/** After a message went to the chat, "typing…" waits this long before it is sent again. */
export const TYPING_QUIET_MS = 6000;
/** It stops after this long whatever happens (the container cuts a turn at 15 minutes). */
export const TYPING_MAX_MS = 16 * 60_000;

const timing = { refreshMs: TYPING_REFRESH_MS, quietMs: TYPING_QUIET_MS, maxMs: TYPING_MAX_MS };

/** Tests: shorter times. Called with nothing, back to the real ones. */
export function setTypingTiming(t?: Partial<typeof timing>): void {
  Object.assign(timing, {
    refreshMs: TYPING_REFRESH_MS,
    quietMs: TYPING_QUIET_MS,
    maxMs: TYPING_MAX_MS,
    ...t,
  });
}

const sentKey = (channel: Channel, chatId: string) => `chat-sent:${channel}:${chatId}`;

function typingWanted(channel: Channel): boolean {
  return channel === 'telegram' && config().TELEGRAM_TYPING && isChannelEnabled('telegram');
}

/**
 * A message is about to go to this chat (the outbound sender calls this just before it sends):
 * "typing…" is not sent again for TYPING_QUIET_MS. Noted before the send, so a "typing…" that
 * was about to go out cannot land after the message. One short note in Redis, gone by itself;
 * never fails the send.
 */
export async function noteSendingToChat(channel: Channel, chatId: string): Promise<void> {
  if (!typingWanted(channel)) return;
  await redis()
    .set(sentKey(channel, chatId), String(Date.now()), 'PX', timing.quietMs)
    .catch((err: unknown) => logger().debug({ err: String(err) }, 'chat send not noted'));
}

export interface Typing {
  stop(): void;
}

const NOT_TYPING: Typing = { stop() {} };

/**
 * Shows "typing…" in the chat of `sessionKey` now, and keeps it up until `stop()`. Nothing for
 * web chat or the other chat apps, or when TELEGRAM_TYPING is off. Best effort: a failed call is
 * logged and the next one is tried at the usual time; it never fails the work it goes with.
 */
export function startTyping(sessionKey: string): Typing {
  const chat = parseSessionKey(sessionKey);
  if (!chat?.externalChatId || !typingWanted(chat.channel)) return NOT_TYPING;
  const { channel, externalChatId: chatId } = chat;
  const startedAt = Date.now();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
  const tick = async () => {
    if (stopped) return;
    if (Date.now() - startedAt > timing.maxMs) return stop();
    try {
      // A message sent to the chat since this started, and only a moment ago: wait.
      // (Redis out of reach: shown anyway.)
      const sent = Number(
        await redis()
          .get(sentKey(channel, chatId))
          .catch(() => null),
      );
      const quiet = sent >= startedAt && Date.now() - sent < timing.quietMs;
      if (!quiet && !stopped)
        await telegramApi()('sendChatAction', { chat_id: chatId, action: 'typing' });
    } catch (err) {
      logger().debug({ channel, err: String(err) }, '"typing…" not shown');
    }
    if (!stopped) timer = setTimeout(() => void tick(), timing.refreshMs);
  };
  void tick();
  return { stop };
}

/** Runs `work` with "typing…" shown in the chat of `sessionKey` (startTyping) until it ends. */
export async function whileTyping<T>(sessionKey: string, work: () => Promise<T>): Promise<T> {
  const typing = startTyping(sessionKey);
  try {
    return await work();
  } finally {
    typing.stop();
  }
}
