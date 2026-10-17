import type { Job } from 'bullmq';
import { and, count, desc, eq, gt, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { conflict, notFound } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import { audit } from '../admin/audit.ts';
import { conversationOfApproval } from '../channels/messages.ts';
import { copyApprovalQuestion, settleApprovalMessages } from '../channels/notify.ts';
import { queueOutbound, queueRawOutbound } from '../channels/outbound.ts';
import { publish } from '../channels/stream.ts';
import type { InboundMessage } from '../channels/types.ts';
import { whileTyping } from '../channels/typing.ts';
import { getEvent, queueSavedEvent, saveEvent } from '../events/intake.ts';
import { addJob } from '../events/queues.ts';
import { logger } from '../../shared/logger.ts';
import { IGNORED } from '../../worker/ignored.ts';
import { approvalKind, CREW_RERUN_ACTION, ownGoAhead } from './approval-kinds.ts';
import {
  APPROVE_TITLE,
  approvalAskText,
  approvalEndNote,
  channelOfSession,
  DENY_TITLE,
} from './approval-text.ts';
import { approvals, type ApprovedRun } from './schema.ts';
import { runTurn, turnForAutomation, turnMessageFields } from './turn.ts';

export type Approval = typeof approvals.$inferSelect;
export const APPROVAL_TTL_MS = 24 * 3600 * 1000;

/**
 * The action an approval names when the lead asks the user's yes for a crew job whose report is
 * posted on a pull request (the start_crew_job tool). It is the platform's own, not an app's.
 */
export const START_CREW_JOB_ACTION = 'TEXTCREW_START_CREW_JOB';

/**
 * What the agent is told to do after a yes. An app action's approval holds its arguments, and
 * run_app_action runs exactly those: the agent does not send them again. (An app action the
 * platform ran at once is told with approvedRunText instead.)
 */
function goAhead(a: Approval): string {
  const own = ownGoAhead(a);
  if (own) return own;
  if (a.action === START_CREW_JOB_ACTION)
    return `Go ahead (call start_crew_job with approval_id "${a.id}").`;
  if (a.action && a.arguments)
    return (
      `Go ahead: call run_app_action with action "${a.action}" and approval_id "${a.id}". ` +
      'It runs exactly the arguments the user approved, so leave arguments out.'
    );
  return `Go ahead (call run_app_action with approval_id "${a.id}").`;
}

// --- an approved app action runs at once --------------------------------------------------------

/** The job that runs an approved app action at once: on the system queue, never behind the lock. */
export const RUN_APPROVED_JOB = 'run-approved-action';
/** How long the turn after the yes waits for a run in progress (the app's answer, our charge). */
export const APPROVED_RUN_WAIT_MS = 90_000;
/** A run still `running` after this long ended without a word (a worker stopped): never rerun. */
const APPROVED_RUN_STALE_MS = 5 * 60_000;
const APPROVED_RUN_POLL_MS = 300;
/** At most this much of the result goes into the text that wakes Tex; the tool gives it whole. */
const RESULT_IN_TEXT_MAX = 4_000;

/**
 * Whether the platform runs this approval's action itself, the moment the user approves (founder's
 * decision of 17 October): an action in one of the user's apps (`app`, set when request_approval
 * checked its inputs). Not the platform's own kinds (a command, a push, a crew job: Tex, the gate or
 * the git gateway makes those again), and not a step of an automation's run with steps (that run
 * goes on through Tex, one step at a time).
 */
export function runsWhenApproved(
  a: Pick<Approval, 'app' | 'action' | 'arguments' | 'automationRunId'>,
): boolean {
  return Boolean(
    a.app && a.action && a.arguments && !a.action.startsWith('TEXTCREW_') && !a.automationRunId,
  );
}

/** What running an approved app action gave: its short result, or why nothing happened. */
export type ApprovedActionResult =
  | { ok: true; data: unknown; note?: string; creditsCharged: number }
  | { ok: false; error: string; reason: string };

/**
 * Runs an approved app action (the Platform MCP's runApprovedAppAction, plugged in by wiring): the
 * stored arguments, the same connection, charge, result shaping and activity-log entry as
 * run_app_action.
 */
export type ApprovedActionRunner = (userId: string, a: Approval) => Promise<ApprovedActionResult>;
let approvedActionRunner: ApprovedActionRunner | null = null;
export function setApprovedActionRunner(fn: ApprovedActionRunner): void {
  approvedActionRunner = fn;
}

/**
 * The run's end: `done` with its result, or `failed`, which hands the approval back (unused) so the
 * agent may try once more or ask again with corrected inputs. Returns what was saved.
 */
export async function finishApprovedRun(
  userId: string,
  id: string,
  result: ApprovedActionResult,
): Promise<ApprovedRun> {
  const at = new Date().toISOString();
  const run: ApprovedRun = result.ok
    ? {
        state: 'done',
        at,
        data: result.data,
        ...(result.note ? { note: result.note } : {}),
        creditsCharged: result.creditsCharged,
      }
    : { state: 'failed', at, error: result.error, reason: result.reason };
  await db()
    .update(approvals)
    .set(result.ok ? { runResult: run } : { runResult: run, usedAt: null })
    .where(and(eq(approvals.userId, userId), eq(approvals.id, id)));
  return run;
}

/** Hands a consumed approval back untouched: nothing was tried (the agent sent other inputs). */
export async function releaseApproval(userId: string, id: string): Promise<void> {
  await db()
    .update(approvals)
    .set({ usedAt: null, runResult: null })
    .where(and(eq(approvals.userId, userId), eq(approvals.id, id)));
}

const runAge = (run: ApprovedRun) => Date.now() - new Date(run.at).getTime();

/**
 * Waits up to `waitMs` for the run of an approval that is running now, and returns how it ended,
 * or the `running` mark when it has not ended (then it may or may not have happened: never run it
 * again). Null: it was never run by the platform (or used before results were kept).
 */
export async function waitForApprovedRun(
  userId: string,
  id: string,
  waitMs: number,
): Promise<ApprovedRun | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    const a = await getApproval(userId, id);
    const run = a?.runResult ?? null;
    if (!run || run.state !== 'running') return run;
    if (Date.now() >= until || runAge(run) > APPROVED_RUN_STALE_MS) return run;
    await new Promise((r) => setTimeout(r, APPROVED_RUN_POLL_MS));
  }
}

