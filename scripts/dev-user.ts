// Ops script for a live test without the web app or Telegram: a dev user, a chat link code, the
// Claude plan sign-in, app connections, and a whole turn from the command line, all through the
// same module functions the api and worker use.
// Run inside the api container:  node --import tsx scripts/dev-user.ts <command> [--flags]
//
//   create          --email <e> --name <n> [--plan free|pro|max] [--credits 2000]
//                   (the 100 sign-up credits are given anyway; `credits` takes them away)
//   credits         --user <id> --adjust <signed whole number> --reason <text> [--key <k>]
//                   (the admin adjustment, once per key; e.g. --adjust -100 for an out-of-credits test)
//   plan            --user <id> --plan free|pro|max
//                   (moves the user to that plan the way a paid change does: the plan, the LiteLLM
//                   key's models and budget, Scout's browser switch, the priority. No payment, no
//                   credits granted)
//   link-code       --user <id> [--channel telegram|whatsapp|imessage]
//   claude-login    --user <id>
//   claude-complete --user <id> --login <loginId> --code <code>   (the code is never printed or logged)
//   connect-app     --user <id> --app <slug>
//   apps            --user <id>
//                   (each app connection: our status, what Composio says, its account id and setup,
//                   and what the agent sees in list_app_actions)
//   status          --user <id>
//   browser         --user <id>                      (send Scout's browser switch for this user now)
//   send            --user <id> --text <text> [--conversation <id>] [--timeout 900]
//                   (into web chat's active conversation; with --conversation into that web
//                   conversation, which becomes the active one first)
//   conversations   --user <id> [--channel web|telegram] [--limit 20]
//                   (the user's conversations, the one with the newest message first)
//   new-chat        --user <id>                      (start a new web conversation, as the web app's button does)
//   messages        --user <id> [--conversation <id>] [--limit 10]
//   activity        --user <id> [--limit 20]
//   approve         --user <id> [--approval <id>] [--decision approve|reject] [--timeout 900]
//   pr-review       --user <id> [--repo <owner>/<name> --state on|off]
//   memories        --user <id> [--clear all|<memoryId>]
//   timings         --user <id> [--last 10]
//                   (where the time of each of the last turns went: each stage, how long the user
//                   waited for the answer, and a line on the biggest stage; never any text)
//
// Every command that takes --user also takes --email <the user's email> instead.
//
// What it prints is for a person to read and paste into a report. It never prints a secret: no
// key, token or sign-in code is ever read for printing, and text that people or the agent wrote
// (messages, replies, approvals, memories) goes through `hideSecrets` first.
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Job } from 'bullmq';
import { audit, listAudit } from '../src/modules/admin/audit.ts';
import { createLinkCode, listLinks, type LinkChannel } from '../src/modules/auth/links.ts';
import {
  findActiveUsersByEmail,
  getActiveUser,
  setPlan,
  upsertUserFromClerk,
} from '../src/modules/auth/users.ts';
import {
  disablePrReview,
  enablePrReview,
  listPrReviews,
  toApiPrReview,
} from '../src/modules/automations/pr-review.ts';
import { adjustCredits, setPlanByHand } from '../src/modules/billing/admin.ts';
import { getBalance } from '../src/modules/billing/index.ts';
import { getKeyRow } from '../src/modules/billing/litellm.ts';
import { creditExpiry, PLAN_IDS, type PlanId } from '../src/modules/billing/plans.ts';
import { getCurrentSubscription } from '../src/modules/billing/subscriptions.ts';
import {
  getConversation,
  listConversations,
  toApiConversation,
} from '../src/modules/channels/conversations.ts';
import {
  getMessageById,
  listMessages,
  recentConversationMessages,
  recentSessionMessages,
} from '../src/modules/channels/messages.ts';
import { subscribe } from '../src/modules/channels/stream.ts';
import type { Channel } from '../src/modules/channels/types.ts';
import { findEvent, getEvent } from '../src/modules/events/intake.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { appActionsFor } from '../src/modules/integrations/agent-apps.ts';
import {
  currentSetupFor,
  listConnections,
  refreshPendingConnections,
  startConnect,
} from '../src/modules/integrations/apps.ts';
import { composio, type ComposioAccount } from '../src/modules/integrations/composio.ts';
import { getAgentSettings } from '../src/modules/orchestrator/agent-settings.ts';
import { decideApproval, listApprovals } from '../src/modules/orchestrator/approvals.ts';
import { browserStatus, syncBrowser } from '../src/modules/orchestrator/browser.ts';
import { startNewWebChat } from '../src/modules/orchestrator/chats.ts';
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
import {
  answeredAfter,
  recentTurnTimings,
  seconds,
  turnStages,
  verdict,
  type TurnTimingRow,
} from '../src/modules/orchestrator/timings.ts';
import { sendWebMessage } from '../src/modules/orchestrator/process-message.ts';
import { getAgentStatus } from '../src/modules/orchestrator/sandbox.ts';
import { planPriority, Priority } from '../src/modules/orchestrator/vm.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeRedis } from '../src/shared/redis.ts';
import { wireModules } from '../src/wiring.ts';

