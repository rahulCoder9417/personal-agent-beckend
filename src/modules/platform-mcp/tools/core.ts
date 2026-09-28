import { z } from 'zod';
import { getActiveUser } from '../../auth/users.ts';
import { ownsChat } from '../../auth/links.ts';
import { lastInboundSession } from '../../channels/messages.ts';
import { queueOutbound } from '../../channels/outbound.ts';
import { parseSessionKey } from '../../channels/types.ts';
import { defineTool, ToolError } from '../registry.ts';

/** Where the agent's messages may go: only this user's own sessions. */
export async function resolveSession(userId: string, sessionKey?: string): Promise<string> {
  const key = sessionKey || (await lastInboundSession(userId)) || 'web';
  const parsed = parseSessionKey(key);
  if (!parsed) throw new ToolError(`Unknown session "${key}"`);
  if (parsed.channel === 'web') return 'web';
  const link = await ownsChat(userId, parsed.channel, parsed.externalChatId ?? '');
  if (!link) throw new ToolError(`Unknown session "${key}"`);
  if (link.blocked) throw new ToolError('The user blocked this chat; use the web session instead');
  return key;
}

/** Other modules add fields (connected apps) to get_profile. */
type ProfileExtender = (userId: string) => Promise<Record<string, unknown>>;
const profileExtenders: ProfileExtender[] = [];
export function extendProfile(fn: ProfileExtender): void {
  profileExtenders.push(fn);
}

defineTool({
  name: 'send_message',
  description:
    'Send a message to your user. Use this for your final answer and for progress updates. ' +
    'session_key is the chat the request came from (e.g. "telegram:12345" or "web"); omit it to use the last chat the user wrote from.',
  input: {
    text: z.string().min(1).max(8000),
    session_key: z.string().optional(),
  },
  async run({ userId }, args) {
    const sessionKey = await resolveSession(userId, args.session_key);
    const msg = await queueOutbound({ userId, sessionKey, text: args.text });
    return { message_id: msg.id, status: 'queued' };
  },
  summarize: (args) => `Sent a message (${args.text.length} chars)`,
});

defineTool({
  name: 'get_profile',
  description: "Your user's name, timezone, plan and connected apps.",
  input: {},
  async run({ userId }) {
    const user = await getActiveUser(userId);
    if (!user) throw new ToolError('User not found');
    let extra: Record<string, unknown> = { connected_apps: [] };
    for (const fn of profileExtenders) extra = { ...extra, ...(await fn(userId)) };
    return { name: user.name, timezone: user.timezone, plan: user.plan, ...extra };
  },
});
