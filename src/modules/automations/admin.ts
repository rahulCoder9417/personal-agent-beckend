// Admin tools for automations (docs/backend-report.md, "Admin tools"). Reading only: pausing,
// resuming and deleting go through the same functions as the user's own (automations.ts), so the
// timers and Composio triggers are handled the same way.
import { desc, eq } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import type { Automation } from './automations.ts';
import { repoOf } from './pr-review.ts';
import { automations } from './schema.ts';

/** One automation by its id, whoever owns it. For admin tools only. */
export async function findAutomation(id: string): Promise<Automation | undefined> {
  const [row] = await db().select().from(automations).where(eq(automations.id, id));
  return row;
}

/** Every automation of a user, newest first, one-time reminders that already ran too. */
export async function listAllAutomations(userId: string): Promise<Automation[]> {
  return db()
    .select()
    .from(automations)
    .where(eq(automations.userId, userId))
    .orderBy(desc(automations.createdAt), desc(automations.id));
}

/** An automation as an admin sees it: no instruction text, no trigger settings, no chat id. */
export function toAdminAutomation(a: Automation) {
  const repo = a.preset === 'pr_review' ? repoOf(a) : null;
  return {
    id: a.id,
    userId: a.userId,
    title: a.title,
    kind: a.kind,
    runAt: a.runAt ? a.runAt.toISOString() : null,
    cron: a.cron,
    trigger: a.trigger ? { app: a.trigger.app, event: a.trigger.event } : null,
    repo: repo ? `${repo.owner}/${repo.repo}` : null,
    timezone: a.timezone,
    enabled: a.enabled,
    pausedReason: a.pausedReason ?? null,
    failCount: a.failCount,
    lastRunAt: a.lastRunAt ? a.lastRunAt.toISOString() : null,
    nextRunAt: a.nextRunAt ? a.nextRunAt.toISOString() : null,
    preset: a.preset ?? null,
    completedAt: a.completedAt ? a.completedAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
  };
}
