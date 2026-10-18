import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { newId } from '../../../shared/ids.ts';
import { logger } from '../../../shared/logger.ts';
import { getActiveUserCached, type User } from '../../auth/users.ts';
import {
  appActionsFor,
  agentAppStates,
  currentConnections,
  describeAppAction,
} from '../../integrations/agent-apps.ts';
import { withAccountLabels } from '../../integrations/account-identity.ts';
import { inlineAppFiles } from '../../integrations/app-files.ts';
import { shapeResult, withResultDefaults } from '../../integrations/app-results.ts';
import {
  activeConnectionsOf,
  appActionChangesSomething,
  appActionNeedsApproval,
  connectionTroubleNote,
  listConnections,
  newestActiveConnection,
  refreshPendingConnections,
  type Connection,
} from '../../integrations/apps.ts';
import {
  claimCrewJobComment,
  claimCrewJobGithubAction,
  releaseCrewJobComment,
  releaseCrewJobGithubAction,
} from '../../automations/crew-jobs.ts';
import {
  appRefusal,
  currentRunLimits,
  RunLimitsUnknown,
  type RunLimits,
} from '../../automations/run-limits.ts';
import { prCommentAllowed } from '../../automations/pr-review.ts';
import {
  failStep,
  gateAppAction,
  gateApprovalRequest,
  markWaiting,
  nowText,
  stepActionDone,
  stepActionFailed,
  type StepGate,
} from '../../automations/runs.ts';
import { appOfAction, checkActionInputs } from '../../integrations/action-inputs.ts';
import {
  actionWords,
  appAllowedOnPlan,
  appForToolkit,
  isSafeChange,
  prCommentTarget,
} from '../../integrations/catalog.ts';
import { audit } from '../../admin/audit.ts';
import { composio } from '../../integrations/composio.ts';
import { approvalFacts } from '../../orchestrator/approval-facts.ts';
import { approvalAskText, channelOfSession } from '../../orchestrator/approval-text.ts';
import {
  autoApprovedText,
  claimAutoApproval,
  consumeApproval,
  finishApprovedRun,
  getApproval,
  publishApproval,
  releaseApproval,
  replaceApproval,
  requestApproval,
  START_CREW_JOB_ACTION,
  waitForApprovedRun,
  type Approval,
  type ApprovedActionResult,
} from '../../orchestrator/approvals.ts';
import type { ApprovedRun } from '../../orchestrator/schema.ts';
import { matchingSkipRule, recipientsOf, type SkipRule } from '../../orchestrator/skip-rules.ts';
import { turnInProgress, userHasCredits } from '../../orchestrator/turn.ts';
import { actionInputsOf, misplacedInputsNote } from '../misplaced-inputs.ts';
import { defineTool, ToolError, type FailureEntry } from '../registry.ts';
import { extendProfile, resolveSession } from './core.ts';

/**
 * Charges one successful app action that changed something (HLD 7.2: 1 credit) and returns the
 * credits charged. `ref` makes the charge idempotent. Billing plugs in through wiring.ts.
 */
export type AppActionCharger = (
  userId: string,
  input: { action: string; ref: string },
) => Promise<number>;
let chargeAppAction: AppActionCharger = async () => 0;
export function setAppActionCharger(fn: AppActionCharger): void {
  chargeAppAction = fn;
}

/**
 * The charge of an action that has already happened: a charge that fails is logged and never
 * turned into an error (the agent would retry and act twice). `ref` keys it (an approval's id).
 */
async function chargeRan(userId: string, action: string, ref: string): Promise<number> {
  try {
    return await chargeAppAction(userId, { action, ref });
  } catch (err) {
    logger().error({ userId, action, err: String(err) }, 'app action not charged');
    return 0;
  }
}

/** Toolkit of a Composio action slug, e.g. GMAIL_SEND_EMAIL → gmail. */
function toolkitOf(action: string, known: string[]): string | undefined {
  const lower = action.toLowerCase();
  return known.filter((t) => lower.startsWith(`${t}_`)).sort((a, b) => b.length - a.length)[0];
}

/** The toolkits of the user's active connections whose app is on their plan. */
function allowedToolkits(user: User | undefined, rows: Connection[]): string[] {
  if (!user) return [];
  return activeConnectionsOf(rows)
    .filter((c) => appAllowedOnPlan(c.catalog, user.plan))
    .map((c) => c.catalog.toolkit);
}

/**
 * The user (from the short-lived copy) and their connections, read at the same time: one round
 * trip to the database instead of three or four one after another (each about 0.26 s on Neon).
 */
async function userAndConnections(userId: string) {
  return Promise.all([getActiveUserCached(userId), listConnections(userId)]);
}

/**
 * The limits of the automation whose run this is (its apps, "ask me first"), or null outside a
 * run. A note that can't be read refuses the tool: a run never acts without its limits.
 */
async function runLimits(userId: string): Promise<RunLimits | null> {
  try {
    return await currentRunLimits(userId);
  } catch (err) {
    if (err instanceof RunLimitsUnknown) throw new ToolError(err.message);
    throw err;
  }
}

