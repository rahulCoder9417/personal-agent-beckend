import { isDeepStrictEqual } from 'node:util';
import { CronExpressionParser } from 'cron-parser';
import { and, count, desc, eq, isNull, ne, or } from 'drizzle-orm';
import { db, type Tx } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { logger } from '../../shared/logger.ts';
import { getActiveUser, isValidTimezone, type PlanId } from '../auth/users.ts';
import { automationsChat } from '../channels/conversations.ts';
import { WEB_APP_NAME } from '../channels/purchase-links.ts';
import { publish } from '../channels/stream.ts';
import { parseSessionKey } from '../channels/types.ts';
import { queue } from '../events/queues.ts';
import { appEventProblems } from '../integrations/app-events.ts';
import { appAllowedOnPlan, appForToolkit, findApp } from '../integrations/catalog.ts';
import { connectionForToolkit } from '../integrations/apps.ts';
import { composio } from '../integrations/composio.ts';
import { automationDrafts, automations, prReviews } from './schema.ts';

export type Automation = typeof automations.$inferSelect;

/** Plan limits (Free 1 / Pro 5 / Max 50). Billing's planLimits plugs in via wiring. */
let limitFor: (plan: PlanId) => number = (plan) => ({ free: 1, pro: 5, max: 50 })[plan];
export function setAutomationLimit(fn: (plan: PlanId) => number): void {
  limitFor = fn;
}

/** How many automations a plan allows. */
export function automationLimit(plan: PlanId): number {
  return limitFor(plan);
}

/**
 * The user's automations that count against the plan (every one not finished). `replacing`: one
 * that a change takes the place of, so it does not count. `exec`: in a transaction.
 */
export async function countAutomations(
  userId: string,
  opts: { exec?: Tx; replacing?: string | null } = {},
): Promise<number> {
  const counted = [eq(automations.userId, userId), isNull(automations.completedAt)];
  if (opts.replacing) counted.push(ne(automations.id, opts.replacing));
  const [{ n } = { n: 0 }] = await (opts.exec ?? db())
    .select({ n: count() })
    .from(automations)
    .where(and(...counted));
  return n;
}

/** 15 minutes between runs (HLD 0.4). Tests lower it. */
let minIntervalMs = 15 * 60 * 1000;
export function setMinIntervalMs(ms: number): void {
  minIntervalMs = ms;
}

export class AutomationError extends Error {
  constructor(
    message: string,
    /** `plan_limit`: the plan's automations are used up. `past`: the moment has passed. */
    readonly code: 'invalid' | 'plan_limit' | 'past' = 'invalid',
    /** `plan_limit`: the user's plan and how many automations it allows. */
    readonly details?: { plan: PlanId; limit: number },
  ) {
    super(message);
  }
}

/**
 * Where a copy of each run's answer goes besides the Automations chat: the chat app the automation
 * was made in (its session key). Null for web chat, or a key that names no chat app.
 */
