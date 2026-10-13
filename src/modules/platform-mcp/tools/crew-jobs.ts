// start_crew_job: the lead gives Patch a review or Byte a job from a chat message, with the same
// brief as the web app's form (docs/backend-report.md, "The crew"). The job runs as its own turn
// right after the current one, and its report comes back to this chat.
import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../shared/db/client.ts';
import {
  checkBrief,
  createCrewJob,
  CrewJobError,
  FOCUS_AREAS,
  jobTitle,
  sameChatJob,
  type CheckedBrief,
} from '../../automations/crew-jobs.ts';
import { consumeApproval, START_CREW_JOB_ACTION } from '../../orchestrator/approvals.ts';
import { approvals } from '../../orchestrator/schema.ts';
import { turnConversationId } from '../../orchestrator/turn.ts';
import { defineTool, ToolError } from '../registry.ts';
import { resolveSession } from './core.ts';

const input = {
  member: z.enum(['patch', 'byte']),
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  pull_number: z.number().int().positive().optional(),
  branch: z.string().max(200).optional(),
  instructions: z.string().max(4000).optional(),
  focus: z.array(z.enum(FOCUS_AREAS)).optional(),
  acceptance: z.string().max(2000).optional(),
  commands: z.string().max(2000).optional(),
  finish: z.enum(['pull_request', 'branch']).optional(),
  post_on_pull_request: z.boolean().optional(),
  open_issue: z.boolean().optional(),
  session_key: z.string().optional(),
  approval_id: z.string().optional(),
};
type Args = z.infer<z.ZodObject<typeof input>>;

/** The brief an approval must name exactly: the arguments, without the approval and the chat. */
export function approvedBrief(args: Args): Record<string, unknown> {
  const { approval_id: _approval, session_key: _session, ...brief } = args;
  return Object.fromEntries(Object.entries(brief).filter(([, v]) => v !== undefined));
}

function brief(args: Args): CheckedBrief {
  try {
    return checkBrief({
      member: args.member,
      owner: args.owner,
      repo: args.repo,
      pullNumber: args.pull_number ?? null,
      branch: args.branch ?? null,
      instructions: args.instructions ?? '',
      focus: args.focus ?? [],
      acceptance: args.acceptance ?? '',
      commands: args.commands ?? '',
      finish: args.finish ?? null,
      reportTo: { pullRequest: args.post_on_pull_request, issue: args.open_issue },
    });
  } catch (err) {
    if (err instanceof CrewJobError) throw new ToolError(err.message);
    throw err;
  }
}

defineTool({
  name: 'start_crew_job',
  description:
    'Give Patch a review or Byte a coding job as a crew job, when your user asks for one in chat (e.g. "Patch, review acme/web PR 42, run pnpm test"). ' +
    'It runs as its own turn right after this one ends: the specialist works in a folder of its own, every program it starts is stopped, the folder is deleted, ' +
    'and the report comes back to this chat. Patch needs pull_number or branch; Byte needs instructions (what to fix or build), and may take branch (to start from), ' +
    'acceptance (what to test for) and finish ("pull_request", the default, or "branch"). commands: how to install, test or start the app. ' +
    "post_on_pull_request: Patch posts its report as ONE review on the pull request (Byte: the report goes in the pull request it opens). For Patch it needs the user's yes: " +
    `call request_approval with action "${START_CREW_JOB_ACTION}" and these exact arguments (without approval_id and session_key), end your turn, and call this tool again ` +
    'with the approval_id once they approve. open_issue: also open an issue with the report. Call it once per job, then tell the user the job is queued.',
  input,
  async run({ userId }, args) {
    const sessionKey = await resolveSession(userId, args.session_key);
    const checked = brief(args);
    let consumedId: string | null = null;
    if (checked.member === 'patch' && checked.reportPullRequest) {
      if (!args.approval_id)
        throw new ToolError(
          "Posting Patch's review on the pull request needs your user's yes first: call request_approval " +
            `with action "${START_CREW_JOB_ACTION}" and these exact arguments (without approval_id and session_key), ` +
            'and end your turn. Or start the job without post_on_pull_request: the report still comes to this chat.',
        );
      const approval = await consumeApproval(userId, args.approval_id, START_CREW_JOB_ACTION);
      if (!approval)
        throw new ToolError(
          'No matching approved approval (it must be approved, unused, for start_crew_job)',
        );
      if (approval.arguments && !isDeepStrictEqual(approval.arguments, approvedBrief(args))) {
        await db().update(approvals).set({ usedAt: null }).where(eq(approvals.id, approval.id));
        throw new ToolError('The brief differs from what the user approved');
      }
      consumedId = approval.id;
    }
    const again = await sameChatJob(userId, checked, sessionKey);
    if (again)
      return {
        job_id: again.id,
        status: again.status,
        title: jobTitle(again),
        already_started: true,
      };
    try {
      const { job } = await createCrewJob(userId, checked, {
        source: 'chat',
        sessionKey,
        conversationId: await turnConversationId(userId, sessionKey),
      });
      return {
        job_id: job.id,
        status: job.status,
        title: jobTitle(job),
        note: 'Queued. It starts right after this turn ends, and its report comes to this chat. Tell your user.',
      };
    } catch (err) {
      if (consumedId)
        await db().update(approvals).set({ usedAt: null }).where(eq(approvals.id, consumedId));
      if (err instanceof CrewJobError) throw new ToolError(err.message);
      throw err;
    }
  },
  summarize: (args) =>
    `Started a crew job for ${args.member === 'patch' ? 'Patch' : 'Byte'} in ${args.owner}/${args.repo}`,
  auditDetails: (args, result) => ({
    crew: args.member,
    crewJobId: (result as { job_id?: string }).job_id,
  }),
});