// The profile asks Composio about connections still pending first, so an app the user just
// connected shows at once; one that is not ready is named with what to tell the user. Each
// connected app says who it is connected as (`account`), asked of the app once when not known yet.
extendProfile(async (userId) => {
  const [user, rows] = await userAndConnections(userId);
  if (!user) return { connected_apps: [], apps_not_ready: [] };
  const current = await withAccountLabels(await currentConnections(userId, rows));
  return {
    connected_apps: activeConnectionsOf(current).map((c) => ({
      app: c.catalog.slug,
      name: c.catalog.name,
      account: c.accountLabel,
    })),
    apps_not_ready: agentAppStates(current, user.plan)
      .filter((s) => s.status !== 'connected' && s.status !== 'not_on_plan')
      .map((s) => ({ app: s.app.slug, name: s.app.name, status: s.status, note: s.note })),
  };
});

defineTool({
  name: 'list_app_actions',
  description:
    "Your user's apps and the actions you can run in them. `apps` gives each app's status: connected, or not " +
    "ready (still connecting, needs connecting again, not on the user's plan) with a note saying what to tell " +
    'the user. `actions` lists the actions of the connected apps by name with one line each, at most 100, shared ' +
    'fairly between the apps. To find the action you need, filter by app (e.g. "github") and by search words (e.g. ' +
    '"pull request", "list repositories"): every action of the app is searched, the best matches first. If a ' +
    'search finds nothing, try other words before you decide the app cannot do it. ' +
    'It has no inputs: call describe_app_action for the inputs of the action you will use. ' +
    'Every action that changes something is marked requires_approval, except a few harmless ones (a draft, a label, ' +
    'marking an email read, a new private document, folder or task). Those marked need request_approval first, then ' +
    'run_app_action with the approval_id (exceptions: a new review or comment on a pull request, in a repo where your ' +
    "user turned on pull-request review, and what a crew job's brief asks for: its one review on the pull request, " +
    "Byte's pull request from the job's own branch, and the report as a new issue). " +
    'costs_credits is what a successful run costs your user: 1 for an action that changes something, 0 for reading.',
  input: { app: z.string().optional(), search: z.string().optional() },
  async run({ userId }, args) {
    const [user, rows] = await userAndConnections(userId);
    if (!user) throw new ToolError('User not found');
    return appActionsFor(userId, user.plan, { app: args.app, search: args.search }, rows);
  },
});

defineTool({
  name: 'describe_app_action',
  description:
    "One app action's inputs (input_schema: each input's name, type and meaning, and which are required), with " +
    'what it does, whether it needs request_approval and what it costs. Call it before run_app_action or ' +
    "request_approval when you don't know the action's inputs; the names must be exactly these.",
  input: { action: z.string().min(3) },
  async run(_ctx, args) {
    try {
      return await describeAppAction(args.action);
    } catch (err) {
      throw new ToolError(err instanceof Error ? err.message : String(err));
    }
  },
  summarize: (args) => `Looked up ${args.action}`,
});

/** Why an app's actions can't run, in plain words for the activity log (agent-apps.ts states). */
const APP_STATE_REASON: Record<string, string> = {
  not_on_plan: "the app isn't on your plan",
  connecting: 'the app was still connecting',
  needs_reconnecting: 'the app needs to be connected again',
  not_finished: "the app's connection was never finished",
};

/**
 * The connection an action runs through: the user's newest active connection of the action's app,
 * when that app is on their plan. An app not found may have finished connecting a moment ago, so
 * Composio is asked about the connections still pending first. ToolError says why it can't run.
 */
async function connectionFor(
  userId: string,
  user: User | undefined,
  read: Connection[],
  action: string,
): Promise<{ conn: Connection; toolkit: string }> {
  let rows = read;
  let toolkit = toolkitOf(action, allowedToolkits(user, rows));
  if (!toolkit && (await refreshPendingConnections(userId, rows))) {
    // It may have finished connecting a moment ago: Composio was asked, so look again.
    rows = await listConnections(userId);
    toolkit = toolkitOf(action, allowedToolkits(user, rows));
  }
  if (!toolkit) {
    // Say why, when the app is one the user has a connection for (still connecting, expired…).
    const app = appOfAction(action);
    const state =
      app && user ? agentAppStates(rows, user.plan).find((s) => s.app === app) : undefined;
    throw new ToolError(state?.note ?? 'That app is not connected or not available on your plan', {
      reason: (state && APP_STATE_REASON[state.status]) ?? "the app isn't connected",
    });
  }
  const conn = newestActiveConnection(rows, toolkit);
  if (!conn)
    throw new ToolError('That app is not connected', { reason: "the app isn't connected" });
  return { conn, toolkit };
}

/** What a user out of credits is told (the agent passes it on). */
const OUT_OF_CREDITS =
  "Your user is out of credits, so actions that change something can't run (reading still works). " +
  'Tell them to open the Textcrew web app to top up or upgrade. Do not send a link.';

/**
 * The activity-log entry of an app action or approval request that failed or was refused: the
 * action, its app and the reason in plain words, never the inputs. It made the approvals whose
 * arguments did not fit their action visible (they were refused, and the log showed nothing).
 */
function appFailure(logAction: string, verb: string, action: string, reason: string): FailureEntry {
  const app = appOfAction(action);
  return {
    action: logAction,
    summary: `${verb} ${action}${app ? ` in ${app.name}` : ''}: ${reason}`,
    details: { action, app: app?.slug ?? null, reason },
  };
}

/** The activity log's mark of inputs that were sent beside `action` and used. */
const movedDetails = (moved: string[]) => (moved.length > 0 ? { inputs_moved: moved } : {});

/**
 * An action's inputs, as the agent is shown them. Inputs sent beside `action` instead are used too
 * (misplaced-inputs.ts), so the tools keep the names they do not know (`keepOtherInputs`).
 */