/**
 * The approved app action's run, done once whoever asks first: the system job right after the
 * yes, or the turn that tells Tex (when that job has not started yet). It claims the approval in
 * one database step (as run_app_action does), so it never runs twice; a caller that finds it
 * running waits up to `waitMs` for the result. A run that failed is not tried again here: Tex is
 * told, and may try once more. Null: not an approved app action the platform runs.
 */
export async function settleApprovedRun(
  userId: string,
  id: string,
  opts: { waitMs: number },
): Promise<ApprovedRun | null> {
  const a = await getApproval(userId, id);
  if (!a || a.status !== 'approved' || !runsWhenApproved(a)) return null;
  if (a.runResult && a.runResult.state !== 'running') return a.runResult;
  if (!a.usedAt && !a.runResult) {
    const claimed = await consumeApproval(userId, id, a.action!);
    if (claimed) {
      if (!approvedActionRunner) throw new Error('no runner for approved app actions');
      let result: ApprovedActionResult;
      try {
        result = await approvedActionRunner(userId, claimed);
      } catch (err) {
        // Not known whether the app ran it: the claim stays, so it is never run twice.
        logger().error({ userId, approvalId: id, err: String(err) }, 'approved action run failed');
        throw err;
      }
      return finishApprovedRun(userId, id, result);
    }
  }
  return waitForApprovedRun(userId, id, opts.waitMs);
}

/** system/run-approved-action: the approved app action runs now, whatever Tex is doing. */
export async function handleRunApprovedAction(job: Job): Promise<unknown> {
  const { approvalId, userId } = job.data as { approvalId: string; userId: string };
  const run = await settleApprovedRun(userId, approvalId, { waitMs: 0 });
  return run ? run.state : IGNORED;
}

/** The approved action's result, in the text that wakes Tex: JSON, cut to RESULT_IN_TEXT_MAX. */
function resultText(run: Extract<ApprovedRun, { state: 'done' }>): string {
  const json = JSON.stringify(run.data ?? null);
  const cut =
    json.length > RESULT_IN_TEXT_MAX
      ? `${json.slice(0, RESULT_IN_TEXT_MAX)}… (cut here; run_app_action with the approval_id gives it whole)`
      : json;
  return `${cut}${run.note ? ` (${run.note})` : ''}`;
}

