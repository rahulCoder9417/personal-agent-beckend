// Which app actions ask first (founder's decision, 18 October 2026, after the Composio audit of
// 17 October): every action that changes something asks, except a short named list of harmless
// changes; an action whose name says nothing asks unless Composio marks it read-only; the kinds a
// skip rule may never cover (deleting, paying, merging, access to the account, making something
// public, writing files or branches on GitHub) ask even with a rule written into the database.
//
// Covered: each example of the audit asks; only the short list runs without asking, and a Gmail
// label change that archives, trashes or marks as spam asks; an unknown name asks (also when
// Composio can't be asked); reads don't ask; never-skipped kinds can't be skipped; through the
// agent's tools: a change refused without approval, a harmless one run, a stored "anyone" rule
// ignored for a collaborator, and a crew job's own pull request and issue let through once.
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crewBranchName } from '../src/modules/automations/crew-jobs.ts';
import { crewJobs } from '../src/modules/automations/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { appActionNeedsApproval } from '../src/modules/integrations/apps.ts';
import {
  actionNeedsApproval,
  approvalSkippable,
  isSafeChange,
  SAFE_CHANGES,
} from '../src/modules/integrations/catalog.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { approvals, skipRules } from '../src/modules/orchestrator/schema.ts';
import { ruleCovers } from '../src/modules/orchestrator/skip-rules.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { installFakeComposio, installFakeVm, mcpCall } from './fakes.ts';
import { chatUser } from './helpers.ts';

let workers: Worker[];
let vm: ReturnType<typeof installFakeVm>;
let composio: Awaited<ReturnType<typeof installFakeComposio>>;

beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(async () => {
  vm = installFakeVm(async () => {});
  composio = await installFakeComposio();
});

/** The audit's examples (17 October) of changes that ran without asking, as Composio names them. */
const AUDIT_EXAMPLES = [
  // Google Calendar: delete every event, share the calendar, change an event, a one-line event
  'GOOGLECALENDAR_CLEAR_CALENDAR',
  'GOOGLECALENDAR_ACL_INSERT',
  'GOOGLECALENDAR_ACL_PATCH',
  'GOOGLECALENDAR_CALENDAR_LIST_INSERT',
  'GOOGLECALENDAR_PATCH_EVENT',
  'GOOGLECALENDAR_QUICK_ADD',
  // Google Drive: share with anyone, overwrite a file
  'GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE',
  'GOOGLEDRIVE_CREATE_PERMISSION',
  'GOOGLEDRIVE_EDIT_FILE',
  // Google Sheets and Docs, Notion: clear cells, replace all text, replace a page's content
  'GOOGLESHEETS_CLEAR_VALUES',
  'GOOGLESHEETS_SPREADSHEETS_VALUES_BATCH_CLEAR',
  'GOOGLEDOCS_REPLACE_ALL_TEXT_IN_DOCUMENT',
  'NOTION_REPLACE_PAGE_CONTENT',
  // Gmail: a filter, forwarding, relabelling up to 1,000 mails at once
  'GMAIL_CREATE_FILTER',
  'GMAIL_CREATE_FORWARDING_ADDRESS',
  'GMAIL_UPDATE_AUTO_FORWARDING',
  'GMAIL_BATCH_MODIFY_MESSAGES',
  // GitHub: collaborator, deploy key, account email, commit to the default branch, workflows,
  // a release, a gist, a webhook
  'GITHUB_ADD_A_REPOSITORY_COLLABORATOR',
  'GITHUB_CREATE_A_DEPLOY_KEY',
  'GITHUB_ADD_AN_EMAIL_ADDRESS_FOR_THE_AUTHENTICATED_USER',
  'GITHUB_COMMIT_MULTIPLE_FILES',
  'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS',
  'GITHUB_CREATE_A_WORKFLOW_DISPATCH_EVENT',
  'GITHUB_RE_RUN_A_WORKFLOW',
  'GITHUB_CREATE_A_RELEASE',
  'GITHUB_CREATE_A_GIST',
  'GITHUB_CREATE_A_REPOSITORY_WEBHOOK',
  'GITHUB_UPDATE_A_REFERENCE',
  // Slack: delete, schedule, upload, make a file public, edit a sent message
  'SLACK_DELETES_A_MESSAGE_FROM_A_CHAT',
  'SLACK_SCHEDULES_A_MESSAGE_TO_A_CHANNEL_AT_A_SPECIFIED_TIME',
  'SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK',
  'SLACK_ENABLE_PUBLIC_SHARING_OF_A_FILE',
  'SLACK_UPDATES_A_SLACK_MESSAGE',
  // Opening things others see, which never asked before
  'GITHUB_CREATE_AN_ISSUE',
  'GITHUB_CREATE_A_PULL_REQUEST',
  'NOTION_CREATE_COMMENT',
];