const ACTION_ARGUMENTS = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    "The action's inputs, as one object with the names from describe_app_action, e.g. " +
      '{"owner": "octocat", "repo": "hello-world"}. Every input goes here, not beside action.',
  );
const APPROVAL_INPUTS = ['summary', 'action', 'arguments', 'replaces_approval_id', 'session_key'];
const RUN_INPUTS = ['action', 'arguments', 'approval_id'];

/** request_approval's action inputs: only an app action's (a plain question has none). */
const approvalInputs = (args: Record<string, unknown>) =>
  args.action
    ? actionInputsOf(args, APPROVAL_INPUTS)
    : actionInputsOf({ arguments: args.arguments }, APPROVAL_INPUTS);

defineTool({
  name: 'request_approval',
  description:
    'Ask your user to approve an action before you run it: every app action marked requires_approval (anything that changes ' +
    'something, but a few harmless ones), or anything else you want their OK for. ' +
    'The user is shown your summary as "I\'d like to <summary>." with Approve and Deny buttons, so write the summary as what you will do, ' +
    'starting with the verb, with what they need to decide. Example: Send an email to priya@acme.com with subject "Notes". ' +
    'Under it they also see what will really run, written by Textcrew from the arguments (the app and action, who it goes to, ' +
    'which repository, calendar or file, the subject or first words), so your summary must say the same as the arguments. ' +
    "Pass the exact action and its arguments, named as in the action's input_schema from describe_app_action. An app action's " +
    'arguments are checked against it: a name the action does not have, a missing required input or a wrong kind of value is ' +
    'refused before the user sees anything, with the right names. After the yes, run_app_action with the approval_id runs exactly ' +
    'these arguments. If an approved request could not run and its arguments must change, ask again with replaces_approval_id ' +
    'set to its id: the earlier request is marked replaced. ' +
    'Returns immediately with status "pending". Then END YOUR TURN: the user already sees what you asked and that you wait for ' +
    "their answer, so don't repeat it or say you're waiting. Their answer arrives later as a new message. " +
    'Exception: if your user made a rule to skip approval for this action, nobody is asked. It runs at once instead and the answer ' +
    'has status "auto_approved" with its result (like run_app_action): then do not end with NO_REPLY, tell the user what was done.',
  input: {
    summary: z.string().min(3).max(500),
    action: z.string().optional(),
    arguments: ACTION_ARGUMENTS,
    replaces_approval_id: z.string().optional(),
    session_key: z.string().optional(),
  },
  keepOtherInputs: true,
  async run({ userId }, args) {
    const sessionKey = await resolveSession(userId, args.session_key);
    const action = args.action ?? null;
    let app: string | null = null;
    // The inputs in `arguments`, or the ones the agent put beside `action` instead.
    const found = approvalInputs(args);
    const inputsNote = misplacedInputsNote(found);
    let approved = found.inputs ?? null;
    // During an automation's run, its limits. A run with steps: only the current step's action can
    // be asked for (no plain question, no crew job), its fixed inputs put in, and the approval is
    // bound to that step of that run.
    const limits = await runLimits(userId);
    let step: { runId: string; stepId: string } | null = null;
    if (limits?.runId) {
      const gate = await gateApprovalRequest(userId, limits.runId, {
        action,
        args: found.inputs ?? {},
      });
      if (!gate.ok)
        throw new ToolError(gate.refusal, {
          reason: "it didn't fit the automation's current step, so you weren't asked",
        });
      step = { runId: limits.runId, stepId: gate.step.id };
      approved = gate.args;
    }
    // An app action: its arguments must fit the action, so the user approves something that can
    // run exactly as shown. Its approval always holds what will run (no arguments means none).
    if (action && action !== START_CREW_JOB_ACTION) {
      const check = await checkActionInputs(action, approved ?? {});
      if (check && !check.ok)
        throw new ToolError(check.problem, {
          reason: "its details didn't fit the action, so you weren't asked",
        });
      if (check) {
        // During an automation's run, only its own apps: no approval for another one either.
        const refusal = limits && appRefusal(limits, check.app.toolkit, check.app.name);
        if (refusal) throw new ToolError(refusal);
        app = check.app.slug;
        approved = approved ?? {};
      } else if (step)
        throw new ToolError("During a run with steps, ask only for the current step's action.");
    }
    const earlier = args.replaces_approval_id
      ? await getApproval(userId, args.replaces_approval_id)
      : undefined;
    if (args.replaces_approval_id && (!earlier || earlier.action !== action))
      throw new ToolError(
        'replaces_approval_id must be the id of an earlier request of yours for the same action',
        { reason: 'it named an earlier request that is not for the same action' },
      );
    // The user's skip rule covers exactly this request: nobody is asked. It runs now, the way
    // run_app_action runs an approved one, and is kept in their Approvals as auto-approved. An
    // automation set to ask before any change stays strict.
    if (
      app &&
      action &&
      limits?.askFirst !== 'changes' &&
      (await appActionNeedsApproval(action, approved ?? {})) &&
      (await matchingSkipRule(userId, action, approved ?? {}))
    ) {
      const ran = await runAppAction(
        userId,
        { action, arguments: approved ?? {} },
        { summary: args.summary },
      );
      const autoId = (ran as { approval_id?: string }).approval_id;
      const auto = autoId ? await getApproval(userId, autoId) : undefined;
      // The earlier request it corrects is set aside, as for a new question.
      if (earlier && auto) await replaceApproval(userId, earlier.id, auto);
      return {
        // A standing permission of another kind (pull-request review) may have covered it instead.
        status: (ran as { auto_approved?: boolean }).auto_approved ? 'auto_approved' : 'done',
        ...ran,
        ...(inputsNote ? { inputs_note: inputsNote } : {}),
      };
    }
    const a = await requestApproval({
      userId,
      sessionKey,
      summary: args.summary,
      app,
      action,
      arguments: approved,
      run: step,
    });
    const replaced = earlier ? await replaceApproval(userId, earlier.id, a) : null;
    // The run waits for the yes on its step, holding no container.
    if (step) await markWaiting(userId, step.runId, a.id);
    return {
      approval_id: a.id,
      status: 'pending',
      expires_at: a.expiresAt.toISOString(),
      shown_to_user: approvalAskText(a.summary, channelOfSession(sessionKey), approvalFacts(a)),
      ...(step ? { step_id: step.stepId } : {}),
      ...(inputsNote ? { inputs_note: inputsNote } : {}),
      ...(replaced
        ? {
            replaced_approval_id: replaced.id,
            next:
              'End your turn now. The user already sees this question with Approve and Deny. The earlier request is ' +
              'marked replaced and can no longer run: tell the user in one short sentence why you ask again (the first ' +
              'request could not run as approved, so nothing was done yet).',
          }
        : {
            next:
              'End your turn now. The user already sees this question with Approve and Deny: write nothing more, ' +
              'unless there is something else they must know.',
          }),
    };
  },
  summarize: (args, result) =>
    (result as { status?: string }).status === 'auto_approved'
      ? autoSummary(args.action ?? '', result)
      : `${args.replaces_approval_id ? 'Asked again for approval' : 'Asked for approval'}: ${args.summary}`,
  // A request a skip rule let run at once was charged like the run it is.
  creditsCharged: (_args, result) =>
    (result as { credits_charged?: number }).credits_charged ?? null,
  // The log keeps the inputs as they were used, and says when they were sent beside `action`.
  auditArgs: (args) => {
    const found = approvalInputs(args);
    const own = Object.entries(args).filter(
      ([k]) => APPROVAL_INPUTS.includes(k) && k !== 'arguments',
    );
    return { ...Object.fromEntries(own), ...(found.inputs ? { arguments: found.inputs } : {}) };
  },
  auditDetails: (args) => movedDetails(approvalInputs(args).moved),
  // Only a request for an action is logged: a plain question has no app to name.
  auditFailure: (args, reason) =>
    args.action
      ? appFailure(
          'approval_request_refused',
          "Couldn't ask for approval to run",
          args.action,
          reason,
        )
      : null,
});

