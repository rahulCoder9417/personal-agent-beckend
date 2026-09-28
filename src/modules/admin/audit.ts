import { and, desc, eq, lt } from 'drizzle-orm';
import { db, type Tx } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { auditLog } from './schema.ts';

export type AuditEntry = typeof auditLog.$inferSelect;

export interface AuditInput {
  userId: string | null;
  actor: AuditEntry['actor'];
  action: string;
  summary: string;
  details?: Record<string, unknown>;
  creditsCharged?: number | null;
}

/** Append-only audit log (every agent action, redemption, link, admin change). */
export async function audit(input: AuditInput, tx: Tx = db()): Promise<void> {
  await tx.insert(auditLog).values({
    id: newId('aud'),
    userId: input.userId,
    actor: input.actor,
    action: input.action,
    summary: input.summary,
    details: input.details ?? null,
    creditsCharged: input.creditsCharged ?? null,
  });
}

export async function listAudit(userId: string, opts: { cursor?: string; limit: number }) {
  const where = [eq(auditLog.userId, userId)];
  if (opts.cursor) where.push(lt(auditLog.id, opts.cursor));
  const rows = await db()
    .select()
    .from(auditLog)
    .where(and(...where))
    .orderBy(desc(auditLog.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  return { items: page, nextCursor: rows.length > opts.limit ? page[page.length - 1]!.id : null };
}
