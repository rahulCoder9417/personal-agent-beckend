// Approvals for the agent's own actions (docs/backend-report.md, "Approvals for the agent's own
// actions"). Two callers, both from the user's container and both known by its token only:
//
// - Claude Code's gate hook (POST /mcp/gate), before a command or a file change that its rules say
//   needs the user's OK (network commands while Scout's browser is on, changing git's remotes,
//   deleting or overwriting files outside the workspace).
// - The git gateway, before a push to a branch that already existed or a force push.
//
// Either way the answer is one of three. `allow`: the user approved exactly this call and it was
// not used yet; it is used now (once). `asked`: the user is asked now, in the chat of the turn in
// progress, with the same card as any approval; the call is refused and the turn should end; after
// the yes a new turn makes the call again and it is let through. `refused`: during a crew job's
// run nothing is asked; the job's brief is the user's yes for its own branch and its pull request
// only, so anything else is refused and kept on the job, and the user is asked after the run
// whether to run the job again with it allowed.
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { logger } from '../../shared/logger.ts';
import { audit } from '../admin/audit.ts';
import type { CrewJobItem } from '../automations/schema.ts';
import { APPROVAL_TTL_MS, requestApproval, type Approval } from './approvals.ts';
import {
  COMMAND_ACTION,
  GIT_PUSH_ACTION,
  itemApproval,
  releaseApprovals,
} from './approval-kinds.ts';
import { commandSummary } from './command-words.ts';
import { approvals } from './schema.ts';
import { turnInProgress } from './turn.ts';

/** The tools whose calls the gate hook may ask about. */
export const GATED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit'] as const;
export type GatedTool = (typeof GATED_TOOLS)[number];

export interface GateCall {
  tool: GatedTool;
  /** The exact command (Bash), or the file (Edit, Write, NotebookEdit). */
  target: string;
  /** Why the hook says it needs the user's OK, in plain words ("it reaches the internet"). */
  why: string;
  /** The folder the call was made in, for the card. */
  cwd?: string | null;
}

export type GateAnswer =
  | { decision: 'allow'; message: string; approvalId: string }
  | { decision: 'asked'; message: string; approvalId: string }
  | { decision: 'refused'; message: string };

/** A crew job's run in progress, as the gate needs it (set by the automations module). */
export interface GateCrewJob {
  id: string;
  member: 'patch' | 'byte';
  owner: string;
  repo: string;
  /** The branch the job makes and may push (Byte), or null. */
  ownBranch: string | null;
}

interface CrewHooks {
  jobInProgress(userId: string): Promise<GateCrewJob | null>;
  recordBlocked(userId: string, jobId: string, item: CrewJobItem): Promise<void>;
}

let crew: CrewHooks = {
  jobInProgress: async () => null,
  recordBlocked: async () => {},
};

/** wiring.ts: the crew job of the turn in progress, and where its refusals are kept. */
export function setGateCrewHooks(h: CrewHooks): void {
  crew = h;
}

/** Waiting requests of these kinds a user may have at once: more are refused, not asked. */
export const MAX_WAITING_ASKS = 10;
const TARGET_MAX = 4000;

const oneLine = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/**
 * The card's summary (its title), as Tex's sentence starts it ("I'd like to download a file from …").
 * A command in plain words when it is a lone download or upload, else the command with its long
 * addresses cut to their host (command-words.ts). The exact command is in the card's details.
 */
export function gateSummary(call: Pick<GateCall, 'tool' | 'target' | 'why'>): string {
  if (call.tool === 'Bash') return commandSummary(call.target, call.why);
  const why = call.why ? ` (${oneLine(call.why, 120)})` : '';
  const verb =
    call.tool === 'Write'
      ? 'Write the file'
      : call.tool === 'NotebookEdit'
        ? 'Change the notebook'
        : 'Change the file';
  return `${verb} ${oneLine(call.target, 300)}${why}`;
}

export function pushSummary(p: Pick<PushUpdate, 'owner' | 'repo' | 'branch' | 'force'>): string {
  return p.force
    ? `Force push to the branch "${p.branch}" of ${p.owner}/${p.repo} (it rewrites the branch's history)`
    : `Push to the branch "${p.branch}" of ${p.owner}/${p.repo}, which already existed`;
}

const usable = (now: Date) =>
  and(
    eq(approvals.status, 'approved'),
    isNull(approvals.usedAt),
    gt(approvals.decidedAt, new Date(now.getTime() - APPROVAL_TTL_MS)),
  );

/** An approval meant for one crew job's run is usable only during that run; any other, never then. */
const scopedTo = (jobId: string | null) =>
  jobId
    ? sql`(${approvals.details}->>'crewJobId' is null or ${approvals.details}->>'crewJobId' = ${jobId})`
    : sql`${approvals.details}->>'crewJobId' is null`;