/** Names that say only "change" — the name decides, Composio's tags don't matter. */
const NAMED_CHANGES = AUDIT_EXAMPLES.filter(
  (a) =>
    ![
      'GITHUB_COMMIT_MULTIPLE_FILES',
      'GITHUB_RE_RUN_A_WORKFLOW',
      'SLACK_SCHEDULES_A_MESSAGE_TO_A_CHANNEL_AT_A_SPECIFIED_TIME',
      'SLACK_UPDATES_A_SLACK_MESSAGE',
    ].includes(a),
);

describe('which actions ask first', () => {
  it('every example of the audit asks', () => {
    for (const a of AUDIT_EXAMPLES) {
      expect(actionNeedsApproval(a), a).toBe(true);
      expect(actionNeedsApproval(a, { tags: [] }), a).toBe(true);
      expect(actionNeedsApproval(a, { tags: ['important'] }), a).toBe(true);
    }
    // A name with a change word asks even if Composio called it read-only.
    for (const a of NAMED_CHANGES)
      expect(actionNeedsApproval(a, { tags: ['readOnlyHint'] }), a).toBe(true);
  });

  it('only the short list of harmless changes runs without asking', () => {
    expect(Object.keys(SAFE_CHANGES).length).toBeLessThanOrEqual(10);
    for (const a of Object.keys(SAFE_CHANGES)) {
      expect(actionNeedsApproval(a), a).toBe(false);
      expect(actionNeedsApproval(a.toLowerCase()), a).toBe(false);
      expect(SAFE_CHANGES[a]!.why.length, a).toBeGreaterThan(10);
    }
    // Close cousins are not on it.
    for (const a of [
      'GMAIL_SEND_DRAFT',
      'GMAIL_BATCH_MODIFY_MESSAGES',
      'GMAIL_MOVE_TO_TRASH',
      'GOOGLEDOCS_UPDATE_EXISTING_DOCUMENT',
      'NOTION_CREATE_NOTION_PAGE',
      'GITHUB_STAR_A_REPOSITORY',
      'SLACK_ADD_REACTION_TO_AN_ITEM',
      'TODOIST_CLOSE_TASK',
    ])
      expect(actionNeedsApproval(a), a).toBe(true);
  });

  it('a Gmail label change asks when it archives, trashes or marks as spam', () => {
    const label = 'GMAIL_ADD_LABEL_TO_EMAIL';
    const thread = 'GMAIL_MODIFY_THREAD_LABELS';
    const markRead = { message_id: 'm1', remove_label_ids: ['UNREAD'] };
    expect(actionNeedsApproval(label, { args: markRead })).toBe(false);
    expect(
      actionNeedsApproval(label, {
        args: { message_id: 'm1', add_label_ids: ['Label_7', 'STARRED'] },
      }),
    ).toBe(false);
    for (const args of [
      { message_id: 'm1', add_label_ids: ['TRASH'] },
      { message_id: 'm1', add_label_ids: ['spam'] },
      { message_id: 'm1', remove_label_ids: ['INBOX'] },
      { message_id: 'm1', add_label_ids: 'Label_1, TRASH' },
    ]) {
      expect(actionNeedsApproval(label, { args }), JSON.stringify(args)).toBe(true);
      expect(actionNeedsApproval(thread, { args: { ...args, thread_id: 't1' } })).toBe(true);
      expect(isSafeChange(label, args)).toBe(false);
    }
  });

  it('a name that says nothing asks, unless Composio marks it read-only', () => {
    for (const a of [
      'SLACK_CONVERSATIONS_HISTORY',
      'NEWAPP_FROBNICATE',
      'GITHUB_COMMIT_MULTIPLE_FILES',
    ]) {
      expect(actionNeedsApproval(a), a).toBe(true);
      expect(actionNeedsApproval(a, { tags: ['important'] }), a).toBe(true);
      expect(actionNeedsApproval(a, { tags: ['readOnlyHint'] }), a).toBe(false);
      expect(actionNeedsApproval(a, { tags: ['readOnlyHint', 'destructiveHint'] }), a).toBe(true);
    }
  });

  it('reads never ask', () => {
    for (const a of [
      'GMAIL_FETCH_EMAILS',
      'GMAIL_LIST_LABELS',
      'GOOGLECALENDAR_EVENTS_LIST',
      'GOOGLECALENDAR_FIND_FREE_SLOTS',
      'GITHUB_LIST_PULL_REQUESTS',
      'GITHUB_GET_A_PULL_REQUEST',
      'GITHUB_LIST_COMMITS',
      'GOOGLEDRIVE_DOWNLOAD_FILE',
      'SLACK_SEARCH_MESSAGES',
      'NOTION_QUERY_DATABASE',
    ])
      expect(actionNeedsApproval(a), a).toBe(false);
  });

  it('asks Composio for the tags only for a name that says nothing, and asks when it can’t', async () => {
    expect(await appActionNeedsApproval('GITHUB_ADD_A_REPOSITORY_COLLABORATOR', {})).toBe(true);
    expect(await appActionNeedsApproval('GMAIL_CREATE_EMAIL_DRAFT', {})).toBe(false);
    expect(await appActionNeedsApproval('GMAIL_FETCH_EMAILS', {})).toBe(false);
    expect(composio.state.tagLookups).toEqual([]);
    composio.state.tags.set('SLACK_CONVERSATIONS_HISTORY', ['readOnlyHint']);
    expect(await appActionNeedsApproval('SLACK_CONVERSATIONS_HISTORY', {})).toBe(false);
    composio.state.tagsError = new Error('composio down');
    expect(await appActionNeedsApproval('TODOIST_CHECK_ITEM', {})).toBe(true);
  });
});

