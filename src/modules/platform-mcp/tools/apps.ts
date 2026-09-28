import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../shared/db/client.ts';
import { logger } from '../../../shared/logger.ts';
import { getActiveUser } from '../../auth/users.ts';
import { activeConnections, connectionForToolkit } from '../../integrations/apps.ts';
import {
  actionNeedsApproval,
  appAllowedOnPlan,
  appForToolkit,
} from '../../integrations/catalog.ts';
import { composio } from '../../integrations/composio.ts';
import { approvals } from '../../orchestrator/schema.ts';
import { consumeApproval, requestApproval } from '../../orchestrator/approvals.ts';
import { defineTool, ToolError } from '../registry.ts';
import { extendProfile, resolveSession } from './core.ts';

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
    'Actions marked requires_approval need request_approval first, then run_app_action with the approval_id.',
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
    'with the same action and arguments.',
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

    let consumedId: string | null = null;
    if (actionNeedsApproval(args.action)) {
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

    try {
      // The Composio user id is ALWAYS the caller's (forced from the container token).
      const res = await composio().execute(args.action, {
        userId,
        connectedAccountId: conn.composioAccountId,
        arguments: args.arguments,
      });
      if (!res.successful)
        throw new ToolError(`The app returned an error: ${res.error ?? 'unknown'}`);
      return { ok: true, data: res.data };
    } catch (err) {
      if (consumedId)
        await db().update(approvals).set({ usedAt: null }).where(eq(approvals.id, consumedId));
      if (err instanceof ToolError) throw err;
      logger().warn({ userId, action: args.action, err: String(err) }, 'composio execute failed');
      throw new ToolError('The app is unavailable right now; tell the user and try later');
    }
  },
  summarize: (args) => `Ran ${args.action}${args.approval_id ? ' (approved)' : ''}`,
});