/**
 * The app refused an approved action, so nothing happened. The approval stays usable for one more
 * try (the problem may pass), and the agent is told how to ask again when the inputs must change.
 */
function approvedRunFailed(approvalId: string, error: string | null): string {
  return (
    `The app refused the approved request, so nothing was done: ${error ?? 'unknown error'}. ` +
    'If it looks like a passing problem, you may try once more with the same approval_id. If the arguments ' +
    `must change, call request_approval with the corrected arguments and replaces_approval_id "${approvalId}", ` +
    'end your turn, and tell the user in plain words that the app did not accept the request as approved, ' +
    'nothing was done yet, and they need to approve the corrected one.'
  );
}

defineTool({
  name: 'run_app_action',
  description:
    "Run an action in one of your user's connected apps (from list_app_actions; its inputs from describe_app_action). An action marked " +
    'requires_approval (every one that changes something, but a few harmless ones) needs approval_id from an APPROVED request_approval ' +
    'for the same action: it runs exactly the arguments the user approved, so leave arguments out (any you pass must be the approved ones). ' +
    "During an automation's run only that automation's apps can be used, and one set to ask first before any change needs " +
    'request_approval for every action that changes something. ' +
    'If your user made a rule to skip approval for an action, it runs without approval_id and the answer says ' +
    'auto_approved: tell the user what was done. ' +
    'Posting a new review or comment on a pull request needs no approval in a repo where your user turned on ' +
    'pull-request review (a review must use event "COMMENT"); merging, approving and comments on other repos still do. ' +
    'A successful action that changes something (send, create, update, delete) costs your user 1 credit; reading, listing and searching are free. ' +
    'The answer is kept short: GMAIL_FETCH_EMAILS gives the sender, subject, date and a snippet of each email (pass include_payload true for ' +
    'the bodies, or read one with GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID); any answer over about 8,000 tokens is cut, with a note on how to ask for less.',
  input: {
    action: z.string().min(3),
    arguments: ACTION_ARGUMENTS,
    approval_id: z.string().optional(),
  },
  keepOtherInputs: true,
  run: ({ userId }, args) => runAppAction(userId, args),
  summarize: (args, result) => {
    if ((result as { auto_approved?: boolean }).auto_approved)
      return autoSummary(args.action, result);
    if ((result as { already_done?: boolean }).already_done)
      return `Result of ${args.action} (it ran when the user approved)`;
    const repo = (result as { pr_review?: string }).pr_review;
    if (repo) return `Ran ${args.action} (pull-request review is on for ${repo})`;
    const job = (result as { crew_job?: string }).crew_job;
    if (job) return `Ran ${args.action} (the brief of crew job ${job} asked for it)`;
    return `Ran ${args.action}${args.approval_id ? ' (approved)' : ''}`;
  },
  // The log keeps the inputs as they ran, and says when they were sent beside `action`.
  auditArgs: (args) => {
    const found = actionInputsOf(args, RUN_INPUTS);
    return {
      action: args.action,
      ...(found.inputs ? { arguments: found.inputs } : {}),
      ...(args.approval_id ? { approval_id: args.approval_id } : {}),
    };
  },
  auditDetails: (args, result) => ({
    ...movedDetails(actionInputsOf(args, RUN_INPUTS).moved),
    ...autoDetails(result),
  }),
  creditsCharged: (_args, result) => (result as { credits_charged: number }).credits_charged,
  // Nothing is charged for an action that did not run.
  auditFailure: (args, reason) => ({
    ...appFailure('app_action_failed', "Couldn't run", args.action, reason),
    creditsCharged: 0,
  }),
});