const credits = (n: number) => (n ? ` (${n} credit${n === 1 ? '' : 's'})` : '');

/**
 * What wakes Tex after the yes to an app action the platform already ran: approved AND done (or
 * why not), so Tex only reports it. Never "go ahead": running it again is what this replaced.
 */
export function approvedRunText(a: Approval, run: ApprovedRun): string {
  const head = `The user APPROVED: ${a.summary}.`;
  if (run.state === 'done')
    return (
      `${head} It is DONE: Textcrew ran ${a.action} with exactly the approved details the moment they ` +
      `approved${credits(run.creditsCharged)}. Don't run it again. The result: ` +
      `${resultText(run)}. Tell the user in one or two short sentences what was done.`
    );
  if (run.state === 'failed')
    return (
      `${head} Textcrew ran it at once, but it did not go through, so nothing was done: ${run.error}. ` +
      'If it looks like a passing problem, you may try once more: call run_app_action with action ' +
      `"${a.action}" and approval_id "${a.id}" (leave arguments out). If the details must change, call ` +
      `request_approval with the corrected arguments and replaces_approval_id "${a.id}", and end your turn. ` +
      'Tell the user in plain words what happened.'
    );
  return (
    `${head} Textcrew started ${a.action} the moment they approved, but its result has not come back. ` +
    "Don't run it again: it may already have happened. Tell the user it was started and that they can " +
    'check in the app whether it went through.'
  );
}

/**
 * A job added again from its event (a worker start after Redis was lost) carries only the event's
 * id: the approval's id is in the event. Fills it in, so every approval answer is handled.
 */
export async function withApprovalId(job: Job): Promise<Job> {
  const data = job.data as { approvalId?: string; eventId?: string };
  if (data.approvalId || !data.eventId) return job;
  const id = (await getEvent(data.eventId))?.payload.approvalId;
  if (typeof id === 'string') job.data = { ...job.data, approvalId: id };
  return job;
}

export function toApiApproval(a: Approval) {
  return {
    id: a.id,
    kind: approvalKind(a),
    status: a.status,
    summary: a.summary,
    app: a.app,
    action: a.action,
    details: { ...(a.details ?? {}), ...(a.arguments ? { arguments: a.arguments } : {}) },
    createdAt: a.createdAt.toISOString(),
    expiresAt: a.expiresAt.toISOString(),
    decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
  };
}

const effective = (a: Approval): Approval =>
  a.status === 'pending' && a.expiresAt.getTime() <= Date.now() ? { ...a, status: 'expired' } : a;

/**
 * Saves the approval and sends the question with ✅ Approve / ❌ Deny buttons: Tex saying what it
 * wants to do, made from the approval's summary (approval-text.ts). Returns immediately ("pending").
 */
export async function requestApproval(input: {
  userId: string;
  sessionKey: string;
  summary: string;
  app?: string | null;
  action?: string | null;
  arguments?: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
  /** The conversation the question goes to (default: the turn's in progress in that chat). */
  conversationId?: string | null;
  /**
   * The automation whose work asks (null: the user's own). Default: the turn in progress's, from
   * the worker's note, never from anything the agent says.
   */
  automationId?: string | null;
  /** Asked for one step of an automation's run with steps: only that step of that run uses it. */
  run?: { runId: string; stepId: string } | null;
}): Promise<Approval> {
  const automationId =
    input.automationId !== undefined ? input.automationId : await turnForAutomation(input.userId);
  const [row] = await db()
    .insert(approvals)
    .values({
      id: newId('apr'),
      userId: input.userId,
      summary: input.summary,
      app: input.app ?? null,
      action: input.action ?? null,
      arguments: input.arguments ?? null,
      details: input.details ?? null,
      sessionKey: input.sessionKey,
      automationId,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      automationRunId: input.run?.runId ?? null,
      automationStepId: input.run?.stepId ?? null,
    })
    .returning();
  const a = row!;
  const buttons = [
    { id: `apr:${a.id}:yes`, title: APPROVE_TITLE },
    { id: `apr:${a.id}:no`, title: DENY_TITLE },
  ];
  const asked = await queueOutbound({
    userId: input.userId,
    sessionKey: input.sessionKey,
    // Asked during a turn: the question belongs to that turn's conversation.
    ...(input.conversationId !== undefined
      ? { conversationId: input.conversationId }
      : await turnMessageFields(input.userId, input.sessionKey)),
    text: approvalAskText(a.summary, channelOfSession(input.sessionKey)),
    approvalId: a.id,
    template: 'approval',
    buttons,
  });
  // Asked by an automation's work: the same question on the user's Telegram too (their switch).
  // One asked in the web app stays there. The first answer wins.
  await copyApprovalQuestion(
    input.userId,
    asked,
    { text: approvalAskText(a.summary, 'telegram'), buttons },
    a.automationId,
  );
  await publish(input.userId, 'approval.created', toApiApproval(a));
  await audit({
    userId: input.userId,
    actor: 'agent',
    action: 'approval_requested',
    summary: a.summary,
    details: { approvalId: a.id, action: a.action },
  });
  return a;
}

