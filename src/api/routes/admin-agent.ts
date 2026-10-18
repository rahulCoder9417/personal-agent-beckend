// Admin tools for one user's agent and container (openapi tag `admin`: the router lets admins
// only). Reads show states, names and times, never a token, a secret, a key, an approval's inputs
// or a crew job's brief. Every change is audited by the module that makes it, with the admin's id
// and the reason.
import { getActiveUser, type User } from '../../modules/auth/users.ts';
import { listUsagePeriods } from '../../modules/billing/usage.ts';
import { wakeCreditsBetween } from '../../modules/billing/wake-fee.ts';
import {
  cancelQueuedCrewJob,
  listCrewJobs,
  type CrewJob,
} from '../../modules/automations/crew-jobs.ts';
import { parseSessionKey, type Channel } from '../../modules/channels/types.ts';
import {
  adminAgentView,
  adminResetAgent,
  adminStopContainer,
  adminWakeContainer,
  type AdminContainerView,
} from '../../modules/orchestrator/admin-agent.ts';
import {
  cancelApproval,
  listApprovalsForAdmin,
  type Approval,
} from '../../modules/orchestrator/approvals.ts';
import { config } from '../../shared/config.ts';
import { badRequest, notFound } from '../../shared/errors.ts';
import { iso } from '../presenters.ts';
import { route } from '../router.ts';
import type { Schemas } from '../types.ts';

async function userOf(userId: string): Promise<User> {
  const user = await getActiveUser(userId);
  if (!user) throw notFound('User not found');
  return user;
}

/** The spec asks for one character at least; a reason of spaces only is no reason either. */
function reasonOf(reason: string): string {
  const r = reason.trim();
  if (!r) throw badRequest('`reason` must not be empty');
  return r;
}

function toAdminContainer(c: AdminContainerView): Schemas['AdminContainer'] {
  return {
    reachable: c.reachable,
    state: c.state,
    busy: c.busy,
    lastActiveAt: iso(c.lastActiveAt),
    imageVersion: c.imageVersion,
    memoryBytes: c.memoryBytes,
    engine: c.engine,
    claudeSignedIn: c.claudeSignedIn,
    browserOn: c.browserOn,
  };
}

const utcMidnight = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

async function agentOf(user: User): Promise<Schemas['AdminAgent']> {
  const now = new Date();
  const since = utcMidnight(now);
  const [view, periods, wakeCredits] = await Promise.all([
    adminAgentView(user.id, user.plan),
    listUsagePeriods(user.id, since, new Date(now.getTime() + 1)),
    wakeCreditsBetween(user.id, since, new Date(now.getTime() + 1)),
  ]);
  const s = view.settings;
  const sum = (pick: (p: (typeof periods)[number]) => number) =>
    periods.reduce((n, p) => n + pick(p), 0);
  return {
    userId: user.id,
    plan: user.plan,
    container: toAdminContainer(view.container),
    engine: { chosen: s.runtime, effective: s.effectiveRuntime },
    claude: { connected: s.claude.connected, connectedAt: iso(s.claude.connectedAt) },
    claudeModel: s.claudeModel,
    claudeEffort: s.claudeEffort,
    browser: view.browser,
    ai: {
      access: s.aiAccess,
      preference: s.aiPreference,
      serverMode: config().AI_ACCESS_MODE,
      ownKeyProviders: s.ownKeyProviders,
    },
    today: {
      since: since.toISOString(),
      awakeSeconds: sum((p) => p.awakeSeconds),
      browserSeconds: sum((p) => p.browserSeconds),
      creditsCharged: sum((p) => p.creditsCharged),
      wakeCredits,
    },
  };
}

/** No inputs, no details: the action's name, its app and the short summary the user was shown. */
function toAdminApproval(a: Approval): Schemas['AdminApproval'] {
  return {
    id: a.id,
    userId: a.userId,
    status: a.status,
    summary: a.summary,
    app: a.app,
    action: a.action,
    createdAt: a.createdAt.toISOString(),
    expiresAt: a.expiresAt.toISOString(),
    decidedAt: iso(a.decidedAt),
    decidedVia: a.decidedVia,
    used: a.usedAt !== null,
  };
}

/** No brief text (instructions, commands, what to test for); the report only when asked for. */
function toAdminCrewJob(job: CrewJob, withReport: boolean): Schemas['AdminCrewJob'] {
  return {
    id: job.id,
    userId: job.userId,
    member: job.member,
    status: job.status,
    source: job.source,
    owner: job.owner,
    repo: job.repo,
    pullNumber: job.pullNumber,
    branch: job.branch,
    reportTo: {
      channel: (parseSessionKey(job.sessionKey)?.channel ?? 'web') as Channel,
      pullRequest: job.reportPullRequest,
      issue: job.reportIssue,
    },
    postedOnPullRequest: job.postedAt !== null,
    hasReport: Boolean(job.report),
    ...(withReport ? { report: job.report } : {}),
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    startedAt: iso(job.startedAt),
    finishedAt: iso(job.finishedAt),
  };
}

export const adminAgentRoutes = [
  route('adminGetUserAgent', async (c, { params }) => {
    return c.json(await agentOf(await userOf(params.userId)), 200);
  }),

  route('adminStopContainer', async (c, { params, body }) => {
    const container = await adminStopContainer({
      userId: params.userId,
      adminId: c.get('user').id,
      reason: reasonOf(body.reason),
      force: body.force === true,
    });
    return c.json({ container: toAdminContainer(container) }, 200);
  }),

  route('adminWakeContainer', async (c, { params, body }) => {
    const woke = await adminWakeContainer({
      userId: params.userId,
      adminId: c.get('user').id,
      reason: reasonOf(body.reason),
    });
    return c.json(
      { container: toAdminContainer(woke.container), wasStopped: woke.wasStopped },
      200,
    );
  }),

  route('adminResetAgent', async (c, { params, body }) => {
    const user = await userOf(params.userId);
    await adminResetAgent({
      userId: user.id,
      adminId: c.get('user').id,
      reason: reasonOf(body.reason),
      what: body.what,
    });
    return c.json(await agentOf(user), 200);
  }),

  route('adminListUserApprovals', async (c, { params, query }) => {
    const user = await userOf(params.userId);
    const page = await listApprovalsForAdmin(user.id, {
      limit: query.limit ?? 30,
      ...(query.status ? { status: query.status } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    return c.json({ items: page.items.map(toAdminApproval), nextCursor: page.nextCursor }, 200);
  }),

  route('adminCancelApproval', async (c, { params, body }) => {
    const approval = await cancelApproval(params.approvalId, {
      adminId: c.get('user').id,
      reason: reasonOf(body.reason),
    });
    return c.json(toAdminApproval(approval), 200);
  }),

  route('adminListUserCrewJobs', async (c, { params, query }) => {
    const user = await userOf(params.userId);
    const withReport = query.withReport === '1' || query.withReport === 'true';
    const page = await listCrewJobs(user.id, {
      limit: query.limit ?? 30,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    return c.json(
      { items: page.items.map((j) => toAdminCrewJob(j, withReport)), nextCursor: page.nextCursor },
      200,
    );
  }),

  route('adminCancelCrewJob', async (c, { params, body }) => {
    const job = await cancelQueuedCrewJob(params.crewJobId, {
      adminId: c.get('user').id,
      reason: reasonOf(body.reason),
    });
    return c.json(toAdminCrewJob(job, false), 200);
  }),
];
