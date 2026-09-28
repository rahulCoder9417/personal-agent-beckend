import { and, inArray, lt } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { events } from './schema.ts';

/** Old finished events (the permanent record is kept 30 days after it's done). */
export async function cleanupEvents(olderThanDays = 30): Promise<number> {
  const rows = await db()
    .delete(events)
    .where(
      and(
        inArray(events.status, ['done', 'ignored']),
        lt(events.createdAt, new Date(Date.now() - olderThanDays * 86400_000)),
      ),
    )
    .returning({ id: events.id });
  return rows.length;
}
