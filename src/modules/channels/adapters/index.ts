import type { Channel, ChannelAdapter } from '../types.ts';
import { telegramAdapter } from './telegram.ts';
import { webAdapter } from './web.ts';

const adapters = new Map<Channel, ChannelAdapter>([
  ['telegram', telegramAdapter],
  ['web', webAdapter],
]);

export function adapterFor(channel: Channel): ChannelAdapter {
  const a = adapters.get(channel);
  if (!a) throw new Error(`no adapter for channel ${channel}`);
  return a;
}

/** Registers (or, in tests, replaces) a channel adapter. */
export function registerAdapter(adapter: ChannelAdapter): void {
  adapters.set(adapter.channel, adapter);
}
