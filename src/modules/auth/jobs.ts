import type { Job } from 'bullmq';
import { getEvent } from '../events/intake.ts';
import { enqueueUserDeletion, provisionUser } from './provision.ts';
import { clerkUserFromPayload, markUserDeleted } from './users.ts';

/** system/clerk-event: user.created, user.updated, user.deleted. Safe to re-run. */
export async function handleClerkEvent(job: Job): Promise<unknown> {
  const event = await getEvent((job.data as { eventId: string }).eventId);
  if (!event) return null;
  const payload = event.payload as { type?: string; data?: Record<string, unknown> };
  const data = payload.data ?? {};
  switch (payload.type) {
    case 'user.created':
    case 'user.updated':
      await provisionUser(clerkUserFromPayload(data));
      return null;
    case 'user.deleted': {
      const clerkId = data.id as string | undefined;
      if (!clerkId) return null;
      const user = await markUserDeleted(clerkId);
      if (user) await enqueueUserDeletion(user.id);
      return null;
    }
    default:
      return null;
  }
}
