import { and, count, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { notFound, rateLimited } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import { hit } from '../../shared/rate-limit.ts';
import { waitlistAttempts, waitlistEntries } from './schema.ts';

export type WaitlistEntry = typeof waitlistEntries.$inferSelect;
export type WaitlistStatus = WaitlistEntry['status'];
type Outcome = (typeof waitlistAttempts.$inferSelect)['outcome'];

/** Request data stored with every entry and attempt (abuse monitoring). */
export interface RequestInfo {
  ip: string;
  forwardedFor?: string | null;
  userAgent?: string | null;
  acceptLanguage?: string | null;
  referer?: string | null;
  origin?: string | null;
}

export interface JoinInput {
  email: string;
  name?: string;
  referralSource?: string;
  useCase?: string;
  utm?: Record<string, string>;
  /** Honeypot: the form hides it; bots fill it. */
  website?: string;
}

export const WAITLIST_LIMITS = {
  perIpPerHour: 10,
  perEmailPerHour: 5,
  /** More entries than this from one IP in 24 h are flagged `ip_burst`. */
  ipBurst: 3,
};

/** Throwaway-inbox domains (flagged, not refused). */
const DISPOSABLE = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.info',
  'sharklasers.com',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'yopmail.com',
  'trashmail.com',
  'getnada.com',
  'dispostable.com',
  'maildrop.cc',
  'throwawaymail.com',
  'fakeinbox.com',
  'mintemail.com',
  'mohmal.com',
  'emailondeck.com',
  'tempmailo.com',
  'burnermail.io',
  'mail.tm',
]);

const clip = (v: string | null | undefined, max = 500) => (v ? v.slice(0, max) : null);

/** Lowercase; for Gmail drop dots and +tags, so one inbox can't join many times. */
export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  local = local.split('+')[0]!;
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

async function logAttempt(
  req: RequestInfo,
  outcome: Outcome,
  emailNormalized: string | null,
  entryId: string | null,
) {
  await db()
    .insert(waitlistAttempts)
    .values({
      id: newId('wla'),
      entryId,
      emailNormalized,
      ip: req.ip,
      userAgent: clip(req.userAgent),
      outcome,
    });
}

/**
 * Adds someone to the waitlist. The answer never says whether the email was already there.
 * Honeypot hits "succeed" without an entry; rate-limited attempts are logged, then refused.
 */
export async function joinWaitlist(input: JoinInput, req: RequestInfo): Promise<void> {
  const normalized = normalizeEmail(input.email);

  const [byIp, byEmail] = await Promise.all([
    hit({ key: `waitlist:ip:${req.ip}`, max: WAITLIST_LIMITS.perIpPerHour, windowSeconds: 3600 }),
    hit({
      key: `waitlist:email:${normalized}`,
      max: WAITLIST_LIMITS.perEmailPerHour,
      windowSeconds: 3600,
    }),
  ]);
  if (!byIp.allowed || !byEmail.allowed) {
    await logAttempt(req, 'rate_limited', normalized, null);
    throw rateLimited(
      Math.max(byIp.allowed ? 0 : byIp.retryAfter, byEmail.allowed ? 0 : byEmail.retryAfter),
    );
  }

  if (input.website?.trim()) {
    await logAttempt(req, 'honeypot', normalized, null);
    return;
  }

  const reasons: string[] = [];
  if (DISPOSABLE.has(normalized.split('@')[1]!)) reasons.push('disposable_email');
  const [recent] = await db()
    .select({ n: count() })
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.ip, req.ip),
        gt(waitlistEntries.createdAt, new Date(Date.now() - 86400_000)),
      ),
    );
  if ((recent?.n ?? 0) >= WAITLIST_LIMITS.ipBurst) reasons.push('ip_burst');

  const [created] = await db()
    .insert(waitlistEntries)
    .values({
      id: newId('wl'),
      email: input.email.trim().slice(0, 254),
      emailNormalized: normalized,
      name: clip(input.name, 80),
      referralSource: clip(input.referralSource, 100),
      useCase: clip(input.useCase, 500),
      utm: input.utm && Object.keys(input.utm).length ? input.utm : null,
      flagged: reasons.length > 0,
      flagReasons: reasons,
      ip: req.ip,
      forwardedFor: clip(req.forwardedFor),
      userAgent: clip(req.userAgent),
      acceptLanguage: clip(req.acceptLanguage, 200),
      referer: clip(req.referer),
      origin: clip(req.origin, 200),
    })
    .onConflictDoNothing({ target: waitlistEntries.emailNormalized })
    .returning({ id: waitlistEntries.id });

  if (created) {
    await logAttempt(req, 'created', normalized, created.id);
    return;
  }

  // Already on the list: count it; a different spelling of the same inbox is an alias.
  const [existing] = await db()
    .select()
    .from(waitlistEntries)
    .where(eq(waitlistEntries.emailNormalized, normalized));
  const alias = existing!.email.toLowerCase() !== input.email.trim().toLowerCase();
  const newReasons = [
    ...new Set([...existing!.flagReasons, ...reasons, ...(alias ? ['email_alias'] : [])]),
  ];
  await db()
    .update(waitlistEntries)
    .set({
      submitCount: sql`${waitlistEntries.submitCount} + 1`,
      lastSeenAt: new Date(),
      flagReasons: newReasons,
      flagged: existing!.flagged || newReasons.length > existing!.flagReasons.length,
    })
    .where(eq(waitlistEntries.id, existing!.id));
  await logAttempt(req, 'duplicate', normalized, existing!.id);
}

