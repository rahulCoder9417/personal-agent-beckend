import { z } from 'zod';
import { isChannelEnabled } from '../../../shared/config.ts';
import { recordCrewJobReport } from '../../automations/crew-jobs.ts';
import { getRun, nowText } from '../../automations/runs.ts';
import { getActiveUserCached } from '../../auth/users.ts';
import { ownsChat } from '../../auth/links.ts';
import { getConversation } from '../../channels/conversations.ts';
import { lastInboundSession } from '../../channels/messages.ts';
import { queueOutbound } from '../../channels/outbound.ts';
import { parseSessionKey } from '../../channels/types.ts';
import { turnAutomationRun, turnMessageFields } from '../../orchestrator/turn.ts';
import { defineTool, ToolError } from '../registry.ts';

/**
 * During the turn of a run with steps that has stopped (a false "only if", Tex deciding no) or was
 * superseded: the platform tells the user in one line, so a message from Tex would say it twice.
 * The refusal for the agent, or null. A note that can't be read lets the message through: a
 * message must never be lost for want of this check.
 */
async function endedRunRefusal(userId: string): Promise<string | null> {
  const turn = await turnAutomationRun(userId);
  if (!turn || turn === 'unknown' || !turn.runId) return null;
  const run = await getRun(userId, turn.runId).catch(() => undefined);
  if (!run || (run.state !== 'stopped' && run.state !== 'superseded')) return null;
  return `Nothing was sent. ${nowText(run)}`;
}

/** Where the agent's messages may go: only this user's own sessions. */
export async function resolveSession(userId: string, sessionKey?: string): Promise<string> {
  const key = sessionKey || (await lastInboundSession(userId)) || 'web';
  const parsed = parseSessionKey(key);
  if (!parsed) throw new ToolError(`Unknown session "${key}"`);
  if (parsed.channel === 'web') return 'web';
  if (!isChannelEnabled(parsed.channel))
    throw new ToolError(`${parsed.channel} is switched off; use the web session instead`);
  const link = await ownsChat(userId, parsed.channel, parsed.externalChatId ?? '');
  if (!link) throw new ToolError(`Unknown session "${key}"`);
  if (link.blocked) throw new ToolError('The user blocked this chat; use the web session instead');
  return key;
}

/**
 * What a message to `sessionKey` is saved with during a turn in that chat (`turnMessageFields`),
 * and, with `read`, the row of the turn's conversation (null: it is gone), so saving the message
 * does not read it again. Without `read`, `known` is left out and it is read there.
 */
async function turnFields(userId: string, sessionKey: string, read = true) {
  const fields = await turnMessageFields(userId, sessionKey);
  const known =
    read && fields.conversationId
      ? ((await getConversation(userId, fields.conversationId)) ?? null)
      : undefined;
  return { fields, known };
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
    // Two reads at once, one round trip instead of two (the Bridge always names the chat): may
    // the agent write to this chat, and the conversation of the turn in progress there. Both only
    // read: nothing is saved before the chat is known to be the user's own.
    const asked = args.session_key || undefined;
    const [sessionKey, early, ended] = await Promise.all([
      resolveSession(userId, asked),
      asked ? turnFields(userId, asked) : undefined,
      endedRunRefusal(userId),
    ]);
    if (ended) throw new ToolError(ended, { reason: 'the run has ended' });
    // Sent during a turn in this chat: it belongs to the turn's conversation, with the turn's id.
    const turn =
      early && sessionKey === asked ? early : await turnFields(userId, sessionKey, false);
    const [msg] = await Promise.all([
      queueOutbound({
        userId,
        sessionKey,
        text: args.text,
        ...turn.fields,
        ...(turn.known !== undefined ? { knownConversation: turn.known } : {}),
      }),
      // During a crew job's turn this is the lead's final answer: the job's report. Saved beside
      // the message, as nothing in one depends on the other.
      recordCrewJobReport(userId, sessionKey, args.text),
    ]);
    return { message_id: msg.id, status: 'queued' };
  },
  summarize: (args) => `Sent a message (${args.text.length} chars)`,
});

defineTool({
  name: 'get_profile',
  description: "Your user's name, timezone, plan and connected apps.",
  input: {},
  async run({ userId }) {
    // The user from the short-lived copy, and the other parts (connected apps) at the same time.
    const [user, ...parts] = await Promise.all([
      getActiveUserCached(userId),
      ...profileExtenders.map((fn) => fn(userId)),
    ]);
    if (!user) throw new ToolError('User not found');
    const extra = Object.assign({ connected_apps: [] }, ...parts) as Record<string, unknown>;
    return { name: user.name, timezone: user.timezone, plan: user.plan, ...extra };
  },
});
