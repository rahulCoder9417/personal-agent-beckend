// Ops script for a live test without the web app: a dev user, a chat link code, the Claude plan
// sign-in and app connections, all through the same module functions the api and worker use.
// Run inside the api container:  node --import tsx scripts/dev-user.ts <command> [--flags]
//
//   create          --email <e> --name <n> [--plan free|pro|max] [--credits 2000]
//   link-code       --user <id> [--channel telegram|whatsapp|imessage]
//   claude-login    --user <id>
//   claude-complete --user <id> --login <loginId> --code <code>   (the code is never printed or logged)
//   connect-app     --user <id> --app <slug>
//   status          --user <id>
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Job } from 'bullmq';
import { createLinkCode, listLinks, type LinkChannel } from '../src/modules/auth/links.ts';
import { getActiveUser, setPlan, upsertUserFromClerk } from '../src/modules/auth/users.ts';
import { adjustCredits } from '../src/modules/billing/admin.ts';
import { getBalance } from '../src/modules/billing/index.ts';
import { creditExpiry, PLAN_IDS, type PlanId } from '../src/modules/billing/plans.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import {
  listConnections,
  refreshPendingConnections,
  startConnect,
} from '../src/modules/integrations/apps.ts';
import { getAgentSettings } from '../src/modules/orchestrator/agent-settings.ts';
import { completeClaudeLogin, startClaudeLogin } from '../src/modules/orchestrator/claude-login.ts';
import { handleOnboardUser } from '../src/modules/orchestrator/lifecycle.ts';
import { getAgentStatus } from '../src/modules/orchestrator/sandbox.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeRedis } from '../src/shared/redis.ts';
import { wireModules } from '../src/wiring.ts';

const ADMIN_ID = 'dev-user-script';
const USAGE = `usage: node --import tsx scripts/dev-user.ts <command> [flags]
  create          --email <e> --name <n> [--plan free|pro|max] [--credits 2000]
  link-code       --user <id> [--channel telegram|whatsapp|imessage]
  claude-login    --user <id>
  claude-complete --user <id> --login <loginId> --code <code>
  connect-app     --user <id> --app <slug>
  status          --user <id>`;

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

async function activeUser(flags: Record<string, string>) {
  const id = need(flags, 'user');
  const user = await getActiveUser(id);
  if (!user) throw new UsageError(`no active user ${id}`);
  return user;
}

/** Runs one command; returns the lines to print. Never returns the Claude code. */
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
      const [balance, agent, settings, links, conns] = await Promise.all([
        getBalance(user.id),
        getAgentStatus(user.id),
        getAgentSettings(user.id),
        listLinks(user.id),
        listConnections(user.id),
      ]);
      return [
        `user ${user.id} (${user.email}, plan ${user.plan})`,
        `balance ${balance} credits`,
        `agent ${agent.state} (last active ${agent.lastActiveAt?.toISOString() ?? 'never'})`,
        `runtime ${settings.runtime} (effective ${settings.effectiveRuntime}, ai ${settings.aiAccess}, claude ${settings.claude.connected ? 'connected' : 'not connected'})`,
        `links ${links.map((l) => `${l.channel}:${l.id}`).join(', ') || 'none'}`,
        `apps ${conns.map((c) => `${c.app}:${c.status}`).join(', ') || 'none'}`,
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