/** The activity log's line for an action a skip rule let run without asking. */
function autoSummary(action: string, result: unknown): string {
  return (result as { already_done?: boolean }).already_done
    ? `Result of ${action} (it ran already in this turn, without asking: your skip rule)`
    : `Ran ${action} without asking (your skip rule)`;
}

/** The activity log's mark of an action a skip rule let run: the approval it is kept as. */
function autoDetails(result: unknown): Record<string, unknown> {
  const r = result as { auto_approved?: boolean; approval_id?: string; skip_rule_id?: string };
  return r.auto_approved
    ? { auto_approved: true, approval_id: r.approval_id, skip_rule_id: r.skip_rule_id }
    : {};
}

/** A run_app_action call's inputs: the action, its arguments, an approval, and anything beside. */
type RunArgs = {
  action: string;
  arguments?: Record<string, unknown>;
  approval_id?: string;
} & Record<string, unknown>;

/**
 * run_app_action: runs an action in one of the user's apps. Also request_approval's run of a
 * request the user's skip rule covers (`opts.summary`: what the agent asked, kept on the approval).
 */
async function runAppAction(userId: string, args: RunArgs, opts: { summary?: string } = {}) {
  // The inputs in `arguments`, or the ones the agent put beside `action` instead.
  const found = actionInputsOf(args, RUN_INPUTS);
  const inputsNote = misplacedInputsNote(found);
  // What runs: the agent's arguments, or with an approval exactly the approved ones (below).
  let runArgs = found.inputs ?? {};
  // One read of the user's connections serves every check below (it was three or four). The
  // run's limits (an automation's run only) and the approval are read at the same time.
  const [[user, read], limits, approval] = await Promise.all([
    userAndConnections(userId),
    runLimits(userId),
    args.approval_id ? getApproval(userId, args.approval_id) : undefined,
  ]);
  // The platform ran it the moment the user approved (or runs it now): its result, never a
  // second run. (A step of a run with steps is always run here, by the agent.)
  if (approval && !limits?.runId) {
    const ran = await approvedRunOf(userId, approval, args.action);
    if (ran) {
      if (found.inputs && !isDeepStrictEqual(approval.arguments ?? {}, found.inputs))
        throw new ToolError(
          'This approval already ran the moment the user approved it, with exactly the approved arguments, and ' +
            'nothing ran now: the arguments you sent differ from those and were not used. Leave arguments out ' +
            'to get its result. Something different needs a request_approval of its own.',
          { reason: 'its details differed from what you approved' },
        );
      return ranResult(ran);
    }
  }
  const { conn, toolkit } = await connectionFor(userId, user, read, args.action);
  // An automation's run may use only the apps on its canvas.
  const refusal = limits && appRefusal(limits, toolkit, appForToolkit(toolkit)?.name ?? toolkit);
  if (refusal) throw new ToolError(refusal, { reason: "the automation isn't set to use this app" });

  const changes = await appActionChangesSomething(args.action);
  // A run of an automation with steps: the call must fit the current step (its own action, with
  // its fixed inputs put in, or a read to look something up first); it is counted.
  let gate: Extract<StepGate, { ok: true }> | null = null;
  if (limits?.runId) {
    const g = await gateAppAction(userId, limits.runId, {
      action: args.action,
      args: runArgs,
      changes,
    });
    if (!g.ok)
      throw new ToolError(g.refusal, { reason: "it didn't fit the automation's current step" });
    gate = g;
    runArgs = g.args;
  }
  const stepAction = gate?.kind === 'step' ? gate : null;

  // HLD 7.5: at zero credits an action that changes something doesn't run (reading still does).
  if (changes && !(await userHasCredits(userId))) {
    // A step's action that can't run fails its step, and the run stops.
    const next = stepAction
      ? await failStep(userId, stepAction.run.id, stepAction.step.id, 'out of credits')
      : '';
    throw new ToolError(`${OUT_OF_CREDITS}${next ? ` ${next}` : ''}`, {
      reason: 'you were out of credits',
    });
  }

  let consumedId: string | null = null;
  // The user's skip rule that let it run without asking (kept as an auto-approved approval).
  let byRule: SkipRule | null = null;
  // Pull-request review is on for this repo: the user's standing approval covers a new review
  // or comment on its pull requests, and nothing else (HLD 0.8).
  let prReviewRepo: string | null = null;
  // A crew job whose brief says "post it on the pull request": the user's yes for ONE review or
  // comment on that pull request, during that job (docs/backend-report.md, "The crew"). Or for
  // Byte's pull request from the job's own branch, or the report as a new issue (`crewOpened`).
  let crewJobId: string | null = null;
  let crewOpened: string | null = null;
  // Every action that changes something asks, but a few harmless ones (catalog.ts). Decided on the
  // inputs that would run: an approval's own when the agent sends only its id.
  const risky = await appActionNeedsApproval(
    args.action,
    !found.inputs && approval?.action === args.action && approval.arguments
      ? approval.arguments
      : runArgs,
  );
  // The automation's "ask me first" set to every change: an action that changes something
  // waits for the user's yes too, not only a risky one. A step set to ask first: its action.
  const askedFirst =
    !risky && ((changes && limits?.askFirst === 'changes') || stepAction?.step.askFirst === true);
  // In a run with steps the standing permissions (pull-request review, a crew job's one review)
  // don't apply: a step that changes things asks first as its step says.
  if (risky && !args.approval_id && !limits?.runId) {
    const target = prCommentTarget(args.action, runArgs);
    if (target && (await prCommentAllowed(userId, target)))
      prReviewRepo = `${target.owner}/${target.repo}`;
    else if (target) crewJobId = await claimCrewJobComment(userId, target);
    else {
      crewOpened = await claimCrewJobGithubAction(userId, args.action, runArgs);
      crewJobId = crewOpened;
    }
  }
  if ((risky && !prReviewRepo && !crewJobId) || askedFirst) {
    // No approval, but the user's skip rule covers exactly this: it runs now, with no card, the
    // way an approved one does, and is kept in their Approvals as auto-approved. Never in an
    // automation set to ask before any change (a stricter setting wins), never for an action that
    // always asks (deleting, paying, merging: skip-rules.ts and catalog.ts).
    const auto =
      !args.approval_id && !askedFirst && limits?.askFirst !== 'changes'
        ? await claimByRule(userId, {
            action: args.action,
            args: runArgs,
            summary: opts.summary,
            step: stepAction ? { runId: stepAction.run.id, stepId: stepAction.step.id } : null,
          })
        : null;
    // The same request again in this turn: the result of the first, nothing run again.
    if (auto && !auto.fresh) return earlierAutoResult(userId, auto.approval, auto.rule);
    if (auto) {
      consumedId = auto.approval.id;
      byRule = auto.rule;
    } else {
      if (!args.approval_id)
        throw new ToolError(
          askedFirst
            ? `The automation "${limits!.title}" asks the user first ${stepAction ? `at step ${stepAction.index + 1}` : 'before anything that changes something'}. ` +
                'Call request_approval for this action and end your turn; run it with that approval_id after the yes.'
            : `This action needs the user's approval${isSafeChange(args.action) ? ' with these labels (archiving, Trash and Spam ask first)' : ''}. ` +
                'If the user already approved it, call run_app_action again with that approval_id. Otherwise call ' +
                'request_approval and end your turn.',
          {
            reason: askedFirst
              ? 'the automation asks you first, and no approval was given'
              : 'it needs your approval, and none was given',
          },
        );
      // In a run with steps, only an approval asked for this step of this run.
      const consumed = await consumeApproval(
        userId,
        args.approval_id,
        args.action,
        stepAction ? { runId: stepAction.run.id, stepId: stepAction.step.id } : null,
      );
      if (!consumed)
        throw new ToolError(
          'No matching approved approval (it must be approved, unused, for this exact action)',
          { reason: 'there was no approved request for it that was still unused' },
        );
      if (consumed.arguments) {
        // The approval holds what runs. Arguments sent again must be exactly those.
        if (found.inputs && !isDeepStrictEqual(consumed.arguments, found.inputs)) {
          await releaseApproval(userId, consumed.id);
          throw new ToolError(
            'The arguments differ from what the user approved. Leave arguments out: the approved ones run.',
            { reason: 'its details differed from what you approved' },
          );
        }
        runArgs = consumed.arguments;
      }
      consumedId = consumed.id;
    }
  }

  // Our defaults for actions whose own send far too much (Gmail's fetch: no bodies), never on
  // approved arguments: those run exactly as the user saw them.
  if (!consumedId) runArgs = withResultDefaults(args.action, runArgs);

  let data: unknown;
  try {
    // The Composio user id is ALWAYS the caller's (forced from the container token).
    const res = await composio().execute(args.action, {
      userId,
      connectedAccountId: conn.composioAccountId,
      arguments: runArgs,
    });
    if (!res.successful)
      throw new ToolError(
        byRule
          ? autoRunFailed(res.error)
          : consumedId
            ? approvedRunFailed(consumedId, res.error)
            : `The app returned an error: ${res.error ?? 'unknown'}`,
        // The app's own error may quote the inputs: the log says only that it refused.
        {
          reason: byRule
            ? 'the app refused it, so nothing was done'
            : consumedId
              ? 'the app refused the approved request, so nothing was done'
              : 'the app returned an error',
        },
      );
    data = res.data;
  } catch (err) {
    const plainFailure =
      err instanceof ToolError
        ? err
        : new ToolError('The app is unavailable right now; tell the user and try later', {
            reason: "the app couldn't be reached",
          });
    // Maybe the connection itself stopped working (an expired sign-in): Composio is asked, the
    // connection is marked so ("Reconnect needed"), and Tex is told to send the user there.
    const trouble = await connectionTroubleNote(conn);
    const failed = trouble
      ? new ToolError(`${plainFailure.message} ${trouble}`, {
          reason: 'the app needs to be connected again',
        })
      : plainFailure;
    // Nothing happened: the approval is handed back, for one more try.
    if (consumedId)
      await finishApprovedRun(userId, consumedId, {
        ok: false,
        error: failed.message,
        reason: failed.reason ?? 'the app refused it',
      });
    if (byRule && consumedId) await publishApproval(userId, consumedId);
    if (crewOpened) await releaseCrewJobGithubAction(crewOpened, args.action);
    else if (crewJobId) await releaseCrewJobComment(userId, crewJobId);
    if (!(err instanceof ToolError))
      logger().warn({ userId, action: args.action, err: String(err) }, 'composio execute failed');
    // A step's own action: one more try, then the step fails and the run stops.
    if (stepAction) {
      const next = await stepActionFailed(
        userId,
        stepAction.run.id,
        stepAction.step.id,
        failed.reason ?? 'the app refused it',
      );
      if (next)
        throw new ToolError(`${failed.message} ${next}`, {
          ...(failed.reason ? { reason: failed.reason } : {}),
        });
    }
    throw failed;
  }

  // Only a successful action is charged. The approval id is the charge's key when there is one
  // (an approval runs once); otherwise an id for this one run.
  const creditsCharged = changes
    ? await chargeRan(userId, args.action, consumedId ?? newId('act'))
    : 0;
  // A file the app gave as a link to Composio's storage: its content, never the link
  // (app-files.ts). Never throws: the action has run, and a file that can't be fetched is a note.
  data = await inlineAppFiles(args.action, data);
  // No more than the agent needs: Gmail's fetch summarised, anything too long cut (app-results.ts).
  const shaped = shapeResult(args.action, runArgs, data);
  // The approval keeps the result: asked again, it gives this, and never runs twice.
  if (consumedId)
    await finishApprovedRun(userId, consumedId, {
      ok: true,
      data: shaped.data,
      ...(shaped.note ? { note: shaped.note } : {}),
      creditsCharged,
    });
  // Kept in the user's Approvals, under Auto-approved, with its result.
  if (byRule && consumedId) await publishApproval(userId, consumedId);
  // A run with steps: the step's own action is done (its short result saved, the pointer moved
  // on); a look-up leaves it where it is. Either way the answer says what comes next.
  let next: string | null = null;
  if (gate) {
    const after = stepAction
      ? await stepActionDone(userId, gate.run.id, gate.step.id, shaped.data)
      : null;
    next = nowText(after ?? gate.run);
  }
  return {
    ok: true,
    data: shaped.data,
    ...(shaped.note ? { note: shaped.note } : {}),
    credits_charged: creditsCharged,
    ...(inputsNote ? { inputs_note: inputsNote } : {}),
    ...(prReviewRepo ? { pr_review: prReviewRepo } : {}),
    ...(crewJobId ? { crew_job: crewJobId } : {}),
    ...(byRule
      ? {
          auto_approved: true,
          approval_id: consumedId,
          skip_rule_id: byRule.id,
          about_approval: autoApprovedText(byRule, Boolean(gate)),
        }
      : {}),
    ...(next ? { next } : {}),
  };
}

