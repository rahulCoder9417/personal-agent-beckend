import type { ChannelAdapter } from '../types.ts';

/** Web replies need no provider call: they're in `messages` and pushed over SSE. */
export const webAdapter: ChannelAdapter = {
  channel: 'web',
  async send() {
    return {};
  },
};