export function toApiWaitlistEntry(e: WaitlistEntry) {
  return {
    id: e.id,
    email: e.email,
    name: e.name,
    referralSource: e.referralSource,
    useCase: e.useCase,
    utm: e.utm,
    status: e.status,
    flagged: e.flagged,
    flagReasons: e.flagReasons as Array<'disposable_email' | 'ip_burst' | 'email_alias' | 'manual'>,
    ip: e.ip,
    forwardedFor: e.forwardedFor,
    userAgent: e.userAgent,
    acceptLanguage: e.acceptLanguage,
    referer: e.referer,
    origin: e.origin,
    submitCount: e.submitCount,
    createdAt: e.createdAt.toISOString(),
    lastSeenAt: e.lastSeenAt.toISOString(),
  };
}

export async function listWaitlist(opts: {
  limit: number;
  cursor?: string;
  status?: WaitlistStatus;
  flagged?: boolean;
  ip?: string;
}) {
  const where = [];
  if (opts.cursor) where.push(lt(waitlistEntries.id, opts.cursor));
  if (opts.status) where.push(eq(waitlistEntries.status, opts.status));
  if (opts.flagged !== undefined) where.push(eq(waitlistEntries.flagged, opts.flagged));
  if (opts.ip) where.push(eq(waitlistEntries.ip, opts.ip));
  const rows = await db()
    .select()
    .from(waitlistEntries)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(waitlistEntries.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  return { items: page, nextCursor: rows.length > opts.limit ? page[page.length - 1]!.id : null };
}

export async function updateWaitlistEntry(
  id: string,
  patch: { status?: WaitlistStatus; flagged?: boolean },
): Promise<WaitlistEntry> {
  const [existing] = await db().select().from(waitlistEntries).where(eq(waitlistEntries.id, id));
  if (!existing) throw notFound('Waitlist entry not found');
  const set: Partial<WaitlistEntry> = {};
  if (patch.status) set.status = patch.status;
  if (patch.flagged !== undefined) {
    set.flagged = patch.flagged;
    set.flagReasons = patch.flagged
      ? [...new Set([...existing.flagReasons, 'manual'])]
      : existing.flagReasons.filter((r) => r !== 'manual');
  }
  const [row] = await db()
    .update(waitlistEntries)
    .set(set)
    .where(eq(waitlistEntries.id, id))
    .returning();
  return row!;
}

export async function waitlistStats() {
  const day = new Date(Date.now() - 86400_000);
  const week = new Date(Date.now() - 7 * 86400_000);
  const [totals] = await db()
    .select({
      total: count(),
      pending: sql<number>`count(*) filter (where ${waitlistEntries.status} = 'pending')`.mapWith(
        Number,
      ),
      invited: sql<number>`count(*) filter (where ${waitlistEntries.status} = 'invited')`.mapWith(
        Number,
      ),
      rejected: sql<number>`count(*) filter (where ${waitlistEntries.status} = 'rejected')`.mapWith(
        Number,
      ),
      flagged: sql<number>`count(*) filter (where ${waitlistEntries.flagged})`.mapWith(Number),
      last24h: sql<number>`count(*) filter (where ${waitlistEntries.createdAt} > ${day})`.mapWith(
        Number,
      ),
    })
    .from(waitlistEntries);
  const [attempts] = await db()
    .select({
      all: count(),
      blocked:
        sql<number>`count(*) filter (where ${waitlistAttempts.outcome} in ('honeypot', 'rate_limited'))`.mapWith(
          Number,
        ),
    })
    .from(waitlistAttempts)
    .where(gt(waitlistAttempts.createdAt, day));
  const top = await db()
    .select({
      ip: waitlistAttempts.ip,
      attempts: count(),
      entries: sql<number>`count(distinct ${waitlistAttempts.entryId})`.mapWith(Number),
      lastAt: sql<Date>`max(${waitlistAttempts.createdAt})`.mapWith(
        (v: string | Date) => new Date(v),
      ),
    })
    .from(waitlistAttempts)
    .where(gt(waitlistAttempts.createdAt, week))
    .groupBy(waitlistAttempts.ip)
    .having(sql`count(*) > 1`)
    .orderBy(desc(count()))
    .limit(20);
  return {
    total: totals?.total ?? 0,
    pending: totals?.pending ?? 0,
    invited: totals?.invited ?? 0,
    rejected: totals?.rejected ?? 0,
    flagged: totals?.flagged ?? 0,
    last24h: totals?.last24h ?? 0,
    attemptsLast24h: attempts?.all ?? 0,
    blockedLast24h: attempts?.blocked ?? 0,
    topIps: top.map((t) => ({
      ip: t.ip,
      entries: t.entries,
      attempts: t.attempts,
      lastAt: t.lastAt.toISOString(),
    })),
  };
}

/** Retention: attempts are kept 90 days. */
export async function cleanupWaitlistAttempts(olderThanDays = 90): Promise<number> {
  const rows = await db()
    .delete(waitlistAttempts)
    .where(lt(waitlistAttempts.createdAt, new Date(Date.now() - olderThanDays * 86400_000)))
    .returning({ id: waitlistAttempts.id });
  return rows.length;
}
