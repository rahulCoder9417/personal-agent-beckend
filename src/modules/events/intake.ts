import { and, eq, gt, inArray } from 'drizzle-orm';
import { db, type Tx } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { runLater } from '../../shared/later.ts';
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
  /** The new event's id, when the caller made it already (a web message is saved with it). */
  id?: string;
  /**
   * Don't wait for the event's `queued` mark (one round trip). Safe: the job is already added, and
   * an event left `received` is queued again by a resend or a worker start, which the job's id makes
   * harmless. For a request whose answer someone is waiting for (the web app's send).
   */
  markLater?: boolean;
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
      id: input.id ?? newId('evt'),
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
    await enqueueEvent(row, input.jobData, input.markLater);
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

/**
 * Saves the event inside the caller's transaction, so it exists exactly when the caller's own
 * change does: an approval's answer and its event are one step, so a message the user sends right
 * after the answer can't be queued before it. Add its job with queueSavedEvent once the transaction
 * is over. Null: the event was saved before (its job was added then; a worker start adds it again
 * while it is still `received`).
 */
export async function saveEvent(
  input: Omit<IngestInput, 'jobData' | 'markLater'>,
  tx: Tx,
): Promise<EventRow | null> {
  const [row] = await tx
    .insert(events)
    .values({
      id: input.id ?? newId('evt'),
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
  return row ?? null;
}

/** Adds the job of an event saved with saveEvent (its id is the job's id, so twice is harmless). */
export async function queueSavedEvent(
  row: EventRow,
  jobData?: Record<string, unknown>,
): Promise<void> {
  await enqueueEvent(row, jobData);
}

/** Plan → inbound priority (HLD 7.1: Max gets priority in the queue). Filled by wiring. */
let priorityFor: (userId: string) => Promise<number | undefined> = async () => undefined;
export function setInboundPriority(fn: (userId: string) => Promise<number | undefined>): void {
  priorityFor = fn;
}

async function enqueueEvent(
  row: EventRow,
  jobData?: Record<string, unknown>,
  markLater = false,
): Promise<void> {
  if (!row.queue || !row.jobName) return;
  const priority =
    row.queue === 'inbound' && row.userId ? await priorityFor(row.userId) : undefined;
  await addJob(
    row.queue as QueueName,
    row.jobName,
    { ...jobData, eventId: row.id, userId: row.userId },
    { jobId: row.id, ...(priority ? { priority } : {}) },
  );
  // Only while the row is still `received`. A quick job (a link-code reply) can end before this
  // line runs: its `done` / `ignored` must stay, or every worker start would queue it again.
  const mark = () =>
    db()
      .update(events)
      .set({ status: 'queued' })
      .where(and(eq(events.id, row.id), eq(events.status, 'received')));
  if (markLater) runLater("an event's queued mark", mark, { eventId: row.id });
  else await mark();
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

/** The event saved for a source's own id (e.g. source `approval`, the approval's id). */
export async function findEvent(source: string, externalId: string): Promise<EventRow | undefined> {
  const [row] = await db()
    .select()
    .from(events)
    .where(and(eq(events.source, source), eq(events.externalId, externalId)));
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