/** Uses one approved, unused approval whose action and arguments are exactly these. Single use. */
async function useApproval(
  userId: string,
  action: string,
  args: Record<string, unknown>,
  jobId: string | null,
): Promise<Approval | null> {
  const now = new Date();
  const [row] = await db()
    .update(approvals)
    .set({ usedAt: now })
    .where(
      and(
        eq(approvals.userId, userId),
        sql`${approvals.id} = (
          select ${approvals.id} from ${approvals}
          where ${and(
            eq(approvals.userId, userId),
            eq(approvals.action, action),
            usable(now),
            sql`${approvals.arguments} = ${JSON.stringify(args)}::jsonb`,
            scopedTo(jobId),
          )}
          order by ${approvals.id} limit 1
        )`,
        isNull(approvals.usedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** A request for exactly this that is still waiting for the user's answer. */
async function waitingAsk(
  userId: string,
  action: string,
  args: Record<string, unknown>,
): Promise<Approval | null> {
  const [row] = await db()
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.userId, userId),
        eq(approvals.action, action),
        eq(approvals.status, 'pending'),
        gt(approvals.expiresAt, new Date()),
        sql`${approvals.arguments} = ${JSON.stringify(args)}::jsonb`,
      ),
    )
    .orderBy(desc(approvals.id))
    .limit(1);
  return row ?? null;
}

async function waitingCount(userId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(approvals)
    .where(
      and(
        eq(approvals.userId, userId),
        sql`${approvals.action} in (${COMMAND_ACTION}, ${GIT_PUSH_ACTION})`,
        eq(approvals.status, 'pending'),
        gt(approvals.expiresAt, new Date()),
      ),
    );
  return row?.n ?? 0;
}

type Ask =
  | { asked: true; approval: Approval; again: boolean }
  | { asked: false; why: 'no_turn' | 'too_many' };

/** Asks the user in the chat of the turn in progress, unless the same request is waiting already. */
async function ask(
  userId: string,
  action: string,
  args: Record<string, unknown>,
  summary: string,
  details: Record<string, unknown>,
): Promise<Ask> {
  const waiting = await waitingAsk(userId, action, args);
  if (waiting) return { asked: true, approval: waiting, again: true };
  // Only during a turn: the question belongs to that turn's chat, and its answer starts the next.
  const turn = await turnInProgress(userId);
  if (!turn) return { asked: false, why: 'no_turn' };
  if ((await waitingCount(userId)) >= MAX_WAITING_ASKS) return { asked: false, why: 'too_many' };
  const approval = await requestApproval({
    userId,
    sessionKey: turn.sessionKey,
    summary,
    action,
    arguments: args,
    details,
  });
  return { asked: true, approval, again: false };
}

const END_TURN =
  'End your turn now: your user already sees the question with Approve and Deny, so write nothing more about it. ' +
  'Their answer comes as a new message; after a yes, make exactly the same call again and it goes through once.';

function notAsked(why: 'no_turn' | 'too_many'): string {
  return why === 'too_many'
    ? `Your user already has ${MAX_WAITING_ASKS} requests like this waiting for an answer, so nothing more was asked. Wait for their answers.`
    : "This needs your user's OK, and there is no chat to ask them in now. Ask them in your answer instead.";
}

/** POST /mcp/gate: Claude Code's gate hook, before a command or file change that needs the user's OK. */
export async function checkGate(userId: string, call: GateCall): Promise<GateAnswer> {
  const target = call.target.slice(0, TARGET_MAX);
  const args = { tool: call.tool, target };
  const job = await crew.jobInProgress(userId);
  const used = await useApproval(userId, COMMAND_ACTION, args, job?.id ?? null);
  if (used) {
    await audit({
      userId,
      actor: 'agent',
      action: 'gate_allowed',
      summary: `Approved, so it ran: ${used.summary}`,
      details: { approvalId: used.id, tool: call.tool },
    });
    return {
      decision: 'allow',
      approvalId: used.id,
      message: 'Your user approved this. It runs once.',
    };
  }
  if (job) {
    await crew.recordBlocked(userId, job.id, {
      kind: 'command',
      tool: call.tool,
      target,
      why: oneLine(call.why, 200),
    });
    await audit({
      userId,
      actor: 'agent',
      action: 'gate_refused',
      summary: `Refused during a crew job (not in its brief): ${gateSummary(call)}`,
      details: { crewJobId: job.id, tool: call.tool },
    });
    return {
      decision: 'refused',
      message:
        "This is not covered by the job's brief, so it was not run. It is listed for your user, who can approve it " +
        'and run the job again. Go on without it, and name it in the report under "Needs your OK".',
    };
  }
  const summary = gateSummary(call);
  const asked = await ask(userId, COMMAND_ACTION, args, summary, {
    tool: call.tool,
    target,
    why: oneLine(call.why, 200),
    ...(call.cwd ? { folder: call.cwd.slice(0, 500) } : {}),
  });
  if (!asked.asked) return { decision: 'refused', message: notAsked(asked.why) };
  return {
    decision: 'asked',
    approvalId: asked.approval.id,
    message: `${asked.again ? 'Your user was already asked to approve this' : 'Your user was asked to approve this in the chat'} (${summary}). It was not run. ${END_TURN}`,
  };
}

// --- git pushes ------------------------------------------------------------------------------------

/** One branch a push updates that already exists on GitHub. */
export interface PushUpdate {
  owner: string;
  repo: string;
  branch: string;
  /** Not a fast-forward (or it could not be told): it rewrites the branch's history. */
  force: boolean;
  /** The agent made this branch through the git gateway. */
  createdByAgent: boolean;
}

export type PushDecision =
  { ok: true; release: () => Promise<void> } | { ok: false; message: string };

const sameRepo = (job: GateCrewJob, p: PushUpdate) =>
  job.owner.toLowerCase() === p.owner.toLowerCase() &&
  job.repo.toLowerCase() === p.repo.toLowerCase();

const pushItem = (p: PushUpdate): Extract<CrewJobItem, { kind: 'git_push' }> => ({
  kind: 'git_push',
  owner: p.owner,
  repo: p.repo,
  branch: p.branch,
  force: p.force,
});

/**
 * The git gateway, for the branches a push updates that already exist (a new branch is never
 * asked about; the default branch, deletes and tags are refused before this). Each one goes
 * through when it is the running crew job's own branch, when it only adds commits to a branch the
 * agent made, or with an approved, unused approval for exactly that push (a force push needs one
 * that says force). Otherwise the whole push is refused: during a crew job the pushes are kept on
 * the job; else the user is asked.
 */
export async function decidePushes(userId: string, updates: PushUpdate[]): Promise<PushDecision> {
  const job = await crew.jobInProgress(userId);
  const needed = updates.filter((p) => {
    if (job?.ownBranch && sameRepo(job, p) && p.branch === job.ownBranch) return false;
    return p.force || !p.createdByAgent;
  });
  const used: string[] = [];
  const missing: PushUpdate[] = [];
  for (const p of needed) {
    const exact = itemApproval(pushItem(p)).arguments;
    // A yes for a force push covers a push that only adds commits; never the other way round.
    const found =
      (await useApproval(userId, GIT_PUSH_ACTION, exact, job?.id ?? null)) ??
      (p.force
        ? null
        : await useApproval(userId, GIT_PUSH_ACTION, { ...exact, force: true }, job?.id ?? null));
    if (found) used.push(found.id);
    else missing.push(p);
  }
  if (missing.length === 0) {
    if (used.length)
      await audit({
        userId,
        actor: 'agent',
        action: 'gate_allowed',
        summary: `Approved, so it ran: ${needed.map(pushSummary).join('; ')}`,
        details: { approvalIds: used },
      });
    return { ok: true, release: () => releaseApprovals(userId, used) };
  }
  // Refused: what this push used is given back, so the next try can use it again.
  await releaseApprovals(userId, used);
  if (job) {
    for (const p of missing) await crew.recordBlocked(userId, job.id, pushItem(p));
    const own = job.ownBranch ? ` Only the job's own branch "${job.ownBranch}" may be pushed.` : '';
    return {
      ok: false,
      message:
        `${missing.map(pushSummary).join('; ')}: not covered by the job's brief, so it was refused.${own} ` +
        'It is listed for your user, who can approve it and run the job again. Go on without it, and name it in the report under "Needs your OK".',
    };
  }
  const lines: string[] = [];
  for (const p of missing) {
    const asked = await ask(
      userId,
      GIT_PUSH_ACTION,
      itemApproval(pushItem(p)).arguments,
      pushSummary(p),
      {
        repo: `${p.owner}/${p.repo}`,
        branch: p.branch,
        force: p.force,
      },
    );
    if (!asked.asked) return { ok: false, message: `${pushSummary(p)}: ${notAsked(asked.why)}` };
    lines.push(pushSummary(p));
  }
  logger().info({ userId, pushes: missing.length }, 'git push waits for the user');
  return {
    ok: false,
    message: `This push needs your user's OK, so nothing was pushed. They were asked in the chat: ${lines.join('; ')}. ${END_TURN}`,
  };
}
