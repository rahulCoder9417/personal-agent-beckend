// scripts/dev-user.ts: the ops script for a live test without the web app or Telegram. It must
// reuse the real module functions (onboarding, grants, link codes, Claude sign-in, the web chat's
// own path for a message, approvals, pull-request review, memory) and never print a secret.
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { devClerkId, devUser, setDevUserPollMs, UsageError } from '../scripts/dev-user.ts';
import { audit } from '../src/modules/admin/audit.ts';
import { auditLog } from '../src/modules/admin/schema.ts';
import { linkWithCode } from '../src/modules/auth/links.ts';
import { getActiveUser, getUserByClerkId, setPlan } from '../src/modules/auth/users.ts';
import { setLiteLLMClient } from '../src/modules/billing/litellm.ts';
import { keyModelsForPlan } from '../src/modules/billing/plans.ts';
import { creditGrants, payments, subscriptions } from '../src/modules/billing/schema.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { getApproval } from '../src/modules/orchestrator/approvals.ts';
import { saveMemory } from '../src/modules/orchestrator/memory.ts';
import { hideSecrets } from '../src/modules/orchestrator/memory-secrets.ts';
import { DeliverKind, Priority } from '../src/modules/orchestrator/vm.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { AppError } from '../src/shared/errors.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { FakeLiteLLM } from './billing-fakes.ts';
import { installFakeComposio, installFakeVm } from './fakes.ts';
import { createUser, waitFor } from './helpers.ts';

