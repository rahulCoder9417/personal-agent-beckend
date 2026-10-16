// Building and changing an automation by hand, on the canvas (docs/backend-report.md, "Building
// one by hand"): check the parts without saving (every problem at once, each with the box of the
// canvas it belongs to, and the next three run times), make one (once per idempotency key), change
// one in place, and run one once now as a test. The checks are the same as a save of a draft's:
// this file finds all of them at once instead of stopping at the first.
import { and, count, eq, gt, ne, sql } from 'drizzle-orm';
import { isChannelEnabled } from '../../shared/config.ts';
import { db, type Tx } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { logger } from '../../shared/logger.ts';
import { audit } from '../admin/audit.ts';
import { listLinks } from '../auth/links.ts';
import { getActiveUser, isValidTimezone, type PlanId } from '../auth/users.ts';
import { parseSessionKey } from '../channels/types.ts';
import { findEvent, ingestEvent } from '../events/intake.ts';
import { appEventProblems } from '../integrations/app-events.ts';
import { connectionForToolkit } from '../integrations/apps.ts';
import { appAllowedOnPlan, appForToolkit, findApp } from '../integrations/catalog.ts';
import {
  activateAutomation,
  AutomationError,
  afterChange,
  automationLimit,
  countAutomations,
  DuplicateRequest,
  dropTrigger,
  getAutomation,
  insertAutomation,
  nextCronRuns,
  TriggerError,
  updateAutomationInTx,
  validateCron,
  type Automation,
  type CheckedAutomation,
  type CreateInput,
} from './automations.ts';
import {
  DRAFT_TTL_MS,
  DraftError,
  emitDraft,
  getDraft,
  MAX_OPEN_DRAFTS,
  notOpen,
  statusOf,
  type Draft,
} from './drafts.ts';
import { automationDrafts, automations, type DraftTrigger } from './schema.ts';

export type Step = 'trigger' | 'instruction' | 'apps' | 'asks' | 'results';
export type CopyTo = 'telegram' | 'whatsapp' | 'imessage';

/** The parts of an automation as the canvas holds them (any of them may be missing). */
export interface Parts {
  title?: string;
  instruction?: string;
  runAt?: Date | null;
  cron?: string | null;
  timezone?: string | null;
  trigger?: DraftTrigger | null;
  apps?: string[];
  askFirst?: Automation['askFirst'];
  copyTo?: CopyTo | null;
}

/** One thing wrong with the parts, for the box it belongs to (null: the whole, the plan). */
export interface Problem {
  step: Step | null;
  code: 'invalid' | 'plan_limit' | 'past';
  message: string;
}

