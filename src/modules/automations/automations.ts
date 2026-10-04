import { CronExpressionParser } from 'cron-parser';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { logger } from '../../shared/logger.ts';
import { getActiveUser, isValidTimezone, type PlanId } from '../auth/users.ts';
import { publish } from '../channels/stream.ts';
import { queue } from '../events/queues.ts';
import { appForToolkit, findApp } from '../integrations/catalog.ts';
import { connectionForToolkit } from '../integrations/apps.ts';
import { composio } from '../integrations/composio.ts';
import { automations, prReviews } from './schema.ts';

export type Automation = typeof automations.$inferSelect;

/** Plan limits (Free 1 / Pro 5 / Max 50). Billing's planLimits plugs in via wiring. */
let limitFor: (plan: PlanId) => number = (plan) => ({ free: 1, pro: 5, max: 50 })[plan];
export function setAutomationLimit(fn: (plan: PlanId) => number): void {
  limitFor = fn;
}

/** 15 minutes between runs (HLD 0.4). Tests lower it. */
let minIntervalMs = 15 * 60 * 1000;
export function setMinIntervalMs(ms: number): void {
  minIntervalMs = ms;
}

export class AutomationError extends Error {
  constructor(
    message: string,
    /** `plan_limit`: the plan's automations are used up. */
    readonly code: 'invalid' | 'plan_limit' = 'invalid',
  ) {
    super(message);
  }
}

export function toApiAutomation(a: Automation) {
  return {
    id: a.id,
    kind: a.kind,
    title: a.title,
    instruction: a.instruction,
    runAt: a.runAt ? a.runAt.toISOString() : null,
    cron: a.cron,
    timezone: a.timezone,
    trigger: a.trigger ? { app: a.trigger.app, event: a.trigger.event } : null,
    preset: a.preset ?? null,
    enabled: a.enabled,
    pausedReason: a.pausedReason ?? null,
    nextRunAt: a.nextRunAt ? a.nextRunAt.toISOString() : null,
    lastRunAt: a.lastRunAt ? a.lastRunAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
  };
}

function nextRuns(cron: string, tz: string, n: number): Date[] {
  const expr = CronExpressionParser.parse(cron, { tz, currentDate: new Date() });
  return Array.from({ length: n }, () => expr.next().toDate());
}

/** Validates a cron: parses, and consecutive runs are at least the minimum interval apart. */
export function validateCron(cron: string, tz: string): Date {
  let runs: Date[];
  try {
    runs = nextRuns(cron, tz, 50);
  } catch {
    throw new AutomationError('Invalid cron expression');
  }
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]!.getTime() - runs[i - 1]!.getTime() < minIntervalMs) {
      throw new AutomationError(
        `Automations can run at most every ${Math.round(minIntervalMs / 60000)} minutes`,
      );
    }
  }
  return runs[0]!;
}

const schedulerId = (id: string) => `auto-${id}`;
const onceJobId = (a: Automation) => `auto-${a.id}-${a.runAt!.getTime()}`;

async function emit(a: Automation): Promise<void> {
  await publish(a.userId, 'automation.updated', toApiAutomation(a));
}

/** Registers the timer (or trigger) for an enabled automation. Idempotent. */
export async function registerTimer(a: Automation): Promise<void> {
  if (!a.enabled || a.completedAt) return;
  if (a.kind === 'once' && a.runAt) {
    await queue('scheduled').add(
      'run-automation',
      { automationId: a.id, userId: a.userId },
      { jobId: onceJobId(a), delay: Math.max(0, a.runAt.getTime() - Date.now()) },
    );
  } else if (a.kind === 'repeat' && a.cron) {
    await queue('scheduled').upsertJobScheduler(
      schedulerId(a.id),
      { pattern: a.cron, tz: a.timezone ?? 'UTC' },
      { name: 'run-automation', data: { automationId: a.id, userId: a.userId } },
    );
  }
  // kind=event: the Composio trigger lives at Composio; nothing to register in BullMQ.
}

export async function removeTimer(a: Automation): Promise<void> {
  if (a.kind === 'once' && a.runAt) {
    const job = await queue('scheduled').getJob(onceJobId(a));
    await job?.remove().catch(() => {});
  } else if (a.kind === 'repeat') {
    await queue('scheduled').removeJobScheduler(schedulerId(a.id));
  }
}

export interface CreateInput {
  userId: string;
  title: string;
  instruction: string;
  sessionKey: string;
  runAt?: Date;
  cron?: string;
  timezone?: string;
  trigger?: { app: string; event: string; config?: Record<string, unknown> };
  /** Set only by the platform itself (pr-review.ts), never from the agent's tools. */
  preset?: NonNullable<Automation['preset']>;
}

