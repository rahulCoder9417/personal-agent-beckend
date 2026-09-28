import { and, eq, gt, inArray } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { addJob, type QueueName } from './queues.ts';
import { events } from './schema.ts';

export type EventRow = typeof events.$inferSelect;

export interface IngestInput {
  source: string;
  /** Provider's unique id for this event (message id, svix-id, …). */
  externalId: string;
  type: string;
  userId?: string | null;
  payload: Record<string, unknown>;
  queue: QueueName;
  jobName: string;
  /** Extra job data; `eventId` and `userId` are always added. */
  jobData?: Record<string, unknown>;
}

/**
 * "Webhooks never do work": save the event (unique on source + external id) and add one job
 * whose id is the event id. Sending the same event twice creates one event and one job.
 */
export async function ingestEvent(
  input: IngestInput,
): Promise<{ eventId: string; duplicate: boolean }> {
  const [row] = await db()
    .insert(events)
    .values({
      id: newId('evt'),
      source: input.source,
      externalId: input.externalId,
      type: input.type,
      userId: input.userId ?? null,
      payload: input.payload,
      queue: input.queue,
      jobName: input.jobName,
      status: 'received',
    })
    .onConflictDoNothing({ target: [events.source, events.externalId] })
    .returning();

  if (row) {
    await enqueueEvent(row, input.jobData);
    return { eventId: row.id, duplicate: false };
  }

  const [existing] = await db()
    .select()
    .from(events)
    .where(and(eq(events.source, input.source), eq(events.externalId, input.externalId)));
  // A crash between insert and enqueue leaves it "received": queue it now (jobId dedupes).
  if (existing?.status === 'received') await enqueueEvent(existing, input.jobData);
  return { eventId: existing!.id, duplicate: true };
}

async function enqueueEvent(row: EventRow, jobData?: Record<string, unknown>): Promise<void> {
  if (!row.queue || !row.jobName) return;
  await addJob(
    row.queue as QueueName,
    row.jobName,
    { ...jobData, eventId: row.id, userId: row.userId },
    { jobId: row.id },
  );
  await db().update(events).set({ status: 'queued' }).where(eq(events.id, row.id));
}

/** Saves an event that needs no job (e.g. a duplicate-proof record). Returns false if seen before. */
export async function recordEventOnce(
  input: Omit<IngestInput, 'queue' | 'jobName'>,
): Promise<boolean> {
  const [row] = await db()
    .insert(events)
    .values({
      id: newId('evt'),
      source: input.source,
      externalId: input.externalId,
      type: input.type,
      userId: input.userId ?? null,
      payload: input.payload,
      status: 'done',
      processedAt: new Date(),
    })
    .onConflictDoNothing({ target: [events.source, events.externalId] })
    .returning({ id: events.id });
  return Boolean(row);
}

export async function getEvent(eventId: string): Promise<EventRow | undefined> {
  const [row] = await db().select().from(events).where(eq(events.id, eventId));
  return row;
}

export async function markEvent(
  eventId: string,
  status: 'done' | 'failed' | 'ignored',
  error?: string,
): Promise<void> {
  await db()
    .update(events)
    .set({ status, processedAt: new Date(), error: error ?? null })
    .where(eq(events.id, eventId));
}

/** Redis lost (HLD 0.2 / 10.1): re-add jobs for recent events that were never marked done. */
export async function requeuePendingEvents(sinceMs = 7 * 24 * 3600 * 1000): Promise<number> {
  const rows = await db()
    .select()
    .from(events)
    .where(
      and(
        inArray(events.status, ['received', 'queued']),
        gt(events.createdAt, new Date(Date.now() - sinceMs)),
      ),
    );
  for (const row of rows) await enqueueEvent(row);
  return rows.length;
}
