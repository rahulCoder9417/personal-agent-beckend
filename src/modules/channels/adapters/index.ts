import { markdownToPlainText } from '../plain-text.ts';
import type { Channel, ChannelAdapter, OutboundContent, SendResult } from '../types.ts';
import { telegramAdapter } from './telegram.ts';
import { webAdapter } from './web.ts';

const adapters = new Map<Channel, ChannelAdapter>([
  ['telegram', telegramAdapter],
  ['web', webAdapter],
]);

function adapterFor(channel: Channel): ChannelAdapter {
  const a = adapters.get(channel);
  if (!a) throw new Error(`no adapter for channel ${channel}`);
  return a;
}

/** Registers (or, in tests, replaces) a channel adapter. */
export function registerAdapter(adapter: ChannelAdapter): void {
  adapters.set(adapter.channel, adapter);
}

/**
 * The one way a text leaves for a chat. A chat app (Telegram, WhatsApp, iMessage) shows a text as
 * typed, so it gets a plain message: the Markdown is taken out first, whoever wrote the text (the
 * agent, the cheap model or us). The channel's own steps come after that, on the plain text: the
 * purchase-link check on Telegram, then the split into parts. Web chat sends nothing out: the web
 * app reads the saved message, which keeps the original Markdown.
 */
export function sendToChat(
  channel: Channel,
  externalChatId: string,
  content: OutboundContent,
): Promise<SendResult> {
  const adapter = adapterFor(channel);
  if (channel === 'web') return adapter.send(externalChatId, content);
  return adapter.send(externalChatId, { ...content, text: markdownToPlainText(content.text) });
}