/** Why a save by hand was refused. */
export class ManualError extends Error {
  constructor(
    message: string,
    /**
     * `problems`: the checks found these (`problems`). `not_found`: no such automation or draft.
     * `conflict`: it can't be changed so (pull-request review, finished, the draft not open).
     * `unavailable`: Composio could not make the watch just now.
     */
    readonly code: 'problems' | 'not_found' | 'conflict' | 'unavailable',
    readonly problems: Problem[] = [],
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const PLAN_NAMES: Record<PlanId, string> = { free: 'Free', pro: 'Pro', max: 'Max' };
const CHANNEL_NAMES: Record<CopyTo, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  imessage: 'iMessage',
};
const appOf = (name: string) => findApp(name) ?? appForToolkit(name);

/** What the checks found, and what a save would be made of when nothing is wrong. */
export interface Examined {
  problems: Problem[];
  plan: PlanId;
  kind: Automation['kind'] | null;
  /** When it would run: the moment, or the schedule's next three. */
  nextRuns: Date[];
  /** Set when there are no problems. */
  input?: CreateInput;
  checked?: CheckedAutomation;
}

/**
 * Where the copy of each answer goes, as the session key the automation keeps: the web app only
 * (`web`), or a linked chat of that chat app. The one it was made in is kept when it is of the
 * same app. A string: what is wrong, for the Results box.
 */
async function copySessionKey(
  userId: string,
  copyTo: CopyTo | null | undefined,
  current: string | null,
): Promise<{ sessionKey: string } | string> {
  if (!copyTo) return { sessionKey: 'web' };
  const name = CHANNEL_NAMES[copyTo];
  if (!isChannelEnabled(copyTo)) return `${name} is switched off, so no copy can go there.`;
  if (current && parseSessionKey(current)?.channel === copyTo) return { sessionKey: current };
  const link = (await listLinks(userId)).find((l) => l.channel === copyTo && !l.blocked);
  if (!link)
    return `No ${name} chat is linked to your account. Link one in Settings, under Chats, to get a copy there.`;
  return { sessionKey: `${copyTo}:${link.externalId}` };
}

/**
 * Every check a save makes, all at once, without saving or watching anything. `replacing`: the
 * automation these parts would change (it does not count against the plan, and its chat is kept
 * for the copy). `exec`: count the plan's automations in this transaction.
 */
export async function examine(
  userId: string,
  parts: Parts,
  opts: { replacing?: Automation | null; exec?: Tx } = {},
): Promise<Examined> {
  const user = await getActiveUser(userId);
  if (!user) throw new ManualError('User not found', 'not_found');
  const problems: Problem[] = [];
  const say = (step: Step | null, message: string, code: Problem['code'] = 'invalid') =>
    problems.push({ step, code, message });

  // Tex's instruction.
  const title = (parts.title ?? '').trim();
  const instruction = (parts.instruction ?? '').trim();
  if (!title) say('instruction', 'Give it a title.');
  if (!instruction) say('instruction', 'Write what Tex should do each time it runs.');

  // The trigger: exactly one of a moment, a schedule or an app event.
  const ways = [parts.runAt, parts.cron?.trim(), parts.trigger].filter(Boolean).length;
  const kind: Examined['kind'] =
    ways !== 1 ? null : parts.runAt ? 'once' : parts.cron?.trim() ? 'repeat' : 'event';
  if (ways === 0)
    say('trigger', 'Pick when it runs: once, on a schedule, or when something happens in an app.');
  if (ways > 1) say('trigger', 'Pick only one way for it to run.');
  const tz = parts.timezone?.trim() || user.timezone;
  const tzOk = isValidTimezone(tz);
  if (kind !== 'event' && !tzOk) say('trigger', `"${tz}" is not a time zone we know.`);
  let nextRuns: Date[] = [];
  let watchAccount: string | null = null;
  if (kind === 'once') {
    const at = parts.runAt!;
    if (at.getTime() < Date.now() - 60_000)
      say('trigger', 'That moment has passed. Pick a later one.', 'past');
    nextRuns = [at];
  } else if (kind === 'repeat' && tzOk) {
    try {
      validateCron(parts.cron!.trim(), tz);
      nextRuns = nextCronRuns(parts.cron!.trim(), tz, 3);
    } catch (err) {
      say('trigger', err instanceof AutomationError ? cronWords(err.message) : String(err));
    }
  } else if (kind === 'event') {
    const t = parts.trigger!;
    const app = t.app ? appOf(t.app) : undefined;
    if (!app) say('trigger', 'Pick the app to watch.');
    else if (!appAllowedOnPlan(app, user.plan))
      say('trigger', `${app.name} isn't on your ${PLAN_NAMES[user.plan]} plan. Upgrade to use it.`);
    else {
      const [conn, wrong] = await Promise.all([
        connectionForToolkit(userId, app.toolkit),
        t.event?.trim()
          ? appEventProblems(app.toolkit, app.name, t.event.trim(), t.config ?? {})
          : Promise.resolve(['Pick the event to watch for.']),
      ]);
      if (!conn) say('trigger', `Connect ${app.name} first, under Integrations, Apps.`);
      else watchAccount = conn.composioAccountId;
      for (const m of wrong ?? []) say('trigger', m);
    }
  }

  // The apps it may use: known, on the plan, connected. Once each, by slug.
  const apps: string[] = [];
  for (const name of parts.apps ?? []) {
    const app = appOf(name);
    if (!app) {
      say('apps', `"${name}" is not an app we know.`);
      continue;
    }
    if (apps.includes(app.slug)) continue;
    apps.push(app.slug);
    if (!appAllowedOnPlan(app, user.plan))
      say('apps', `${app.name} isn't on your ${PLAN_NAMES[user.plan]} plan.`);
    else if (!(await connectionForToolkit(userId, app.toolkit)))
      say('apps', `${app.name} is not connected. Connect it under Integrations, Apps.`);
  }

  // Where the results go.
  const copy = await copySessionKey(userId, parts.copyTo, opts.replacing?.sessionKey ?? null);
  if (typeof copy === 'string') say('results', copy);

  // The plan's number of automations (a change does not count itself).
  const n = await countAutomations(userId, {
    ...(opts.exec ? { exec: opts.exec } : {}),
    replacing: opts.replacing?.id ?? null,
  });
  const limit = automationLimit(user.plan);
  if (n >= limit) problems.push(planProblem(user.plan));

  const plan = user.plan;
  if (problems.length || !kind || typeof copy === 'string')
    return { problems, plan, kind, nextRuns };
  const input: CreateInput = {
    userId,
    title,
    instruction,
    sessionKey: copy.sessionKey,
    timezone: tz,
    ...(kind === 'once' ? { runAt: parts.runAt! } : {}),
    ...(kind === 'repeat' ? { cron: parts.cron!.trim() } : {}),
    ...(kind === 'event'
      ? {
          trigger: {
            app: appOf(parts.trigger!.app)!.slug,
            event: parts.trigger!.event.trim(),
            config: parts.trigger!.config ?? {},
          },
        }
      : {}),
    apps,
    askFirst: parts.askFirst ?? 'risky',
  };
  const checked: CheckedAutomation = {
    kind,
    timezone: tz,
    nextRunAt: kind === 'event' ? null : (nextRuns[0] ?? null),
    watchAccount,
  };
  return { problems, plan, kind, nextRuns, input, checked };
}

/** The plan's automations are all in use. */
function planProblem(plan: PlanId): Problem {
  const limit = automationLimit(plan);
  return {
    step: null,
    code: 'plan_limit',
    message: `Your ${PLAN_NAMES[plan]} plan allows ${limit} automation${limit === 1 ? '' : 's'}, and ${limit === 1 ? 'it is' : 'they are'} in use. Delete one or upgrade.`,
  };
}

/** The schedule's refusals, in the canvas's words. */
function cronWords(message: string): string {
  if (message === 'Invalid cron expression')
    return "That schedule line can't be read. It has five parts: minute, hour, day of the month, month, day of the week.";
  return message.replace(/^Automations can run/, 'An automation can run');
}

/** The refusal for problems found at a save: the plan's limit first (403), else all of them (400). */
function refuse(problems: Problem[]): ManualError {
  const plan = problems.find((p) => p.code === 'plan_limit');
  return new ManualError(plan?.message ?? problems[0]!.message, 'problems', problems);
}

/** One user's saves by hand wait for each other, so two at once can't pass the plan's limit. */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`automations:${userId}`}))`);
}

/** The draft open on the canvas, locked, for a save that marks it saved. */
async function lockOpenDraft(tx: Tx, userId: string, draftId: string): Promise<Draft> {
  const [d] = await tx
    .select()
    .from(automationDrafts)
    .where(and(eq(automationDrafts.userId, userId), eq(automationDrafts.id, draftId)))
    .for('update');
  if (!d) throw new ManualError('Draft not found', 'not_found');
  const status = statusOf(d);
  if (status !== 'open') {
    const e = notOpen(d, status);
    throw new ManualError(e.message, 'conflict', [], e.details);
  }
  return d;
}

async function markDraftSaved(tx: Tx, d: Draft, automationId: string): Promise<Draft> {
  const [done] = await tx
    .update(automationDrafts)
    .set({ status: 'saved', automationId, decidedAt: new Date() })
    .where(eq(automationDrafts.id, d.id))
    .returning();
  return done!;
}

async function byRequest(userId: string, clientRequestId: string, exec: Tx = db()) {
  const [row] = await exec
    .select()
    .from(automations)
    .where(and(eq(automations.userId, userId), eq(automations.clientRequestId, clientRequestId)));
  return row;
}

const unavailable = (appSlug: string | undefined) =>
  new ManualError(
    `Couldn't set up the watch in ${(appSlug && appOf(appSlug)?.name) || 'the app'} just now. Try again in a moment.`,
    'unavailable',
  );

