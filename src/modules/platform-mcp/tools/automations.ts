import { z } from 'zod';
import {
  AutomationError,
  createAutomation,
  deleteAutomation,
  listAutomations,
  toApiAutomation,
  copyChannel,
  copyRules,
  whereRunsAnswer,
} from '../../automations/automations.ts';
import {
  draftLink,
  DraftError,
  getDraft,
  proposeDraft,
  toApiDraft,
} from '../../automations/drafts.ts';
import { turnWithOthersText, type OthersTextTurn } from '../../orchestrator/turn.ts';
import { defineTool, ToolError } from '../registry.ts';
import { resolveSession } from './core.ts';

/**
 * Every run answers in the user's Automations chat (and, made in a Telegram chat, a copy goes
 * there). The answer says so, for the agent to tell the user.
 */
async function create(userId: string, input: Parameters<typeof createAutomation>[0]) {
  try {
    const a = await createAutomation(input);
    return { ...toApiAutomation(a), where_results_go: whereRunsAnswer(a) };
  } catch (err) {
    if (err instanceof AutomationError) throw new ToolError(err.message);
    throw err;
  }
}

/** Why no reminder is set in such a turn, in words for the agent (turnWithOthersText). */
const NO_REMINDER: Record<OthersTextTurn, string> = {
  automation_run:
    "A reminder can't be set while an automation runs: what the run read could have asked for it.",
  crew_job:
    "A reminder can't be set during a crew job: the code and pull requests it reads could have asked for it.",
  automations_chat:
    "A reminder can't be set in the Automations chat: the runs' results there hold text the user didn't write, which could have asked for it.",
  approval_answer:
    "A reminder can't be set while you carry on after an approval: what you read before asking could have asked for it.",
};

/**
 * In some turns the agent has things in mind that the user did not write: an email, a page, a
 * pull request (an automation's run, a crew job, the Automations chat, the turn after an approval).
 * A reminder is saved without the user seeing it first, so none is set then; a draft
 * (propose_automation) still is, because the user sees and saves it. Only the user's own message
 * in their own chat sets one.
 */
async function refuseWithOthersText(userId: string): Promise<void> {
  const why = await turnWithOthersText(userId);
  if (why === 'unknown')
    throw new ToolError('Could not check this turn just now. Try again in a moment.');
  if (why)
    throw new ToolError(
      `${NO_REMINDER[why]} If the user wants one, propose it with propose_automation; they save it themselves.`,
    );
}

defineTool({
  name: 'schedule_reminder',
  description:
    'Remind your user at a time (ISO 8601 with offset, e.g. 2026-10-02T10:00:00+05:30). The reminder is delivered to them by you at that time. ' +
    'Only for a plain reminder; anything else that runs later is proposed with propose_automation.',
  input: {
    text: z.string().min(1).max(2000),
    run_at: z.string().datetime({ offset: true }),
    session_key: z.string().optional(),
  },
  async run({ userId }, args) {
    await refuseWithOthersText(userId);
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
  name: 'propose_automation',
  description:
    'Propose an automation for your user to save. It runs an instruction once (run_at), on a schedule (cron, 5 fields, in their timezone; at most every 15 minutes) ' +
    'or on an app event (trigger: { app, event, config } where event is a Composio trigger slug like GMAIL_NEW_GMAIL_MESSAGE and config its settings). ' +
    'Give exactly one of run_at, cron, trigger, and the apps it will use (app slugs, e.g. ["github"]): its runs may use only these and the trigger\'s app. ' +
    'ask_first "changes" when the user wants to be asked before anything that changes something (default "risky": before sending, deleting or paying). ' +
    'The platform checks it as a save would and shows the user a draft with a Save button; nothing runs until they save it, and you cannot save it. ' +
    'To change a draft you proposed, give replaces_draft_id; to change a saved automation, give change_of with its id. ' +
    'For a plain one-time reminder use schedule_reminder instead.',
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
    apps: z.array(z.string().min(1).max(60)).max(10).optional(),
    ask_first: z.enum(['risky', 'changes']).optional(),
    change_of: z.string().optional(),
    replaces_draft_id: z.string().optional(),
    session_key: z.string().optional(),
  },
  async run({ userId }, args) {
    try {
      const { draft, replaced } = await proposeDraft({
        userId,
        sessionKey: await resolveSession(userId, args.session_key),
        title: args.title,
        instruction: args.instruction,
        ...(args.run_at ? { runAt: new Date(args.run_at) } : {}),
        ...(args.cron ? { cron: args.cron } : {}),
        ...(args.timezone ? { timezone: args.timezone } : {}),
        ...(args.trigger ? { trigger: args.trigger } : {}),
        ...(args.apps ? { apps: args.apps } : {}),
        ...(args.ask_first ? { askFirst: args.ask_first } : {}),
        ...(args.change_of ? { changeOf: args.change_of } : {}),
        ...(args.replaces_draft_id ? { replaces: args.replaces_draft_id } : {}),
      });
      return {
        draft_id: draft.id,
        status: 'proposed',
        ...(replaced ? { replaced_draft_id: replaced.id } : {}),
        review_link: draftLink(draft),
        note:
          'The user now sees this draft with a Save button. Nothing runs until they save it. ' +
          'End your turn now: do not repeat the draft and do not say it is set up.',
      };
    } catch (err) {
      if (err instanceof DraftError) throw new ToolError(err.message);
      throw err;
    }
  },
  summarize: (args) => `Proposed the automation "${args.title}"`,
  auditDetails: (_args, result) => ({ draftId: (result as { draft_id: string }).draft_id }),
});

defineTool({
  name: 'get_automation_draft',
  description:
    "One of your user's automation drafts, by id: its parts and its state (open, saved, discarded, replaced or expired). " +
    'When the user asks you to change a draft (the web app sends "Change this draft (drf_…): …" with their own version from the canvas, madeBy user), ' +
    'read it here, then propose the change with propose_automation and replaces_draft_id set to its id; a draft of a change keeps its change_of.',
  input: { draft_id: z.string() },
  async run({ userId }, args) {
    const d = await getDraft(userId, args.draft_id);
    if (!d) throw new ToolError('Draft not found');
    return { ...toApiDraft(d), review_link: draftLink(d) };
  },
});

defineTool({
  name: 'list_automations',
  description: "Your user's automations and reminders.",
  input: {},
  async run({ userId }) {
    const [rows, rule] = await Promise.all([listAutomations(userId), copyRules(userId)]);
    return rows.map((a) => toApiAutomation(a, copyChannel(rule, a)));
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