const ADMIN_ID = 'dev-user-script';
const USAGE = `usage: node --import tsx scripts/dev-user.ts <command> [flags]
  create          --email <e> --name <n> [--plan free|pro|max] [--credits 2000]
  credits         --user <id> --adjust <signed whole number> --reason <text> [--key <k>]
  plan            --user <id> --plan free|pro|max
  link-code       --user <id> [--channel telegram|whatsapp|imessage]
  claude-login    --user <id>
  claude-complete --user <id> --login <loginId> --code <code>
  connect-app     --user <id> --app <slug>
  apps            --user <id>
  status          --user <id>
  browser         --user <id>
  send            --user <id> --text <text> [--conversation <id>] [--timeout 900]
  conversations   --user <id> [--channel web|telegram] [--limit 20]
  new-chat        --user <id>
  messages        --user <id> [--conversation <id>] [--limit 10]
  activity        --user <id> [--limit 20]
  approve         --user <id> [--approval <id>] [--decision approve|reject] [--timeout 900]
  pr-review       --user <id> [--repo <owner>/<name> --state on|off]
  memories        --user <id> [--clear all|<memoryId>]
  timings         --user <id> [--last 10]
(--email <the user's email> works in place of --user)`;

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

const CHANNELS: Channel[] = ['web', 'telegram', 'whatsapp', 'imessage'];

/** One conversation on one line: id, channel, its number in the chat, whether it is the active one. */
function conversationLine(c: ReturnType<typeof toApiConversation>): string {
  return (
    `${c.id} ${c.channel} #${c.epoch}${c.active ? ' active' : ''} ` +
    `last ${c.lastMessageAt}: ${shown(c.title, 80)}`
  );
}

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
      /** The turn's conversation, when known: only what was sent there counts as the reply. */
      conversationId?: string;
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
      const after = input.conversationId
        ? await recentConversationMessages(userId, input.conversationId, 50, input.since)
        : await recentSessionMessages(userId, input.sessionKey, 50, input.since);
      const sent = after.filter((m) => m.direction === 'out');
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
  if (!flags.user && flags.email) {
    const found = await findActiveUsersByEmail(flags.email);
    if (found.length === 0) throw new UsageError(`no active user with email ${flags.email}`);
    if (found.length > 1)
      throw new UsageError(
        `${found.length} users have email ${flags.email} (${found.map((u) => u.id).join(', ')}): use --user`,
      );
    return found[0]!;
  }
  if (!flags.user) throw new UsageError('--user (or --email) is required');
  const id = flags.user;
  const user = await getActiveUser(id);
  if (!user) throw new UsageError(`no active user ${id}`);
  return user;
}

/** What Composio says about one account, on one line; never a token. */
function composioLine(acc: ComposioAccount | null | Error): string {
  if (acc === null) return 'Composio: no such account';
  if (acc instanceof Error) return `Composio: could not ask (${shown(acc.message, 200)})`;
  return (
    `Composio: ${acc.status} (app ${acc.toolkit || '?'}, setup ${acc.authConfigId ?? '?'}` +
    `${acc.label ? `, ${shown(acc.label, 80)}` : ''})`
  );
}