/** Checks plan limit, 15-minute minimum and timezone → saves → registers the timer. */
export async function createAutomation(input: CreateInput): Promise<Automation> {
  const user = await getActiveUser(input.userId);
  if (!user) throw new AutomationError('User not found');
  const kinds = [input.runAt, input.cron, input.trigger].filter(Boolean).length;
  if (kinds !== 1) throw new AutomationError('Give exactly one of run_at, cron or trigger');
  const tz = input.timezone ?? user.timezone;
  if (!isValidTimezone(tz)) throw new AutomationError(`Unknown timezone ${tz}`);

  const [{ n } = { n: 0 }] = await db()
    .select({ n: count() })
    .from(automations)
    .where(and(eq(automations.userId, input.userId), isNull(automations.completedAt)));
  const limit = limitFor(user.plan);
  if (n >= limit)
    throw new AutomationError(
      `Your ${user.plan} plan allows ${limit} automations; cancel one or upgrade`,
      'plan_limit',
    );

  let kind: Automation['kind'];
  let nextRunAt: Date | null = null;
  let triggerRef: string | null = null;
  if (input.runAt) {
    if (input.runAt.getTime() < Date.now() - 60_000)
      throw new AutomationError('run_at is in the past');
    kind = 'once';
    nextRunAt = input.runAt;
  } else if (input.cron) {
    kind = 'repeat';
    nextRunAt = validateCron(input.cron, tz);
  } else {
    kind = 'event';
    const app = findApp(input.trigger!.app) ?? appForToolkit(input.trigger!.app);
    if (!app) throw new AutomationError(`Unknown app ${input.trigger!.app}`);
    const conn = await connectionForToolkit(input.userId, app.toolkit);
    if (!conn) throw new AutomationError(`Connect ${app.name} first`);
    const res = await composio().createTrigger(
      input.userId,
      input.trigger!.event,
      conn.composioAccountId,
      input.trigger!.config ?? {},
    );
    triggerRef = res.triggerId;
  }

  const [row] = await db()
    .insert(automations)
    .values({
      id: newId('aut'),
      userId: input.userId,
      kind,
      title: input.title,
      instruction: input.instruction,
      runAt: input.runAt ?? null,
      cron: input.cron ?? null,
      timezone: tz,
      trigger: input.trigger ?? null,
      triggerRef,
      preset: input.preset ?? null,
      sessionKey: input.sessionKey,
      nextRunAt,
    })
    .returning();
  await registerTimer(row!);
  await emit(row!);
  return row!;
}

export async function listAutomations(userId: string): Promise<Automation[]> {
  return db()
    .select()
    .from(automations)
    .where(and(eq(automations.userId, userId), isNull(automations.completedAt)))
    .orderBy(desc(automations.id));
}

export async function getAutomation(userId: string, id: string): Promise<Automation | undefined> {
  const [row] = await db()
    .select()
    .from(automations)
    .where(and(eq(automations.userId, userId), eq(automations.id, id)));
  return row;
}

export async function setEnabled(
  userId: string,
  id: string,
  enabled: boolean,
  reason: Automation['pausedReason'] = 'user',
): Promise<Automation | undefined> {
  const existing = await getAutomation(userId, id);
  if (!existing) return undefined;
  const [row] = await db()
    .update(automations)
    .set(
      enabled
        ? { enabled: true, pausedReason: null, failCount: 0 }
        : { enabled: false, pausedReason: reason },
    )
    .where(eq(automations.id, id))
    .returning();
  if (enabled) await registerTimer(row!);
  else await removeTimer(row!);
  await emit(row!);
  return row;
}

/** Deletes an automation; the timer or Composio trigger is removed too. */
export async function deleteAutomation(userId: string, id: string): Promise<boolean> {
  const a = await getAutomation(userId, id);
  if (!a) return false;
  await removeTimer(a);
  if (a.triggerRef) {
    await composio()
      .deleteTrigger(a.triggerRef)
      .catch((err: unknown) => logger().warn({ err: String(err) }, 'delete trigger failed'));
  }
  await db().delete(automations).where(eq(automations.id, id));
  return true;
}

/** Billing hook: pause at 0 credits; un-pause (only those) when credits are added. */
export async function pauseAllForCredits(userId: string): Promise<void> {
  const rows = await db()
    .select()
    .from(automations)
    .where(
      and(
        eq(automations.userId, userId),
        eq(automations.enabled, true),
        isNull(automations.completedAt),
      ),
    );
  for (const a of rows) await setEnabled(userId, a.id, false, 'out_of_credits');
}

export async function resumeAfterCredits(userId: string): Promise<void> {
  const rows = await db()
    .select()
    .from(automations)
    .where(
      and(
        eq(automations.userId, userId),
        eq(automations.pausedReason, 'out_of_credits'),
        isNull(automations.completedAt),
      ),
    );
  for (const a of rows) await setEnabled(userId, a.id, true);
}

export async function findByTriggerRef(triggerRef: string): Promise<Automation | undefined> {
  const [row] = await db().select().from(automations).where(eq(automations.triggerRef, triggerRef));
  return row;
}

export async function recordRun(a: Automation, ok: boolean): Promise<Automation> {
  const failCount = ok ? 0 : a.failCount + 1;
  const patch: Partial<Automation> = { lastRunAt: new Date(), failCount };
  if (a.kind === 'once')
    Object.assign(patch, { completedAt: new Date(), enabled: false, nextRunAt: null });
  if (a.kind === 'repeat' && a.cron) patch.nextRunAt = nextRuns(a.cron, a.timezone ?? 'UTC', 1)[0]!;
  const [row] = await db()
    .update(automations)
    .set(patch)
    .where(eq(automations.id, a.id))
    .returning();
  await emit(row!);
  return row!;
}

/** Worker start / Redis lost: re-register every enabled automation from Postgres. */
export async function reregisterAll(): Promise<number> {
  const rows = await db()
    .select()
    .from(automations)
    .where(and(eq(automations.enabled, true), isNull(automations.completedAt)));
  for (const a of rows) await registerTimer(a);
  return rows.length;
}

export async function deleteUserAutomations(userId: string): Promise<void> {
  const rows = await db().select().from(automations).where(eq(automations.userId, userId));
  for (const a of rows) {
    await removeTimer(a).catch(() => {});
    if (a.triggerRef)
      await composio()
        .deleteTrigger(a.triggerRef)
        .catch(() => {});
  }
  await db().delete(automations).where(eq(automations.userId, userId));
  await db().delete(prReviews).where(eq(prReviews.userId, userId));
}