let fake: ReturnType<typeof installFakeVm>;
let workers: Worker[];
beforeAll(() => {
  wireModules();
  // `send` and `approve` only queue a job, like the api: the worker runs the turn.
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
  setDevUserPollMs(20);
});
afterAll(async () => {
  setDevUserPollMs(undefined);
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(() => {
  fake = installFakeVm();
  setLiteLLMClient(new FakeLiteLLM());
});
afterEach(() => {
  delete process.env.BROWSER_AVAILABLE;
  resetConfig();
});

function field(lines: string[], name: string): string {
  const line = lines.find((l) => l.startsWith(`${name} `));
  if (!line) throw new Error(`no ${name} in ${JSON.stringify(lines)}`);
  return line.slice(name.length + 1).split(' ')[0]!;
}

describe('dev-user script', () => {
  it('create: user + sign-up and dev credits + sandbox; re-running updates the same user', async () => {
    const out = await devUser([
      'create',
      '--email',
      'dev@example.com',
      '--name',
      'Dev',
      '--plan',
      'max',
    ]);
    const userId = field(out, 'user');
    expect(field(out, 'balance')).toBe('2100'); // 100 sign-up + 2,000 dev credits
    expect(fake.created).toContain(userId);
    const user = await getUserByClerkId(devClerkId('dev@example.com'));
    expect(user).toMatchObject({ id: userId, plan: 'max', emailVerified: true });
    expect(devClerkId('dev@example.com')).toMatch(
      /^dev_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const again = await devUser(['create', '--email', 'dev@example.com', '--plan', 'max']);
    expect(field(again, 'user')).toBe(userId);
    expect(field(again, 'balance')).toBe('2100'); // grants are idempotent
  });

  it('link-code: a working Telegram link code', async () => {
    const userId = field(await devUser(['create', '--email', 'link@example.com']), 'user');
    const out = await devUser(['link-code', '--user', userId]);
    const code = field(out, 'code');
    expect(code).toMatch(/^LINK-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const res = await linkWithCode({
      code,
      channel: 'telegram',
      externalId: '4242',
      displayId: '@dev',
    });
    expect(res).toMatchObject({ ok: true, link: { userId } });
  });

  it('claude-login + claude-complete: connects the plan without printing the code', async () => {
    const userId = field(await devUser(['create', '--email', 'claude@example.com']), 'user');
    const start = await devUser(['claude-login', '--user', userId]);
    const loginId = field(start, 'loginId');
    expect(field(start, 'authorizeUrl')).toMatch(/^https:\/\/claude\.ai\//);
    const code = fake.logins.get(loginId)!.code;
    const done = await devUser([
      'claude-complete',
      '--user',
      userId,
      '--login',
      loginId,
      '--code',
      code,
    ]);
    expect(done.join('\n')).not.toContain(code);
    expect(done).toContain('claude connected true');

    const status = await devUser(['status', '--user', userId]);
    expect(status.join('\n')).toContain('claude connected');
    expect(status.join('\n')).toContain('runtime claude_code');
  });

  it('credits: a signed adjustment through the admin path, once per --key, down to zero', async () => {
    const email = `${randomUUID()}@example.com`;
    const userId = field(await devUser(['create', '--email', email, '--credits', '0']), 'user');
    // Only the sign-up credits, which `create` cannot skip.
    expect(field(await devUser(['status', '--user', userId]), 'balance')).toBe('100');

    const args = [
      'credits',
      '--user',
      userId,
      '--adjust',
      '-100',
      '--reason',
      'out of credits test',
    ];
    const out = await devUser([...args, '--key', 'zero-1']);
    expect(out).toContain('adjusted -100 credits (key zero-1)');
    expect(field(out, 'balance')).toBe('0');
    // The same key again changes nothing; the admin log has one entry.
    expect(field(await devUser([...args, '--key', 'zero-1']), 'balance')).toBe('0');
    const logged = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userId), eq(auditLog.action, 'credits_adjusted')));
    expect(logged.map((e) => e.summary)).toEqual(['-100 credits: out of credits test']);
    // At zero the user is refused like any user out of credits.
    await expect(devUser(['send', '--user', userId, '--text', 'hello'])).rejects.toMatchObject({
      code: 'out_of_credits',
    });

    // Without --key, each run is its own adjustment.
    const up = await devUser(['credits', '--user', userId, '--adjust', '+25', '--reason', 'back']);
    expect(field(up, 'balance')).toBe('25');
    expect(
      field(
        await devUser(['credits', '--user', userId, '--adjust', '25', '--reason', 'more']),
        'balance',
      ),
    ).toBe('50');
  });

  it('rejects bad input with a usage error', async () => {
    await expect(devUser(['create'])).rejects.toBeInstanceOf(UsageError);
    await expect(devUser(['status', '--user', 'usr_missing'])).rejects.toBeInstanceOf(UsageError);
    await expect(devUser(['nope'])).rejects.toBeInstanceOf(UsageError);
    await expect(devUser(['create', '--email'])).rejects.toBeInstanceOf(UsageError);
    const userId = await devUserId();
    for (const bad of [
      ['send', '--user', userId],
      ['send', '--user', userId, '--text', 'hi', '--timeout', '0'],
      ['messages', '--user', userId, '--limit', 'many'],
      ['activity', '--user', userId, '--limit', '0'],
      ['approve', '--user', userId, '--decision', 'maybe'],
      ['pr-review', '--user', userId, '--repo', 'acme/api'],
      ['pr-review', '--user', userId, '--repo', 'no-owner', '--state', 'on'],
      ['pr-review', '--user', userId, '--repo', 'acme/api', '--state', 'sometimes'],
      ['memories', '--user', userId, '--clear', 'mem_not_theirs'],
      ['browser'],
      ['credits', '--user', userId, '--adjust', '-5'],
      ['credits', '--user', userId, '--reason', 'x'],
      ['credits', '--user', userId, '--adjust', '0', '--reason', 'x'],
      ['credits', '--user', userId, '--adjust', '1.5', '--reason', 'x'],
      ['credits', '--user', userId, '--adjust', 'ten', '--reason', 'x'],
      ['credits', '--user', 'usr_missing', '--adjust', '5', '--reason', 'x'],
      ['plan', '--user', userId],
      ['plan', '--user', userId, '--plan', 'gold'],
      ['plan', '--plan', 'pro'],
    ])
      await expect(devUser(bad), bad.join(' ')).rejects.toBeInstanceOf(UsageError);
  });
});

/** A dev user made by the script itself (2,100 credits, a container). */
async function devUserId(plan = 'free'): Promise<string> {
  const email = `${randomUUID()}@example.com`;
  return field(await devUser(['create', '--email', email, '--plan', plan]), 'user');
}

const withPrefix = (lines: string[], prefix: string) =>
  lines.filter((l) => l.startsWith(`${prefix} `)).map((l) => l.slice(prefix.length + 1));

describe('dev-user script: a turn without Telegram or the web app', () => {
  it('send: the message goes in through web chat, the worker runs the turn, and the progress lines and the reply come back', async () => {
    const userId = await devUserId();
    fake.state.agent = async (d, mcp, progress) => {
      progress('Scout: reading 2 pages');
      progress('using read_page');
      await mcp('send_message', { text: `You said: ${d.text}`, session_key: d.sessionKey });
    };
    const out = await devUser(['send', '--user', userId, '--text', 'what is new in Hono?']);

    // Delivered as that user, on the web chat channel, as a message.
    const [delivery] = fake.deliveries.filter((d) => d.userId === userId);
    expect(delivery).toMatchObject({
      sessionKey: 'web',
      kind: DeliverKind.MESSAGE,
      text: 'what is new in Hono?',
    });
    expect((delivery as unknown as { channel: string }).channel).toBe('web');
    // Saved the way POST /v1/messages saves it: an inbound web message with a client id.
    const [inbound] = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.direction, 'in')));
    expect(inbound).toMatchObject({
      channel: 'web',
      sessionKey: 'web',
      text: 'what is new in Hono?',
      status: 'delivered',
    });
    expect(inbound!.clientMessageId).toMatch(/^dev-/);

    expect(field(out, 'sent')).toBe(inbound!.id);
    expect(withPrefix(out, 'progress')).toEqual(['Scout: reading 2 pages', 'using read_page']);
    expect(withPrefix(out, 'reply')).toEqual(['You said: what is new in Hono?']);
    expect(out.find((l) => l.startsWith('turn '))).toMatch(/^turn done after \d+\.\d s$/);
    expect(out).toContain('message delivered');
    expect(field(out, 'balance')).toBe('2100');
  });

  it('send: at zero credits it is refused like the api refuses it, and nothing is queued', async () => {
    const u = await createUser();
    const err = await devUser(['send', '--user', u.id, '--text', 'hello']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 402, code: 'out_of_credits' });
    expect(fake.deliveries).toEqual([]);
    expect(await db().select().from(messages).where(eq(messages.userId, u.id))).toEqual([]);
  });

  it('send: a turn that fails says so, with what the user was told', async () => {
    const userId = await devUserId();
    fake.state.turnError = { message: 'the engine stopped', platformFault: false };
    const out = await devUser(['send', '--user', userId, '--text', 'hello']);
    expect(withPrefix(out, 'reply')).toEqual(["I couldn't finish that: the engine stopped"]);
    expect(out).toContain('message failed');
  });

  it('send: gives up after --timeout and says the turn is still running', async () => {
    const userId = await devUserId();
    let finish = () => {};
    const held = new Promise<void>((r) => (finish = r));
    fake.state.agent = async (d, mcp) => {
      await held;
      await mcp('send_message', { text: 'late answer', session_key: d.sessionKey });
    };
    const out = await devUser(['send', '--user', userId, '--text', 'slow one', '--timeout', '1']);
    expect(withPrefix(out, 'reply')).toEqual(['(none)']);
    expect(out.find((l) => l.startsWith('turn '))).toMatch(/^turn still running after 1\.\d s/);
    expect(out).toContain('message processing');
    // The turn goes on in the worker; `messages` shows the reply once it is there.
    finish();
    await waitFor(async () =>
      (await devUser(['messages', '--user', userId])).some((l) => l.endsWith('late answer')),
    );
  });

  it('never prints a secret: a key, a token or a password in a message or a reply is hidden', async () => {
    const userId = await devUserId();
    const key = 'sk-live1234567890abcdefghij';
    fake.state.agent = async (d, mcp, progress) => {
      progress(`Byte: using ${key}`);
      await mcp('send_message', {
        text: `Stored. Your key is ${key}\nReviewed commit 3f2a9c1b7d4e5f60718293a4b5c6d7e8f9012345.`,
        session_key: d.sessionKey,
      });
    };
    const out = await devUser([
      'send',
      '--user',
      userId,
      '--text',
      `my wifi password is hunter2 and the key is ${key}`,
    ]);
    const listed = await devUser(['messages', '--user', userId]);
    const activity = await devUser(['activity', '--user', userId]);
    for (const lines of [out, listed, activity]) {
      const text = lines.join('\n');
      expect(text).not.toContain(key);
      expect(text).not.toContain('hunter2');
    }
    expect(withPrefix(out, 'reply')[0]).toBe(
      'Stored. Your key is [hidden]\nReviewed commit 3f2a9c1b7d4e5f60718293a4b5c6d7e8f9012345.',
    );
    expect(withPrefix(out, 'progress')).toEqual(['Byte: using [hidden]']);
    expect(listed[0]).toMatch(/user {2}web delivered: my wifi \[hidden\]$/);
    // What is hidden, and what is not.
    expect(hideSecrets('token ghp_abcdefghijklmnopqrstuvwxyz0123 ok')).toBe('token [hidden] ok');
    expect(hideSecrets('see https://x.example/cb?token=abcdef123456 now')).toBe('see [hidden] now');
    expect(hideSecrets('random AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')).toBe('random [hidden]');
    expect(hideSecrets('card 4242 4242 4242 4242')).toBe('card [hidden]');
    const plain = 'Open https://docs.example.com/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
    expect(hideSecrets(plain)).toBe(plain);
  });
});