/** One turn's timings as lines: what the turn was, each stage, the answer's wait, the biggest stage. */
function timingLines(row: TurnTimingRow): string[] {
  const what = [
    row.route ? `route ${row.route}` : '',
    row.engine ? `engine ${row.engine}` : '',
    row.wake ? `wake ${row.wake}` : '',
    row.outcome,
    row.attempt > 1 ? `try ${row.attempt}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const stages = turnStages(row);
  const width = Math.max(...stages.map((st) => st.name.length), 5);
  const answered = answeredAfter(row);
  const finished = row.stages.finished;
  const after =
    finished !== undefined && row.stages.turn_done !== undefined
      ? `; after the answer, saving its last state ${seconds(finished - row.stages.turn_done)}`
      : '';
  return [
    `turn ${row.deliveryId} at ${row.startedAt.toISOString()} (${row.channel} ${row.kind}): ${what}`,
    ...stages.map(
      (st) =>
        `  ${st.name.padEnd(width)}  ${seconds(st.ms).padStart(9)}${st.note ? `  ${st.note}` : ''}`,
    ),
    answered !== undefined
      ? `  answer after ${seconds(answered)}${finished !== undefined ? ` (turn over after ${seconds(finished)}${after})` : ''}`
      : `  no answer${finished !== undefined ? ` (turn over after ${seconds(finished)})` : ''}`,
    `  ${verdict(row, stages)}`,
  ];
}

/** Over several turns: the middle answer time, and the stage that was biggest most often. */
function timingSummary(rows: TurnTimingRow[]): string[] {
  const waits = rows
    .map(answeredAfter)
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b);
  if (!waits.length) return [];
  const biggest = new Map<string, number>();
  for (const row of rows) {
    const stages = turnStages(row);
    if (!stages.length) continue;
    const big = stages.reduce((a, b) => (b.ms > a.ms ? b : a)).name;
    biggest.set(big, (biggest.get(big) ?? 0) + 1);
  }
  const [top, times] = [...biggest].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  return [
    `${rows.length === 1 ? 'over this turn' : `over these ${rows.length} turns`}: answer after ${seconds(waits[Math.floor((waits.length - 1) / 2)]!)} ` +
      `in the middle (${seconds(waits[0]!)} to ${seconds(waits.at(-1)!)}); ` +
      `the biggest stage was ${top} in ${times} of them`,
  ];
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
    case 'plan': {
      // The steps a paid change of plan takes (billing/polar-events.ts, subscriptions.ts), with no
      // payment and no monthly grant: the plan, then the LiteLLM key's models and budget (and the
      // balance listeners), then Scout's browser switch, a system job the worker runs. The
      // priority needs no step: each wake and each queued message reads it from the plan.
      const user = await activeUser(flags);
      const plan = need(flags, 'plan') as PlanId;
      if (!PLAN_IDS.includes(plan))
        throw new UsageError(`--plan must be one of ${PLAN_IDS.join(', ')}`);
      // The same function as the admin api's PATCH /v1/admin/users/{id}.
      const { changed } = await setPlanByHand({
        userId: user.id,
        from: user.plan,
        plan,
        adminId: ADMIN_ID,
      });
      const [key, sub, balance] = await Promise.all([
        getKeyRow(user.id),
        getCurrentSubscription(user.id),
        getBalance(user.id),
      ]);
      const budget =
        key?.maxBudgetMicroUsd == null ? 'no cap' : `$${(key.maxBudgetMicroUsd / 1e6).toFixed(2)}`;
      return [
        changed ? `plan ${plan} (was ${user.plan})` : `plan ${plan} (no change)`,
        key ? `models ${key.models.join(', ')} (budget ${budget})` : 'models (no LiteLLM key yet)',
        `priority ${Priority[planPriority(plan)].toLowerCase()} (from the next wake and the next message)`,
        changed
          ? "browser switch queued: the worker sends it, and it applies from the agent's next start"
          : 'browser switch not sent (same plan); `browser` sends it',
        `balance ${balance} credits (no payment, nothing granted)`,
        ...(sub && !sub.endedAt && sub.plan !== plan
          ? [`note: a Polar subscription (${sub.plan}, ${sub.status}) can set its plan again`]
          : []),
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
      const { redirectUrl, direct } = await startConnect(user.id, user.plan, need(flags, 'app'));
      return [
        `open ${redirectUrl}`,
        direct
          ? "sign-in: straight to the provider's page (our own sign-in app)"
          : "sign-in: Composio's connect page first, then the provider's",
        'the worker checks Composio over the next minutes; `status` also asks right away',
      ];
    }
    case 'apps': {
      // Each connection as we keep it and as Composio has it, the setup each app connects with,
      // and what the agent is told by list_app_actions. For "I connected it, but Tex can't see it".
      const user = await activeUser(flags);
      await refreshPendingConnections(user.id);
      const rows = (await listConnections(user.id)).sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );
      const accounts = await Promise.all(
        rows.map((r) =>
          composio()
            .account(r.composioAccountId)
            .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
        ),
      );
      const known = new Set(rows.map((r) => r.composioAccountId));
      const others = await composio()
        .listAccounts(user.id)
        .then((list) => list.filter((a) => !known.has(a.id)))
        .catch(() => []);
      const setups = await Promise.all(
        [...new Set(rows.map((r) => r.app))].map(async (app) => ({
          app,
          setup: await currentSetupFor(app, user.id),
        })),
      );
      const agent = await appActionsFor(user.id, user.plan);
      return [
        `user ${user.id} (${user.email}, plan ${user.plan})`,
        ...(rows.length === 0 ? ['connections none'] : []),
        ...rows.map(
          (r, i) =>
            `connection ${r.id} ${r.app}: ${r.status} since ${r.createdAt.toISOString()}, ` +
            `account ${r.composioAccountId}${r.accountLabel ? ` (${shown(r.accountLabel, 80)})` : ''}; ` +
            composioLine(accounts[i]!),
        ),
        ...setups.map(({ app, setup }) =>
          setup ? `setup ${app} ${setup.id} (${setup.source})` : `setup ${app} none`,
        ),
        ...others.map(
          (a) =>
            `composio also has ${a.id} (${a.toolkit || '?'}, ${a.status}) with no connection here`,
        ),
        ...agent.apps.map(
          (a) =>
            `agent sees ${a.app}: ${a.status}` +
            `${a.actions === undefined ? '' : `, ${a.actions} actions`}` +
            `${a.note ? ` (${a.note})` : ''}`,
        ),
        ...(agent.note ? [`agent sees: ${agent.note}`] : []),
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
      // the turn; this waits for it and prints what the user would see. With --conversation it
      // goes into that web conversation (made the active one first), else into the active one.
      const user = await activeUser(flags);
      const text = need(flags, 'text');
      const timeoutSeconds = count(flags, 'timeout', TURN_TIMEOUT_SECONDS, 3600);
      const turn = await listen(user.id);
      const { message, eventId } = await sendWebMessage(user.id, {
        text,
        clientMessageId: `dev-${randomUUID()}`,
        ...(flags.conversation ? { conversationId: flags.conversation } : {}),
      }).catch((err: unknown) => {
        turn.cancel();
        throw err;
      });
      const lines = await turn.finish({
        eventId,
        sessionKey: 'web',
        conversationId: message.conversationId,
        since: message.createdAt,
        timeoutSeconds,
      });
      return [
        `sent ${message.id} (web chat, conversation ${message.conversationId})`,
        ...lines,
        // `failed`: the turn ended in an error (the reply says which).
        `message ${(await getMessageById(message.id))?.status ?? 'gone'}`,
        `balance ${await getBalance(user.id)} credits`,
      ];
    }
    case 'conversations': {
      // What GET /v1/conversations lists: every chat's conversations, newest message first.
      const user = await activeUser(flags);
      const channel = flags.channel as Channel | undefined;
      if (channel && !CHANNELS.includes(channel))
        throw new UsageError(`--channel must be one of ${CHANNELS.join(', ')}`);
      const page = await listConversations(user.id, {
        limit: count(flags, 'limit', 20, 100),
        ...(channel ? { channel } : {}),
      });
      if (!page.items.length) return ['no conversations'];
      return [
        ...page.items.map((c) => conversationLine(toApiConversation(c))),
        ...(page.nextCursor ? ['(more: raise --limit)'] : []),
      ];
    }
    case 'new-chat': {
      // A new web conversation, through the same function as POST /v1/conversations (and its
      // limit of 30 an hour). No turn runs.
      const user = await activeUser(flags);
      return [`started ${conversationLine(toApiConversation(await startNewWebChat(user.id)))}`];
    }
    case 'messages': {
      const user = await activeUser(flags);
      if (flags.conversation && !(await getConversation(user.id, flags.conversation)))
        throw new UsageError(`no conversation ${flags.conversation} for this user`);
      const page = await listMessages(user.id, {
        limit: count(flags, 'limit', 10, 100),
        ...(flags.conversation ? { conversationId: flags.conversation } : {}),
      });
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
    case 'timings': {
      // Where the time of the user's last turns went (orchestrator/timings.ts). Newest first.
      const user = await activeUser(flags);
      const rows = await recentTurnTimings(user.id, count(flags, 'last', 10, 100));
      if (!rows.length) return ['no turn timings yet (they are kept 30 days)'];
      return [...rows.flatMap(timingLines), ...timingSummary(rows)];
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
