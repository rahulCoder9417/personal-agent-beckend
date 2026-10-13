import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { isValidTimezone } from '../auth/users.ts';
import { queueOutbound } from '../channels/outbound.ts';
import { parseSessionKey } from '../channels/types.ts';
import { getEvent, ingestEvent } from '../events/intake.ts';
import type { ComposioTriggerEvent } from '../integrations/composio.ts';
import { runTurn, type TurnKind, type TurnOutcome } from '../orchestrator/turn.ts';
import { IGNORED } from '../../worker/ignored.ts';
import {
  findByTriggerRef,
  recordRun,
  runConversation,
  setEnabled,
  type Automation,
} from './automations.ts';
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

async function runAutomationTurn(
  a: Automation,
  deliveryId: string,
  kind: TurnKind,
  text: string,
  metadata: Record<string, unknown> = {},
): Promise<TurnOutcome> {
  const session = parseSessionKey(a.sessionKey) ?? { channel: 'web' as const };
  // Web chat: the conversation it was made in, or its own; never the one the user has open.
  const conversationId = await runConversation(a);
  const outcome = await runTurn({
    userId: a.userId,
    deliveryId,
    kind,
    sessionKey: a.sessionKey,
    channel: session.channel,
    text,
    ...(conversationId ? { conversationId } : {}),
    metadata: { automationId: a.id, title: a.title, ...metadata },
  });
  if (outcome === 'out_of_credits') {
    await setEnabled(a.userId, a.id, false, 'out_of_credits');
    return outcome;
  }
  const updated = await recordRun(a, outcome !== 'error');
  if (outcome === 'error' && updated.failCount >= MAX_FAILURES && updated.enabled) {
    await setEnabled(a.userId, a.id, false, 'failures');
    await queueOutbound({
      userId: a.userId,
      sessionKey: a.sessionKey,
      conversationId: conversationId ?? null,
      text: `I paused the automation "${a.title}" because it failed ${MAX_FAILURES} times in a row. You can resume it in the web app.`,
    });
  }
  return outcome;
}

/**
 * What an automation-turn job is about. Its data, or, for a job re-added from its saved event
 * after Redis lost its jobs (that job has only the event id), the event's payload.
 */
async function timerRunOf(job: Job): Promise<{ automationId?: string; dueAt?: string }> {
  const data = job.data as { automationId?: string; dueAt?: string; eventId: string };
  if (data.automationId) return data;
  const payload = (await getEvent(data.eventId))?.payload as
    { automationId?: string; dueAt?: string } | undefined;
  return payload ?? {};
}

/** inbound/automation-turn: same path as a normal message, with the saved instruction. */
export async function handleAutomationTurn(job: Job): Promise<unknown> {
  const { eventId } = job.data as { eventId: string };
  const { automationId, dueAt } = await timerRunOf(job);
  const a = automationId ? await load(automationId) : undefined;
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
