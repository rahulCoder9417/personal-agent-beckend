// Automation drafts (docs/backend-report.md, "Drafts"): an automation the agent proposed
// (propose_automation) that the user has not saved. A draft never runs: no timer, no watch at
// Composio. It is checked as a save would check it, posted in the chat it was asked in (a card in
// web chat; an outline, the link and a Save button in a chat app), and only the user's Save makes
// the automation. Open for 7 days, at most 20 open per user; asked again, the old one is replaced.
import { and, count, desc, eq, gt, lt, lte, ne } from 'drizzle-orm';
import { config } from '../../shared/config.ts';
import { db } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { logger } from '../../shared/logger.ts';
import { audit } from '../admin/audit.ts';
import type { PlanId } from '../auth/users.ts';
import type { MessageRow } from '../channels/messages.ts';
import { queueOutbound } from '../channels/outbound.ts';
import { publish } from '../channels/stream.ts';
import { parseSessionKey, type InboundMessage } from '../channels/types.ts';
import { appForToolkit, findApp } from '../integrations/catalog.ts';
import { connectionForToolkit } from '../integrations/apps.ts';
import { turnMessageFields } from '../orchestrator/turn.ts';
import {
  activateAutomation,
  AutomationError,
  checkAutomation,
  copyToOf,
  deleteAutomation,
  dropTrigger,
  getAutomation,
  insertAutomation,
  nextCronRun,
  TriggerError,
  type Automation,
  type CreateInput,
} from './automations.ts';
import { describeDueTime } from './jobs.ts';
import { automationDrafts, type DraftTrigger } from './schema.ts';
import { cronInWords, triggerInWords } from './words.ts';

export type Draft = typeof automationDrafts.$inferSelect;
export type DraftStatus = Draft['status'];

/** A draft is open for 7 days. */
export const DRAFT_TTL_MS = 7 * 24 * 3600 * 1000;
/** At most this many open drafts per user. */
export const MAX_OPEN_DRAFTS = 20;
/** Drafts are removed this long after they were made, whatever their state. */
export const DRAFT_KEEP_MS = 30 * 24 * 3600 * 1000;
/** The button under a draft in a chat app. Its data is `drf:<draft id>:save`. */
export const SAVE_TITLE = '✅ Save';
/** What the user is told a draft waits for before it runs, in the outline. */
const ASKS_FIRST = 'Asks first: before sending, deleting or paying';

const PLAN_NAMES: Record<PlanId, string> = { free: 'Free', pro: 'Pro', max: 'Max' };

/**
 * Why a draft could not be proposed or saved. The message is written for whoever reads it: the
 * agent when it proposes, the user when they save.
 */
