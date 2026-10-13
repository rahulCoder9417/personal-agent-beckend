import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../shared/db/client.ts';
import { newId } from '../../../shared/ids.ts';
import { logger } from '../../../shared/logger.ts';
import { getActiveUser } from '../../auth/users.ts';
import {
  activeConnections,
  appActionChangesSomething,
  connectionForToolkit,
} from '../../integrations/apps.ts';
import { claimCrewJobComment, releaseCrewJobComment } from '../../automations/crew-jobs.ts';
import { prCommentAllowed } from '../../automations/pr-review.ts';
import {
  actionChangesSomething,
  actionNeedsApproval,
  appAllowedOnPlan,
  appForToolkit,
  prCommentTarget,
} from '../../integrations/catalog.ts';
import { composio } from '../../integrations/composio.ts';
import { approvals } from '../../orchestrator/schema.ts';
import { consumeApproval, requestApproval } from '../../orchestrator/approvals.ts';
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

extendProfile(async (userId) => ({
  connected_apps: (await activeConnections(userId)).map((c) => ({
    app: c.catalog.slug,
    name: c.catalog.name,
    account: c.accountLabel,
  })),
}));

defineTool({
  name: 'list_app_actions',
  description:
    'Actions you can run in your user\'s connected apps (connected apps × plan). Optionally filter by app (e.g. "gmail"). ' +
    'Actions marked requires_approval need request_approval first, then run_app_action with the approval_id ' +
    '(exceptions: a new review or comment on a pull request, in a repo where your user turned on pull-request review, ' +
    "and the one review a crew job's brief asks you to post on its pull request). " +
    'costs_credits is what a successful run costs your user: 1 for an action that changes something, 0 for reading.',
  input: { app: z.string().optional(), search: z.string().optional() },
  async run({ userId }, args) {
    let toolkits = (await allowedToolkits(userId)).map((t) => t.toolkit);
    if (args.app)
      toolkits = toolkits.filter((t) => t === args.app || appForToolkit(t)?.slug === args.app);
    const tools = await composio().listTools(toolkits);
    const q = args.search?.toLowerCase();
    return tools
      .filter(
        (t) => !q || t.slug.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
      )
      .slice(0, 100)
      .map((t) => ({
        action: t.slug,
        app: appForToolkit(t.toolkit)?.slug ?? t.toolkit,
        description: t.description.slice(0, 300),
        requires_approval: actionNeedsApproval(t.slug),
        costs_credits: actionChangesSomething(t.slug, t.tags) ? 1 : 0,
        input_schema: t.inputParameters,
      }));
  },
});

defineTool({
  name: 'request_approval',
  description:
    'Ask your user to approve a risky action (sending to others, deleting, paying…). Returns immediately with status "pending": ' +
    "END YOUR TURN after calling it (tell the user you're waiting for their OK). Their answer arrives later as a new message. " +
    'Pass the exact action and arguments you intend to run; run_app_action will only run exactly those.',
  input: {
    summary: z.string().min(3).max(500),
    action: z.string().optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    session_key: z.string().optional(),
  },
  async run({ userId }, args) {
    const sessionKey = await resolveSession(userId, args.session_key);
    const app = args.action ? (appForToolkit(args.action.split('_')[0] ?? '')?.slug ?? null) : null;
    const a = await requestApproval({
      userId,
      sessionKey,
      summary: args.summary,
      app,
      action: args.action ?? null,
      arguments: args.arguments ?? null,
    });
    return { approval_id: a.id, status: 'pending', expires_at: a.expiresAt.toISOString() };
  },
  summarize: (args) => `Asked for approval: ${args.summary}`,
});

defineTool({
  name: 'run_app_action',
  description:
    "Run an action in one of your user's connected apps (from list_app_actions). Risky actions need approval_id from an APPROVED request_approval " +
    'with the same action and arguments. Posting a new review or comment on a pull request needs no approval in a repo where your user turned on ' +
    'pull-request review (a review must use event "COMMENT"); merging, approving and comments on other repos still do. ' +
    'A successful action that changes something (send, create, update, delete) costs your user 1 credit; reading, listing and searching are free.',
  input: {
    action: z.string().min(3),
    arguments: z.record(z.string(), z.unknown()).default({}),
    approval_id: z.string().optional(),
  },
  async run({ userId }, args) {
    const allowed = await allowedToolkits(userId);
    const toolkit = toolkitOf(
      args.action,
      allowed.map((a) => a.toolkit),
    );
    if (!toolkit) throw new ToolError('That app is not connected or not available on your plan');
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
      const target = prCommentTarget(args.action, args.arguments);
      if (target && (await prCommentAllowed(userId, target)))
        prReviewRepo = `${target.owner}/${target.repo}`;
      else if (target) crewJobId = await claimCrewJobComment(userId, target);
    }
    if (actionNeedsApproval(args.action) && !prReviewRepo && !crewJobId) {
      if (!args.approval_id)
        throw new ToolError(
          "This action needs the user's approval first: call request_approval and end your turn",
        );
      const approval = await consumeApproval(userId, args.approval_id, args.action);
      if (!approval)
        throw new ToolError(
          'No matching approved approval (it must be approved, unused, for this exact action)',
        );
      if (approval.arguments && !isDeepStrictEqual(approval.arguments, args.arguments)) {
        await db().update(approvals).set({ usedAt: null }).where(eq(approvals.id, approval.id));
        throw new ToolError('The arguments differ from what the user approved');
      }
      consumedId = approval.id;
    }

    let data: unknown;
    try {
      // The Composio user id is ALWAYS the caller's (forced from the container token).
      const res = await composio().execute(args.action, {
        userId,
        connectedAccountId: conn.composioAccountId,
        arguments: args.arguments,
      });
      if (!res.successful)
        throw new ToolError(`The app returned an error: ${res.error ?? 'unknown'}`);
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
