import { createHmac } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { config } from '../../shared/config.ts';
import { safeEqual } from '../../shared/crypto.ts';
import { db } from '../../shared/db/client.ts';
import { attachments } from './schema.ts';

export type AttachmentRow = typeof attachments.$inferSelect;

function sign(id: string, exp: number): string {
  return createHmac('sha256', Buffer.from(config().ENCRYPTION_KEY, 'base64'))
    .update(`file:${id}:${exp}`)
    .digest('base64url');
}

/**
 * Short-lived URL a container can fetch through the egress proxy. It lives under /mcp because
 * that's the only api path the proxy lets containers reach.
 */
export function signedFileUrl(id: string, ttlSeconds = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${config().INTERNAL_API_URL}/mcp/files/${id}?exp=${exp}&sig=${sign(id, exp)}`;
}

export function verifyFileSignature(
  id: string,
  exp: string | undefined,
  sig: string | undefined,
): boolean {
  const e = Number(exp);
  if (!sig || !Number.isFinite(e) || e < Date.now() / 1000) return false;
  return safeEqual(sig, sign(id, e));
}

export async function getAttachment(id: string): Promise<AttachmentRow | undefined> {
  const [row] = await db().select().from(attachments).where(eq(attachments.id, id));
  return row;
}

export async function getUserAttachments(userId: string, ids: string[]): Promise<AttachmentRow[]> {
  if (ids.length === 0) return [];
  return db()
    .select()
    .from(attachments)
    .where(and(eq(attachments.userId, userId), inArray(attachments.id, ids)));
}