/**
 * Makes an automation from the canvas. With a `clientRequestId` seen before, returns the
 * automation it made and makes nothing (`created: false`). `draftId`: the draft open on the
 * canvas, marked saved with it (it must be open, and not a change). Throws ManualError.
 */
export async function createByHand(
  userId: string,
  body: Parts & { enabled?: boolean; draftId?: string | null; clientRequestId: string },
): Promise<{ automation: Automation; created: boolean }> {
  const seen = await byRequest(userId, body.clientRequestId);
  if (seen) return { automation: seen, created: false };
  const found = await examine(userId, body);
  if (found.problems.length) throw refuse(found.problems);
  const input: CreateInput = {
    ...found.input!,
    enabled: body.enabled !== false,
    clientRequestId: body.clientRequestId,
  };
  const made: { triggerRef?: string } = {};
  let result: { automation: Automation; created: boolean; draft: Draft | null };
  try {
    result = await db().transaction(async (tx) => {
      await lockUser(tx, userId);
      const again = await byRequest(userId, body.clientRequestId, tx);
      if (again) return { automation: again, created: false, draft: null };
      // The plan's limit again, now that the user's other saves wait.
      if ((await countAutomations(userId, { exec: tx })) >= automationLimit(found.plan))
        throw refuse([planProblem(found.plan)]);
      const d = body.draftId ? await lockOpenDraft(tx, userId, body.draftId) : null;
      if (d?.changeOf)
        throw new ManualError(
          'This draft changes an automation: save it on that automation.',
          'conflict',
          [],
          { changeOf: d.changeOf },
        );
      let automation: Automation;
      try {
        automation = await insertAutomation(input, found.checked!, tx, made);
      } catch (err) {
        if (err instanceof TriggerError) throw unavailable(input.trigger?.app);
        throw err;
      }
      const draft = d ? await markDraftSaved(tx, d, automation.id) : null;
      return { automation, created: true, draft };
    });
  } catch (err) {
    if (made.triggerRef) await dropTrigger(made.triggerRef);
    if (err instanceof DuplicateRequest) {
      const other = await byRequest(userId, body.clientRequestId);
      if (other) return { automation: other, created: false };
    }
    throw err;
  }
  if (!result.created) return result;
  await activateAutomation(result.automation);
  if (result.draft) await emitDraft(result.draft);
  await audit({
    userId,
    actor: 'user',
    action: 'automation_saved',
    summary: `Made the automation "${result.automation.title}"${input.enabled === false ? ' (paused)' : ''}`,
    details: {
      automationId: result.automation.id,
      via: 'web:canvas',
      ...(result.draft ? { draftId: result.draft.id } : {}),
    },
  });
  return result;
}