describe('what a skip rule may never cover', () => {
  it('deleting, paying, merging, access to the account and making things public never skip', () => {
    for (const a of [
      'GMAIL_DELETE_MESSAGE',
      'SLACK_DELETES_A_MESSAGE_FROM_A_CHAT',
      'GOOGLECALENDAR_CLEAR_CALENDAR',
      'GOOGLESHEETS_CLEAR_VALUES',
      'STRIPE_CREATE_A_PAYMENT',
      'GITHUB_MERGE_A_PULL_REQUEST',
      // access: collaborators, keys, the account's emails, sharing, webhooks, forwarding, filters
      'GITHUB_ADD_A_REPOSITORY_COLLABORATOR',
      'GITHUB_CREATE_AN_ORGANIZATION_INVITATION',
      'GITHUB_CREATE_A_DEPLOY_KEY',
      'GITHUB_CREATE_A_PUBLIC_SSH_KEY_FOR_THE_AUTHENTICATED_USER',
      'GITHUB_ADD_AN_EMAIL_ADDRESS_FOR_THE_AUTHENTICATED_USER',
      'GITHUB_CREATE_OR_UPDATE_A_REPOSITORY_SECRET',
      'GITHUB_CREATE_A_REPOSITORY_WEBHOOK',
      'GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE',
      'GOOGLEDRIVE_CREATE_PERMISSION',
      'GOOGLECALENDAR_ACL_INSERT',
      'GMAIL_CREATE_FILTER',
      'GMAIL_UPDATE_AUTO_FORWARDING',
      'SLACK_ENABLE_PUBLIC_SHARING_OF_A_FILE',
      // writing files or branches straight through GitHub's API, like a merge
      'GITHUB_COMMIT_MULTIPLE_FILES',
      'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS',
      'GITHUB_UPDATE_A_REFERENCE',
      'TEXTCREW_RUN_COMMAND',
    ])
      expect(approvalSkippable(a), a).toBe(false);
    // Inputs that make something public, or a label change that trashes, never skip either.
    expect(approvalSkippable('GITHUB_CREATE_A_GIST', { public: true, files: {} })).toBe(false);
    expect(approvalSkippable('GITHUB_CREATE_A_GIST', { public: 'true' })).toBe(false);
    expect(approvalSkippable('GITHUB_CREATE_A_GIST', { public: false })).toBe(true);
    expect(approvalSkippable('GITHUB_UPDATE_A_REPOSITORY', { private: false })).toBe(false);
    expect(approvalSkippable('GITHUB_UPDATE_A_REPOSITORY', { visibility: 'public' })).toBe(false);
    expect(approvalSkippable('GITHUB_UPDATE_A_REPOSITORY', { description: 'x' })).toBe(true);
    expect(
      approvalSkippable('GMAIL_ADD_LABEL_TO_EMAIL', { message_id: 'm', add_label_ids: ['TRASH'] }),
    ).toBe(false);
  });

  it('sending and ordinary changes may still be skipped, by the user only', () => {
    for (const a of [
      'GMAIL_SEND_EMAIL',
      'GMAIL_SEND_DRAFT',
      'SLACK_SCHEDULES_A_MESSAGE_TO_A_CHANNEL_AT_A_SPECIFIED_TIME',
      'GOOGLECALENDAR_PATCH_EVENT',
      'GITHUB_CREATE_AN_ISSUE',
      'GITHUB_CREATE_A_WORKFLOW_DISPATCH_EVENT',
      'NOTION_CREATE_NOTION_PAGE',
    ])
      expect(approvalSkippable(a), a).toBe(true);
    // Nothing to skip for what never asks.
    expect(approvalSkippable('GMAIL_CREATE_EMAIL_DRAFT')).toBe(false);
    expect(approvalSkippable('GMAIL_FETCH_EMAILS')).toBe(false);
  });

  it('a rule for "anyone" written into the database covers none of them', () => {
    const rule = (action: string) => ({ action, scope: 'anyone' as const, recipients: [] });
    expect(
      ruleCovers(
        rule('GITHUB_ADD_A_REPOSITORY_COLLABORATOR'),
        'GITHUB_ADD_A_REPOSITORY_COLLABORATOR',
        { owner: 'a', repo: 'b', username: 'eve' },
      ),
    ).toBe(false);
    expect(ruleCovers(rule('GITHUB_CREATE_A_GIST'), 'GITHUB_CREATE_A_GIST', { public: true })).toBe(
      false,
    );
    expect(
      ruleCovers(rule('GITHUB_CREATE_A_GIST'), 'GITHUB_CREATE_A_GIST', { public: false }),
    ).toBe(true);
    expect(
      ruleCovers(
        rule('SLACK_DELETES_A_MESSAGE_FROM_A_CHAT'),
        'SLACK_DELETES_A_MESSAGE_FROM_A_CHAT',
        { channel: 'C1', ts: '1' },
      ),
    ).toBe(false);
  });
});

