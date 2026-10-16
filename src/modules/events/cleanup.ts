import { lt } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { events } from './schema.ts';

/**
 * Saved webhooks and other events older than `olderThanDays` (30), whatever their state: done,
 * ignored, failed, or left waiting. The privacy page promises raw events are kept 30 days, and a
 * failed one holds the message as it came in.
 *
 * What a duplicate check needs stays: an event's row is what makes a provider's resend of it a
 * no-op (unique on source + external id), and the providers resend within hours or a few days, so
 * a 30-day-old key is never asked for again. A worker start queues again only events of the last
 * 7 days, so nothing removed here was still due to run.
 */
export async function cleanupEvents(olderThanDays = 30, now = new Date()): Promise<number> {
  const rows = await db()
    .delete(events)
    .where(lt(events.createdAt, new Date(now.getTime() - olderThanDays * 86400_000)))
    .returning({ id: events.id });
  return rows.length;
}
