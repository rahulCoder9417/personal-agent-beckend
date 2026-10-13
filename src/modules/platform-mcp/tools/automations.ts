import { z } from 'zod';
import {
  AutomationError,
  createAutomation,
  deleteAutomation,
  listAutomations,
  toApiAutomation,
} from '../../automations/automations.ts';
import { turnConversationId } from '../../orchestrator/turn.ts';
import { defineTool, ToolError } from '../registry.ts';
import { resolveSession } from './core.ts';

/**
 * Made during a turn in the same chat: the automation remembers the turn's conversation, and its
 * runs reply there (web chat).
 */
async function create(userId: string, input: Parameters<typeof createAutomation>[0]) {
  try {
    const conversationId = await turnConversationId(userId, input.sessionKey);
    return toApiAutomation(await createAutomation({ ...input, conversationId }));
  } catch (err) {
    if (err instanceof AutomationError) throw new ToolError(err.message);
    throw err;
  }
}

defineTool({
  name: 'schedule_reminder',
  description:
    'Remind your user at a time (ISO 8601 with offset, e.g. 2026-10-02T10:00:00+05:30). The reminder is delivered to them by you at that time.',
  input: {
    text: z.string().min(1).max(2000),
    run_at: z.string().datetime({ offset: true }),
    session_key: z.string().optional(),
  },
  async run({ userId }, args) {
    return create(userId, {
      userId,
      title: `Reminder: ${args.text.slice(0, 60)}`,
      instruction: `Remind the user: ${args.text}`,
      runAt: new Date(args.run_at),
      sessionKey: await resolveSession(userId, args.session_key),
    });
  },
  summarize: (args) => `Scheduled a reminder for ${args.run_at}`,
});

defineTool({
  name: 'create_automation',
  description:
    'Create an automation that runs an instruction for your user: once (run_at), repeating (cron, 5 fields, in their timezone; at most every 15 minutes) ' +
    'or on an app event (trigger: { app, event } where event is a Composio trigger slug like GMAIL_NEW_GMAIL_MESSAGE). Give exactly one of run_at, cron, trigger.',
  input: {
    title: z.string().min(1).max(120),
    instruction: z.string().min(1).max(4000),
    run_at: z.string().datetime({ offset: true }).optional(),
    cron: z.string().optional(),
    timezone: z.string().optional(),
    trigger: z
      .object({
        app: z.string(),
        event: z.string(),
        config: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
    session_key: z.string().optional(),
  },
  async run({ userId }, args) {
    return create(userId, {
      userId,
      title: args.title,
      instruction: args.instruction,
      sessionKey: await resolveSession(userId, args.session_key),
      ...(args.run_at ? { runAt: new Date(args.run_at) } : {}),
      ...(args.cron ? { cron: args.cron } : {}),
      ...(args.timezone ? { timezone: args.timezone } : {}),
      ...(args.trigger ? { trigger: args.trigger } : {}),
    });
  },
  summarize: (args) => `Created automation "${args.title}"`,
});

defineTool({
  name: 'list_automations',
  description: "Your user's automations and reminders.",
  input: {},
  async run({ userId }) {
    return (await listAutomations(userId)).map(toApiAutomation);
  },
});

defineTool({
  name: 'cancel_automation',
  description: "Cancel (delete) one of your user's automations or reminders by id.",
  input: { automation_id: z.string() },
  async run({ userId }, args) {
    if (!(await deleteAutomation(userId, args.automation_id)))
      throw new ToolError('Automation not found');
    return { cancelled: true };
  },
  summarize: (args) => `Cancelled automation ${args.automation_id}`,
});
