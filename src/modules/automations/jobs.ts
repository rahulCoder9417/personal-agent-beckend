import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { config, isChannelEnabled } from '../../shared/config.ts';
import { db } from '../../shared/db/client.ts';
import { redis } from '../../shared/redis.ts';
import { isValidTimezone } from '../auth/users.ts';
import { automationsChat } from '../channels/conversations.ts';
import { turnReply, type MessageRow } from '../channels/messages.ts';
import { queueOutbound } from '../channels/outbound.ts';
import { WEB_APP_NAME } from '../channels/purchase-links.ts';
import { getEvent, ingestEvent } from '../events/intake.ts';
import type { ComposioTriggerEvent } from '../integrations/composio.ts';
import { runTurn, type TurnKind, type TurnOutcome } from '../orchestrator/turn.ts';
import { IGNORED } from '../../worker/ignored.ts';
import {
  copyRules,
  findByTriggerRef,
  recordRun,
  setEnabled,
  type Automation,
} from './automations.ts';
import { finishPrReview, preparePrReview } from './pr-review.ts';
import {
  closeTurn,
  currentStep,
  expireWaitingRuns,
  getRun,
  resumeAfterYes,
  runTurnText,
  startRun,
  stopAfterNo,
  trailLine,
  type Run,
} from './runs.ts';
import { automations } from './schema.ts';
import { conversationOfApproval } from '../channels/messages.ts';
import { getApproval } from '../orchestrator/approvals.ts';

export const MAX_FAILURES = 3;

async function load(id: string): Promise<Automation | undefined> {
  const [row] = await db().select().from(automations).where(eq(automations.id, id));
  return row;
}

/** A timer run that starts more than this after it was due says so. Tests lower it. */
export const LATE_AFTER_MS = 10 * 60 * 1000;
let lateAfterMs = LATE_AFTER_MS;
export function setLateAfterMs(ms: number): void {
  lateAfterMs = ms;
}

/**
 * When a timer run was due. A one-time automation: its moment (also when it was paused past it
 * and resumed). A repeating one: the slot the scheduler made this job for, which BullMQ keeps on
 * the job; failing that, when the job was added plus its delay.
 */
export function dueTimeOf(a: Automation, job: Pick<Job, 'opts' | 'timestamp'>): Date {
  if (a.kind === 'once' && a.runAt) return a.runAt;
  const slot = job.opts.prevMillis;
  if (typeof slot === 'number' && slot > 0) return new Date(slot);
  return new Date(job.timestamp + (job.opts.delay ?? 0));
}

