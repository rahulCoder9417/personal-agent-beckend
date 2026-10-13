import type { Job } from 'bullmq';
import { and, desc, eq, gt, isNull, lt, lte } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { conflict, notFound } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import { audit } from '../admin/audit.ts';
import { conversationOfApproval } from '../channels/messages.ts';
import { queueOutbound } from '../channels/outbound.ts';
import { publish } from '../channels/stream.ts';
import type { InboundMessage } from '../channels/types.ts';
import { ingestEvent } from '../events/intake.ts';
import { IGNORED } from '../../worker/ignored.ts';
import { approvals } from './schema.ts';
import { runTurn, turnMessageFields } from './turn.ts';

export type Approval = typeof approvals.$inferSelect;
export const APPROVAL_TTL_MS = 24 * 3600 * 1000;

/**
 * The action an approval names when the lead asks the user's yes for a crew job whose report is
 * posted on a pull request (the start_crew_job tool). It is the platform's own, not an app's.
 */
export const START_CREW_JOB_ACTION = 'TEXTCREW_START_CREW_JOB';

/** The tool that runs what an approval was asked for. */
const toolFor = (a: Approval) =>
  a.action === START_CREW_JOB_ACTION ? 'start_crew_job' : 'run_app_action';

export function toApiApproval(a: Approval) {
  return {
    id: a.id,
    status: a.status,
    summary: a.summary,
    app: a.app,
    action: a.action,
    details: { ...(a.details ?? {}), ...(a.arguments ? { arguments: a.arguments } : {}) },
    createdAt: a.createdAt.toISOString(),
    expiresAt: a.expiresAt.toISOString(),
    decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
  };
}

const effective = (a: Approval): Approval =>
  a.status === 'pending' && a.expiresAt.getTime() <= Date.now() ? { ...a, status: 'expired' } : a;

/** Saves the approval and sends the question with ✅ / ❌ buttons. Returns immediately ("pending"). */
export async function requestApproval(input: {
  userId: string;
  sessionKey: string;
  summary: string;
  app?: string | null;
  action?: string | null;
  arguments?: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
}): Promise<Approval> {
  const [row] = await db()
    .insert(approvals)
    .values({
      id: newId('apr'),
      userId: input.userId,
      summary: input.summary,
      app: input.app ?? null,
      action: input.action ?? null,
      arguments: input.arguments ?? null,
      details: input.details ?? null,
      sessionKey: input.sessionKey,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    })
    .returning();
  const a = row!;
  await queueOutbound({
    userId: input.userId,
    sessionKey: input.sessionKey,
    // Asked during a turn: the question belongs to that turn's conversation.
    ...(await turnMessageFields(input.userId, input.sessionKey)),
    text: `Approval needed: ${a.summary}`,
    approvalId: a.id,
    template: 'approval',
    buttons: [
      { id: `apr:${a.id}:yes`, title: '✅ Approve' },
      { id: `apr:${a.id}:no`, title: '❌ Reject' },
    ],
  });
  await publish(input.userId, 'approval.created', toApiApproval(a));
  await audit({
    userId: input.userId,
    actor: 'agent',
    action: 'approval_requested',
    summary: a.summary,
    details: { approvalId: a.id, action: a.action },
  });
  return a;
}

export async function getApproval(userId: string, id: string): Promise<Approval | undefined> {
  const [row] = await db()
    .select()
    .from(approvals)
    .where(and(eq(approvals.userId, userId), eq(approvals.id, id)));
  return row ? effective(row) : undefined;
}

export async function listApprovals(
  userId: string,
  opts: { status?: Approval['status']; cursor?: string; limit: number },
) {
  const status = opts.status ?? 'pending';
  const where = [eq(approvals.userId, userId)];
  if (opts.cursor) where.push(lt(approvals.id, opts.cursor));
  if (status === 'pending') {
    where.push(eq(approvals.status, 'pending'), gt(approvals.expiresAt, new Date()));
  } else if (status === 'expired') {
    // stored expired, or pending past its expiry
  } else {
    where.push(eq(approvals.status, status));
  }
  const rows = (
    await db()
      .select()
      .from(approvals)
      .where(and(...where))
      .orderBy(desc(approvals.id))
      .limit(status === 'expired' ? 500 : opts.limit + 1)
  )
    .map(effective)
    .filter((a) => a.status === status);
  const page = rows.slice(0, opts.limit);
  return { items: page, nextCursor: rows.length > opts.limit ? page[page.length - 1]!.id : null };
}

/**
 * Records the user's answer (web, button or yes/no), then queues a job that wakes the agent
 * with it. 404 if not this user's; 409 if already decided or expired.
 */