/**
 * The app refused an action the user's skip rule let run, so nothing happened. The rule still
 * covers the action: corrected arguments run without asking too.
 */
function autoRunFailed(error: string | null): string {
  return (
    `The app refused it, so nothing was done: ${error ?? 'unknown error'}. Your user's rule to skip ` +
    'approval for this action still covers it: if the arguments must change, call run_app_action again ' +
    'with the corrected ones. Tell the user in plain words what happened.'
  );
}

/** The fingerprint of one request in one turn: the same one again finds the first (claimAutoApproval). */
function autoKey(turnId: string | null, action: string, args: Record<string, unknown>): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
          )
        : v;
  // No turn on record (a call outside a turn): the same request within ten minutes is the same.
  const turn = turnId ?? `t${Math.floor(Date.now() / 600_000)}`;
  return createHash('sha256')
    .update(JSON.stringify([turn, action.toUpperCase(), sorted(args)]))
    .digest('hex');
}

/** The approval's line when the agent gave none (run_app_action alone): "Send email to a@b.com". */
function autoSummary0(action: string, args: Record<string, unknown>): string {
  const to = recipientsOf(action, args);
  const where = action.toUpperCase().startsWith('GITHUB_') ? 'in' : 'to';
  return `${actionWords(action)}${to.length ? ` ${where} ${to.join(', ')}` : ''}`.slice(0, 500);
}

