// Provider delivery receipts (WhatsApp statuses, Sendblue outbound events). They only update a
// message's status; they never start an agent turn.
//
// Webhooks never do work: each receipt is saved as an event (unique on provider id + status) and
// handled by the tiny `outbound/message-status` job below. It lives on the outbound queue because
// it concerns messages we sent, and that queue takes no per-user lock.
import type { Job } from 'bullmq';
import { getEvent, ingestEvent } from '../events/intake.ts';
import { IGNORED } from '../../worker/ignored.ts';
import { setStatusByExternalId } from './messages.ts';
import { reportBlocked } from './outbound.ts';
import type { Channel } from './types.ts';

export interface StatusUpdate {
  channel: Channel;
  /** The provider's id of the message we sent. */
  externalId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  /** The provider says the recipient can't be reached (the link is marked blocked). */
  recipientBlocked?: boolean;
}

type StatusParser = (payload: Record<string, unknown>) => StatusUpdate | null;
const parsers = new Map<string, StatusParser>();

/** Registers a provider's receipt parser (event source → normalized status). */
export function registerStatusParser(source: string, parser: StatusParser): void {
  parsers.set(source, parser);
}

/** api side: save a receipt as an event and queue the status job. */
export async function ingestStatusEvent(input: {
  source: string;
  externalId: string;
  status: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await ingestEvent({
    source: input.source,
    externalId: `status:${input.externalId}:${input.status}`,
    type: 'status',
    payload: input.payload,
    queue: 'outbound',
    jobName: 'message-status',
  });
}

/** outbound/message-status. Safe to re-run: statuses only move forward. */
export async function handleMessageStatus(job: Job): Promise<unknown> {
  const { eventId } = job.data as { eventId: string };
  const event = await getEvent(eventId);
  if (!event) return IGNORED;
  const update = parsers.get(event.source)?.(event.payload);
  if (!update) return IGNORED;
  const rows = await setStatusByExternalId(update.channel, update.externalId, update.status);
  if (update.recipientBlocked) {
    for (const row of rows) if (row.sessionKey) await reportBlocked(row.userId, row.sessionKey);
  }
  return rows.length ? null : IGNORED;
}
