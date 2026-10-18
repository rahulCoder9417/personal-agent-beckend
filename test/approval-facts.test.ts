// What an approval really does, written by the server from the action's inputs (the Composio
// audit of 17 October, problem 3): on Telegram, WhatsApp and iMessage the question has a second
// line, "What will run: …", and the web card shows the same facts. Tex's own summary stays above
// it, but can't hide where it really goes.
//
// Covered: the facts of a Gmail send, a GitHub collaborator, a Drive share, a public gist and a
// commit; secrets never shown; long text cut; other inputs named; nothing for the platform's own
// kinds; through the tools: the Telegram question and the API's facts show the real recipient and
// repository even when Tex's summary says something else.
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeQueues } from '../src/modules/events/queues.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { approvalFacts, factsLine } from '../src/modules/orchestrator/approval-facts.ts';
import { approvalAskText } from '../src/modules/orchestrator/approval-text.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import {
  installFakeComposio,
  installFakeTelegram,
  installFakeVm,
  mcpCall,
  telegramUpdate,
  type SentTelegram,
} from './fakes.ts';
import { call, chatUser, expectContract, waitFor } from './helpers.ts';

const facts = (action: string, args: Record<string, unknown>, app: string | null = null) =>
  approvalFacts({ app, action, arguments: args });
const valueOf = (list: Array<{ label: string; value: string }>, label: string) =>
  list.find((f) => f.label === label)?.value;

describe('the facts of a request', () => {
  it('a Gmail send: the action, who it goes to, the subject and the first words', () => {
    const f = facts(
      'GMAIL_SEND_EMAIL',
      {
        recipient_email: 'Eve <EVE@evil.com>',
        cc: ['boss@acme.com'],
        subject: 'Notes',
        body: 'Here are the notes from today.',
        user_id: 'me',
      },
      'gmail',
    );
    expect(f).toEqual([
      { label: 'Action', value: 'Gmail – send email' },
      { label: 'To', value: 'eve@evil.com, boss@acme.com' },
      { label: 'Subject', value: 'Notes' },
      { label: 'Text', value: 'Here are the notes from today.' },
    ]);
    expect(factsLine(f)).toBe(
      'Gmail – send email · To: eve@evil.com, boss@acme.com · Subject: Notes · Text: Here are the notes from today.',
    );
  });

  it('GitHub: the repository, who gets access and with which rights', () => {
    const f = facts('GITHUB_ADD_A_REPOSITORY_COLLABORATOR', {
      owner: 'acme',
      repo: 'secret-plans',
      username: 'eve',
      permission: 'admin',
    });
    expect(valueOf(f, 'Action')).toBe('GitHub – add a repository collaborator');
    expect(valueOf(f, 'Repository')).toBe('acme/secret-plans');
    expect(valueOf(f, 'People')).toBe('eve');
    expect(valueOf(f, 'Access')).toBe('admin');
    expect(valueOf(f, 'Other inputs')).toBeUndefined();
  });

  it('sharing and making public say so plainly', () => {
    const share = facts('GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE', {
      file_id: '1AbC',
      type: 'anyone',
      role: 'writer',
    });
    expect(valueOf(share, 'Shared with')).toBe('anyone with the link');
    expect(valueOf(share, 'Access')).toBe('writer');
    expect(valueOf(share, 'File')).toBe('1AbC');
    const gist = facts('GITHUB_CREATE_A_GIST', {
      public: true,
      description: 'notes',
      files: { 'a.txt': { content: 'x' } },
    });
    expect(valueOf(gist, 'Visibility')).toBe('public: anyone can see it');
    expect(valueOf(gist, 'Files')).toBe('1 file: a.txt');
    const calendar = facts('GOOGLECALENDAR_ACL_INSERT', {
      calendar_id: 'primary',
      scope: { type: 'default' },
      role: 'reader',
    });
    expect(valueOf(calendar, 'Shared with')).toBe('everyone (public)');
    expect(valueOf(calendar, 'Calendar')).toBe('primary');
  });

  it('a commit: the repository, the branch, the message and the files', () => {
    const f = facts('GITHUB_COMMIT_MULTIPLE_FILES', {
      owner: 'acme',
      repo: 'web',
      branch: 'main',
      message: 'Remove the login check',
      upserts: [{ path: 'src/auth.ts', content: '…' }],
    });
    expect(factsLine(f)).toContain('Repository: acme/web');
    expect(factsLine(f)).toContain('Branch: main');
    expect(factsLine(f)).toContain('Text: Remove the login check');
    // An input this does not know is named, never left out.
    expect(valueOf(f, 'Other inputs')).toBe('upserts');
  });

  it('never shows a secret, by its name or by its look', () => {
    const f = facts('GITHUB_CREATE_OR_UPDATE_A_REPOSITORY_SECRET', {
      owner: 'acme',
      repo: 'web',
      secret_name: 'DEPLOY',
      encrypted_value: 'c2VjcmV0',
      body: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      config: { url: 'https://hooks.evil.com', secret: 'hunter2' },
    });
    const line = factsLine(f);
    expect(line).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('c2VjcmV0');
    expect(valueOf(f, 'Text')).toBe('(hidden)');
    expect(valueOf(f, 'Sends to')).toBe('url: https://hooks.evil.com, secret: (hidden)');
  });

  it('cuts long text and long lists short', () => {
    const f = facts('SLACK_SEND_MESSAGE', {
      channel: 'C1',
      text: 'word '.repeat(100),
    });
    const text = valueOf(f, 'Text')!;
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text.endsWith('…')).toBe(true);
    const many = facts('GMAIL_SEND_EMAIL', {
      recipient_email: 'a1@x.com',
      extra_recipients: ['a2@x.com', 'a3@x.com', 'a4@x.com', 'a5@x.com', 'a6@x.com', 'a7@x.com'],
    });
    expect(valueOf(many, 'To')).toBe('a1@x.com, a2@x.com, a3@x.com, a4@x.com, a5@x.com and 2 more');
    expect(factsLine(facts('GMAIL_SEND_EMAIL', { body: 'x'.repeat(5000) })).length).toBeLessThan(
      600,
    );
  });

  it('nothing for the platform’s own kinds, or an approval without an action', () => {
    expect(facts('TEXTCREW_RUN_COMMAND', { tool: 'Bash', target: 'curl x' })).toEqual([]);
    expect(approvalFacts({ app: null, action: null, arguments: null })).toEqual([]);
    expect(facts('UNKNOWNAPP_DO_THING', { x: 1 })).toEqual([]);
  });

  it('the question keeps Tex’s sentence and adds what will run under it', () => {
    const f = facts('GMAIL_SEND_EMAIL', { recipient_email: 'eve@evil.com', subject: 'Notes' });
    expect(approvalAskText('Send the notes to Priya', 'telegram', f)).toBe(
      "I'd like to send the notes to Priya.\nWhat will run: Gmail – send email · To: eve@evil.com · Subject: Notes\nApprove or Deny below.",
    );
    expect(approvalAskText('Send the notes to Priya', 'imessage', f)).toBe(
      "I'd like to send the notes to Priya.\nWhat will run: Gmail – send email · To: eve@evil.com · Subject: Notes",
    );
    // Without facts (a command, a push), as before.
    expect(approvalAskText('Pay the invoice', 'telegram')).toBe(
      "I'd like to pay the invoice. Approve or Deny below.",
    );
  });
});