/** The automation, if it may be changed by hand: the user's own, not review, not finished. */
async function changeable(userId: string, id: string, exec: Tx = db()): Promise<Automation> {
  const [a] = await exec
    .select()
    .from(automations)
    .where(and(eq(automations.userId, userId), eq(automations.id, id)))
    .for('update');
  if (!a) throw new ManualError('Automation not found', 'not_found');
  if (a.preset === 'pr_review')
    throw new ManualError(
      'Pull-request review is changed on its own screen: Automations, Pull-request review.',
      'conflict',
    );
  if (a.completedAt)
    throw new ManualError('This one-time reminder has run, so it is finished.', 'conflict');
  return a;
}

/**
 * Changes an automation in place from the canvas: the checks, then (for a changed app event) the
 * new watch first, the change saved, the old watch removed. `enabled` left out keeps it on or
 * paused. `draftId`: the draft of this change open on the canvas, marked saved with it.
 */
export async function changeByHand(
  userId: string,
  id: string,
  body: Parts & { enabled?: boolean; draftId?: string | null },
): Promise<Automation> {
  const before = await changeable(userId, id);
  const found = await examine(userId, body, { replacing: before });
  if (found.problems.length) throw refuse(found.problems);
  const made: { triggerRef?: string } = {};
  let saved: { before: Automation; after: Automation; draft: Draft | null };
  try {
    saved = await db().transaction(async (tx) => {
      await lockUser(tx, userId);
      const locked = await changeable(userId, id, tx);
      const d = body.draftId ? await lockOpenDraft(tx, userId, body.draftId) : null;
      if (d && d.changeOf !== id)
        throw new ManualError('This draft is not a change of this automation.', 'conflict', [], {
          changeOf: d.changeOf,
        });
      let after: Automation;
      try {
        after = await updateAutomationInTx(
          tx,
          locked,
          found.input!,
          found.checked!,
          body.enabled === undefined ? {} : { enabled: body.enabled },
          made,
        );
      } catch (err) {
        if (err instanceof TriggerError) throw unavailable(found.input!.trigger?.app);
        throw err;
      }
      const draft = d ? await markDraftSaved(tx, d, after.id) : null;
      return { before: locked, after, draft };
    });
  } catch (err) {
    if (made.triggerRef) await dropTrigger(made.triggerRef);
    throw err;
  }
  await afterChange(saved.before, saved.after);
  if (saved.draft) await emitDraft(saved.draft);
  await audit({
    userId,
    actor: 'user',
    action: 'automation_changed',
    summary: `Changed the automation "${saved.after.title}"`,
    details: {
      automationId: id,
      via: 'web:canvas',
      ...(saved.draft ? { draftId: saved.draft.id } : {}),
    },
  });
  return saved.after;
}

