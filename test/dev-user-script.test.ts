// scripts/dev-user.ts: the ops script for a live test without the web app. It must reuse the real
// module functions (onboarding, grants, link codes, Claude sign-in) and never print the Claude code.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { devClerkId, devUser, UsageError } from '../scripts/dev-user.ts';
import { linkWithCode } from '../src/modules/auth/links.ts';
import { getUserByClerkId } from '../src/modules/auth/users.ts';
import { setLiteLLMClient } from '../src/modules/billing/litellm.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { wireModules } from '../src/wiring.ts';
import { FakeLiteLLM } from './billing-fakes.ts';
import { installFakeVm } from './fakes.ts';

let fake: ReturnType<typeof installFakeVm>;
beforeAll(() => wireModules());
afterAll(async () => {
  await closeQueues();
});
beforeEach(() => {
  fake = installFakeVm();
  setLiteLLMClient(new FakeLiteLLM());
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

  it('rejects bad input with a usage error', async () => {
    await expect(devUser(['create'])).rejects.toBeInstanceOf(UsageError);
    await expect(devUser(['status', '--user', 'usr_missing'])).rejects.toBeInstanceOf(UsageError);
    await expect(devUser(['nope'])).rejects.toBeInstanceOf(UsageError);
    await expect(devUser(['create', '--email'])).rejects.toBeInstanceOf(UsageError);
  });
});
