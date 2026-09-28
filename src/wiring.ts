// Composition root: connects modules through their exported hooks. Imported by api and worker.
import { markBlocked } from './modules/auth/links.ts';
import { setBlockedHandler } from './modules/channels/outbound.ts';
import { parseSessionKey } from './modules/channels/types.ts';

let wired = false;

export function wireModules(): void {
  if (wired) return;
  wired = true;

  // A blocked chat is marked; the agent is told to use the web app instead.
  setBlockedHandler(async (userId, sessionKey) => {
    const s = parseSessionKey(sessionKey);
    if (s && s.channel !== 'web' && s.externalChatId)
      await markBlocked(userId, s.channel, s.externalChatId);
  });
}
