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
import { currentRunLimits, RunLimitsUnknown } from '../../automations/run-limits.ts';
import { finishStep, nowText } from '../../automations/runs.ts';
import type { StepInput } from '../../automations/steps.ts';
import { automationRunInProgress } from '../../orchestrator/turn.ts';
import { defineTool, ToolError } from '../registry.ts';
import { resolveSession } from './core.ts';

/**
 * Every run answers in the user's Automations chat (and, made in a Telegram chat, a copy goes
 * there). The answer says so, for the agent to tell the user.
 */
async function create(userId: string, input: Parameters<typeof createAutomation>[0]) {
  try {
    const a = await createAutomation(input);
    const copyTo = copyChannel(await copyRules(userId), a);
    return { ...toApiAutomation(a, copyTo), where_results_go: whereRunsAnswer(a, copyTo) };
  } catch (err) {
    if (err instanceof AutomationError) throw new ToolError(err.message);
    throw err;
  }
}

/**
 * During an automation's run (a timer or an app event) the agent read things the user did not
 * write: an email, a page, a pull request. A reminder is saved without the user seeing it first,
 * so none is set then; a draft (propose_automation) still is, because the user sees and saves it.
 */
async function refuseDuringAutomationRun(userId: string): Promise<void> {
  const during = await automationRunInProgress(userId);
  if (during === 'unknown')
    throw new ToolError('Could not check this turn just now. Try again in a moment.');
  if (during)
    throw new ToolError(
      "A reminder can't be set while an automation runs: what the run read could have asked for it. " +
        'If the user wants one, propose it with propose_automation; they save it themselves.',
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
    await refuseDuringAutomationRun(userId);
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

/** A step as propose_automation takes it (steps.ts makes it whole and checks it). */
const stepInput = z.object({
  id: z.string().max(24).optional(),
  type: z.enum(['action', 'tex']),
  title: z.string().max(80).optional(),
  app: z.string().max(60).optional(),
  action: z.string().max(120).optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  instruction: z.string().max(2000).optional(),
  read_apps: z.array(z.string().max(60)).max(5).optional(),
  ask_first: z.boolean().optional(),
  only_if: z
    .object({
      kind: z.enum(['always', 'found', 'mentions', 'tex']),
      words: z.array(z.string().max(60)).max(10).optional(),
      question: z.string().max(300).optional(),
    })
    .optional(),
  show_result: z.boolean().optional(),
});

const stepFromTool = (s: z.infer<typeof stepInput>): StepInput => ({
  type: s.type,
  ...(s.id ? { id: s.id } : {}),
  ...(s.title ? { title: s.title } : {}),
  ...(s.app ? { app: s.app } : {}),
  ...(s.action ? { action: s.action } : {}),
  ...(s.inputs ? { inputs: s.inputs } : {}),
  ...(s.instruction ? { instruction: s.instruction } : {}),
  ...(s.read_apps ? { readApps: s.read_apps } : {}),
  ...(s.ask_first !== undefined ? { askFirst: s.ask_first } : {}),
  ...(s.only_if ? { onlyIf: s.only_if } : {}),
  ...(s.show_result !== undefined ? { showResult: s.show_result } : {}),
});

defineTool({
  name: 'propose_automation',
  description:
    'Propose an automation for your user to save. It runs an instruction once (run_at), on a schedule (cron, 5 fields, in their timezone; at most every 15 minutes) ' +
    'or on an app event (trigger: { app, event, config } where event is a Composio trigger slug like GMAIL_NEW_GMAIL_MESSAGE and config its settings). ' +
    'Give exactly one of run_at, cron, trigger, and the apps it will use (app slugs, e.g. ["github"]): its runs may use only these and the trigger\'s app. ' +
    'ask_first "changes" when the user wants to be asked before anything that changes something (default "risky": before sending, deleting or paying). ' +
    'For a job of several parts, give up to 6 steps instead of one instruction (instruction is then its purpose in one line, and apps come from the steps): ' +
    'each step is { type "action", app, action (a Composio action slug), inputs (the inputs the user fixes, by the names describe_app_action gives) } or ' +
    '{ type "tex", instruction, read_apps (apps it may only read) }, with only_if (kind "found": the step before found something; "mentions" with words; ' +
    '"tex" with a question you will decide during the run) and show_result (its result goes into the run\'s answer). A step that sends, deletes or pays always asks first. ' +
    'A tex step never changes anything: a change is an action step. A problem names its step. ' +
    'The platform checks it as a save would and shows the user a draft with a Save button; nothing runs until they save it, and you cannot save it. ' +
    'To change a draft you proposed, give replaces_draft_id; to change a saved automation, give change_of with its id. ' +
    'For a plain one-time reminder use schedule_reminder instead.',
  input: {
    steps: z.array(stepInput).max(6).optional(),
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
        ...(args.steps?.length ? { steps: args.steps.map(stepFromTool) } : {}),
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
  name: 'finish_step',
  description:
    "Only during the run of an automation with steps. Saves the current step's result when it is a Tex step (result: in words, " +
    'at most 4,000 characters; found false when you found nothing), then the platform moves to the next step. When the current step ' +
    'runs only if you decide (a "Tex decides" condition), call it first with condition_met true or false and why in one line: a no ends ' +
    'the run there. An app step is not finished here: run its action with run_app_action. The answer ends with what comes next (next): follow it.',
  input: {
    step_id: z.string().min(1).max(24),
    result: z.string().max(8000).optional(),
    found: z.boolean().optional(),
    condition_met: z.boolean().optional(),
    why: z.string().max(500).optional(),
  },
  async run({ userId }, args) {
    let limits;
    try {
      limits = await currentRunLimits(userId);
    } catch (err) {
      if (err instanceof RunLimitsUnknown) throw new ToolError(err.message);
      throw err;
    }
    if (!limits?.runId)
      throw new ToolError(
        'finish_step is only for the run of an automation with steps, and this turn is not one. Nothing was saved.',
      );
    const done = await finishStep(userId, limits.runId, {
      stepId: args.step_id,
      ...(args.result !== undefined ? { result: args.result } : {}),
      ...(args.found !== undefined ? { found: args.found } : {}),
      ...(args.condition_met !== undefined ? { conditionMet: args.condition_met } : {}),
      ...(args.why !== undefined ? { why: args.why } : {}),
    });
    if (!done.ok) throw new ToolError(done.refusal, { reason: "it didn't fit the current step" });
    return { saved: true, run_state: done.run.state, next: nowText(done.run) };
  },
  summarize: (args) =>
    args.condition_met !== undefined
      ? `Decided step ${args.step_id}'s condition: ${args.condition_met ? 'yes' : 'no'}`
      : `Finished step ${args.step_id}`,
  // The result can quote an email: the log keeps only which step.
  auditArgs: (args) => ({ step_id: args.step_id }),
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
