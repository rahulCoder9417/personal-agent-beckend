import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { config, isChannelEnabled } from '../../shared/config.ts';
import { db } from '../../shared/db/client.ts';
import { redis } from '../../shared/redis.ts';
import { ownsChat } from '../auth/links.ts';
import { isValidTimezone } from '../auth/users.ts';
import { automationsChat } from '../channels/conversations.ts';
import { turnReply, type MessageRow } from '../channels/messages.ts';
import { queueOutbound } from '../channels/outbound.ts';
import { WEB_APP_NAME } from '../channels/purchase-links.ts';
import { parseSessionKey } from '../channels/types.ts';
import { getEvent, ingestEvent } from '../events/intake.ts';
import type { ComposioTriggerEvent } from '../integrations/composio.ts';
import { runTurn, type TurnKind, type TurnOutcome } from '../orchestrator/turn.ts';
import { IGNORED } from '../../worker/ignored.ts';
import { findByTriggerRef, recordRun, setEnabled, type Automation } from './automations.ts';
import { finishPrReview, preparePrReview } from './pr-review.ts';
import { automations } from './schema.ts';

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
 * Made in a chat app (its session key is a Telegram chat): a copy of `message`, which is kept in
 * the Automations chat, is sent there as well, as plain text. It is saved in that chat's current
 * conversation, to be shown there, marked as a copy: it never becomes part of the agent's context
 * in that chat. Once per message, so a job that runs again sends no second copy. Nothing is sent
 * to a chat that is no longer the user's, that blocked the bot, or whose channel is switched off.
 */
async function copyToChat(
  a: Automation,
  message: MessageRow | undefined,
  opts: { test?: boolean } = {},
): Promise<void> {
  const target = parseSessionKey(a.sessionKey);
  if (!message || !target || target.channel === 'web' || !isChannelEnabled(target.channel)) return;
  const link = await ownsChat(a.userId, target.channel, target.externalChatId ?? '');
  if (!link || link.blocked) return;
  await queueOutbound({
    userId: a.userId,
    sessionKey: a.sessionKey,
    text: copyText(a, message.text, opts),
    copyOf: message.id,
  });
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
  const updated = await recordRun(a, outcome !== 'error');
  if (outcome === 'error' && updated.failCount >= MAX_FAILURES && updated.enabled) {
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
  return outcome;
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
  const event =
    a.kind === 'event'
      ? ' No app event happened, so there is no event data: follow the instruction as well as you can without it, for example with the latest matching item, and say what you used.'
      : '';
  return `[Test run of automation "${a.title}", started by the user from the web app.${event} Start your answer with "Test run:".] ${a.instruction}`;
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
    await runTestTurn(a, eventId);
    return null;
  }
  if (!a || !a.enabled) return IGNORED;
  const note = dueAt ? lateNote(new Date(dueAt), new Date(), a.timezone ?? 'UTC') : null;
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
  await runAutomationTurn(
    a,
    eventId,
    'app_event',
    `[Automation "${a.title}"] ${a.instruction}\n\nEvent ${t.triggerSlug}: ${summary}`,
  );
  return null;
}
