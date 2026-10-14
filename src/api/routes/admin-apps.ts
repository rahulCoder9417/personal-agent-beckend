// Admin tools for one user's apps, linked chats and automations (docs/backend-report.md, "Admin
// tools"). Admin only: the router adds requireAdmin for every operation tagged `admin`.
//
// Every action runs the same module function as the user's own, then writes one audit row with
// the admin's id and the required reason (the reason is kept in the row's details, which the
// user's activity log does not show). Nothing here returns a Composio account id, token or secret,
// or a chat id other than masked.
import type { Context } from 'hono';
import { audit } from '../../modules/admin/audit.ts';
import { adminLinkLabel, listLinks, maskChatId, unlinkChat } from '../../modules/auth/links.ts';
import { getUser } from '../../modules/auth/users.ts';
import {
  findAutomation,
  listAllAutomations,
  toAdminAutomation,
} from '../../modules/automations/admin.ts';
import { deleteAutomation, setEnabled } from '../../modules/automations/automations.ts';
import { repoOf } from '../../modules/automations/pr-review.ts';
import {
  appConnectionSummary,
  appSetups,
  connectionsForAdmin,
  disconnect,
  getConnection,
  recheckConnection,
  toAdminConnection,
} from '../../modules/integrations/apps.ts';
import { findApp } from '../../modules/integrations/catalog.ts';
import { isChannelEnabled } from '../../shared/config.ts';
import { badRequest, conflict, notFound } from '../../shared/errors.ts';
import { route } from '../router.ts';
import type { AppEnv } from '../types.ts';

/** The reason, trimmed. The contract already asks for one that isn't blank. */
function reasonOf(body: { reason: string }): string {
  const reason = body.reason.trim();
  if (!reason) throw badRequest('`reason` must not be blank');
  return reason;
}

async function requireTargetUser(userId: string): Promise<void> {
  if (!(await getUser(userId))) throw notFound('User not found');
}