export async function getApproval(userId: string, id: string): Promise<Approval | undefined> {
  const [row] = await db()
    .select()
    .from(approvals)
    .where(and(eq(approvals.userId, userId), eq(approvals.id, id)));
  return row ? effective(row) : undefined;
}

export async function listApprovals(
  userId: string,
  opts: { status?: Approval['status']; cursor?: string; limit: number },
) {
  const status = opts.status ?? 'pending';
  const where = [eq(approvals.userId, userId)];
  if (opts.cursor) where.push(lt(approvals.id, opts.cursor));
  if (status === 'pending') {
    where.push(eq(approvals.status, 'pending'), gt(approvals.expiresAt, new Date()));
  } else if (status === 'expired') {
    // stored expired, or pending past its expiry
  } else {
    where.push(eq(approvals.status, status));
  }
  const rows = (
    await db()
      .select()
      .from(approvals)
      .where(and(...where))
      .orderBy(desc(approvals.id))
      .limit(status === 'expired' ? 500 : opts.limit + 1)
  )
    .map(effective)
    .filter((a) => a.status === status);
  const page = rows.slice(0, opts.limit);
  return { items: page, nextCursor: rows.length > opts.limit ? page[page.length - 1]!.id : null };
}

/**
 * Records the user's answer (web, button or yes/no) and, in the same database step, the event
 * that wakes the agent with it: a message the user sends right after the answer can't be queued
 * before it. An approved app action then runs at once, on the system queue, which never waits
 * for the user's lock (Tex may be busy with another message). 404 if not this user's; 409 if
 * already decided or expired.
 */
