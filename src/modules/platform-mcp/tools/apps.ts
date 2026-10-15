import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../shared/db/client.ts';
import { newId } from '../../../shared/ids.ts';
import { logger } from '../../../shared/logger.ts';
import { getActiveUser } from '../../auth/users.ts';
import {
  appActionsFor,
  agentAppStates,
  currentAgentAppStates,
} from '../../integrations/agent-apps.ts';
import {
  activeConnections,
  appActionChangesSomething,
  connectionForToolkit,
  listConnections,
  refreshPendingConnections,
} from '../../integrations/apps.ts';
import { claimCrewJobComment, releaseCrewJobComment } from '../../automations/crew-jobs.ts';
import { prCommentAllowed } from '../../automations/pr-review.ts';
import { appOfAction, checkActionInputs } from '../../integrations/action-inputs.ts';
import {
  actionNeedsApproval,
  appAllowedOnPlan,
  prCommentTarget,
} from '../../integrations/catalog.ts';
import { composio } from '../../integrations/composio.ts';
import { approvals } from '../../orchestrator/schema.ts';
import { approvalAskText, channelOfSession } from '../../orchestrator/approval-text.ts';
import {
  consumeApproval,
  getApproval,
  replaceApproval,
  requestApproval,
  START_CREW_JOB_ACTION,
} from '../../orchestrator/approvals.ts';
import { userHasCredits } from '../../orchestrator/turn.ts';
import { defineTool, ToolError } from '../registry.ts';
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

/** Toolkit of a Composio action slug, e.g. GMAIL_SEND_EMAIL → gmail. */
function toolkitOf(action: string, known: string[]): string | undefined {
  const lower = action.toLowerCase();
  return known.filter((t) => lower.startsWith(`${t}_`)).sort((a, b) => b.length - a.length)[0];
}

async function allowedToolkits(
  userId: string,
): Promise<Array<{ toolkit: string; connectedAccountId: string }>> {
  const user = await getActiveUser(userId);
  if (!user) return [];
  const conns = await activeConnections(userId);
  return conns
    .filter((c) => appAllowedOnPlan(c.catalog, user.plan))
    .map((c) => ({ toolkit: c.catalog.toolkit, connectedAccountId: c.composioAccountId }));
}

// The profile asks Composio about connections still pending first, so an app the user just
// connected shows at once; one that is not ready is named with what to tell the user.
extendProfile(async (userId) => {
  const user = await getActiveUser(userId);
  if (!user) return { connected_apps: [], apps_not_ready: [] };
  const states = await currentAgentAppStates(userId, user.plan);
  return {
    connected_apps: (await activeConnections(userId)).map((c) => ({
      app: c.catalog.slug,
      name: c.catalog.name,
      account: c.accountLabel,
    })),
    apps_not_ready: states
      .filter((s) => s.status !== 'connected' && s.status !== 'not_on_plan')
      .map((s) => ({ app: s.app.slug, name: s.app.name, status: s.status, note: s.note })),
  };
});

defineTool({
  name: 'list_app_actions',
  description:
    "Your user's apps and the actions you can run in them. `apps` gives each app's status: connected, or not " +
    "ready (still connecting, needs connecting again, not on the user's plan) with a note saying what to tell " +
    'the user. `actions` lists the actions of the connected apps, at most 100, shared fairly between the apps; ' +
    'filter by app (e.g. "googlecalendar") or by a search word to see more of one app. ' +
    'Actions marked requires_approval need request_approval first, then run_app_action with the approval_id ' +
    '(exceptions: a new review or comment on a pull request, in a repo where your user turned on pull-request review, ' +
    "and the one review a crew job's brief asks you to post on its pull request). " +
    'costs_credits is what a successful run costs your user: 1 for an action that changes something, 0 for reading.',
  input: { app: z.string().optional(), search: z.string().optional() },
  async run({ userId }, args) {
    const user = await getActiveUser(userId);
    if (!user) throw new ToolError('User not found');
    return appActionsFor(userId, user.plan, { app: args.app, search: args.search });
  },
});