/** Test runs per user per hour ("Run once now"). */
export const TEST_RUNS_PER_HOUR = 10;

/**
 * "Run once now": queues one test run of a saved automation, on or paused, as an inbound event
 * (the worker runs it: runTestTurn in jobs.ts). One `clientRequestId`, one run: the same key again
 * answers with that run. `beforeNew` runs only for a new run (the caller's credit check and hourly
 * limit, so a repeated click doesn't count twice).
 */
export async function queueTestRun(
  userId: string,
  id: string,
  clientRequestId: string,
  beforeNew: () => Promise<void> = async () => {},
): Promise<{ automation: Automation; eventId: string; duplicate: boolean }> {
  const a = await getAutomation(userId, id);
  if (!a) throw new ManualError('Automation not found', 'not_found');
  if (a.preset === 'pr_review')
    throw new ManualError(
      'Pull-request review runs when a pull request opens; it has no test run.',
      'conflict',
    );
  if (a.completedAt)
    throw new ManualError('This one-time reminder has run, so it is finished.', 'conflict');
  const externalId = `${a.id}:test:${clientRequestId}`;
  const seen = await findEvent('automation', externalId);
  if (seen && seen.userId === userId) return { automation: a, eventId: seen.id, duplicate: true };
  await beforeNew();
  const { eventId, duplicate } = await ingestEvent({
    source: 'automation',
    externalId,
    type: 'test',
    userId,
    payload: { automationId: a.id, test: true, requestedAt: new Date().toISOString() },
    queue: 'inbound',
    jobName: 'automation-turn',
    jobData: { automationId: a.id, test: true },
  });
  if (!duplicate)
    await audit({
      userId,
      actor: 'user',
      action: 'automation_test_run',
      summary: `Ran the automation "${a.title}" once now, as a test`,
      details: { automationId: a.id, eventId },
    }).catch((err: unknown) => logger().warn({ userId, err: String(err) }, 'audit failed'));
  return { automation: a, eventId, duplicate };
}

/**
 * "Ask Tex to change this": the parts as they stand on the canvas, kept as a draft of the user's
 * own (`madeBy: user`) for Tex to read and propose again. Nothing runs and nothing is posted in a
 * chat. Only its shape is checked (one of a moment, a schedule or an app event; a time zone we
 * know; apps we know), since the point is for Tex to fix the rest. `replaces`: the open draft the
 * user started from, which becomes `replaced`. Counts towards the 20 open drafts. Throws
 * DraftError.
 */