export async function decideApproval(
  userId: string,
  id: string,
  approve: boolean,
  via: string,
): Promise<Approval> {
  const decided = await db().transaction(async (tx) => {
    const [answered] = await tx
      .update(approvals)
      .set({ status: approve ? 'approved' : 'rejected', decidedAt: new Date(), decidedVia: via })
      .where(
        and(
          eq(approvals.userId, userId),
          eq(approvals.id, id),
          eq(approvals.status, 'pending'),
          gt(approvals.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!answered) return null;
    const event = await saveEvent(
      {
        source: 'approval',
        externalId: id,
        type: approve ? 'approved' : 'rejected',
        userId,
        payload: { approvalId: id, approved: approve },
        queue: 'inbound',
        jobName: 'process-approval',
      },
      tx,
    );
    return { answered, event };
  });
  if (!decided) {
    const existing = await getApproval(userId, id);
    if (!existing) throw notFound('Approval not found');
    if (existing.status === 'replaced')
      throw conflict('This request was replaced by a newer one, so it can no longer be answered');
    throw conflict(`Approval is already ${existing.status}`);
  }
  const row = decided.answered;
  // First the work, then the notices: the action runs now, and Tex is woken with the answer.
  await Promise.all([
    approve && runsWhenApproved(row)
      ? addJob('system', RUN_APPROVED_JOB, { approvalId: id, userId }, { jobId: `apr-run-${id}` })
      : undefined,
    decided.event ? queueSavedEvent(decided.event, { approvalId: id }) : undefined,
  ]);
  await publish(userId, 'approval.resolved', toApiApproval(row));
  const outcome = approve ? 'approved' : 'rejected';
  await settleApprovalMessages(userId, id, outcome, approvalEndNote(outcome, via));
  await audit({
    userId,
    actor: 'user',
    action: 'approval_decided',
    summary: `${approve ? 'Approved' : 'Denied'}: ${row.summary}`,
    details: { approvalId: id, via },
  });
  return row;
}

/** inbound/process-approval: wake the agent with the answer; it continues from its saved session. */
export async function handleProcessApproval(job: Job): Promise<unknown> {
  const { approvalId, userId, eventId } = job.data as {
    approvalId: string;
    userId: string;
    eventId: string;
  };
  const a = await getApproval(userId, approvalId);
  if (!a || (a.status !== 'approved' && a.status !== 'rejected')) return IGNORED;
  // An approved app action ran at once (the system job); its result is what Tex is told. When that
  // job has not started yet, it runs here, once; when it is running, this waits for it.
  const ran =
    a.status === 'approved'
      ? await settleApprovedRun(userId, a.id, { waitMs: APPROVED_RUN_WAIT_MS })
      : null;
  const parsedChannel = channelOfSession(a.sessionKey);
  // The answer goes back to the conversation the question was asked in, not to whichever one is
  // active now: that is where the agent is waiting for it.
  const conversationId = await conversationOfApproval(userId, a.id);
  // The agent goes on in the chat the question was asked in: "typing…" there (Telegram) meanwhile.
  await whileTyping(a.sessionKey, () =>
    runTurn({
      userId,
      deliveryId: eventId,
      kind: 'approval_answer',
      // Still the automation's work: a next question it asks follows the same rule for Telegram.
      ...(a.automationId ? { forAutomation: a.automationId } : {}),
      sessionKey: a.sessionKey,
      channel: parsedChannel,
      ...(conversationId ? { conversationId } : {}),
      text: ran
        ? approvedRunText(a, ran)
        : a.status === 'approved'
          ? `The user APPROVED: ${a.summary}. ${goAhead(a)}`
          : `The user REJECTED: ${a.summary}. Don't do it. Tell them in one short sentence that you won't.`,
      approval: { id: a.id, approved: a.status === 'approved' },
    }),
  );
  return null;
}

const YES = /^\s*(yes|y|ok|okay|approve|approved|✅|👍)\s*[.!]*\s*$/i;
const NO = /^\s*(no|n|reject|rejected|deny|❌|👎)\s*[.!]*\s*$/i;

/**
 * Inbound hook: a tapped approval button (`apr:<id>:yes|no`), or on channels without buttons
 * a plain "yes"/"no" answering the latest pending approval in that chat. `eventId`: the inbound
 * event, which names the one "already answered" reply (a job that runs again sends no second).
 */
export async function handleApprovalReply(
  userId: string,
  msg: InboundMessage,
  eventId?: string,
): Promise<boolean> {
  let id: string | undefined;
  let approve: boolean | undefined;
  const data = msg.buttonReply?.data;
  if (data) {
    const m = /^apr:([a-z0-9_]+):(yes|no)$/.exec(data);
    if (!m) return false;
    id = m[1];
    approve = m[2] === 'yes';
  } else {
    const yes = YES.test(msg.text);
    const no = NO.test(msg.text);
    if (!yes && !no) return false;
    const sessionKey = `${msg.channel}:${msg.externalChatId}`;
    const [latest] = await db()
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.userId, userId),
          eq(approvals.sessionKey, sessionKey),
          eq(approvals.status, 'pending'),
          gt(approvals.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(approvals.id))
      .limit(1);
    if (!latest) return false;
    id = latest.id;
    approve = yes;
  }
  try {
    await decideApproval(
      userId,
      id!,
      approve!,
      msg.buttonReply ? `${msg.channel}:button` : `${msg.channel}:text`,
    );
  } catch {
    const replaced = (await getApproval(userId, id!))?.status === 'replaced';
    // Sent, not saved: like the tap or the "yes" it answers, it is part of no conversation, so it
    // never starts one in that chat (the tap may be on an automation's copy, kept in the web app).
    await queueRawOutbound(
      msg.channel,
      msg.externalChatId,
      replaced
        ? 'That request was replaced by a newer one. Please answer the newest request.'
        : 'That approval was already answered or has expired.',
      `apr-late-${eventId ?? msg.buttonReply?.callbackId ?? msg.externalMessageId}`,
    );
  }
  return true;
}

/**
 * run_app_action, and the platform's own run of an approved app action: an approved, unexpired,
 * unused approval for exactly this action. Single use.
 * `run`: the step of an automation's run with steps that uses it: the approval must have been
 * asked for that step of that run. Left out, an approval asked for a run's step never matches.
 */
export async function consumeApproval(
  userId: string,
  id: string,
  action: string,
  run?: { runId: string; stepId: string } | null,
): Promise<Approval | null> {
  const now = new Date();
  const [row] = await db()
    .update(approvals)
    // An app action is running from now on: a second caller waits for its result instead of
    // running it again. (The platform's own kinds keep no result.)
    .set({
      usedAt: now,
      ...(action.startsWith('TEXTCREW_')
        ? {}
        : { runResult: { state: 'running' as const, at: now.toISOString() } }),
    })
    .where(
      and(
        eq(approvals.userId, userId),
        eq(approvals.id, id),
        eq(approvals.status, 'approved'),
        eq(approvals.action, action),
        isNull(approvals.usedAt),
        gt(approvals.decidedAt, new Date(Date.now() - APPROVAL_TTL_MS)),
        ...(run
          ? [eq(approvals.automationRunId, run.runId), eq(approvals.automationStepId, run.stepId)]
          : [isNull(approvals.automationRunId)]),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * A newer run of an automation started while an older one waited for a yes on this approval:
 * it becomes `replaced` (when still waiting, or approved and not used), so it can neither be
 * answered nor run. Safe to run again.
 */
export async function replaceRunApproval(userId: string, id: string): Promise<Approval | null> {
  const now = new Date();
  const [row] = await db()
    .update(approvals)
    .set({ status: 'replaced' })
    .where(
      and(
        eq(approvals.userId, userId),
        eq(approvals.id, id),
        isNull(approvals.usedAt),
        or(
          and(eq(approvals.status, 'pending'), gt(approvals.expiresAt, now)),
          eq(approvals.status, 'approved'),
        ),
      ),
    )
    .returning();
  if (!row) return null;
  await publish(userId, 'approval.resolved', toApiApproval(row));
  await settleApprovalMessages(userId, row.id, 'replaced', approvalEndNote('replaced'));
  await audit({
    userId,
    actor: 'agent',
    action: 'approval_replaced',
    summary: `A newer run of the automation started: ${row.summary}`,
    details: { approvalId: row.id, action: row.action, automationRunId: row.automationRunId },
  });
  return row;
}

/**
 * request_approval with replaces_approval_id: the agent asked again for the same action with
 * corrected arguments (`by`), because the earlier request could not run as it was. The earlier one
 * becomes `replaced` when it is still waiting, or approved and not used: it can then neither be
 * answered nor run, and the web app shows it as replaced, not as rejected. One that was rejected,
 * expired, used or replaced already stays as it is (null). The new request asks the user again.
 */
export async function replaceApproval(
  userId: string,
  oldId: string,
  by: Approval,
): Promise<Approval | null> {
  const now = new Date();
  const [row] = await db()
    .update(approvals)
    .set({ status: 'replaced' })
    .where(
      and(
        eq(approvals.userId, userId),
        eq(approvals.id, oldId),
        by.action === null ? isNull(approvals.action) : eq(approvals.action, by.action),
        isNull(approvals.usedAt),
        or(
          and(eq(approvals.status, 'pending'), gt(approvals.expiresAt, now)),
          and(
            eq(approvals.status, 'approved'),
            gt(approvals.decidedAt, new Date(now.getTime() - APPROVAL_TTL_MS)),
          ),
        ),
      ),
    )
    .returning();
  if (!row) return null;
  await publish(userId, 'approval.resolved', toApiApproval(row));
  await settleApprovalMessages(userId, row.id, 'replaced', approvalEndNote('replaced'));
  await audit({
    userId,
    actor: 'agent',
    action: 'approval_replaced',
    summary: `Asked again with corrected details: ${by.summary}`,
    details: { approvalId: row.id, replacedBy: by.id, action: row.action },
  });
  return row;
}

/** system/expire-approvals (hourly): mark stale pending approvals expired. */
export async function expireApprovals(): Promise<number> {
  const rows = await db()
    .update(approvals)
    .set({ status: 'expired' })
    .where(and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, new Date())))
    .returning();
  for (const r of rows) {
    await publish(r.userId, 'approval.resolved', toApiApproval(r));
    await settleApprovalMessages(r.userId, r.id, 'expired', approvalEndNote('expired'));
  }
  return rows.length;
}

/**
 * Account deletion: every approval of the user, in any state, with the inputs saved with it.
 * A job that still holds one of their ids finds nothing and does nothing. Safe to re-run.
 */
export async function deleteUserApprovals(userId: string): Promise<number> {
  const res = await db().delete(approvals).where(eq(approvals.userId, userId));
  return res.rowCount ?? 0;
}

/** Admin overview: approvals waiting for an answer that have not expired. */
export async function countOpenApprovals(now = new Date()): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(approvals)
    .where(and(eq(approvals.status, 'pending'), gt(approvals.expiresAt, now)));
  return row?.n ?? 0;
}

// --- admin tools ---------------------------------------------------------------------------------

/** Admin tools: one approval by its id, whoever's it is (the route is admin-only). */
export async function approvalForAdmin(id: string): Promise<Approval | undefined> {
  const [row] = await db().select().from(approvals).where(eq(approvals.id, id));
  return row ? effective(row) : undefined;
}

/** Admin tools: one user's approvals, newest first, every state unless `status` is given. */
export async function listApprovalsForAdmin(
  userId: string,
  opts: { status?: Approval['status']; cursor?: string; limit: number },
) {
  if (opts.status) return listApprovals(userId, { ...opts, status: opts.status });
  const where = [eq(approvals.userId, userId)];
  if (opts.cursor) where.push(lt(approvals.id, opts.cursor));
  const rows = (
    await db()
      .select()
      .from(approvals)
      .where(and(...where))
      .orderBy(desc(approvals.id))
      .limit(opts.limit + 1)
  ).map(effective);
  const page = rows.slice(0, opts.limit);
  return { items: page, nextCursor: rows.length > opts.limit ? page[page.length - 1]!.id : null };
}

/**
 * Admin tools: ends a waiting approval the way the 24-hour expiry does. It becomes `expired` (now),
 * the agent is not woken and nothing can run with it. Audited with the admin's id and reason.
 * 404 if there is no such approval; 409 if it is no longer waiting.
 */
export async function cancelApproval(
  id: string,
  by: { adminId: string; reason: string },
): Promise<Approval> {
  const now = new Date();
  const row = await db().transaction(async (tx) => {
    const [cancelled] = await tx
      .update(approvals)
      .set({ status: 'expired', expiresAt: now, decidedVia: 'admin' })
      .where(
        and(eq(approvals.id, id), eq(approvals.status, 'pending'), gt(approvals.expiresAt, now)),
      )
      .returning();
    if (!cancelled) return undefined;
    await audit(
      {
        userId: cancelled.userId,
        actor: 'admin',
        action: 'approval_cancelled',
        summary: `Cancelled by Textcrew support: ${cancelled.summary}`,
        details: {
          approvalId: id,
          action: cancelled.action,
          adminId: by.adminId,
          reason: by.reason,
        },
      },
      tx,
    );
    return cancelled;
  });
  if (!row) {
    const existing = await approvalForAdmin(id);
    if (!existing) throw notFound('Approval not found');
    throw conflict(`Approval is already ${existing.status}`);
  }
  await publish(row.userId, 'approval.resolved', toApiApproval(row));
  await settleApprovalMessages(row.userId, id, 'expired', approvalEndNote('expired', 'admin'));
  return row;
}

/** Whether the user was already asked to run this crew job again (crew-jobs.ts, offerCrewRerun). */
export async function hasCrewRerunApproval(userId: string, crewJobId: string): Promise<boolean> {
  const [asked] = await db()
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.userId, userId),
        eq(approvals.action, CREW_RERUN_ACTION),
        sql`${approvals.arguments}->>'crew_job_id' = ${crewJobId}`,
      ),
    );
  return Boolean(asked);
}
