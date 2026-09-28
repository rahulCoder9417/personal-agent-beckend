import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { queueOutbound } from '../channels/outbound.ts';
import { parseSessionKey } from '../channels/types.ts';
import { getEvent, ingestEvent } from '../events/intake.ts';
import type { ComposioTriggerEvent } from '../integrations/composio.ts';
import { runTurn, type TurnKind } from '../orchestrator/turn.ts';
import { IGNORED } from '../../worker/ignored.ts';
import { findByTriggerRef, recordRun, setEnabled, type Automation } from './automations.ts';
import { automations } from './schema.ts';

export const MAX_FAILURES = 3;

async function load(id: string): Promise<Automation | undefined> {
  const [row] = await db().select().from(automations).where(eq(automations.id, id));
  return row;
}

/** scheduled/run-automation: the timer fired → queue a normal inbound turn (per-user lock applies). */
export async function handleRunAutomation(job: Job): Promise<unknown> {
  const { automationId } = job.data as { automationId: string };
  const a = await load(automationId);
  if (!a || !a.enabled || a.completedAt) return IGNORED;
  await ingestEvent({
    source: 'automation',
    externalId: `${a.id}:${job.id}`,
    type: 'fired',
    userId: a.userId,
    payload: { automationId: a.id, firedAt: new Date().toISOString() },
    queue: 'inbound',
    jobName: 'automation-turn',
    jobData: { automationId: a.id },
  });
  return null;
}

async function runAutomationTurn(
  a: Automation,
  deliveryId: string,
  kind: TurnKind,
  text: string,
): Promise<void> {
  const session = parseSessionKey(a.sessionKey) ?? { channel: 'web' as const };
  const outcome = await runTurn({
    userId: a.userId,
    deliveryId,
    kind,
    sessionKey: a.sessionKey,
    channel: session.channel,
    text,
    metadata: { automationId: a.id, title: a.title },
  });
  if (outcome === 'out_of_credits') {
    await setEnabled(a.userId, a.id, false, 'out_of_credits');
    return;
  }
  const updated = await recordRun(a, outcome !== 'error');
  if (outcome === 'error' && updated.failCount >= MAX_FAILURES && updated.enabled) {
    await setEnabled(a.userId, a.id, false, 'failures');
    await queueOutbound({
      userId: a.userId,
      sessionKey: a.sessionKey,
      text: `I paused the automation "${a.title}" because it failed ${MAX_FAILURES} times in a row. You can resume it in the web app.`,
    });
  }
}

/** inbound/automation-turn: same path as a normal message, with the saved instruction. */
export async function handleAutomationTurn(job: Job): Promise<unknown> {
  const { automationId, eventId } = job.data as { automationId: string; eventId: string };
  const a = await load(automationId);
  if (!a || !a.enabled) return IGNORED;
  await runAutomationTurn(a, eventId, 'automation', `[Automation "${a.title}"] ${a.instruction}`);
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
  const summary = JSON.stringify(t.payload).slice(0, 4000);
  await runAutomationTurn(
    a,
    eventId,
    'app_event',
    `[Automation "${a.title}"] ${a.instruction}\n\nEvent ${t.triggerSlug}: ${summary}`,
  );
  return null;
}
