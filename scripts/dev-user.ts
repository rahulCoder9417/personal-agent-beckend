// Ops script for a live test without the web app or Telegram: a dev user, a chat link code, the
// Claude plan sign-in, app connections, and a whole turn from the command line, all through the
// same module functions the api and worker use.
// Run inside the api container:  node --import tsx scripts/dev-user.ts <command> [--flags]
//
//   create          --email <e> --name <n> [--plan free|pro|max] [--credits 2000]
//                   (the 100 sign-up credits are given anyway; `credits` takes them away)
//   credits         --user <id> --adjust <signed whole number> --reason <text> [--key <k>]
//                   (the admin adjustment, once per key; e.g. --adjust -100 for an out-of-credits test)
//   link-code       --user <id> [--channel telegram|whatsapp|imessage]
//   claude-login    --user <id>
//   claude-complete --user <id> --login <loginId> --code <code>   (the code is never printed or logged)
//   connect-app     --user <id> --app <slug>
//   status          --user <id>
//   browser         --user <id>                      (send Scout's browser switch for this user now)
//   send            --user <id> --text <text> [--timeout 900]
//   messages        --user <id> [--limit 10]
//   activity        --user <id> [--limit 20]
//   approve         --user <id> [--approval <id>] [--decision approve|reject] [--timeout 900]
//   pr-review       --user <id> [--repo <owner>/<name> --state on|off]
//   memories        --user <id> [--clear all|<memoryId>]
//
// What it prints is for a person to read and paste into a report. It never prints a secret: no
// key, token or sign-in code is ever read for printing, and text that people or the agent wrote
// (messages, replies, approvals, memories) goes through `hideSecrets` first.
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Job } from 'bullmq';
import { audit, listAudit } from '../src/modules/admin/audit.ts';
import { createLinkCode, listLinks, type LinkChannel } from '../src/modules/auth/links.ts';
import { getActiveUser, setPlan, upsertUserFromClerk } from '../src/modules/auth/users.ts';
import {
  disablePrReview,
  enablePrReview,
  listPrReviews,
  toApiPrReview,
} from '../src/modules/automations/pr-review.ts';
import { adjustCredits } from '../src/modules/billing/admin.ts';
import { getBalance } from '../src/modules/billing/index.ts';
import { creditExpiry, PLAN_IDS, type PlanId } from '../src/modules/billing/plans.ts';
import {
  getMessageById,
  listMessages,
  recentSessionMessages,
} from '../src/modules/channels/messages.ts';
import { subscribe } from '../src/modules/channels/stream.ts';
import { findEvent, getEvent } from '../src/modules/events/intake.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import {
  listConnections,
  refreshPendingConnections,
  startConnect,
} from '../src/modules/integrations/apps.ts';
import { getAgentSettings } from '../src/modules/orchestrator/agent-settings.ts';
import { decideApproval, listApprovals } from '../src/modules/orchestrator/approvals.ts';
import { browserStatus, syncBrowser } from '../src/modules/orchestrator/browser.ts';
import { completeClaudeLogin, startClaudeLogin } from '../src/modules/orchestrator/claude-login.ts';
import { crewOfDetails } from '../src/modules/orchestrator/crew.ts';
import { handleOnboardUser } from '../src/modules/orchestrator/lifecycle.ts';
import {
  deleteAllMemories,
  deleteMemory,
  listMemories,
  MEMORY_MAX_COUNT,
} from '../src/modules/orchestrator/memory.ts';
import { hideSecrets } from '../src/modules/orchestrator/memory-secrets.ts';
import { sendWebMessage } from '../src/modules/orchestrator/process-message.ts';
import { getAgentStatus } from '../src/modules/orchestrator/sandbox.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeRedis } from '../src/shared/redis.ts';
import { wireModules } from '../src/wiring.ts';