export class DraftError extends Error {
  constructor(
    message: string,
    /**
     * `not_found`: no such draft for this user. `not_open`: saved, discarded, replaced or expired
     * (`details.status`). `plan_limit`, `invalid`: a check refused it. `unavailable`: Composio could
     * not make the watch just now.
     */
    readonly code: 'not_found' | 'not_open' | 'plan_limit' | 'invalid' | 'unavailable',
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Its state now: an open draft past its 7 days is expired, whether or not the hourly job ran. */
export function statusOf(d: Draft, now = Date.now()): DraftStatus {
  return d.status === 'open' && d.expiresAt.getTime() <= now ? 'expired' : d.status;
}

/** Where the draft opens in the web app: on the canvas of a new automation, or of the one it changes. */
export function draftPath(d: Pick<Draft, 'id' | 'changeOf'>): string {
  return d.changeOf ? `/automations/${d.changeOf}?draft=${d.id}` : `/automations/new?draft=${d.id}`;
}

export function draftLink(d: Pick<Draft, 'id' | 'changeOf'>): string {
  return `${config().WEB_APP_URL.replace(/\/+$/, '')}${draftPath(d)}`;
}

/** When it would first run if it were saved now. Null for an app event. */
function firstRun(d: Pick<Draft, 'kind' | 'runAt' | 'cron' | 'timezone'>): Date | null {
  if (d.kind === 'once') return d.runAt;
  if (d.kind === 'repeat' && d.cron) return nextCronRun(d.cron, d.timezone);
  return null;
}

export function toApiDraft(d: Draft) {
  const next = firstRun(d);
  return {
    id: d.id,
    status: statusOf(d),
    madeBy: d.madeBy,
    changeOf: d.changeOf,
    kind: d.kind,
    title: d.title,
    instruction: d.instruction,
    runAt: d.runAt ? d.runAt.toISOString() : null,
    cron: d.cron,
    timezone: d.timezone,
    trigger: d.trigger
      ? { app: d.trigger.app, event: d.trigger.event, config: d.trigger.config ?? {} }
      : null,
    apps: d.apps ?? [],
    copyTo: copyToOf(d.sessionKey),
    nextRunAt: next ? next.toISOString() : null,
    replacedBy: d.replacedBy,
    automationId: d.automationId,
    createdAt: d.createdAt.toISOString(),
    expiresAt: d.expiresAt.toISOString(),
    decidedAt: d.decidedAt ? d.decidedAt.toISOString() : null,
  };
}

const emitDraft = (d: Draft) => publish(d.userId, 'automation_draft.updated', toApiDraft(d));

// ---------------------------------------------------------------- what the user is shown

const appName = (slug: string) => (findApp(slug) ?? appForToolkit(slug))?.name ?? slug;

/** When it runs, in words: "every Monday at 9:00 AM (Asia/Kolkata)". */
export function draftWhen(d: Pick<Draft, 'kind' | 'runAt' | 'cron' | 'timezone' | 'trigger'>) {
  if (d.kind === 'once' && d.runAt) return `once, at ${describeDueTime(d.runAt, d.timezone)}`;
  if (d.kind === 'repeat' && d.cron)
    return `${cronInWords(d.cron) ?? `on the schedule "${d.cron}"`} (${d.timezone})`;
  if (d.trigger) {
    const app = findApp(d.trigger.app) ?? appForToolkit(d.trigger.app);
    return triggerInWords(d.trigger, app?.name ?? d.trigger.app, app?.slug ?? d.trigger.app);
  }
  return 'not set';
}

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/**
 * The draft as a chat app shows it (plain text): what it is and that it is not saved yet, when it
 * runs, what Tex does, the apps, the fixed rule for approvals, where the results go and the link
 * to review it. The Save button goes under it.
 */
export function draftOutline(d: Draft, changes?: Pick<Automation, 'title'> | null): string {
  const icon = d.kind === 'event' ? '⚡' : '⏰';
  const lines = [
    changes
      ? `${icon} A change, not saved yet: ${d.title}`
      : `${icon} New automation, not saved yet: ${d.title}`,
    ...(changes ? [`Changes: "${changes.title}". Saving replaces it.`] : []),
    `When: ${draftWhen(d)}`,
    `Tex: ${cut(d.instruction, 300)}`,
    ...(d.apps.length ? [`Apps: ${d.apps.map(appName).join(', ')}`] : []),
    ASKS_FIRST,
    copyToOf(d.sessionKey)
      ? 'Results: your Automations chat, and a copy here'
      : 'Results: your Automations chat',
    `Review it: ${draftLink(d)}`,
  ];
  return lines.join('\n');
}

/** The draft's message in web chat: one line. The web app draws the draft's card under it. */
export function draftWebText(d: Draft, changes?: Pick<Automation, 'title'> | null): string {
  return changes
    ? `Here's a draft of the change to "${changes.title}". Nothing changes until you save it.`
    : `Here's a draft of "${d.title}". Nothing runs until you save it.`;
}

// ---------------------------------------------------------------- reading

export async function getDraft(userId: string, id: string): Promise<Draft | undefined> {
  const [row] = await db()
    .select()
    .from(automationDrafts)
    .where(and(eq(automationDrafts.userId, userId), eq(automationDrafts.id, id)));
  return row;
}

/** The user's open drafts, newest first. */
export async function listOpenDrafts(userId: string): Promise<Draft[]> {
  return db()
    .select()
    .from(automationDrafts)
    .where(
      and(
        eq(automationDrafts.userId, userId),
        eq(automationDrafts.status, 'open'),
        gt(automationDrafts.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(automationDrafts.id))
    .limit(MAX_OPEN_DRAFTS * 2);
}

// ---------------------------------------------------------------- proposing

export interface ProposeInput {
  userId: string;
  /** The chat it is proposed in (already checked to be the user's own). */
  sessionKey: string;
  title: string;
  instruction: string;
  runAt?: Date;
  cron?: string;
  timezone?: string;
  trigger?: DraftTrigger;
  /** The apps the agent says it will use, by app slug or toolkit. */
  apps?: string[];
  /** The automation it would change. */
  changeOf?: string;
  /** The agent's earlier draft that this one takes the place of. */
  replaces?: string;
}

/** The apps as catalog slugs, once each. Each must be one of the user's connected apps. */
async function checkApps(userId: string, names: string[]): Promise<string[]> {
  const slugs: string[] = [];
  for (const name of names) {
    const app = findApp(name) ?? appForToolkit(name);
    if (!app) throw new DraftError(`Unknown app ${name}`, 'invalid');
    if (slugs.includes(app.slug)) continue;
    if (!(await connectionForToolkit(userId, app.toolkit)))
      throw new DraftError(
        `${app.name} is not connected. Ask the user to connect it on the Apps page first`,
        'invalid',
      );
    slugs.push(app.slug);
  }
  return slugs;
}

/** An AutomationError from the checks, as a DraftError for the agent (`forUser`: for the user). */
function refused(err: unknown, forUser: boolean): unknown {
  if (!(err instanceof AutomationError)) return err;
  if (err.code === 'plan_limit') {
    const { plan, limit } = err.details!;
    const words = `Your ${PLAN_NAMES[plan]} plan allows ${limit} automation${limit === 1 ? '' : 's'}`;
    return new DraftError(
      forUser
        ? `${words}. Delete one or upgrade, then save again.`
        : `${words}, and they are used. The user must delete one or upgrade before a new one can be saved. Nothing was proposed.`,
      'plan_limit',
      { plan, limit },
    );
  }
  if (err.code === 'past' && forUser)
    return new DraftError('The time it was set for has passed. Ask Tex for a new time.', 'invalid');
  return new DraftError(err.message, 'invalid');
}

/**
 * Proposes a draft: the same checks as a save, the cap of open drafts, then the draft is saved
 * (the one it replaces becomes `replaced` in the same step) and posted in the chat. Nothing runs.
 */
export async function proposeDraft(
  input: ProposeInput,
): Promise<{ draft: Draft; replaced: Draft | null; message: MessageRow }> {
  const { userId } = input;
  const old = input.replaces ? await getDraft(userId, input.replaces) : undefined;
  if (input.replaces && !old) throw new DraftError(`Unknown draft ${input.replaces}`, 'invalid');
  let changes: Automation | undefined;
  if (input.changeOf) {
    changes = await getAutomation(userId, input.changeOf);
    if (!changes || changes.completedAt)
      throw new DraftError(`Unknown automation ${input.changeOf}`, 'invalid');
    if (changes.preset === 'pr_review')
      throw new DraftError(
        'Pull-request review is changed by the user in the web app, under Automations, Pull-request review, not with a draft',
        'invalid',
      );
  }
  const apps = await checkApps(userId, input.apps ?? []);
  const parts: CreateInput = {
    userId,
    title: input.title,
    instruction: input.instruction,
    sessionKey: input.sessionKey,
    ...(input.runAt ? { runAt: input.runAt } : {}),
    ...(input.cron ? { cron: input.cron } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.trigger ? { trigger: input.trigger } : {}),
    apps,
  };
  let checked;
  try {
    checked = await checkAutomation(parts, { replacing: input.changeOf ?? null });
  } catch (err) {
    throw refused(err, false);
  }

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
      `The user has ${MAX_OPEN_DRAFTS} drafts waiting to be saved. Ask them to save or discard some ` +
        'in the web app (Automations), then propose again. Nothing was proposed.',
      'invalid',
    );

  const { draft, replaced } = await db().transaction(async (tx) => {
    const [made] = await tx
      .insert(automationDrafts)
      .values({
        id: newId('drf'),
        userId,
        madeBy: 'agent',
        changeOf: input.changeOf ?? null,
        kind: checked.kind,
        title: input.title,
        instruction: input.instruction,
        runAt: input.runAt ?? null,
        cron: input.cron ?? null,
        timezone: checked.timezone,
        trigger: input.trigger ?? null,
        apps,
        sessionKey: input.sessionKey,
        expiresAt: new Date(now.getTime() + DRAFT_TTL_MS),
      })
      .returning();
    // The earlier draft gives way, if it is still open (as an approval asked again does). One that
    // was saved, discarded or expired already stays as it is.
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

  // Posted in the chat it was asked in, in the turn's conversation. A chat app gets the outline,
  // the link and a Save button; web chat a line, under which the web app draws the draft's card.
  const chat = parseSessionKey(input.sessionKey)?.channel ?? 'web';
  const message = await queueOutbound({
    userId,
    sessionKey: input.sessionKey,
    ...(await turnMessageFields(userId, input.sessionKey)),
    text: chat === 'web' ? draftWebText(draft, changes) : draftOutline(draft, changes),
    automationDraftId: draft.id,
    ...(chat === 'telegram' || chat === 'whatsapp'
      ? { buttons: [{ id: `drf:${draft.id}:save`, title: SAVE_TITLE }] }
      : {}),
  });
  await emitDraft(draft);
  if (replaced) await emitDraft(replaced);
  return { draft, replaced, message };
}

// ---------------------------------------------------------------- the user's answer

/** The refusal for a draft that is not open. */
function notOpen(d: Draft, status: DraftStatus): DraftError {
  const words: Record<Exclude<DraftStatus, 'open'>, string> = {
    saved: 'This draft is already saved.',
    replaced: 'Tex made a newer version of this draft. Save the newest one.',
    expired: 'This draft expired. Ask Tex again.',
    discarded: 'This draft was discarded. Ask Tex again if you want it.',
  };
  return new DraftError(words[status as Exclude<DraftStatus, 'open'>], 'not_open', {
    status,
    ...(status === 'saved' && d.automationId ? { automationId: d.automationId } : {}),
    ...(status === 'replaced' && d.replacedBy ? { replacedBy: d.replacedBy } : {}),
  });
}

/** The parts of the automation a draft makes. */
function partsOf(d: Draft, enabled: boolean): CreateInput {
  return {
    userId: d.userId,
    title: d.title,
    instruction: d.instruction,
    sessionKey: d.sessionKey,
    timezone: d.timezone,
    ...(d.runAt ? { runAt: d.runAt } : {}),
    ...(d.cron ? { cron: d.cron } : {}),
    ...(d.trigger ? { trigger: d.trigger } : {}),
    apps: d.apps ?? [],
    enabled,
  };
}

/**
 * The user saves a draft: the automation is made, with the checks run again now (the plan's
 * limit counts the automation a change replaces as gone). The draft row is locked while it is
 * read and marked saved in the same transaction as the automation is saved, so one draft makes one
 * automation, also when two saves come at once (the second waits, then finds it saved). Then the
 * timer is set (or the watch made with it), and a change removes the automation it replaces.
 * `enabled: false` makes it paused. `via`: where the user saved it, for the activity log.
 */
export async function saveDraft(
  userId: string,
  draftId: string,
  opts: { enabled?: boolean; via: string },
): Promise<{ draft: Draft; automation: Automation }> {
  const made: { triggerRef?: string } = {};
  let saved: { draft: Draft; automation: Automation };
  try {
    saved = await db().transaction(async (tx) => {
      const [d] = await tx
        .select()
        .from(automationDrafts)
        .where(and(eq(automationDrafts.userId, userId), eq(automationDrafts.id, draftId)))
        .for('update');
      if (!d) throw new DraftError('Draft not found', 'not_found');
      const status = statusOf(d);
      if (status !== 'open') throw notOpen(d, status);
      const parts = partsOf(d, opts.enabled !== false);
      let checked;
      try {
        checked = await checkAutomation(parts, { exec: tx, replacing: d.changeOf });
      } catch (err) {
        throw refused(err, true);
      }
      let automation: Automation;
      try {
        automation = await insertAutomation(parts, checked, tx, made);
      } catch (err) {
        if (!(err instanceof TriggerError)) throw err;
        logger().warn({ userId, draftId, err: err.message }, 'draft save: trigger not made');
        throw new DraftError(
          `Couldn't set up the watch in ${appName(d.trigger?.app ?? '')} just now. Try again in a moment.`,
          'unavailable',
        );
      }
      const [done] = await tx
        .update(automationDrafts)
        .set({ status: 'saved', automationId: automation.id, decidedAt: new Date() })
        .where(eq(automationDrafts.id, d.id))
        .returning();
      return { draft: done!, automation };
    });
  } catch (err) {
    // The transaction did not save: a watch made for it must not stay behind.
    if (made.triggerRef) await dropTrigger(made.triggerRef);
    throw err;
  }
  await activateAutomation(saved.automation);
  // A change: the new automation is live, so the one it replaces goes, with its timer or watch.
  if (saved.draft.changeOf)
    await deleteAutomation(userId, saved.draft.changeOf).catch((err: unknown) =>
      logger().warn({ userId, draftId, err: String(err) }, 'replaced automation not removed'),
    );
  await emitDraft(saved.draft);
  await audit({
    userId,
    actor: 'user',
    action: 'automation_saved',
    summary: `Saved the automation "${saved.automation.title}"${opts.enabled === false ? ' (paused)' : ''}`,
    details: {
      draftId,
      automationId: saved.automation.id,
      via: opts.via,
      ...(saved.draft.changeOf ? { replaced: saved.draft.changeOf } : {}),
    },
  });
  return saved;
}

/** The user discards an open draft. Nothing ran, so nothing stops. */
export async function discardDraft(userId: string, draftId: string): Promise<Draft> {
  const now = new Date();
  const [row] = await db()
    .update(automationDrafts)
    .set({ status: 'discarded', decidedAt: now })
    .where(
      and(
        eq(automationDrafts.userId, userId),
        eq(automationDrafts.id, draftId),
        eq(automationDrafts.status, 'open'),
        gt(automationDrafts.expiresAt, now),
      ),
    )
    .returning();
  if (!row) {
    const d = await getDraft(userId, draftId);
    if (!d) throw new DraftError('Draft not found', 'not_found');
    throw notOpen(d, statusOf(d));
  }
  await emitDraft(row);
  await audit({
    userId,
    actor: 'user',
    action: 'automation_draft_discarded',
    summary: `Discarded the draft "${row.title}"`,
    details: { draftId },
  });
  return row;
}

const SAVE_BUTTON = /^drf:([a-z0-9_]+):save$/;

/** What the chat app is told after a tap on Save. */
function savedText(d: Draft, a: Automation): string {
  const when =
    a.kind === 'once' && a.runAt
      ? `It runs once, at ${describeDueTime(a.runAt, a.timezone ?? d.timezone)}.`
      : a.kind === 'repeat' && a.nextRunAt
        ? `First run: ${describeDueTime(a.nextRunAt, a.timezone ?? d.timezone)}.`
        : 'It runs each time that happens.';
  const copy = copyToOf(d.sessionKey) ? ', with a copy here' : '';
  return `Saved: ${a.title}. ${when}\n\nEach run answers in your Automations chat${copy}.`;
}

/**
 * Inbound hook: a tapped Save button under a draft in a chat app (`drf:<id>:save`). Saves it, and
 * answers in that chat. Returns false for anything else, so the next hook (approvals) gets it.
 */
export async function handleDraftButton(userId: string, msg: InboundMessage): Promise<boolean> {
  const m = SAVE_BUTTON.exec(msg.buttonReply?.data ?? '');
  if (!m) return false;
  const sessionKey = `${msg.channel}:${msg.externalChatId}`;
  let text: string;
  try {
    const { draft, automation } = await saveDraft(userId, m[1]!, {
      via: `${msg.channel}:button`,
    });
    text = savedText(draft, automation);
  } catch (err) {
    if (!(err instanceof DraftError)) throw err;
    text =
      err.code === 'not_found'
        ? 'This draft is no longer there. Ask Tex again.'
        : err.code === 'not_open' && err.details?.status === 'saved'
          ? 'That automation is already saved.'
          : err.message;
  }
  await queueOutbound({ userId, sessionKey, text });
  return true;
}

// ---------------------------------------------------------------- upkeep

/** system/expire-automation-drafts (hourly): open drafts past their 7 days become `expired`. */
export async function expireDrafts(now = new Date()): Promise<number> {
  const rows = await db()
    .update(automationDrafts)
    .set({ status: 'expired', decidedAt: now })
    .where(and(eq(automationDrafts.status, 'open'), lte(automationDrafts.expiresAt, now)))
    .returning();
  for (const r of rows) await emitDraft(r);
  return rows.length;
}

/** Daily clean-up: drafts made more than 30 days ago go, whatever their state. */
export async function cleanupDrafts(now = new Date()): Promise<number> {
  const res = await db()
    .delete(automationDrafts)
    .where(lt(automationDrafts.createdAt, new Date(now.getTime() - DRAFT_KEEP_MS)));
  return res.rowCount ?? 0;
}
