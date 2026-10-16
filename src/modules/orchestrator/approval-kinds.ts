// The kinds of approval (docs/backend-report.md, "Approvals" and "Approvals for the agent's own
// actions"). Most approvals are for an action in one of the user's apps. The platform's own kinds
// are named by an action of its own: a crew job posted on a pull request, one of Claude Code's
// commands or file changes, a git push to a branch that already existed, and running a crew job
// again with what its run was refused.
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import type { CrewJobItem } from '../automations/schema.ts';
import { approvals } from './schema.ts';

type Approval = typeof approvals.$inferSelect;

/** The same value as START_CREW_JOB_ACTION in approvals.ts (kept there for its callers). */
const START_CREW_JOB = 'TEXTCREW_START_CREW_JOB';
/** One of Claude Code's commands or file changes that needs the user's OK (the gate hook). */
export const COMMAND_ACTION = 'TEXTCREW_RUN_COMMAND';
/** A push to a branch that already existed, or a force push (the git gateway). */
export const GIT_PUSH_ACTION = 'TEXTCREW_GIT_PUSH';
/** Run a crew job again, with exactly what its run was refused allowed once each. */
export const CREW_RERUN_ACTION = 'TEXTCREW_RERUN_CREW_JOB';

export type ApprovalKind =
  'app_action' | 'crew_job' | 'command' | 'git_push' | 'crew_rerun' | 'other';

export function approvalKind(a: Pick<Approval, 'action' | 'app'>): ApprovalKind {
  if (a.action === START_CREW_JOB) return 'crew_job';
  if (a.action === COMMAND_ACTION) return 'command';
  if (a.action === GIT_PUSH_ACTION) return 'git_push';
  if (a.action === CREW_RERUN_ACTION) return 'crew_rerun';
  return a.app || a.action ? 'app_action' : 'other';
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * What the agent is told to do after the user's yes, for the platform's own kinds of approval
 * (null for any other: approvals.ts says it). The call itself is let through once, by the gate
 * hook or the git gateway, so the agent only has to make it again, unchanged.
 */
export function ownGoAhead(a: Approval): string | null {
  const args = a.arguments ?? {};
  if (a.action === COMMAND_ACTION) {
    const what = str(args.tool) === 'Bash' ? 'command' : 'file change';
    return (
      `Go ahead: make exactly the same ${what} again (${str(args.tool)}: ${str(args.target)}). ` +
      'It goes through once. Anything changed in it is a new request, and your user is asked again.'
    );
  }
  if (a.action === GIT_PUSH_ACTION)
    return (
      `Go ahead: run the same git push again (${str(args.owner)}/${str(args.repo)}, branch ` +
      `"${str(args.branch)}"${args.force === true ? ', force push' : ''}). It goes through once.`
    );
  return null;
}

/** The approval that lets one item of a crew job through once: its action and arguments. */
export function itemApproval(item: CrewJobItem): {
  action: string;
  arguments: Record<string, unknown>;
} {
  if (item.kind === 'command')
    return { action: COMMAND_ACTION, arguments: { tool: item.tool, target: item.target } };
  return {
    action: GIT_PUSH_ACTION,
    arguments: {
      owner: item.owner.toLowerCase(),
      repo: item.repo.toLowerCase(),
      branch: item.branch,
      force: item.force,
    },
  };
}

/**
 * A crew job run again after the user's yes: one approved approval per item, usable once each and
 * only during that job's run (`details.crewJobId`). Safe to run again: an item that already has
 * one for this job gets no second.
 */
export async function grantForCrewJob(input: {
  userId: string;
  sessionKey: string;
  crewJobId: string;
  items: CrewJobItem[];
  summaryOf: (item: CrewJobItem) => string;
  via: string;
}): Promise<number> {
  let granted = 0;
  const now = new Date();
  for (const item of input.items) {
    const { action, arguments: args } = itemApproval(item);
    const [seen] = await db()
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.userId, input.userId),
          eq(approvals.action, action),
          sql`${approvals.details}->>'crewJobId' = ${input.crewJobId}`,
          sql`${approvals.arguments} = ${JSON.stringify(args)}::jsonb`,
        ),
      );
    if (seen) continue;
    await db()
      .insert(approvals)
      .values({
        id: newId('apr'),
        userId: input.userId,
        summary: input.summaryOf(item),
        action,
        arguments: args,
        details: { crewJobId: input.crewJobId },
        status: 'approved',
        sessionKey: input.sessionKey,
        // Approved now; usable for as long as any approval (consume checks decidedAt).
        expiresAt: now,
        decidedAt: now,
        decidedVia: input.via,
      });
    granted++;
  }
  return granted;
}

/** Approvals a push or a command used, given back after the call could not go through. */
export async function releaseApprovals(userId: string, ids: string[]): Promise<void> {
  for (const id of ids)
    await db()
      .update(approvals)
      .set({ usedAt: null })
      .where(and(eq(approvals.userId, userId), eq(approvals.id, id)));
}