defineTool({
  name: 'request_approval',
  description:
    'Ask your user to approve a risky action (sending to others, deleting, paying…) before you run it. ' +
    'The user is shown your summary as "I\'d like to <summary>." with Approve and Deny buttons, so write the summary as what you will do, ' +
    'starting with the verb, with what they need to decide. Example: Send an email to priya@acme.com with subject "Notes". ' +
    "Pass the exact action and its arguments, named as in the action's input_schema from list_app_actions. An app action's " +
    'arguments are checked against it: a name the action does not have, a missing required input or a wrong kind of value is ' +
    'refused before the user sees anything, with the right names. After the yes, run_app_action with the approval_id runs exactly ' +
    'these arguments. If an approved request could not run and its arguments must change, ask again with replaces_approval_id ' +
    'set to its id: the earlier request is marked replaced. ' +
    'Returns immediately with status "pending". Then END YOUR TURN: the user already sees what you asked and that you wait for ' +
    "their answer, so don't repeat it or say you're waiting. Their answer arrives later as a new message.",
  input: {
    summary: z.string().min(3).max(500),
    action: z.string().optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    replaces_approval_id: z.string().optional(),
    session_key: z.string().optional(),
  },
  async run({ userId }, args) {
    const sessionKey = await resolveSession(userId, args.session_key);
    const action = args.action ?? null;
    let app: string | null = null;
    let approved = args.arguments ?? null;
    // An app action: its arguments must fit the action, so the user approves something that can
    // run exactly as shown. Its approval always holds what will run (no arguments means none).
    if (action && action !== START_CREW_JOB_ACTION) {
      const check = await checkActionInputs(action, args.arguments ?? {});
      if (check && !check.ok) throw new ToolError(check.problem);
      if (check) {
        app = check.app.slug;
        approved = args.arguments ?? {};
      }
    }
    const earlier = args.replaces_approval_id
      ? await getApproval(userId, args.replaces_approval_id)
      : undefined;
    if (args.replaces_approval_id && (!earlier || earlier.action !== action))
      throw new ToolError(
        'replaces_approval_id must be the id of an earlier request of yours for the same action',
      );
    const a = await requestApproval({
      userId,
      sessionKey,
      summary: args.summary,
      app,
      action,
      arguments: approved,
    });
    const replaced = earlier ? await replaceApproval(userId, earlier.id, a) : null;
    return {
      approval_id: a.id,
      status: 'pending',
      expires_at: a.expiresAt.toISOString(),
      shown_to_user: approvalAskText(a.summary, channelOfSession(sessionKey)),
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
  summarize: (args) =>
    `${args.replaces_approval_id ? 'Asked again for approval' : 'Asked for approval'}: ${args.summary}`,
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
    "Run an action in one of your user's connected apps (from list_app_actions). Risky actions need approval_id from an APPROVED request_approval " +
    'for the same action: it runs exactly the arguments the user approved, so leave arguments out (any you pass must be the approved ones). Posting a new review or comment on a pull request needs no approval in a repo where your user turned on ' +
    'pull-request review (a review must use event "COMMENT"); merging, approving and comments on other repos still do. ' +
    'A successful action that changes something (send, create, update, delete) costs your user 1 credit; reading, listing and searching are free.',
  input: {
    action: z.string().min(3),
    arguments: z.record(z.string(), z.unknown()).optional(),
    approval_id: z.string().optional(),
  },
  async run({ userId }, args) {
    // What runs: the agent's arguments, or with an approval exactly the approved ones (below).
    let runArgs = args.arguments ?? {};
    let toolkit = toolkitOf(
      args.action,
      (await allowedToolkits(userId)).map((a) => a.toolkit),
    );
    if (!toolkit) {
      // It may have finished connecting a moment ago: ask Composio, then look again.
      await refreshPendingConnections(userId);
      toolkit = toolkitOf(
        args.action,
        (await allowedToolkits(userId)).map((a) => a.toolkit),
      );
    }
    if (!toolkit) {
      // Say why, when the app is one the user has a connection for (still connecting, expired…).
      const app = appOfAction(args.action);
      const user = await getActiveUser(userId);
      const state =
        app && user
          ? agentAppStates(await listConnections(userId), user.plan).find((s) => s.app === app)
          : undefined;
      throw new ToolError(state?.note ?? 'That app is not connected or not available on your plan');
    }
    const conn = await connectionForToolkit(userId, toolkit);
    if (!conn) throw new ToolError('That app is not connected');

    // HLD 7.5: at zero credits an action that changes something doesn't run (reading still does).
    const changes = await appActionChangesSomething(args.action);
    if (changes && !(await userHasCredits(userId)))
      throw new ToolError(
        "Your user is out of credits, so actions that change something can't run (reading still works). " +
          'Tell them to open the Textcrew web app to top up or upgrade. Do not send a link.',
      );

    let consumedId: string | null = null;
    // Pull-request review is on for this repo: the user's standing approval covers a new review
    // or comment on its pull requests, and nothing else (HLD 0.8).
    let prReviewRepo: string | null = null;
    // A crew job whose brief says "post it on the pull request": the user's yes for ONE review or
    // comment on that pull request, during that job (docs/backend-report.md, "The crew").
    let crewJobId: string | null = null;
    if (actionNeedsApproval(args.action) && !args.approval_id) {
      const target = prCommentTarget(args.action, runArgs);
      if (target && (await prCommentAllowed(userId, target)))
        prReviewRepo = `${target.owner}/${target.repo}`;
      else if (target) crewJobId = await claimCrewJobComment(userId, target);
    }
    if (actionNeedsApproval(args.action) && !prReviewRepo && !crewJobId) {
      if (!args.approval_id)
        throw new ToolError(
          "This action needs the user's approval. If the user already approved it, call run_app_action again " +
            'with that approval_id. Otherwise call request_approval and end your turn.',
        );
      const approval = await consumeApproval(userId, args.approval_id, args.action);
      if (!approval)
        throw new ToolError(
          'No matching approved approval (it must be approved, unused, for this exact action)',
        );
      if (approval.arguments) {
        // The approval holds what runs. Arguments sent again must be exactly those.
        if (args.arguments && !isDeepStrictEqual(approval.arguments, args.arguments)) {
          await db().update(approvals).set({ usedAt: null }).where(eq(approvals.id, approval.id));
          throw new ToolError(
            'The arguments differ from what the user approved. Leave arguments out: the approved ones run.',
          );
        }
        runArgs = approval.arguments;
      }
      consumedId = approval.id;
    }

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
          consumedId
            ? approvedRunFailed(consumedId, res.error)
            : `The app returned an error: ${res.error ?? 'unknown'}`,
        );
      data = res.data;
    } catch (err) {
      if (consumedId)
        await db().update(approvals).set({ usedAt: null }).where(eq(approvals.id, consumedId));
      if (crewJobId) await releaseCrewJobComment(userId, crewJobId);
      if (err instanceof ToolError) throw err;
      logger().warn({ userId, action: args.action, err: String(err) }, 'composio execute failed');
      throw new ToolError('The app is unavailable right now; tell the user and try later');
    }

    // Only a successful action is charged. The approval id is the charge's key when there is one
    // (an approval runs once); otherwise an id for this one run. The action has already happened,
    // so a charge that fails is logged and never turned into a tool error (the agent would retry
    // and act twice).
    let creditsCharged = 0;
    if (changes) {
      try {
        creditsCharged = await chargeAppAction(userId, {
          action: args.action,
          ref: consumedId ?? newId('act'),
        });
      } catch (err) {
        logger().error({ userId, action: args.action, err: String(err) }, 'app action not charged');
      }
    }
    return {
      ok: true,
      data,
      credits_charged: creditsCharged,
      ...(prReviewRepo ? { pr_review: prReviewRepo } : {}),
      ...(crewJobId ? { crew_job: crewJobId } : {}),
    };
  },
  summarize: (args, result) => {
    const repo = (result as { pr_review?: string }).pr_review;
    if (repo) return `Ran ${args.action} (pull-request review is on for ${repo})`;
    const job = (result as { crew_job?: string }).crew_job;
    if (job) return `Ran ${args.action} (the review the user asked for in crew job ${job})`;
    return `Ran ${args.action}${args.approval_id ? ' (approved)' : ''}`;
  },
  creditsCharged: (_args, result) => (result as { credits_charged: number }).credits_charged,
});