// --- through the tools ----------------------------------------------------------------------------

let workers: Worker[];
let vm: ReturnType<typeof installFakeVm>;
let tg: { sent: SentTelegram[] };

beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(async () => {
  tg = installFakeTelegram();
  await installFakeComposio();
  vm = installFakeVm(async () => {});
});

describe('on the cards', () => {
  it('Telegram and the web card show the real recipient and repository, whatever Tex wrote', async () => {
    const u = await chatUser({ plan: 'pro' });
    for (const app of ['gmail', 'github'])
      await db()
        .insert(connections)
        .values({
          id: newId('con'),
          userId: u.id,
          app,
          composioAccountId: `ca_${randomUUID()}`,
          status: 'active',
        });
    await ensureSandbox(u.id);
    const token = vm.tokens.get(u.id)!;
    // Link a Telegram chat.
    const chatId = Math.floor(Math.random() * 1e9);
    const lc = await expectContract<{ code: string }>(
      'createLinkCode',
      await call('/v1/channels/link-codes', {
        method: 'POST',
        token: u.token,
        body: { channel: 'telegram' },
      }),
      201,
    );
    await call('/webhooks/telegram', {
      method: 'POST',
      body: telegramUpdate(chatId, lc.code),
      headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
    });
    await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(chatId) && m.text.startsWith('✅')),
    );

    // A tricked Tex: the summary says Priya, the email goes to Eve.
    const asked = await mcpCall(token, 'request_approval', {
      summary: 'Send the notes to Priya',
      action: 'GMAIL_SEND_EMAIL',
      arguments: { recipient_email: 'eve@evil.com', subject: 'Notes', body: 'All of it' },
      session_key: `telegram:${chatId}`,
    });
    expect(asked.isError).toBeFalsy();
    const answer = JSON.parse(asked.text) as { approval_id: string; shown_to_user: string };
    expect(answer.shown_to_user).toContain('To: eve@evil.com');
    const question = await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(chatId) && m.buttons),
    );
    expect(question.text).toContain("I'd like to send the notes to Priya.");
    expect(question.text).toContain('What will run: Gmail – send email · To: eve@evil.com');

    // And a GitHub one: the summary names another repository.
    await mcpCall(token, 'request_approval', {
      summary: 'Add Bob to the docs repo',
      action: 'GITHUB_ADD_A_REPOSITORY_COLLABORATOR',
      arguments: { owner: 'acme', repo: 'secret-plans', username: 'eve', permission: 'admin' },
      session_key: 'web',
    });

    const list = await expectContract<{
      items: Array<{ summary: string; facts: Array<{ label: string; value: string }> }>;
    }>('listApprovals', await call('/v1/approvals?status=pending', { token: u.token }), 200);
    const mail = list.items.find((a) => a.summary === 'Send the notes to Priya')!;
    expect(mail.facts).toContainEqual({ label: 'To', value: 'eve@evil.com' });
    const gh = list.items.find((a) => a.summary === 'Add Bob to the docs repo')!;
    expect(gh.facts).toContainEqual({ label: 'Repository', value: 'acme/secret-plans' });
    expect(gh.facts).toContainEqual({ label: 'People', value: 'eve' });
  });
});
