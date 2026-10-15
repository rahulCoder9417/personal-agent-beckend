// API shapes for the admin's user views (openapi.yaml: AdminUser, AdminUserDetail). Each field is
// picked one by one, so nothing a module adds to its rows later reaches an admin by accident.
import type { AdminUserDetail, AdminUserView } from '../modules/admin/users.ts';
import { answeredAfter, turnStages, type TurnTimingRow } from '../modules/orchestrator/timings.ts';
import { toBalance, toLedgerEntry, toSubscription } from './billing-presenters.ts';
import { iso } from './presenters.ts';
import type { Schemas } from './types.ts';

export function toAdminUser(v: AdminUserView): Schemas['AdminUser'] {
  const u = v.user;
  return {
    id: u.id,
    email: u.email,
    emailVerified: u.emailVerified,
    name: u.name,
    timezone: u.timezone,
    plan: u.plan,
    role: u.role,
    status: u.deletedAt ? 'deleted' : u.status,
    suspendedAt: iso(u.suspendedAt),
    flagged: u.flagged,
    createdAt: u.createdAt.toISOString(),
    deletedAt: iso(u.deletedAt),
    lastActiveAt: iso(v.lastActiveAt),
    credits: v.credits,
    engine: v.engine,
    channels: [...v.channels],
    connectedApps: v.connectedApps,
    onboardingCompletedAt: iso(u.onboardingCompletedAt),
    gettingStartedDismissedAt: iso(u.gettingStartedDismissedAt),
  };
}

/** Stage names and milliseconds only: the notes beside them are left out. */
export function toAdminTurn(row: TurnTimingRow): Schemas['AdminTurnTiming'] {
  return {
    id: row.deliveryId,
    startedAt: row.startedAt.toISOString(),
    kind: row.kind,
    channel: row.channel,
    route: row.route,
    engine: row.engine,
    wake: row.wake,
    outcome: row.outcome,
    attempt: row.attempt,
    answeredMs: answeredAfter(row) ?? null,
    stages: turnStages(row).map((s) => ({ name: s.name, ms: Math.round(s.ms) })),
  };
}

export function toAdminUserDetail(d: AdminUserDetail): Schemas['AdminUserDetail'] {
  return {
    user: toAdminUser(d.view),
    // The subscription's own plan, which can differ from a plan set by hand.
    subscription: toSubscription(d.subscription?.plan ?? d.view.user.plan, d.subscription),
    credits: toBalance(d.balance, d.grants),
    ledger: d.ledger.map(toLedgerEntry),
    apps: d.apps.map((a) => ({
      app: a.app,
      name: a.name,
      status: a.status,
      connectedAt: a.connectedAt.toISOString(),
    })),
    automations: d.automations.map((a) => ({
      id: a.id,
      title: a.title,
      kind: a.kind,
      preset: a.preset,
      enabled: a.enabled,
      pausedReason: a.pausedReason,
      nextRunAt: iso(a.nextRunAt),
      lastRunAt: iso(a.lastRunAt),
      createdAt: a.createdAt.toISOString(),
    })),
    crewJobs: d.crewJobs.map((j) => ({
      id: j.id,
      member: j.member,
      status: j.status,
      source: j.source,
      repo: `${j.owner}/${j.repo}`,
      createdAt: j.createdAt.toISOString(),
      finishedAt: iso(j.finishedAt),
    })),
    turns: d.turns.map(toAdminTurn),
    activity: d.activity.map((e) => ({
      id: e.id,
      actor: e.actor,
      action: e.action,
      summary: e.summary,
      creditsCharged: e.creditsCharged,
      createdAt: e.createdAt.toISOString(),
    })),
    agent: {
      runtime: d.agent.runtime,
      effectiveRuntime: d.agent.effectiveRuntime,
      aiAccess: d.agent.aiAccess,
      claudeConnected: d.agent.claude.connected,
    },
    container: d.container
      ? { state: d.container.state, lastActiveAt: iso(d.container.lastActiveAt) }
      : null,
  };
}