export function copyToOf(sessionKey: string): 'telegram' | 'whatsapp' | 'imessage' | null {
  const channel = parseSessionKey(sessionKey)?.channel;
  return channel && channel !== 'web' ? channel : null;
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
    trigger: a.trigger
      ? { app: a.trigger.app, event: a.trigger.event, config: a.trigger.config ?? {} }
      : null,
    copyTo: copyToOf(a.sessionKey),
    apps: a.apps ?? [],
    askFirst: a.askFirst ?? 'risky',
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

/** The schedule's next `n` times from now, in its time zone. Throws when the line can't be read. */
export function nextCronRuns(cron: string, tz: string, n: number): Date[] {
  return nextRuns(cron, tz, n);
}

/** The schedule's next time from now, in its time zone. Null when the line can't be read. */
export function nextCronRun(cron: string, tz: string): Date | null {
  try {
    return nextRuns(cron, tz, 1)[0] ?? null;
  } catch {
    return null;
  }
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

/**
 * Registers the timer (or trigger) for an enabled automation. Idempotent: a timer that is
 * already there is kept.
 */
export async function registerTimer(a: Automation): Promise<void> {
  if (!a.enabled || a.completedAt) return;
  if (a.kind === 'once' && a.runAt) {
    await queue('scheduled').add(
      'run-automation',
      { automationId: a.id, userId: a.userId },
      { jobId: onceJobId(a), delay: Math.max(0, a.runAt.getTime() - Date.now()) },
    );
  } else if (a.kind === 'repeat' && a.cron) {
    const tz = a.timezone ?? 'UTC';
    // Already set with this schedule, its next job waiting (the worker starting again): left as
    // it is. Setting it again would replace a run that came due while the worker was stopped
    // with the next one, so that run would be lost instead of running late.
    const set = await queue('scheduled').getJobScheduler(schedulerId(a.id));
    if (set?.pattern === a.cron && set.tz === tz && set.next) {
      // BullMQ names a scheduler's job after the slot it is for.
      const next = await queue('scheduled').getJob(`repeat:${schedulerId(a.id)}:${set.next}`);
      if (next) return;
    }
    await queue('scheduled').upsertJobScheduler(
      schedulerId(a.id),
      { pattern: a.cron, tz },
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
  /** The apps its runs may use (app slugs). Empty: any connected app. */
  apps?: string[];
  /** When a run stops for the user's yes (default `risky`). */
  askFirst?: Automation['askFirst'];
  /** False: made switched off, paused by the user ("Save paused"). Default on. */
  enabled?: boolean;
  /** The REST api's idempotency key (made by hand). */
  clientRequestId?: string;
  /** Set only by the platform itself (pr-review.ts), never from the agent's tools. */
  preset?: NonNullable<Automation['preset']>;
}

/** What the checks found: what is saved besides the input. */
export interface CheckedAutomation {
  kind: Automation['kind'];
  timezone: string;
  nextRunAt: Date | null;
  /** kind=event: the Composio connected account the trigger watches (the app's newest). */
  watchAccount: string | null;
}

/** Composio could not make the trigger (a watch on the app). Not one of the checks' refusals. */
export class TriggerError extends Error {}

/** The idempotency key made an automation already (insertAutomation). */
export class DuplicateRequest extends Error {}

/**
 * The checks a save makes, without saving or watching anything: exactly one of a moment, a
 * schedule or an app event; a real time zone; the plan's limit (`replacing`: an automation that
 * the new one takes the place of, so it does not count); a moment not past; a schedule at most
 * every 15 minutes; an app event's app connected. A draft is checked with this when it is proposed,
 * and again when it is saved. `exec`: run the plan's count in a transaction.
 */
export async function checkAutomation(
  input: CreateInput,
  opts: { exec?: Tx; replacing?: string | null } = {},
): Promise<CheckedAutomation> {
  const user = await getActiveUser(input.userId);
  if (!user) throw new AutomationError('User not found');
  const kinds = [input.runAt, input.cron, input.trigger].filter(Boolean).length;
  if (kinds !== 1) throw new AutomationError('Give exactly one of run_at, cron or trigger');
  const tz = input.timezone ?? user.timezone;
  if (!isValidTimezone(tz)) throw new AutomationError(`Unknown timezone ${tz}`);

  const n = await countAutomations(input.userId, opts);
  const limit = limitFor(user.plan);
  if (n >= limit)
    throw new AutomationError(
      `Your ${user.plan} plan allows ${limit} automations; cancel one or upgrade`,
      'plan_limit',
      { plan: user.plan, limit },
    );

  if (input.runAt) {
    if (input.runAt.getTime() < Date.now() - 60_000)
      throw new AutomationError('run_at is in the past', 'past');
    return { kind: 'once', timezone: tz, nextRunAt: input.runAt, watchAccount: null };
  }
  if (input.cron) {
    return {
      kind: 'repeat',
      timezone: tz,
      nextRunAt: validateCron(input.cron, tz),
      watchAccount: null,
    };
  }
  const app = findApp(input.trigger!.app) ?? appForToolkit(input.trigger!.app);
  if (!app) throw new AutomationError(`Unknown app ${input.trigger!.app}`);
  if (!appAllowedOnPlan(app, user.plan))
    throw new AutomationError(`${app.name} is not on the ${user.plan} plan`);
  const conn = await connectionForToolkit(input.userId, app.toolkit);
  if (!conn) throw new AutomationError(`Connect ${app.name} first`);
  // The event must be one the app offers, its required settings filled (when Composio can say).
  // Pull-request review is the platform's own, with its settings made by the platform.
  if (!input.preset) {
    const wrong = await appEventProblems(
      app.toolkit,
      app.name,
      input.trigger!.event,
      input.trigger!.config ?? {},
    );
    if (wrong?.length) throw new AutomationError(wrong.join(' '));
  }
  return { kind: 'event', timezone: tz, nextRunAt: null, watchAccount: conn.composioAccountId };
}

/**
 * Saves a checked automation: for an app event, Composio's trigger first (a TriggerError when
 * Composio refuses), then the row. `made.triggerRef` holds the trigger made, so a caller whose
 * transaction fails afterwards can remove it. Nothing is registered here (activateAutomation).
 */
export async function insertAutomation(
  input: CreateInput,
  checked: CheckedAutomation,
  exec: Tx = db(),
  made: { triggerRef?: string } = {},
): Promise<Automation> {
  let triggerRef: string | null = null;
  if (checked.kind === 'event') {
    try {
      triggerRef = (
        await composio().createTrigger(
          input.userId,
          input.trigger!.event,
          checked.watchAccount!,
          input.trigger!.config ?? {},
        )
      ).triggerId;
    } catch (err) {
      throw new TriggerError(String(err));
    }
    made.triggerRef = triggerRef;
  }
  const enabled = input.enabled !== false;
  try {
    const [row] = await exec
      .insert(automations)
      .values({
        id: newId('aut'),
        userId: input.userId,
        kind: checked.kind,
        title: input.title,
        instruction: input.instruction,
        runAt: input.runAt ?? null,
        cron: input.cron ?? null,
        timezone: checked.timezone,
        trigger: input.trigger ?? null,
        triggerRef,
        preset: input.preset ?? null,
        apps: input.apps ?? [],
        askFirst: input.askFirst ?? 'risky',
        clientRequestId: input.clientRequestId ?? null,
        sessionKey: input.sessionKey,
        enabled,
        pausedReason: enabled ? null : 'user',
        nextRunAt: checked.nextRunAt,
      })
      // Only the idempotency key can clash: the same request made one already (DuplicateRequest).
      .onConflictDoNothing()
      .returning();
    if (!row) throw new DuplicateRequest();
    return row;
  } catch (err) {
    if (triggerRef) await dropTrigger(triggerRef);
    delete made.triggerRef;
    throw err;
  }
}

/** Removes a Composio trigger, best effort (logged when Composio refuses). */
export async function dropTrigger(triggerRef: string): Promise<void> {
  await composio()
    .deleteTrigger(triggerRef)
    .catch((err: unknown) => logger().warn({ err: String(err) }, 'delete trigger failed'));
}

/**
 * A saved automation goes live: its timer is set (none while paused, and an app event's watch was
 * made with it), the web app is told, and the user's Automations chat is started if they have none
 * yet, so the web app can show where the results will be (the first run starts it otherwise).
 */
export async function activateAutomation(row: Automation): Promise<void> {
  await registerTimer(row);
  await emit(row);
  await automationsChat(row.userId).catch((err: unknown) =>
    logger().warn({ userId: row.userId, err: String(err) }, 'automations chat not started'),
  );
}

/** Checks plan limit, 15-minute minimum and timezone → saves → registers the timer. */
export async function createAutomation(input: CreateInput): Promise<Automation> {
  const checked = await checkAutomation(input);
  const row = await insertAutomation(input, checked);
  await activateAutomation(row);
  return row;
}

/** Two app events watch the same thing: the same app, event and settings. */
function sameWatch(a: Automation['trigger'], b: CreateInput['trigger']): boolean {
  if (!a || !b) return false;
  const app = (x: string) => (findApp(x) ?? appForToolkit(x))?.toolkit ?? x.toLowerCase();
  return (
    app(a.app) === app(b.app) &&
    a.event.toUpperCase() === b.event.toUpperCase() &&
    isDeepStrictEqual(a.config ?? {}, b.config ?? {})
  );
}

/**
 * Changes a saved automation in place, inside the caller's transaction (which locked the row and
 * ran the checks): its parts, when it runs and where results go. Its id, its page and its runs
 * stay. A changed app event gets its new watch at Composio FIRST (a TriggerError when Composio
 * refuses, with nothing changed); `made.triggerRef` holds it, so a caller whose transaction fails
 * afterwards can remove it. The old watch is removed only after the change is saved (afterChange).
 * `enabled` left out keeps it on or paused as it is. Failures in a row start again from zero.
 */
export async function updateAutomationInTx(
  tx: Tx,
  existing: Automation,
  input: CreateInput,
  checked: CheckedAutomation,
  opts: { enabled?: boolean },
  made: { triggerRef?: string } = {},
): Promise<Automation> {
  let triggerRef: string | null = null;
  if (checked.kind === 'event') {
    const keep =
      existing.kind === 'event' &&
      existing.triggerRef &&
      sameWatch(existing.trigger, input.trigger);
    if (keep) triggerRef = existing.triggerRef;
    else {
      try {
        triggerRef = (
          await composio().createTrigger(
            input.userId,
            input.trigger!.event,
            checked.watchAccount!,
            input.trigger!.config ?? {},
          )
        ).triggerId;
      } catch (err) {
        throw new TriggerError(String(err));
      }
      made.triggerRef = triggerRef;
    }
  }
  const state =
    opts.enabled === undefined
      ? {}
      : opts.enabled
        ? { enabled: true, pausedReason: null }
        : { enabled: false, pausedReason: 'user' as const };
  const [row] = await tx
    .update(automations)
    .set({
      kind: checked.kind,
      title: input.title,
      instruction: input.instruction,
      runAt: input.runAt ?? null,
      cron: input.cron ?? null,
      timezone: checked.timezone,
      trigger: input.trigger ?? null,
      triggerRef,
      apps: input.apps ?? [],
      askFirst: input.askFirst ?? 'risky',
      sessionKey: input.sessionKey,
      nextRunAt: checked.nextRunAt,
      failCount: 0,
      ...state,
    })
    .where(and(eq(automations.id, existing.id), eq(automations.userId, existing.userId)))
    .returning();
  return row!;
}

/**
 * After a change is saved: the old timer goes and the new one is set (none while paused), the old
 * watch at Composio is removed if the change replaced it, and the web app is told.
 */
export async function afterChange(before: Automation, after: Automation): Promise<void> {
  await removeTimer(before);
  await registerTimer(after);
  if (before.triggerRef && before.triggerRef !== after.triggerRef)
    await dropTrigger(before.triggerRef);
  await emit(after);
}

/**
 * Where an automation's runs answer, in words for the agent to tell the user: always the
 * Automations chat; made in a chat app (Telegram), a copy of each answer there too.
 */
export function whereRunsAnswer(a: Pick<Automation, 'sessionKey'>): string {
  const chat = parseSessionKey(a.sessionKey)?.channel;
  const app = chat === 'telegram' ? 'Telegram' : chat === 'whatsapp' ? 'WhatsApp' : 'iMessage';
  return (
    `Each run answers in the Automations chat in ${WEB_APP_NAME}, never in the user's other chats` +
    (chat && chat !== 'web' ? `, and a copy of each answer is sent to this ${app} chat.` : '.')
  );
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

/**
 * An admin suspended the account: every automation that is on, or paused for lack of credits, is
 * paused with the reason `suspended` (no timer; app events for it are ignored). Ones the user paused,
 * or that were paused after failures, stay as they are. Safe to run again. Returns how many
 * changed.
 */
export async function pauseAllForAdmin(userId: string): Promise<number> {
  const rows = await db()
    .select()
    .from(automations)
    .where(
      and(
        eq(automations.userId, userId),
        isNull(automations.completedAt),
        or(eq(automations.enabled, true), eq(automations.pausedReason, 'out_of_credits')),
      ),
    );
  for (const a of rows) await setEnabled(userId, a.id, false, 'suspended');
  return rows.length;
}

/**
 * The suspension was lifted: the automations it paused come back. With credits they are switched
 * on; at zero they wait, paused for lack of credits, and come back with the next credits like any
 * other. Safe to run again.
 */
export async function resumeAfterAdmin(
  userId: string,
  hasCredits: boolean,
): Promise<{ resumed: number; waitingForCredits: number }> {
  const rows = await db()
    .select()
    .from(automations)
    .where(
      and(
        eq(automations.userId, userId),
        eq(automations.pausedReason, 'suspended'),
        isNull(automations.completedAt),
      ),
    );
  for (const a of rows) {
    if (hasCredits) await setEnabled(userId, a.id, true);
    else await setEnabled(userId, a.id, false, 'out_of_credits');
  }
  return hasCredits
    ? { resumed: rows.length, waitingForCredits: 0 }
    : { resumed: 0, waitingForCredits: rows.length };
}

export async function findByTriggerRef(triggerRef: string): Promise<Automation | undefined> {
  const [row] = await db().select().from(automations).where(eq(automations.triggerRef, triggerRef));
  return row;
}

/** Every field we set on a trigger has the same value in Composio's (which may add defaults). */
function sameTriggerConfig(
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
): boolean {
  return Object.entries(ours).every(([k, v]) => isDeepStrictEqual(theirs[k], v));
}

/**
 * Moves the user's app-event automations of one app from one Composio connected account to
 * another: the same account of that app was connected again, and the older connection is about
 * to be removed (integrations/connection-replace.ts). For each automation: a trigger on the new
 * account, the automation pointed at it, then the old trigger removed.
 *
 * Which automations watch the old account is asked of Composio, by their trigger ids. Safe to
 * re-run: an automation already on another account is left alone, and a trigger an earlier run
 * made on the new account before it stopped is used instead of making another. A Composio failure
 * throws, so the job is tried again. Returns how many automations moved.
 */
export async function moveAppTriggers(input: {
  userId: string;
  toolkit: string;
  from: string;
  to: string;
}): Promise<number> {
  const all = await db()
    .select()
    .from(automations)
    .where(and(eq(automations.userId, input.userId), eq(automations.kind, 'event')));
  const ofApp = all.filter((a) => {
    if (!a.triggerRef || !a.trigger) return false;
    const app = findApp(a.trigger.app) ?? appForToolkit(a.trigger.app);
    return app?.toolkit === input.toolkit;
  });
  if (!ofApp.length) return 0;

  const watched = await composio().listTriggers({ triggerIds: ofApp.map((a) => a.triggerRef!) });
  const onOld = new Set(
    watched.filter((t) => t.connectedAccountId === input.from).map((t) => t.id),
  );
  const toMove = ofApp.filter((a) => onOld.has(a.triggerRef!));
  if (!toMove.length) return 0;

  // Triggers already on the new account that no automation of this user points at: left by an
  // earlier run that stopped between making one and saving it.
  const inUse = new Set(all.map((a) => a.triggerRef).filter(Boolean));
  const spare = (await composio().listTriggers({ connectedAccountIds: [input.to] })).filter(
    (t) => !inUse.has(t.id),
  );

  let moved = 0;
  for (const a of toMove) {
    const event = a.trigger!.event;
    const config = a.trigger!.config ?? {};
    const i = spare.findIndex((t) => t.slug === event && sameTriggerConfig(config, t.config));
    const reused = i >= 0 ? spare.splice(i, 1)[0]!.id : null;
    const newRef =
      reused ?? (await composio().createTrigger(input.userId, event, input.to, config)).triggerId;
    const [saved] = await db()
      .update(automations)
      .set({ triggerRef: newRef })
      .where(and(eq(automations.id, a.id), eq(automations.triggerRef, a.triggerRef!)))
      .returning({ id: automations.id });
    if (!saved) {
      // Changed or deleted meanwhile: the trigger just made is not needed.
      if (!reused)
        await composio()
          .deleteTrigger(newRef)
          .catch((err: unknown) => logger().warn({ err: String(err) }, 'delete trigger failed'));
      continue;
    }
    await composio()
      .deleteTrigger(a.triggerRef!)
      .catch((err: unknown) => logger().warn({ err: String(err) }, 'delete trigger failed'));
    moved++;
  }
  if (moved)
    logger().info(
      { userId: input.userId, toolkit: input.toolkit, moved },
      'automations moved to the new connection',
    );
  return moved;
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
  await db().delete(automationDrafts).where(eq(automationDrafts.userId, userId));
}