describe('dev-user script: reading what happened', () => {
  it('messages: the latest messages, oldest first, with who wrote them and their status', async () => {
    const userId = await devUserId();
    expect(await devUser(['messages', '--user', userId])).toEqual(['no messages']);
    for (const text of ['first', 'second', 'third'])
      await devUser(['send', '--user', userId, '--text', text]);
    // A reply is `queued` until the outbound job has run, then `sent`.
    await waitFor(async () =>
      (await devUser(['messages', '--user', userId])).every((l) => !l.includes(' queued: ')),
    );
    const all = await devUser(['messages', '--user', userId]);
    expect(all.map((l) => l.split(' ').slice(1).join(' '))).toEqual([
      'user  web delivered: first',
      'agent web sent: echo: first',
      'user  web delivered: second',
      'agent web sent: echo: second',
      'user  web delivered: third',
      'agent web sent: echo: third',
    ]);
    for (const l of all) expect(Number.isNaN(Date.parse(l.split(' ')[0]!))).toBe(false);
    const last = await devUser(['messages', '--user', userId, '--limit', '2']);
    expect(last.map((l) => l.split(': ').slice(1).join(': '))).toEqual(['third', 'echo: third']);
  });

  it('activity: action, crew member, credits and summary of each entry', async () => {
    const userId = await devUserId();
    fake.state.agent = async (d, mcp, progress) => {
      progress('Scout: reading 2 pages');
      await mcp('send_message', { text: 'done', session_key: d.sessionKey });
    };
    await devUser(['send', '--user', userId, '--text', 'look it up']);
    await audit({
      userId,
      actor: 'agent',
      action: 'web_search',
      summary: 'Searched the web: hono',
      creditsCharged: 1,
    });
    const out = await devUser(['activity', '--user', userId, '--limit', '50']);
    const entries = out.map((l) => l.split(' ').slice(1).join(' '));
    expect(entries).toContain('agent crew_progress crew=scout: Scout: reading 2 pages');
    expect(entries).toContain('agent send_message: Sent a message (4 chars)');
    expect(entries.at(-1)).toBe('agent web_search credits=1: Searched the web: hono');
    expect(entries.some((e) => e.startsWith('admin credits_adjusted: +2000 credits'))).toBe(true);
    // The newest are kept when there are more than the limit.
    expect(await devUser(['activity', '--user', userId, '--limit', '1'])).toHaveLength(1);
  });
});