// --- through the agent's tools --------------------------------------------------------------------

/** A Pro user with Gmail, GitHub, Google Calendar and Slack connected, and Tex's tools. */
async function person() {
  const user = await chatUser({ plan: 'pro' });
  for (const app of ['gmail', 'github', 'googlecalendar', 'slack'])
    await db()
      .insert(connections)
      .values({
        id: newId('con'),
        userId: user.id,
        app,
        composioAccountId: `ca_${randomUUID()}`,
        status: 'active',
      });
  await ensureSandbox(user.id);
  const token = vm.tokens.get(user.id)!;
  const run = (action: string, args: Record<string, unknown>) =>
    mcpCall(token, 'run_app_action', { action, arguments: args });
  return { ...user, token, run };
}

const ranNow = (slug: string) => composio.executed.filter((e) => e.slug === slug).length;

describe('through run_app_action', () => {
  it('a change asks and runs nothing; a harmless one runs at once', async () => {
    const u = await person();
    for (const [action, args] of [
      ['GOOGLECALENDAR_CLEAR_CALENDAR', { calendar_id: 'primary' }],
      [
        'GITHUB_ADD_A_REPOSITORY_COLLABORATOR',
        { owner: 'acme', repo: 'web', username: 'eve', permission: 'admin' },
      ],
      ['GITHUB_COMMIT_MULTIPLE_FILES', { owner: 'acme', repo: 'web', branch: 'main' }],
      ['SLACK_DELETES_A_MESSAGE_FROM_A_CHAT', { channel: 'C1', ts: '17.1' }],
      ['GMAIL_ADD_LABEL_TO_EMAIL', { message_id: 'm1', add_label_ids: ['TRASH'] }],
    ] as const) {
      const res = await u.run(action, args);
      expect(res.isError, action).toBe(true);
      expect(res.text, action).toContain("needs the user's approval");
      expect(ranNow(action), action).toBe(0);
    }
    const draft = await u.run('GMAIL_CREATE_EMAIL_DRAFT', {
      recipient_email: 'a@b.com',
      body: 'Hi',
    });
    expect(draft.isError).toBe(false);
    const read = await u.run('GMAIL_ADD_LABEL_TO_EMAIL', {
      message_id: 'm1',
      remove_label_ids: ['UNREAD'],
    });
    expect(read.isError).toBe(false);
    expect(ranNow('GMAIL_CREATE_EMAIL_DRAFT')).toBe(1);
    expect(ranNow('GMAIL_ADD_LABEL_TO_EMAIL')).toBe(1);
  });

  it('an unknown name asks, and runs when Composio marks it read-only', async () => {
    const u = await person();
    const asked = await u.run('SLACK_CONVERSATIONS_HISTORY', { channel: 'C1' });
    expect(asked.isError).toBe(true);
    composio.state.tags.set('SLACK_CONVERSATIONS_HISTORY', ['readOnlyHint']);
    // The tags were kept from the first ask: a fresh name is asked about.
    composio.state.tags.set('SLACK_CONVERSATIONS_REPLIES', ['readOnlyHint']);
    const read = await u.run('SLACK_CONVERSATIONS_REPLIES', { channel: 'C1', ts: '1' });
    expect(read.isError).toBe(false);
  });

  it('a skip rule for "anyone" in the database does not let a collaborator be added', async () => {
    const u = await person();
    await db()
      .insert(skipRules)
      .values({
        id: newId('skr'),
        userId: u.id,
        app: 'github',
        action: 'GITHUB_ADD_A_REPOSITORY_COLLABORATOR',
        scope: 'anyone',
        recipients: [],
        createdVia: 'web',
      });
    const res = await u.run('GITHUB_ADD_A_REPOSITORY_COLLABORATOR', {
      owner: 'acme',
      repo: 'web',
      username: 'eve',
    });
    expect(res.isError).toBe(true);
    expect(ranNow('GITHUB_ADD_A_REPOSITORY_COLLABORATOR')).toBe(0);
    const auto = await db().select().from(approvals).where(eq(approvals.userId, u.id));
    expect(auto.filter((a) => a.status === 'auto_approved')).toHaveLength(0);
  });

  it("a crew job's brief lets Byte's own pull request and the report issue through, once each", async () => {
    const u = await person();
    const id = newId('crj');
    await db().insert(crewJobs).values({
      id,
      userId: u.id,
      member: 'byte',
      status: 'running',
      source: 'chat',
      owner: 'acme',
      repo: 'web',
      instructions: 'Fix the login redirect loop.',
      finish: 'pull_request',
      reportIssue: true,
      sessionKey: 'web',
      startedAt: new Date(),
    });
    const branch = crewBranchName({ id });
    const pr = { owner: 'acme', repo: 'web', head: branch, base: 'main', title: 'Fix login' };
    // Another branch, or another repository: asks.
    expect((await u.run('GITHUB_CREATE_A_PULL_REQUEST', { ...pr, head: 'main' })).isError).toBe(
      true,
    );
    expect((await u.run('GITHUB_CREATE_A_PULL_REQUEST', { ...pr, repo: 'other' })).isError).toBe(
      true,
    );
    expect(
      (await u.run('GITHUB_CREATE_A_PULL_REQUEST', { ...pr, head: `acme:${branch}` })).isError,
    ).toBe(false);
    // Once only.
    expect((await u.run('GITHUB_CREATE_A_PULL_REQUEST', pr)).isError).toBe(true);
    expect(ranNow('GITHUB_CREATE_A_PULL_REQUEST')).toBe(1);
    // The app refused the issue: the brief's yes is free again for the next try.
    const issue = { owner: 'acme', repo: 'web', title: 'Report (Textcrew)', body: 'Done.' };
    composio.state.executeFailure = 'Validation failed';
    expect((await u.run('GITHUB_CREATE_AN_ISSUE', issue)).isError).toBe(true);
    expect((await u.run('GITHUB_CREATE_AN_ISSUE', issue)).isError).toBe(false);
    expect((await u.run('GITHUB_CREATE_AN_ISSUE', issue)).isError).toBe(true);
    expect(ranNow('GITHUB_CREATE_AN_ISSUE')).toBe(1);
    // A finished job covers nothing.
    await db().update(crewJobs).set({ status: 'done' }).where(eq(crewJobs.id, id));
    expect((await u.run('GITHUB_CREATE_AN_ISSUE', { ...issue, title: 'Again' })).isError).toBe(
      true,
    );
  });
});