const ADMIN_ID = 'dev-user-script';
const USAGE = `usage: node --import tsx scripts/dev-user.ts <command> [flags]
  create          --email <e> --name <n> [--plan free|pro|max] [--credits 2000]
  credits         --user <id> --adjust <signed whole number> --reason <text> [--key <k>]
  link-code       --user <id> [--channel telegram|whatsapp|imessage]
  claude-login    --user <id>
  claude-complete --user <id> --login <loginId> --code <code>
  connect-app     --user <id> --app <slug>
  status          --user <id>
  browser         --user <id>
  send            --user <id> --text <text> [--timeout 900]
  messages        --user <id> [--limit 10]
  activity        --user <id> [--limit 20]
  approve         --user <id> [--approval <id>] [--decision approve|reject] [--timeout 900]
  pr-review       --user <id> [--repo <owner>/<name> --state on|off]
  memories        --user <id> [--clear all|<memoryId>]`;

/** How long `send` and `approve` wait for the agent's turn: a turn is cut off at 15 minutes. */
const TURN_TIMEOUT_SECONDS = 900;
/** How often the turn's end is looked for. Tests lower it. */
let pollMs = 500;
export function setDevUserPollMs(ms: number | undefined): void {
  pollMs = ms ?? 500;
}

export class UsageError extends Error {}

/** `dev_<uuid>`, stable per email. */
export function devClerkId(email: string): string {
  const h = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return `dev_${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument: ${a}`);
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`missing value for ${a}`);
    flags[a.slice(2)] = v;
    i++;
  }
  return flags;
}

function need(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (!v) throw new UsageError(`--${name} is required`);
  return v;
}

