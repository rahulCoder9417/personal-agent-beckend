import { answerCallback, parseTelegramUpdate, type TelegramUpdate } from './adapters/telegram.ts';
import type { ChatChannel, InboundMessage } from './types.ts';

type Parser = (payload: Record<string, unknown>) => InboundMessage | null;

const parsers = new Map<string, Parser>([
  ['telegram', (p) => parseTelegramUpdate(p as unknown as TelegramUpdate)],
]);

/** Registers a channel's webhook-payload parser (event source → normalized message). */
export function registerInboundParser(source: string, parser: Parser): void {
  parsers.set(source, parser);
}

export function parseInbound(
  source: string,
  payload: Record<string, unknown>,
): InboundMessage | null {
  return parsers.get(source)?.(payload) ?? null;
}

/** Acknowledge a button tap where the channel needs it (Telegram spinner). */
export async function acknowledgeButton(
  channel: ChatChannel,
  callbackId: string | undefined,
  text?: string,
) {
  if (channel === 'telegram' && callbackId) await answerCallback(callbackId, text);
}