/** "9:00 AM on Tuesday 13 October (Asia/Kolkata)": the moment in the automation's time zone. */
export function describeDueTime(at: Date, timeZone: string): string {
  const tz = isValidTimezone(timeZone) ? timeZone : 'UTC';
  const part = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${part.hour}:${part.minute} ${part.dayPeriod} on ${part.weekday} ${part.day} ${part.month} (${tz})`;
}

function howLate(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `about ${hours} hours`;
  return `about ${Math.round(hours / 24)} days`;
}

/**
 * The line a late timer run starts with, so the agent says in its reply that it is late and
 * when it was due. Null when the run starts on time (at most 10 minutes after it was due). A late
 * run is never skipped: the user still gets it, told that it is late.
 */
export function lateNote(
  dueAt: Date,
  startedAt: Date,
  timeZone: string,
  afterMs = lateAfterMs,
): string | null {
  const late = startedAt.getTime() - dueAt.getTime();
  if (late <= afterMs) return null;
  return (
    `[This run is late. It was due at ${describeDueTime(dueAt, timeZone)} and starts ` +
    `${howLate(late)} late. Start your reply by saying that it is late and when it was due.]`
  );
}

/** scheduled/run-automation: the timer fired → queue a normal inbound turn (per-user lock applies). */
export async function handleRunAutomation(job: Job): Promise<unknown> {
  const { automationId } = job.data as { automationId: string };
  const a = await load(automationId);
  if (!a || !a.enabled || a.completedAt) return IGNORED;
  const dueAt = dueTimeOf(a, job).toISOString();
  await ingestEvent({
    source: 'automation',
    externalId: `${a.id}:${job.id}`,
    type: 'fired',
    userId: a.userId,
    payload: { automationId: a.id, firedAt: new Date().toISOString(), dueAt },
    queue: 'inbound',
    jobName: 'automation-turn',
    jobData: { automationId: a.id, dueAt },
  });
  return null;
}

/** The path of the web app that opens the Automations chat. */
export const AUTOMATIONS_CHAT_PATH = '/?chat=automations';

/**
 * The copy of a run's answer that goes to the chat app the automation was made in: a first line
 * naming the automation, the answer, and a last line saying where to follow it up (only while web
 * chat is on). Sent as it is written; the chat app's own plain-text step still runs on it.
 */
export function copyText(
  a: Pick<Automation, 'kind' | 'title'>,
  text: string,
  opts: { test?: boolean } = {},
): string {
  const head = opts.test
    ? `🧪 Test run: ${a.title}`
    : `${a.kind === 'event' ? '⚡' : '⏰'} ${a.title}`;
  const tail = isChannelEnabled('web')
    ? `\n\nTo follow up, open the Automations chat in ${WEB_APP_NAME}: ${config().WEB_APP_URL}${AUTOMATIONS_CHAT_PATH}`
    : '';
  return `${head}\n\n${text.trim()}${tail}`;
}

/**
 * A copy of `message`, which is kept in the Automations chat, is sent to the chat app the user's
 * settings name (copyRules) as well, as plain text. The copy is kept beside the message, in the
 * Automations chat (outbound.ts, `copyOf`): it starts no conversation in that chat app, is not
 * shown twice in the web app, and never becomes part of the agent's context. Once per message, so
 * a job that runs again sends no second copy.
 */
async function copyToChat(
  a: Automation,
  message: MessageRow | undefined,
  opts: { test?: boolean; suffix?: string } = {},
): Promise<void> {
  if (!message) return;
  const target = (await copyRules(a.userId))(a);
  if (!target) return;
  const text = opts.suffix ? `${message.text.trim()}\n\n${opts.suffix}` : message.text;
  await queueOutbound({
    userId: a.userId,
    sessionKey: target,
    text: copyText(a, text, opts),
    copyOf: message.id,
  });
}

/**
 * A run's outcome counts toward "paused after 3 failures in a row" (a success starts again from
 * zero), with the notice in the Automations chat and its copy when it pauses.
 */
async function countRun(
  a: Automation,
  ok: boolean,
  chat: { sessionKey: string; id: string },
): Promise<void> {
  const updated = await recordRun(a, ok);
  if (ok || updated.failCount < MAX_FAILURES || !updated.enabled) return;
  await setEnabled(a.userId, a.id, false, 'failures');
  const notice = await queueOutbound({
    userId: a.userId,
    sessionKey: chat.sessionKey,
    conversationId: chat.id,
    inAutomationsChat: true,
    text: `I paused the automation "${a.title}" because it failed ${MAX_FAILURES} times in a row. You can resume it in the web app.`,
  });
  await copyToChat(a, notice);
}

/**
 * One run as one turn of the agent, in the user's Automations chat: wherever the automation was
 * made, never in the conversation the user has open, and never made the active one. The agent
 * continues the Automations chat's own context. The run's reply (the agent's answer, or what the
 * platform said instead) is then copied to the chat app the automation was made in, if any.
 */
async function runAutomationTurn(
  a: Automation,
  deliveryId: string,
  kind: TurnKind,
  text: string,
  metadata: Record<string, unknown> = {},
): Promise<TurnOutcome> {
  const chat = await automationsChat(a.userId);
  const outcome = await runTurn({
    automationId: a.id,
    // An approval its run asks may go to Telegram too. Not for a test run: that is the user's own.
    forAutomation: a.id,
    userId: a.userId,
    deliveryId,
    kind,
    sessionKey: chat.sessionKey,
    channel: chat.channel,
    text,
    conversationId: chat.id,
    inAutomationsChat: true,
    metadata: { automationId: a.id, title: a.title, ...metadata },
  });
  // Suspended by an admin: the run did nothing. Paused like the rest, back on unsuspend.
  if (outcome === 'suspended') {
    await setEnabled(a.userId, a.id, false, 'suspended');
    return outcome;
  }
  await copyToChat(a, await turnReply(a.userId, deliveryId));
  if (outcome === 'out_of_credits') {
    await setEnabled(a.userId, a.id, false, 'out_of_credits');
    return outcome;
  }
  await countRun(a, outcome !== 'error', chat);
  return outcome;
}

// ---------------------------------------------------------------- automations with steps

/** The line a run says when steps are switched off on this server (AUTOMATION_STEPS=false). */
export const STEPS_OFF_TEXT = (a: Pick<Automation, 'title'>) =>
  `"${a.title}" has steps, and automations with steps are switched off on this server for now, so nothing ran.`;

/** Once per key (a job that runs again says nothing twice). A Redis that can't be asked: say it. */
async function once(key: string): Promise<boolean> {
  const first = await redis()
    .set(key, '1', 'EX', 7 * 24 * 3600, 'NX')
    .catch(() => 'OK');
  return first === 'OK';
}

/**
 * After a turn of a run with steps (its first, or the one after a yes): what the user is told, and
 * what it counts. Once per turn, so a job that runs again tells nothing twice.
 * - A run that stopped (a false "only if", a no, no answer): one line in the Automations chat with
 *   the trail, and no copy to Telegram (decision 2). Not a failure.
 * - Otherwise the trail line ("Steps: 1 ✓ 2 ✓ 3 ✓ 4 waiting for your OK") after Tex's answer, with
 *   why above it when the run failed; the turn's answer is copied to the chat app with them, as a
 *   run's answer is.
 * - A failed run counts toward "paused after 3 failures in a row"; a test run counts nothing.
 */
async function reportRun(
  a: Automation,
  run: Run,
  turnId: string,
  opts: { first: boolean; outcome?: TurnOutcome },
): Promise<void> {
  if (!(await once(`auto-run-report:${run.id}:${turnId}`))) return;
  const chat = await automationsChat(a.userId);
  const say = (text: string) =>
    queueOutbound({
      userId: a.userId,
      sessionKey: chat.sessionKey,
      conversationId: chat.id,
      inAutomationsChat: true,
      text,
    });
  if (opts.outcome === 'out_of_credits') {
    // The turn said so itself; as a run without steps, its answer is copied and it pauses.
    if (opts.first) await copyToChat(a, await turnReply(a.userId, turnId), { test: run.test });
    if (!run.test) await setEnabled(a.userId, a.id, false, 'out_of_credits');
    return;
  }
  const trail = trailLine(run);
  if (run.state === 'stopped' || run.state === 'superseded') {
    await say(`${run.test ? '🧪 ' : ''}${a.title}: ${run.stopReason ?? 'stopped'}\n${trail}`);
    if (!run.test && opts.first) await countRun(a, true, chat);
    return;
  }
  // A failed run says why above its trail: Tex may have ended without saying (Tex ending early).
  const line = run.state === 'failed' && run.stopReason ? `${run.stopReason}\n${trail}` : trail;
  await say(line);
  // Tex's answer of this turn (the first, or the one after a yes) is copied, as a run's answer is.
  if (opts.first || opts.outcome)
    await copyToChat(a, await turnReply(a.userId, turnId), { test: run.test, suffix: line });
  if (run.test) return;
  if (run.state === 'failed') await countRun(a, false, chat);
  else if (opts.first) await countRun(a, true, chat);
}

const closeOutcome = (o: TurnOutcome) =>
  o === 'done'
    ? 'done'
    : o === 'error'
      ? 'error'
      : o === 'out_of_credits'
        ? 'out_of_credits'
        : 'other';

/**
 * One run of an automation with steps (docs/backend-report.md, "Automations with steps"): its run
 * record (one per event), then one turn of Tex that follows the steps, with the run noted beside
 * the turn so the tools hold every call to the current step. A job that runs again finds the run:
 * a run still at a step carries on from the first step not done; one that ended, or waits for a
 * yes, only finishes what it tells the user.
 */
async function runStepped(
  a: Automation,
  eventId: string,
  kind: TurnKind,
  opts: { head: string; tail?: string; test?: boolean; metadata?: Record<string, unknown> },
): Promise<void> {
  const chat = await automationsChat(a.userId);
  if (!config().AUTOMATION_STEPS) {
    if (await once(`auto-steps-off:${eventId}`))
      await queueOutbound({
        userId: a.userId,
        sessionKey: chat.sessionKey,
        conversationId: chat.id,
        inAutomationsChat: true,
        text: STEPS_OFF_TEXT(a),
      });
    return;
  }
  const { run, created } = await startRun(a, eventId, { test: opts.test === true });
  if (!created && run.state !== 'running') {
    await reportRun(a, run, eventId, { first: true });
    return;
  }
  if (!created && run.turnId !== eventId) return;
  if (opts.test && (await once(`test-run-notice:${eventId}`)))
    await queueOutbound({
      userId: a.userId,
      sessionKey: chat.sessionKey,
      conversationId: chat.id,
      inAutomationsChat: true,
      text: testRunNotice(a),
    });
  const outcome = await runTurn({
    automationId: a.id,
    automationRunId: run.id,
    // An approval its run asks may go to Telegram too. Not for a test run: that is the user's own.
    ...(opts.test ? {} : { forAutomation: a.id }),
    userId: a.userId,
    deliveryId: eventId,
    kind,
    sessionKey: chat.sessionKey,
    channel: chat.channel,
    text: runTurnText(a, run, { head: opts.head, ...(opts.tail ? { tail: opts.tail } : {}) }),
    conversationId: chat.id,
    inAutomationsChat: true,
    metadata: {
      automationId: a.id,
      title: a.title,
      automation_run: run.id,
      ...(opts.test ? { test_run: true } : {}),
      ...opts.metadata,
    },
  });
  if (outcome === 'suspended') {
    if (!opts.test) await setEnabled(a.userId, a.id, false, 'suspended');
    return;
  }
  const after = (await closeTurn(a.userId, run.id, closeOutcome(outcome))) ?? run;
  await reportRun(a, after, eventId, { first: true, outcome });
}

/**
 * inbound/process-approval, for an approval asked for a step of a run with steps. Undefined: not
 * one, so the usual answer path takes it. A no stops the run there, with one line and no turn. A
 * yes wakes Tex in the Automations chat with the run noted beside that turn too: Tex runs the
 * approved action and goes on with the steps after it. An older run superseded meanwhile, or a
 * paused automation, runs nothing.
 */
export async function handleRunApprovalAnswer(job: Job): Promise<unknown> {
  const { approvalId, userId, eventId } = job.data as {
    approvalId?: string;
    userId?: string;
    eventId: string;
  };
  if (!approvalId || !userId) return undefined;
  const ap = await getApproval(userId, approvalId);
  if (!ap?.automationRunId) return undefined;
  if (ap.status !== 'approved' && ap.status !== 'rejected') return IGNORED;
  const run = await getRun(userId, ap.automationRunId);
  const a = run ? await load(run.automationId) : undefined;
  if (!run || !a || a.userId !== userId) return IGNORED;
  if (ap.status === 'rejected') {
    const stopped = await stopAfterNo(userId, run.id, ap.id);
    if (stopped) await reportRun(a, stopped, eventId, { first: false });
    return null;
  }
  if ((!run.test && !a.enabled) || !config().AUTOMATION_STEPS) {
    const stopped = await stopAfterNo(userId, run.id, ap.id, {
      why: (n) =>
        a.enabled
          ? `Automations with steps are switched off on this server, so step ${n} did not run.`
          : `The automation is paused, so step ${n} did not run.`,
      reason: a.enabled ? 'Steps are switched off.' : 'The automation was paused.',
    });
    if (stopped) await reportRun(a, stopped, eventId, { first: false });
    return null;
  }
  const resumed = await resumeAfterYes(userId, run.id, ap.id, eventId);
  if (!resumed) return IGNORED;
  const chat = await automationsChat(userId);
  const conversationId = await conversationOfApproval(userId, ap.id);
  const n = (currentStep(resumed)?.index ?? 0) + 1;
  const head =
    `[Automation "${a.title}": the user APPROVED step ${n}: ${ap.summary}.] Go ahead: call run_app_action with ` +
    `action "${ap.action}" and approval_id "${ap.id}" (leave arguments out: the approved ones run). Then go on ` +
    'with the steps after it, one at a time.';
  const outcome = await runTurn({
    automationId: a.id,
    automationRunId: run.id,
    // The yes to an automation's question: what its run asks next may go to Telegram too.
    ...(ap.automationId ? { forAutomation: ap.automationId } : {}),
    userId,
    deliveryId: eventId,
    kind: 'approval_answer',
    sessionKey: ap.sessionKey,
    channel: chat.channel,
    conversationId: conversationId ?? chat.id,
    inAutomationsChat: true,
    approval: { id: ap.id, approved: true },
    text: runTurnText(a, resumed, { head }),
    metadata: { automationId: a.id, title: a.title, automation_run: run.id },
  });
  if (outcome === 'suspended') return null;
  const after = (await closeTurn(userId, run.id, closeOutcome(outcome))) ?? resumed;
  await reportRun(a, after, eventId, { first: false, outcome });
  return null;
}

/** system/expire-automation-runs (hourly): runs that waited 24 hours stop, with their line. */
export async function handleExpireRuns(): Promise<number> {
  const stopped = await expireWaitingRuns();
  for (const r of stopped) {
    const a = await load(r.automationId);
    if (a) await reportRun(a, r, 'expired', { first: false });
  }
  return stopped.length;
}

/**
 * What an automation-turn job is about. Its data, or, for a job re-added from its saved event
 * after Redis lost its jobs (that job has only the event id), the event's payload.
 */
async function timerRunOf(
  job: Job,
): Promise<{ automationId?: string; dueAt?: string; test?: boolean }> {
  const data = job.data as {
    automationId?: string;
    dueAt?: string;
    test?: boolean;
    eventId: string;
  };
  if (data.automationId) return data;
  const payload = (await getEvent(data.eventId))?.payload as
    { automationId?: string; dueAt?: string; test?: boolean } | undefined;
  return payload ?? {};
}

/** The line in the Automations chat before a test run, which marks it as one. */
export function testRunNotice(a: Pick<Automation, 'title'>): string {
  return `🧪 Test run of "${a.title}", started by you. It runs once now, as a real run would, and costs what a run costs. The schedule doesn't change.`;
}