/** A whole number flag between 1 and `max`. */
function count(flags: Record<string, string>, name: string, fallback: number, max: number): number {
  const n = Number(flags[name] ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new UsageError(`--${name} must be a whole number from 1 to ${max}`);
  return n;
}

/** Stored text on one line, secrets hidden, cut at `max` characters. */
function shown(text: string, max = 600): string {
  const line = hideSecrets(text)
    .replace(/\s*\n\s*/g, ' / ')
    .trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

const browserLine = (b: { available: boolean; wanted: boolean; onRecord: boolean | null }) =>
  `browser ${b.onRecord === null ? 'unknown' : b.onRecord ? 'on' : 'off'} ` +
  `(should be ${b.wanted ? 'on' : 'off'}; the image has it: ${b.available ? 'yes' : 'no'})`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An event's job is over: it ran, it failed for good, or it had nothing to do. */
const ENDED = new Set(['done', 'failed', 'ignored']);

/** Waits for the event's job to end. Returns its last status (`gone`: no such event). */
async function eventEnd(eventId: string, timeoutSeconds: number): Promise<string> {
  const started = Date.now();
  for (;;) {
    const status = (await getEvent(eventId))?.status ?? 'gone';
    if (ENDED.has(status) || status === 'gone') return status;
    if (Date.now() - started > timeoutSeconds * 1000) return status;
    await sleep(pollMs);
  }
}

/**
 * Follows one queued turn to its end: the progress lines from the live stream, then what the agent
 * sent to that chat. `listen` must be called before the job is queued, so no line is missed.
 */
async function listen(userId: string) {
  const progress: string[] = [];
  const stop = await subscribe(userId, (e) => {
    if (e.type !== 'agent.progress') return;
    const p = e.data as { text?: string };
    if (p.text) progress.push(p.text);
  });
  return {
    /** Nothing was queued after all. */
    cancel: stop,
    async finish(input: {
      eventId: string;
      sessionKey: string;
      /** Only what was sent after this counts as the reply. */
      since: Date;
      timeoutSeconds: number;
    }): Promise<string[]> {
      const started = Date.now();
      let status: string;
      try {
        status = await eventEnd(input.eventId, input.timeoutSeconds);
        // The last lines and the reply are published just before the job ends.
        await sleep(Math.min(pollMs, 200));
      } finally {
        stop();
      }
      const sent = (await recentSessionMessages(userId, input.sessionKey, 50, input.since)).filter(
        (m) => m.direction === 'out',
      );
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const finished = ENDED.has(status);
      return [
        ...progress.map((line) => `progress ${shown(line, 300)}`),
        ...sent.flatMap((m) => [
          `reply ${hideSecrets(m.text)}`,
          ...(m.approvalId ? [`approval ${m.approvalId} is waiting for an answer`] : []),
        ]),
        ...(sent.length ? [] : ['reply (none)']),
        finished
          ? `turn ${status} after ${seconds} s`
          : `turn still running after ${seconds} s (gave up waiting; \`messages\` shows the reply later)`,
      ];
    },
  };
}

async function activeUser(flags: Record<string, string>) {
  const id = need(flags, 'user');
  const user = await getActiveUser(id);
  if (!user) throw new UsageError(`no active user ${id}`);
  return user;
}

/** Runs one command; returns the lines to print. Never returns the Claude code or any secret. */
export async function devUser(argv: string[]): Promise<string[]> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  switch (command) {
    case 'create': {
      const email = need(flags, 'email');
      const plan = (flags.plan ?? 'free') as PlanId;
      if (!PLAN_IDS.includes(plan)) throw new UsageError(`--plan must be one of ${PLAN_IDS}`);
      const credits = Number(flags.credits ?? 2000);
      if (!Number.isInteger(credits) || credits < 0)
        throw new UsageError('--credits must be a whole number');
      // Same upsert as a Clerk sign-up, with a fake Clerk id derived from the email (re-running
      // `create` for the same email updates that user instead of making a new one).
      const { user } = await upsertUserFromClerk({
        clerkId: devClerkId(email),
        email,
        emailVerified: true,
        name: flags.name ?? '',
        role: 'user',
      });
      await setPlan(user.id, plan);
      // The onboard-user job's handler: sign-up grant + LiteLLM key, then the sandbox.
      await handleOnboardUser({ data: { userId: user.id } } as Job);
      // The plan was set here, not by a payment, so nothing queued the browser switch (HLD 11.3).
      await syncBrowser(user.id, 'dev_script');
      if (credits > 0)
        await adjustCredits({
          userId: user.id,
          amount: credits,
          reason: 'Dev test credits',
          expiresAt: creditExpiry(),
          idempotencyKey: 'dev-user-create',
          adminId: ADMIN_ID,
        });
      return [
        `user ${user.id} (${email}, plan ${plan})`,
        `balance ${await getBalance(user.id)} credits`,
        `sandbox ${(await getAgentStatus(user.id)).state}`,
        browserLine(await browserStatus(user.id, plan)),
      ];
    }
    case 'credits': {
      // The admin endpoint's adjustment: + adds a grant (90 days), - takes from the grants (an
      // overrun becomes debt). One adjustment per --key; without it, each run is a new one.
      const user = await activeUser(flags);
      const amount = Number(need(flags, 'adjust'));
      if (!Number.isInteger(amount) || amount === 0)
        throw new UsageError('--adjust must be a whole number other than 0, e.g. -100 or 500');
      const reason = need(flags, 'reason');
      const key = flags.key ?? `dev-credits-${randomUUID()}`;
      await adjustCredits({
        userId: user.id,
        amount,
        reason,
        expiresAt: creditExpiry(),
        idempotencyKey: key,
        adminId: ADMIN_ID,
      });
      return [
        `adjusted ${amount > 0 ? '+' : ''}${amount} credits (key ${key})`,
        `balance ${await getBalance(user.id)} credits`,
      ];
    }
    case 'link-code': {
      const user = await activeUser(flags);
      const channel = (flags.channel ?? 'telegram') as LinkChannel;
      const link = await createLinkCode(user.id, channel);
      return [
        `code ${link.code} (expires ${link.expiresAt.toISOString()})`,
        link.instructions,
        ...(link.deepLink ? [link.deepLink] : []),
      ];
    }
    case 'claude-login': {
      const user = await activeUser(flags);
      const s = await startClaudeLogin(user.id);
      return [
        `loginId ${s.loginId}`,
        `expires ${s.expiresAt.toISOString()}`,
        `authorizeUrl ${s.authorizeUrl}`,
      ];
    }
    case 'claude-complete': {
      const user = await activeUser(flags);
      const loginId = need(flags, 'login');
      const s = await completeClaudeLogin(user.id, loginId, need(flags, 'code'));
      return [
        `claude connected ${s.claude.connected}`,
        `runtime ${s.runtime} (effective ${s.effectiveRuntime}, ai ${s.aiAccess})`,
      ];
    }
    case 'connect-app': {
      const user = await activeUser(flags);
      const url = await startConnect(user.id, user.plan, need(flags, 'app'));
      return [
        `open ${url}`,
        'the worker checks Composio over the next minutes; `status` also asks right away',
      ];
    }
    case 'status': {
      const user = await activeUser(flags);
      // Ask Composio about connections that are still pending, so this shows the current state.
      await refreshPendingConnections(user.id);
      const [balance, agent, settings, links, conns, browser] = await Promise.all([
        getBalance(user.id),
        getAgentStatus(user.id),
        getAgentSettings(user.id),
        listLinks(user.id),
        listConnections(user.id),
        browserStatus(user.id, user.plan),
      ]);
      return [
        `user ${user.id} (${user.email}, plan ${user.plan})`,
        `balance ${balance} credits`,
        `agent ${agent.state} (last active ${agent.lastActiveAt?.toISOString() ?? 'never'})`,
        `runtime ${settings.runtime} (effective ${settings.effectiveRuntime}, ai ${settings.aiAccess}, claude ${settings.claude.connected ? 'connected' : 'not connected'})`,
        `links ${links.map((l) => `${l.channel}:${l.id}`).join(', ') || 'none'}`,
        `apps ${conns.map((c) => `${c.app}:${c.status}`).join(', ') || 'none'}`,
        browserLine(browser),
      ];
    }
    case 'browser': {
      // Scout's browser (HLD 11.3): work the switch out from the plan and the setting and send
      // it now, instead of waiting for the next turn to notice a difference.
      const user = await activeUser(flags);
      const res = await syncBrowser(user.id, 'dev_script');
      return [
        browserLine(await browserStatus(user.id, user.plan)),
        res === null
          ? 'no container yet: it will be created with the right state'
          : res.changed
            ? `switched ${res.enabled ? 'on' : 'off'}: it applies from the agent's next start`
            : 'no change needed',
      ];
    }
    case 'send': {
      // A message in web chat, through the same function as POST /v1/messages. The worker runs
      // the turn; this waits for it and prints what the user would see.
      const user = await activeUser(flags);
      const text = need(flags, 'text');
      const timeoutSeconds = count(flags, 'timeout', TURN_TIMEOUT_SECONDS, 3600);
      const turn = await listen(user.id);
      const { message, eventId } = await sendWebMessage(user.id, {
        text,
        clientMessageId: `dev-${randomUUID()}`,
      }).catch((err: unknown) => {
        turn.cancel();
        throw err;
      });
      const lines = await turn.finish({
        eventId,
        sessionKey: 'web',
        since: message.createdAt,
        timeoutSeconds,
      });
      return [
        `sent ${message.id} (web chat)`,
        ...lines,
        // `failed`: the turn ended in an error (the reply says which).
        `message ${(await getMessageById(message.id))?.status ?? 'gone'}`,
        `balance ${await getBalance(user.id)} credits`,
      ];
    }
    case 'messages': {
      const user = await activeUser(flags);
      const page = await listMessages(user.id, { limit: count(flags, 'limit', 10, 100) });
      if (!page.items.length) return ['no messages'];
      // Oldest first, the way a chat reads.
      return page.items
        .reverse()
        .map(
          (m) =>
            `${m.createdAt.toISOString()} ${m.direction === 'in' ? 'user ' : 'agent'} ` +
            `${m.channel} ${m.status}: ${shown(m.text)}`,
        );
    }
    case 'activity': {
      const user = await activeUser(flags);
      const page = await listAudit(user.id, { limit: count(flags, 'limit', 20, 200) });
      if (!page.items.length) return ['no activity'];
      return page.items.reverse().map((e) => {
        const crew = crewOfDetails(e.details);
        const credits = e.creditsCharged === null ? '' : ` credits=${e.creditsCharged}`;
        return (
          `${e.createdAt.toISOString()} ${e.actor} ${e.action}` +
          `${crew ? ` crew=${crew}` : ''}${credits}: ${shown(e.summary, 300)}`
        );
      });
    }
    case 'approve': {
      // Answers a pending approval the way the web app does; the worker then wakes the agent
      // with the answer. Without --approval: the one that is pending, if there is exactly one.
      const user = await activeUser(flags);
      const decision = flags.decision ?? 'approve';
      if (decision !== 'approve' && decision !== 'reject')
        throw new UsageError('--decision must be approve or reject');
      const timeoutSeconds = count(flags, 'timeout', TURN_TIMEOUT_SECONDS, 3600);
      let id = flags.approval;
      if (!id) {
        const pending = (await listApprovals(user.id, { status: 'pending', limit: 20 })).items;
        if (pending.length !== 1)
          throw new UsageError(
            pending.length
              ? `${pending.length} approvals are pending; name one with --approval:\n` +
                  pending.map((a) => `  ${a.id}  ${shown(a.summary, 200)}`).join('\n')
              : 'no pending approval',
          );
        id = pending[0]!.id;
      }
      const turn = await listen(user.id);
      const approval = await decideApproval(
        user.id,
        id,
        decision === 'approve',
        'dev-script',
      ).catch((err: unknown) => {
        turn.cancel();
        throw err;
      });
      const event = await findEvent('approval', approval.id);
      if (!event) turn.cancel();
      return [
        `approval ${approval.id} ${approval.status}: ${shown(approval.summary, 300)}`,
        ...(event
          ? await turn.finish({
              eventId: event.id,
              sessionKey: approval.sessionKey,
              since: approval.decidedAt ?? new Date(),
              timeoutSeconds,
            })
          : []),
      ];
    }
    case 'pr-review': {
      // Pull-request review per repo (HLD 0.8), as PUT and DELETE /v1/pr-reviews/{owner}/{repo}.
      const user = await activeUser(flags);
      const lines: string[] = [];
      if (flags.repo || flags.state) {
        const [owner, repo, ...rest] = need(flags, 'repo').split('/');
        if (!owner || !repo || rest.length) throw new UsageError('--repo must be <owner>/<name>');
        const state = need(flags, 'state');
        if (state !== 'on' && state !== 'off') throw new UsageError('--state must be on or off');
        if (state === 'on') {
          const a = toApiPrReview(await enablePrReview(user.id, { owner, repo }));
          lines.push(`turned on for ${a.owner}/${a.repo}`);
        } else {
          const was = await disablePrReview(user.id, { owner, repo });
          lines.push(was ? `turned off for ${owner}/${repo}` : `was not on for ${owner}/${repo}`);
        }
      }
      const on = (await listPrReviews(user.id)).map(toApiPrReview);
      return [
        ...lines,
        ...on.map(
          (r) =>
            `review ${r.owner}/${r.repo} ${r.enabled ? 'on' : `paused (${r.pausedReason ?? 'user'})`}` +
            ` (verdict to ${r.channel}, last review ${r.lastReviewAt ?? 'never'})`,
        ),
        ...(on.length ? [] : ['review is on for no repo']),
      ];
    }
    case 'memories': {
      // The shared memory (HLD 0.9): list it, or delete one or all, as the web app's screen does.
      const user = await activeUser(flags);
      const lines: string[] = [];
      if (flags.clear === 'all') {
        const deleted = await deleteAllMemories(user.id);
        if (deleted > 0)
          await audit({
            userId: user.id,
            actor: 'admin',
            action: 'memories_cleared',
            summary: `Deleted all memories (${deleted})`,
            details: { adminId: ADMIN_ID },
          });
        lines.push(`deleted ${deleted} ${deleted === 1 ? 'memory' : 'memories'}`);
      } else if (flags.clear) {
        const removed = await deleteMemory(user.id, flags.clear);
        if (!removed) throw new UsageError(`no memory ${flags.clear} for this user`);
        await audit({
          userId: user.id,
          actor: 'admin',
          action: 'memory_deleted',
          summary: 'Deleted a memory',
          details: { memoryId: removed.id, adminId: ADMIN_ID },
        });
        lines.push(`deleted ${removed.id}`);
      }
      const all = await listMemories(user.id);
      return [
        ...lines,
        `${all.length} of ${MEMORY_MAX_COUNT} memories`,
        ...all.map((m) => `${m.id} ${m.kind}: ${shown(m.content, 300)}`),
      ];
    }
    default:
      throw new UsageError(command ? `unknown command: ${command}` : 'no command');
  }
}

async function main(): Promise<void> {
  wireModules();
  let code = 0;
  try {
    for (const line of await devUser(process.argv.slice(2))) console.log(line);
  } catch (err) {
    code = 1;
    if (err instanceof UsageError) console.error(`${err.message}\n\n${USAGE}`);
    else console.error(`failed: ${(err as Error).message}`);
  } finally {
    await closeQueues();
    await closeRedis();
    await closeDb();
  }
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
