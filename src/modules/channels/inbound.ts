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

/** A tap on an approval's ✅ / ❌ button (`apr:<id>:yes|no`). */
export function isApprovalButton(msg: InboundMessage): boolean {
  return /^apr:[a-z0-9_]+:(yes|no)$/.test(msg.buttonReply?.data ?? '');
}

/**
 * Where a chat app's inbound event goes. A tap on an approval's button runs no turn, so it goes to
 * the system queue, which does not wait for the user's lock: the answer (and an approved app
 * action) goes through while Tex is busy. Everything else is a message, in order, on inbound.
 */
export function inboundJobOf(
  source: string,
  payload: Record<string, unknown>,
): { queue: 'inbound' | 'system'; jobName: string } {
  const msg = parseInbound(source, payload);
  return msg && isApprovalButton(msg)
    ? { queue: 'system', jobName: 'approval-button' }
    : { queue: 'inbound', jobName: 'process-message' };
}

/** Acknowledge a button tap where the channel needs it (Telegram spinner). */
export async function acknowledgeButton(
  channel: ChatChannel,
  callbackId: string | undefined,
  text?: string,
) {
  if (channel === 'telegram' && callbackId) await answerCallback(callbackId, text);
}