export async function createUserDraft(
  userId: string,
  body: Parts & { changeOf?: string | null; replaces?: string | null },
): Promise<{ draft: Draft; replaced: Draft | null }> {
  const user = await getActiveUser(userId);
  if (!user) throw new DraftError('User not found', 'not_found');
  const ways = [body.runAt, body.cron?.trim(), body.trigger].filter(Boolean).length;
  if (ways !== 1)
    throw new DraftError(
      'Pick one way for it to run (once, a schedule or an app event) before asking Tex.',
      'invalid',
    );
  const kind: Draft['kind'] = body.runAt ? 'once' : body.cron?.trim() ? 'repeat' : 'event';
  const timezone = body.timezone?.trim() || user.timezone;
  if (!isValidTimezone(timezone))
    throw new DraftError(`"${timezone}" is not a time zone we know.`, 'invalid');
  const apps: string[] = [];
  for (const name of body.apps ?? []) {
    const app = appOf(name);
    if (!app) throw new DraftError(`"${name}" is not an app we know.`, 'invalid');
    if (!apps.includes(app.slug)) apps.push(app.slug);
  }
  let current: Automation | undefined;
  if (body.changeOf) {
    current = await getAutomation(userId, body.changeOf);
    if (!current || current.completedAt || current.preset === 'pr_review')
      throw new DraftError('That automation can not be changed with a draft.', 'invalid');
  }
  const old = body.replaces ? await getDraft(userId, body.replaces) : undefined;
  if (body.replaces && !old) throw new DraftError('That draft is not here.', 'invalid');
  // The copy goes where the canvas says when it can; otherwise only the Automations chat.
  const copy = await copySessionKey(userId, body.copyTo, current?.sessionKey ?? null);
  const sessionKey = typeof copy === 'string' ? 'web' : copy.sessionKey;

  const now = new Date();
  const open = [
    eq(automationDrafts.userId, userId),
    eq(automationDrafts.status, 'open'),
    gt(automationDrafts.expiresAt, now),
  ];
  if (old) open.push(ne(automationDrafts.id, old.id));
  const [{ n } = { n: 0 }] = await db()
    .select({ n: count() })
    .from(automationDrafts)
    .where(and(...open));
  if (n >= MAX_OPEN_DRAFTS)
    throw new DraftError(
      `You have ${MAX_OPEN_DRAFTS} drafts waiting. Save or discard some on the Automations page first.`,
      'too_many',
    );

  const { draft, replaced } = await db().transaction(async (tx) => {
    const [made] = await tx
      .insert(automationDrafts)
      .values({
        id: newId('drf'),
        userId,
        madeBy: 'user',
        changeOf: body.changeOf ?? old?.changeOf ?? null,
        kind,
        title: (body.title ?? '').trim() || 'New automation',
        instruction: (body.instruction ?? '').trim(),
        runAt: kind === 'once' ? body.runAt! : null,
        cron: kind === 'repeat' ? body.cron!.trim() : null,
        timezone,
        trigger:
          kind === 'event'
            ? {
                app: appOf(body.trigger!.app)?.slug ?? body.trigger!.app,
                event: body.trigger!.event,
                config: body.trigger!.config ?? {},
              }
            : null,
        apps,
        askFirst: body.askFirst ?? 'risky',
        sessionKey,
        expiresAt: new Date(now.getTime() + DRAFT_TTL_MS),
      })
      .returning();
    const [gone] = old
      ? await tx
          .update(automationDrafts)
          .set({ status: 'replaced', replacedBy: made!.id, decidedAt: now })
          .where(
            and(
              eq(automationDrafts.userId, userId),
              eq(automationDrafts.id, old.id),
              eq(automationDrafts.status, 'open'),
              gt(automationDrafts.expiresAt, now),
            ),
          )
          .returning()
      : [];
    return { draft: made!, replaced: gone ?? null };
  });
  await emitDraft(draft);
  if (replaced) await emitDraft(replaced);
  return { draft, replaced };
}