describe('dev-user script: approvals, pull-request review, memory, the browser', () => {
  /** The agent asks for approval on a normal message, and reports what it was told afterwards. */
  const askingAgent = () => {
    fake.state.agent = async (d, mcp) => {
      if (d.kind === DeliverKind.APPROVAL_ANSWER) {
        await mcp('send_message', {
          text: d.approved ? 'Sent the email.' : 'OK, I did not send it.',
          session_key: d.sessionKey,
        });
        return;
      }
      await mcp('request_approval', {
        summary: `Send the email about ${d.text}`,
        session_key: d.sessionKey,
      });
    };
  };

  it('approve: answers the pending approval, and the agent goes on with the answer', async () => {
    const userId = await devUserId();
    askingAgent();
    const asked = await devUser(['send', '--user', userId, '--text', 'the launch']);
    const approvalId = field(asked, 'approval');
    expect(withPrefix(asked, 'reply')).toEqual([
      'Approval needed: Send the email about the launch',
    ]);

    const out = await devUser(['approve', '--user', userId]);
    expect(out[0]).toBe(`approval ${approvalId} approved: Send the email about the launch`);
    expect(withPrefix(out, 'reply')).toEqual(['Sent the email.']);
    expect(await getApproval(userId, approvalId)).toMatchObject({
      status: 'approved',
      decidedVia: 'dev-script',
    });
    const answer = fake.deliveries.find((d) => d.kind === DeliverKind.APPROVAL_ANSWER);
    expect(answer).toMatchObject({ userId, approvalId, approved: true, sessionKey: 'web' });
    // Answered once: there is nothing pending now, and the same one can't be answered again.
    await expect(devUser(['approve', '--user', userId])).rejects.toThrow('no pending approval');
    await expect(
      devUser(['approve', '--user', userId, '--approval', approvalId]),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('approve: --decision reject, and --approval picks one when several are pending', async () => {
    const userId = await devUserId();
    askingAgent();
    const first = field(
      await devUser(['send', '--user', userId, '--text', 'the invoice']),
      'approval',
    );
    const second = field(
      await devUser(['send', '--user', userId, '--text', 'the offer']),
      'approval',
    );
    const unclear = await devUser(['approve', '--user', userId]).catch((e: unknown) => e);
    expect(unclear).toBeInstanceOf(UsageError);
    expect((unclear as Error).message).toContain('2 approvals are pending');
    expect((unclear as Error).message).toContain(first);
    expect((unclear as Error).message).toContain(second);

    const out = await devUser([
      'approve',
      '--user',
      userId,
      '--approval',
      first,
      '--decision',
      'reject',
    ]);
    expect(out[0]).toBe(`approval ${first} rejected: Send the email about the invoice`);
    expect(withPrefix(out, 'reply')).toEqual(['OK, I did not send it.']);
    expect((await getApproval(userId, second))!.status).toBe('pending');
  });

  it('pr-review: turns review on and off for a repo and lists what is on', async () => {
    const composio = await installFakeComposio();
    const userId = await devUserId('pro');
    expect(await devUser(['pr-review', '--user', userId])).toEqual(['review is on for no repo']);
    // Without GitHub connected it is refused, as in the web app.
    await expect(
      devUser(['pr-review', '--user', userId, '--repo', 'acme/api', '--state', 'on']),
    ).rejects.toMatchObject({ status: 409, message: 'Connect GitHub first' });
    await db()
      .insert(connections)
      .values({
        id: newId('con'),
        userId,
        app: 'github',
        composioAccountId: `ca_${randomUUID()}`,
        status: 'active',
      });

    const on = await devUser([
      'pr-review',
      '--user',
      userId,
      '--repo',
      'acme/api',
      '--state',
      'on',
    ]);
    expect(on).toEqual([
      'turned on for acme/api',
      'review acme/api on (verdict to web, last review never)',
    ]);
    expect(composio.triggers.map((t) => [t.userId, t.config])).toEqual([
      [userId, { owner: 'acme', repo: 'api' }],
    ]);
    await devUser(['pr-review', '--user', userId, '--repo', 'acme/web', '--state', 'on']);
    expect(await devUser(['pr-review', '--user', userId])).toEqual([
      'review acme/api on (verdict to web, last review never)',
      'review acme/web on (verdict to web, last review never)',
    ]);

    const off = await devUser([
      'pr-review',
      '--user',
      userId,
      '--repo',
      'acme/api',
      '--state',
      'off',
    ]);
    expect(off).toEqual([
      'turned off for acme/api',
      'review acme/web on (verdict to web, last review never)',
    ]);
    expect(composio.triggers).toHaveLength(1);
    expect(
      (await devUser(['pr-review', '--user', userId, '--repo', 'acme/api', '--state', 'off']))[0],
    ).toBe('was not on for acme/api');
  });

  it('memories: lists them, deletes one, clears them all', async () => {
    const userId = await devUserId();
    expect(await devUser(['memories', '--user', userId])).toEqual(['0 of 200 memories']);
    const { memory: first } = await saveMemory(userId, {
      content: 'Prefers short replies',
      kind: 'preference',
    });
    const { memory: second } = await saveMemory(userId, { content: 'Works on acme/api' });
    await saveMemory(userId, { content: 'Priya is their co-founder', kind: 'person' });
    const listed = await devUser(['memories', '--user', userId]);
    expect(listed[0]).toBe('3 of 200 memories');
    expect(listed).toContain(`${first.id} preference: Prefers short replies`);
    expect(listed).toContain(`${second.id} fact: Works on acme/api`);

    const one = await devUser(['memories', '--user', userId, '--clear', first.id]);
    expect(one.slice(0, 2)).toEqual([`deleted ${first.id}`, '2 of 200 memories']);
    expect(await devUser(['memories', '--user', userId, '--clear', 'all'])).toEqual([
      'deleted 2 memories',
      '0 of 200 memories',
    ]);
    // In the activity log as the web app's deletes are, without the memory's text.
    const log = await db().select().from(auditLog).where(eq(auditLog.userId, userId));
    expect(log.filter((e) => e.action.startsWith('memor')).map((e) => e.action)).toEqual([
      'memory_deleted',
      'memories_cleared',
    ]);
    expect(JSON.stringify(log)).not.toContain('Prefers short replies');
    // Another user's memory can't be deleted through this user.
    const other = await devUserId();
    const { memory: theirs } = await saveMemory(other, { content: 'Lives in Pune' });
    await expect(
      devUser(['memories', '--user', userId, '--clear', theirs.id]),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('create, status and browser: Scout’s browser follows the plan and the setting', async () => {
    // The default: the deployed image has no browser, so not even a Max user gets one.
    const early = await devUser(['create', '--email', 'early@example.com', '--plan', 'max']);
    expect(early).toContain('browser off (should be off; the image has it: no)');

    process.env.BROWSER_AVAILABLE = 'true';
    resetConfig();
    const max = await devUser(['create', '--email', 'max@example.com', '--plan', 'max']);
    const userId = field(max, 'user');
    expect(max).toContain('browser on (should be on; the image has it: yes)');
    expect(fake.browser.get(userId)).toBe(true);

    // Running `create` again with another plan sends the switch: nothing else would, here.
    const pro = await devUser(['create', '--email', 'max@example.com', '--plan', 'pro']);
    expect(pro).toContain('browser off (should be off; the image has it: yes)');
    expect(fake.browser.get(userId)).toBe(false);
    expect(await devUser(['status', '--user', userId])).toContain(
      'browser off (should be off; the image has it: yes)',
    );

    // A plan set some other way: `status` shows the difference and `browser` sends the switch.
    await setPlan(userId, 'max');
    expect(await devUser(['status', '--user', userId])).toContain(
      'browser off (should be on; the image has it: yes)',
    );
    expect(await devUser(['browser', '--user', userId])).toEqual([
      'browser on (should be on; the image has it: yes)',
      "switched on: it applies from the agent's next start",
    ]);
    expect((await devUser(['browser', '--user', userId]))[1]).toBe('no change needed');
  });
});

describe('dev-user script: plan', () => {
  it('moves the user the way a paid change does: plan, key, browser, priority; no payment, no grant', async () => {
    process.env.BROWSER_AVAILABLE = 'true';
    resetConfig();
    const litellm = new FakeLiteLLM();
    setLiteLLMClient(litellm);
    const userId = await devUserId('free');
    const keyOf = () => [...litellm.keys.values()].find((k) => k.userId === userId)!;
    expect(keyOf().models).toEqual(keyModelsForPlan('free'));
    expect(keyModelsForPlan('max')).not.toEqual(keyModelsForPlan('free'));
    expect(fake.browser.get(userId)).toBe(false);
    const grants = () => db().select().from(creditGrants).where(eq(creditGrants.userId, userId));
    const grantsBefore = await grants();

    const out = await devUser(['plan', '--user', userId, '--plan', 'max']);
    expect(out).toEqual([
      'plan max (was free)',
      `models ${keyModelsForPlan('max').join(', ')} (budget $8.40)`,
      'priority high (from the next wake and the next message)',
      "browser switch queued: the worker sends it, and it applies from the agent's next start",
      'balance 2100 credits (no payment, nothing granted)',
    ]);
    expect((await getActiveUser(userId))!.plan).toBe('max');
    // The LiteLLM key: the plan's models, and the budget still follows the balance.
    expect(keyOf().models).toEqual(keyModelsForPlan('max'));
    expect(keyOf().maxBudget).toBe(8.4);
    // Scout's browser: the system job a paid change queues, run by the worker.
    await waitFor(async () => fake.browser.get(userId) === true);
    // No payment, no subscription, no credits.
    expect(await grants()).toEqual(grantsBefore);
    expect(await db().select().from(payments).where(eq(payments.userId, userId))).toEqual([]);
    expect(await db().select().from(subscriptions).where(eq(subscriptions.userId, userId))).toEqual(
      [],
    );
    const log = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userId), eq(auditLog.action, 'plan_changed')));
    expect(log.map((e) => [e.actor, e.summary])).toEqual([
      ['admin', 'Plan set to Max by hand (no payment)'],
    ]);

    // The priority follows the plan: first in the inbound queue, high at the wake.
    const sent = await devUser(['send', '--user', userId, '--text', 'hello']);
    const [inbound] = await db()
      .select()
      .from(messages)
      .where(eq(messages.id, field(sent, 'sent')));
    expect((await queue('inbound').getJob(inbound!.eventId!))!.opts.priority).toBe(1);
    expect(fake.wakePriorities.at(-1)).toEqual({ userId, priority: Priority.HIGH });

    // Back to Free: the cheap model only, the browser off, the priority low.
    const down = await devUser(['plan', '--user', userId, '--plan', 'free']);
    expect(down.slice(0, 3)).toEqual([
      'plan free (was max)',
      `models ${keyModelsForPlan('free').join(', ')} (budget $8.40)`,
      'priority low (from the next wake and the next message)',
    ]);
    expect(keyOf().models).toEqual(keyModelsForPlan('free'));
    await waitFor(async () => fake.browser.get(userId) === false);

    // The same plan again changes nothing and queues nothing.
    const calls = fake.browserCalls.length;
    const same = await devUser(['plan', '--user', userId, '--plan', 'free']);
    expect(same[0]).toBe('plan free (no change)');
    expect(same[3]).toBe('browser switch not sent (same plan); `browser` sends it');
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.browserCalls.length).toBe(calls);
  });
});