/**
 * The user's skip rule for this request, claimed as an auto-approved approval in the chat of the
 * turn in progress. Null: no rule covers it (the action asks, as before).
 */
async function claimByRule(
  userId: string,
  input: {
    action: string;
    args: Record<string, unknown>;
    summary: string | undefined;
    step: { runId: string; stepId: string } | null;
  },
): Promise<{ approval: Approval; fresh: boolean; rule: SkipRule } | null> {
  const rule = await matchingSkipRule(userId, input.action, input.args);
  if (!rule) return null;
  const turn = await turnInProgress(userId);
  const claimed = await claimAutoApproval({
    userId,
    sessionKey: turn?.sessionKey ?? 'web',
    summary: input.summary?.trim() || autoSummary0(input.action, input.args),
    app: rule.app,
    action: input.action,
    arguments: input.args,
    rule,
    key: autoKey(turn?.turnId ?? null, input.action, input.args),
    run: input.step,
  });
  return { ...claimed, rule };
}

/**
 * The same request a skip rule let run earlier in this turn: its result (waited for while it runs),
 * never a second run. One that never came back is not run again either.
 */
async function earlierAutoResult(userId: string, a: Approval, rule: SkipRule) {
  const run =
    a.runResult?.state === 'running'
      ? await waitForApprovedRun(userId, a.id, TOOL_WAIT_MS)
      : a.runResult;
  if (!run || run.state !== 'done')
    throw new ToolError(
      'This exact action was started a moment ago in this turn (your user’s skip rule let it run without asking) ' +
        "and its result has not come back. Don't run it again: it may already have happened. Tell the user it " +
        'was started and that they can check in the app whether it went through.',
      { reason: 'it was still running from a moment ago' },
    );
  return {
    ok: true,
    data: run.data,
    ...(run.note ? { note: run.note } : {}),
    // Charged once, when it ran.
    credits_charged: 0,
    already_done: true,
    auto_approved: true,
    approval_id: a.id,
    skip_rule_id: rule.id,
    about_approval:
      'This exact action already ran earlier in this turn, without asking (your user’s skip rule), and ' +
      "nothing ran again now. Don't run it again; tell the user what was done.",
  };
}