/**
 * The text of a test run: the instruction, after a note that says it is a test the user started,
 * and for an app event that no event happened.
 */
export function testRunText(a: Pick<Automation, 'kind' | 'title' | 'instruction'>): string {
  return `${testRunHead(a)} ${a.instruction}`;
}

/** The note a test run starts with: a test the user started, and for an app event, no event. */
export function testRunHead(a: Pick<Automation, 'kind' | 'title'>): string {
  const event =
    a.kind === 'event'
      ? ' No app event happened, so there is no event data: follow the instruction as well as you can without it, for example with the latest matching item, and say what you used.'
      : '';
  return `[Test run of automation "${a.title}", started by the user from the web app.${event} Start your answer with "Test run:".]`;
}

/**
 * A test run ("Run once now"): one turn in the Automations chat, on or paused, marked by a line
 * before it and in its copy to a chat app. It moves no schedule, finishes no one-time reminder,
 * counts no failure, and pauses nothing (at zero credits the turn just says so). The line is sent
 * once per run, also when the job runs again.
 */
async function runTestTurn(a: Automation, eventId: string): Promise<void> {
  const chat = await automationsChat(a.userId);
  // Once per run: a job that runs again finds the mark and sends no second line.
  const first = await redis()
    .set(`test-run-notice:${eventId}`, '1', 'EX', 24 * 3600, 'NX')
    .catch(() => 'OK');
  if (first === 'OK')
    await queueOutbound({
      userId: a.userId,
      sessionKey: chat.sessionKey,
      conversationId: chat.id,
      inAutomationsChat: true,
      text: testRunNotice(a),
    });
  const outcome = await runTurn({
    automationId: a.id,
    userId: a.userId,
    deliveryId: eventId,
    kind: 'automation',
    sessionKey: chat.sessionKey,
    channel: chat.channel,
    text: testRunText(a),
    conversationId: chat.id,
    inAutomationsChat: true,
    metadata: { automationId: a.id, title: a.title, test_run: true },
  });
  if (outcome === 'suspended') return;
  await copyToChat(a, await turnReply(a.userId, eventId), { test: true });
}