/** One audit row for an admin's action on a user's things: the admin's id and the reason. */
async function adminAudit(
  c: Context<AppEnv>,
  input: {
    userId: string;
    action: string;
    summary: string;
    reason: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await audit({
    userId: input.userId,
    actor: 'admin',
    action: input.action,
    summary: input.summary,
    details: { adminId: c.get('user').id, reason: input.reason, ...input.details },
  });
}

const appName = (slug: string) => findApp(slug)?.name ?? slug;

async function automationOr404(id: string) {
  const a = await findAutomation(id);
  if (!a) throw notFound('Automation not found');
  return a;
}

export const adminAppRoutes = [
  // --- apps -------------------------------------------------------------------------------------

  route('adminListUserApps', async (c, { params }) => {
    await requireTargetUser(params.userId);
    return c.json({ items: await connectionsForAdmin(params.userId) }, 200);
  }),

  route('adminDisconnectUserApp', async (c, { params, body }) => {
    const reason = reasonOf(body);
    await requireTargetUser(params.userId);
    const conn = await getConnection(params.userId, params.connectionId);
    // The user's own disconnect: the account goes at Composio, then the connection row.
    if (!conn || !(await disconnect(params.userId, conn.id)))
      throw notFound('Connection not found');
    await adminAudit(c, {
      userId: params.userId,
      action: 'app_disconnected',
      summary: `Textcrew support disconnected ${appName(conn.app)}${conn.accountLabel ? ` (${conn.accountLabel})` : ''}`,
      reason,
      details: { app: conn.app, connectionId: conn.id },
    });
    return c.body(null, 204);
  }),

  route('adminRecheckUserApp', async (c, { params, body }) => {
    const reason = reasonOf(body);
    await requireTargetUser(params.userId);
    const result = await recheckConnection(params.userId, params.connectionId);
    if (!result) throw notFound('Connection not found');
    const { connection } = result;
    await adminAudit(c, {
      userId: params.userId,
      action: 'app_rechecked',
      summary: `Textcrew support checked the ${appName(connection.app)} connection: ${connection.status}`,
      reason,
      details: {
        app: connection.app,
        connectionId: connection.id,
        status: connection.status,
        composioStatus: result.composioStatus,
      },
    });
    const setups = await appSetups();
    return c.json(
      {
        connection: toAdminConnection(connection, setups.get(connection.app)),
        composioStatus: result.composioStatus,
        checksQueued: result.checksQueued,
      },
      200,
    );
  }),

  route('adminAppsSummary', async (c) => c.json({ items: await appConnectionSummary() }, 200)),

  // --- linked chats -----------------------------------------------------------------------------

  route('adminListUserChannels', async (c, { params }) => {
    await requireTargetUser(params.userId);
    const links = await listLinks(params.userId);
    return c.json(
      {
        items: links.map((l) => ({
          id: l.id,
          channel: l.channel,
          label: adminLinkLabel(l),
          maskedChatId: maskChatId(l),
          linkedAt: l.createdAt.toISOString(),
          enabled: isChannelEnabled(l.channel),
          blocked: l.blocked,
          lastInboundAt: l.lastInboundAt ? l.lastInboundAt.toISOString() : null,
        })),
      },
      200,
    );
  }),

  // The user's own unlink, activity log entry included; that entry is the audit row.
  route('adminUnlinkUserChannel', async (c, { params, body }) => {
    const reason = reasonOf(body);
    await requireTargetUser(params.userId);
    const link = await unlinkChat(params.userId, params.channelLinkId, {
      actor: 'admin',
      adminId: c.get('user').id,
      reason,
    });
    if (!link) throw notFound('Channel link not found');
    return c.body(null, 204);
  }),

  // --- automations ------------------------------------------------------------------------------

  route('adminListUserAutomations', async (c, { params }) => {
    await requireTargetUser(params.userId);
    const rows = await listAllAutomations(params.userId);
    return c.json({ items: rows.map(toAdminAutomation) }, 200);
  }),

  // The user's own pause (timer removed), with its own reason so the user sees who paused it.
  route('adminPauseAutomation', async (c, { params, body }) => {
    const reason = reasonOf(body);
    const a = await automationOr404(params.automationId);
    if (a.completedAt) throw conflict('This one-time automation already ran');
    const row = await setEnabled(a.userId, a.id, false, 'admin');
    if (!row) throw notFound('Automation not found');
    await adminAudit(c, {
      userId: a.userId,
      action: 'automation_paused',
      summary: `Textcrew support paused "${a.title}"`,
      reason,
      details: { automationId: a.id },
    });
    return c.json(toAdminAutomation(row), 200);
  }),

  // The user's own resume: timer set again, failure count back to 0.
  route('adminResumeAutomation', async (c, { params, body }) => {
    const reason = reasonOf(body);
    const a = await automationOr404(params.automationId);
    if (a.completedAt) throw conflict('This one-time automation already ran');
    const row = await setEnabled(a.userId, a.id, true);
    if (!row) throw notFound('Automation not found');
    await adminAudit(c, {
      userId: a.userId,
      action: 'automation_resumed',
      summary: `Textcrew support resumed "${a.title}"`,
      reason,
      details: { automationId: a.id },
    });
    return c.json(toAdminAutomation(row), 200);
  }),

  // The user's own delete: timer removed, Composio trigger deleted (for pull-request review, the
  // watch on the repo, and with it the standing approval).
  route('adminDeleteAutomation', async (c, { params, body }) => {
    const reason = reasonOf(body);
    const a = await automationOr404(params.automationId);
    if (!(await deleteAutomation(a.userId, a.id))) throw notFound('Automation not found');
    const repo = a.preset === 'pr_review' ? repoOf(a) : null;
    await adminAudit(c, {
      userId: a.userId,
      action: 'automation_deleted',
      summary: repo
        ? `Textcrew support turned off pull-request review for ${repo.owner}/${repo.repo}`
        : `Textcrew support deleted "${a.title}"`,
      reason,
      details: {
        automationId: a.id,
        ...(a.preset ? { preset: a.preset } : {}),
        ...(repo ? { repo: `${repo.owner}/${repo.repo}` } : {}),
      },
    });
    return c.body(null, 204);
  }),
];
