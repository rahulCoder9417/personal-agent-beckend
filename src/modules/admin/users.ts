// The admin's view of users (docs/backend-report.md, "Admin tools"): a list with search, and one
// user's details. Each part is asked of the module that owns it. Counts and metadata only: never a
// message, a memory, a key, a token, an app account's name or the arguments of what the agent did.
import { linkedChannelsFor, type LinkChannel } from '../auth/links.ts';
import { getUser, searchUsers, type User } from '../auth/users.ts';
import {
  balancesFor,
  getCurrentSubscription,
  listBalanceGrants,
  listLedger,
  type Subscription,
} from '../billing/index.ts';
import type { CreditGrant, LedgerRow } from '../billing/credits.ts';
import { lastInboundAtFor } from '../channels/messages.ts';
import { listAutomations } from '../automations/automations.ts';
import { listCrewJobs } from '../automations/crew-jobs.ts';
import { activeConnectionCounts, listConnections } from '../integrations/apps.ts';
import { findApp } from '../integrations/catalog.ts';
import {
  getAgentSettings,
  runtimesFor,
  type AgentSettingsView,
  type RuntimeName,
} from '../orchestrator/agent-settings.ts';
import { agentStatusOrNull } from '../orchestrator/sandbox.ts';
import { recentTurnTimings, type TurnTimingRow } from '../orchestrator/timings.ts';
import { listAudit, type AuditEntry } from './audit.ts';

/** How many of each list the user page shows. */
export const DETAIL_LIMIT = 20;

export interface AdminUserView {
  user: User;
  lastActiveAt: Date | null;
  credits: number;
  engine: RuntimeName;
  channels: LinkChannel[];
  connectedApps: number;
}

/** One row per user, with what each module knows of them: a few queries for the whole page. */
async function summarize(list: User[], now: Date): Promise<AdminUserView[]> {
  const ids = list.map((u) => u.id);
  const [last, balances, engines, channels, apps] = await Promise.all([
    lastInboundAtFor(ids),
    balancesFor(ids, now),
    runtimesFor(ids),
    linkedChannelsFor(ids),
    activeConnectionCounts(ids),
  ]);
  return list.map((user) => ({
    user,
    lastActiveAt: last.get(user.id) ?? null,
    credits: balances.get(user.id) ?? 0,
    engine: engines.get(user.id) ?? 'hermes',
    channels: channels.get(user.id) ?? [],
    connectedApps: apps.get(user.id) ?? 0,
  }));
}

export async function adminUserPage(
  opts: { query?: string; cursor?: string; limit: number },
  now = new Date(),
): Promise<{ items: AdminUserView[]; nextCursor: string | null }> {
  const page = await searchUsers(opts);
  return { items: await summarize(page.items, now), nextCursor: page.nextCursor };
}

export interface AdminUserApp {
  app: string;
  name: string;
  status: 'pending' | 'active' | 'expired' | 'error';
  connectedAt: Date;
}

export interface AdminUserDetail {
  view: AdminUserView;
  subscription: Subscription | undefined;
  balance: number;
  grants: CreditGrant[];
  ledger: LedgerRow[];
  apps: AdminUserApp[];
  automations: Awaited<ReturnType<typeof listAutomations>>;
  crewJobs: Awaited<ReturnType<typeof listCrewJobs>>['items'];
  turns: TurnTimingRow[];
  activity: AuditEntry[];
  agent: AgentSettingsView;
  container: Awaited<ReturnType<typeof agentStatusOrNull>>;
}

/** One user's page; undefined when there is no such user. Deleted users are shown too. */
export async function adminUserDetail(
  userId: string,
  now = new Date(),
): Promise<AdminUserDetail | undefined> {
  const user = await getUser(userId);
  if (!user) return undefined;
  const [[view], subscription, grants, ledger, connections, automations, jobs, turns, activity] =
    await Promise.all([
      summarize([user], now),
      getCurrentSubscription(userId),
      listBalanceGrants(userId, now),
      listLedger(userId, { limit: DETAIL_LIMIT }),
      listConnections(userId),
      listAutomations(userId),
      listCrewJobs(userId, { limit: DETAIL_LIMIT }),
      recentTurnTimings(userId, DETAIL_LIMIT),
      listAudit(userId, { limit: DETAIL_LIMIT }),
    ]);
  const [agent, container] = await Promise.all([
    getAgentSettings(userId),
    agentStatusOrNull(userId),
  ]);
  return {
    view: view!,
    subscription,
    balance: view!.credits,
    grants,
    ledger: ledger.items,
    apps: connections
      .map((c) => ({
        app: c.app,
        name: findApp(c.app)?.name ?? c.app,
        status: c.status,
        connectedAt: c.createdAt,
      }))
      .sort((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime()),
    automations,
    crewJobs: jobs.items,
    turns,
    activity: activity.items,
    agent,
    container,
  };
}