/** inbound/automation-turn: same path as a normal message, with the saved instruction. */
export async function handleAutomationTurn(job: Job): Promise<unknown> {
  const { eventId } = job.data as { eventId: string };
  const { automationId, dueAt, test } = await timerRunOf(job);
  const a = automationId ? await load(automationId) : undefined;
  // A test run is the user's own "Run once now": on or paused, but not a finished reminder.
  if (test) {
    if (!a || a.completedAt) return IGNORED;
    if (a.steps?.length) {
      await runStepped(a, eventId, 'automation', {
        head: testRunHead(a),
        test: true,
      });
      return null;
    }
    await runTestTurn(a, eventId);
    return null;
  }
  if (!a || !a.enabled) return IGNORED;
  const note = dueAt ? lateNote(new Date(dueAt), new Date(), a.timezone ?? 'UTC') : null;
  if (a.steps?.length) {
    await runStepped(a, eventId, 'automation', {
      head: `[Automation "${a.title}"]${note ? ` ${note}` : ''}`,
    });
    return null;
  }
  await runAutomationTurn(
    a,
    eventId,
    'automation',
    `[Automation "${a.title}"] ${note ? `${note}\n` : ''}${a.instruction}`,
  );
  return null;
}

/** inbound/composio-trigger: an app event (e.g. "when my boss emails me"). */
export async function handleComposioTrigger(job: Job): Promise<unknown> {
  const { eventId } = job.data as { eventId: string };
  const event = await getEvent(eventId);
  if (!event) return IGNORED;
  const t = event.payload as unknown as ComposioTriggerEvent;
  if (!t.triggerId) return IGNORED;
  const a = await findByTriggerRef(t.triggerId);
  // The event must belong to the automation's owner.
  if (!a || a.userId !== t.userId || a.userId !== event.userId || !a.enabled) return IGNORED;
  // Pull-request review (HLD 0.8): one review per head commit, with its own instruction.
  if (a.preset === 'pr_review') {
    const run = await preparePrReview(a, t, eventId);
    if (!run) return IGNORED;
    const outcome = await runAutomationTurn(a, eventId, 'app_event', run.text, run.metadata);
    await finishPrReview(run.claimId, outcome);
    return null;
  }
  const summary = JSON.stringify(t.payload).slice(0, 4000);
  if (a.steps?.length) {
    await runStepped(a, eventId, 'app_event', {
      head: `[Automation "${a.title}"]`,
      tail: `Event ${t.triggerSlug}: ${summary}`,
    });
    return null;
  }
  await runAutomationTurn(
    a,
    eventId,
    'app_event',
    `[Automation "${a.title}"] ${a.instruction}\n\nEvent ${t.triggerSlug}: ${summary}`,
  );
  return null;
}