export async function decideApproval(
  userId: string,
  id: string,
  approve: boolean,
  via: string,
): Promise<Approval> {
  const [row] = await db()
    .update(approvals)
    .set({ status: approve ? 'approved' : 'rejected', decidedAt: new Date(), decidedVia: via })
    .where(
      and(
        eq(approvals.userId, userId),
        eq(approvals.id, id),
        eq(approvals.status, 'pending'),
        gt(approvals.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!row) {
    const existing = await getApproval(userId, id);
    if (!existing) throw notFound('Approval not found');
    throw conflict(`Approval is already ${existing.status}`);
  }
  await publish(userId, 'approval.resolved', toApiApproval(row));
  await audit({
    userId,
    actor: 'user',
    action: 'approval_decided',
    summary: `${approve ? 'Approved' : 'Rejected'}: ${row.summary}`,
    details: { approvalId: id, via },
  });
  await ingestEvent({
    source: 'approval',
    externalId: id,
    type: approve ? 'approved' : 'rejected',
    userId,
    payload: { approvalId: id, approved: approve },
    queue: 'inbound',
    jobName: 'process-approval',
    jobData: { approvalId: id },
  });
  return row;
}

/** inbound/process-approval: wake the agent with the answer; it continues from its saved session. */
export async function handleProcessApproval(job: Job): Promise<unknown> {
  const { approvalId, userId, eventId } = job.data as {
    approvalId: string;
    userId: string;
    eventId: string;
  };
  const a = await getApproval(userId, approvalId);
  if (!a || (a.status !== 'approved' && a.status !== 'rejected')) return IGNORED;
  const parsedChannel =
    a.sessionKey === 'web'
      ? 'web'
      : (a.sessionKey.split(':')[0] as 'telegram' | 'whatsapp' | 'imessage');
  // The answer goes back to the conversation the question was asked in, not to whichever one is
  // active now: that is where the agent is waiting for it.
  const conversationId = await conversationOfApproval(userId, a.id);
  await runTurn({
    userId,
    deliveryId: eventId,
    kind: 'approval_answer',
    sessionKey: a.sessionKey,
    channel: parsedChannel,
    ...(conversationId ? { conversationId } : {}),
    text:
      a.status === 'approved'
        ? `The user APPROVED: ${a.summary}. Go ahead (call ${toolFor(a)} with approval_id "${a.id}").`
        : `The user REJECTED: ${a.summary}. Don't do it.`,
    approval: { id: a.id, approved: a.status === 'approved' },
  });
  return null;
}

const YES = /^\s*(yes|y|ok|okay|approve|approved|✅|👍)\s*[.!]*\s*$/i;
const NO = /^\s*(no|n|reject|rejected|deny|❌|👎)\s*[.!]*\s*$/i;

/**
 * Inbound hook: a tapped approval button (`apr:<id>:yes|no`), or on channels without buttons
 * a plain "yes"/"no" answering the latest pending approval in that chat.
 */
export async function handleApprovalReply(userId: string, msg: InboundMessage): Promise<boolean> {
  let id: string | undefined;
  let approve: boolean | undefined;
  const data = msg.buttonReply?.data;
  if (data) {
    const m = /^apr:([a-z0-9_]+):(yes|no)$/.exec(data);
    if (!m) return false;
    id = m[1];
    approve = m[2] === 'yes';
  } else {
    const yes = YES.test(msg.text);
    const no = NO.test(msg.text);
    if (!yes && !no) return false;
    const sessionKey = `${msg.channel}:${msg.externalChatId}`;
    const [latest] = await db()
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.userId, userId),
          eq(approvals.sessionKey, sessionKey),
          eq(approvals.status, 'pending'),
          gt(approvals.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(approvals.id))
      .limit(1);
    if (!latest) return false;
    id = latest.id;
    approve = yes;
  }
  try {
    await decideApproval(
      userId,
      id!,
      approve!,
      msg.buttonReply ? `${msg.channel}:button` : `${msg.channel}:text`,
    );
  } catch {
    await queueOutbound({
      userId,
      sessionKey: `${msg.channel}:${msg.externalChatId}`,
      text: 'That approval was already answered or has expired.',
    });
  }
  return true;
}

/** run_app_action: an approved, unexpired, unused approval for exactly this action. Single use. */
export async function consumeApproval(
  userId: string,
  id: string,
  action: string,
): Promise<Approval | null> {
  const [row] = await db()
    .update(approvals)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(approvals.userId, userId),
        eq(approvals.id, id),
        eq(approvals.status, 'approved'),
        eq(approvals.action, action),
        isNull(approvals.usedAt),
        gt(approvals.decidedAt, new Date(Date.now() - APPROVAL_TTL_MS)),
      ),
    )
    .returning();
  return row ?? null;
}

/** system/expire-approvals (hourly): mark stale pending approvals expired. */
export async function expireApprovals(): Promise<number> {
  const rows = await db()
    .update(approvals)
    .set({ status: 'expired' })
    .where(and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, new Date())))
    .returning();
  for (const r of rows) await publish(r.userId, 'approval.resolved', toApiApproval(r));
  return rows.length;
}
