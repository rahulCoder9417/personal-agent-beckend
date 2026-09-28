import { count, eq } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { channelLinks } from './schema.ts';

export type ChannelLink = typeof channelLinks.$inferSelect;

export async function countChannelLinks(userId: string): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(channelLinks)
    .where(eq(channelLinks.userId, userId));
  return row?.n ?? 0;
}