/** How long run_app_action waits for the platform's run of the same approval to end. */
const TOOL_WAIT_MS = 60_000;

/**
 * The platform's run of this approval (it runs an approved app action the moment the user
 * approves): `done`, or still `running` after a wait. Null: run it here (it never ran, or it
 * failed and the agent tries once more), or it is not an approval for this action.
 */
async function approvedRunOf(
  userId: string,
  a: Approval,
  action: string,
): Promise<ApprovedRun | null> {
  if (a.status !== 'approved' || a.action !== action || !a.runResult) return null;
  const run =
    a.runResult.state === 'running'
      ? await waitForApprovedRun(userId, a.id, TOOL_WAIT_MS)
      : a.runResult;
  return run && run.state !== 'failed' ? run : null;
}

/** run_app_action's answer for an approval the platform already ran: its result, nothing run. */
function ranResult(run: ApprovedRun) {
  if (run.state !== 'done')
    throw new ToolError(
      'This approved action was started the moment the user approved, and its result has not come back. ' +
        "Don't run it again: it may already have happened. Tell the user it was started and that they can " +
        'check in the app whether it went through.',
      { reason: 'it was still running from the approval' },
    );
  return {
    ok: true,
    data: run.data,
    ...(run.note ? { note: run.note } : {}),
    // Charged once, when it ran (the activity log has it there).
    credits_charged: 0,
    already_done: true,
    next:
      'This ran the moment the user approved it (Textcrew runs an approved app action at once), and ' +
      'nothing ran again now. Tell the user how it went.',
  };
}

/**
 * Runs an approved app action for the platform, the moment the user approves it. approvals.ts
 * (settleApprovedRun) has claimed the approval, so this runs once. The same as run_app_action with
 * the approval_id: the stored arguments, the user's newest connection of the app, the same charge
 * (keyed by the approval), the same result shaping and the same activity-log entry. Never throws for
 * a refusal: the result says why, in the words the agent passes on.
 */
export async function runApprovedAppAction(
  userId: string,
  a: Approval,
): Promise<ApprovedActionResult> {
  const action = a.action!;
  const args = a.arguments ?? {};
  const failed = async (error: string, reason: string): Promise<ApprovedActionResult> => {
    await audit({
      userId,
      actor: 'agent',
      ...appFailure('app_action_failed', "Couldn't run", action, reason),
      creditsCharged: 0,
    });
    return { ok: false, error, reason };
  };
  let conn: Connection;
  let changes: boolean;
  try {
    const [user, read] = await userAndConnections(userId);
    if (!user) return await failed('User not found', 'the account was not found');
    ({ conn } = await connectionFor(userId, user, read, action));
    changes = await appActionChangesSomething(action);
    if (changes && !(await userHasCredits(userId)))
      return await failed(OUT_OF_CREDITS, 'you were out of credits');
  } catch (err) {
    if (err instanceof ToolError) return failed(err.message, err.reason ?? 'it was refused');
    logger().error({ userId, action, err: String(err) }, 'approved action could not start');
    return failed(
      'Something went wrong on our side before it ran',
      'something went wrong on our side',
    );
  }
  let data: unknown;
  try {
    // The Composio user id is ALWAYS the approval's user.
    const res = await composio().execute(action, {
      userId,
      connectedAccountId: conn.composioAccountId,
      arguments: args,
    });
    // The app's own error may quote the inputs: the log says only that it refused.
    if (!res.successful) {
      // Maybe the connection stopped working: then it is marked so, and Tex is told.
      const trouble = await connectionTroubleNote(conn);
      return await failed(
        `the app refused it: ${res.error ?? 'unknown error'}${trouble ? `. ${trouble}` : ''}`,
        trouble
          ? 'the app needs to be connected again, so nothing was done'
          : 'the app refused the approved request, so nothing was done',
      );
    }
    data = res.data;
  } catch (err) {
    logger().warn({ userId, action, err: String(err) }, 'composio execute failed');
    const trouble = await connectionTroubleNote(conn);
    return failed(
      `the app couldn't be reached${trouble ? `. ${trouble}` : ''}`,
      trouble ? 'the app needs to be connected again' : "the app couldn't be reached",
    );
  }
  const creditsCharged = changes ? await chargeRan(userId, action, a.id) : 0;
  data = await inlineAppFiles(action, data);
  const shaped = shapeResult(action, args, data);
  await audit({
    userId,
    actor: 'agent',
    action: 'run_app_action',
    summary: `Ran ${action} (approved)`,
    details: { args: { action, approval_id: a.id }, ran_when_approved: true },
    creditsCharged,
  });
  return {
    ok: true,
    data: shaped.data,
    ...(shaped.note ? { note: shaped.note } : {}),
    creditsCharged,
  };
}
