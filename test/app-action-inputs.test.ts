// An action's inputs sent beside `action` are used, never dropped without a word
// (misplaced-inputs.ts). On 17 October 2026 the founder asked Tex (Claude Code) to review "the code
// smith" PR, then to list his repositories and pull requests. Tex sent the inputs next to `action`
// instead of inside `arguments`; the Platform MCP dropped every name it did not know, so:
// - GITHUB_LIST_PULL_REQUESTS ran with no owner or repo, twice, and Composio said they were missing
//   ("it keeps saying fields are missing even when I include them");
// - GITHUB_LIST_REPOSITORIES_FOR_A_USER failed the same way;
// - GITHUB_FIND_PULL_REQUESTS ran with no filter at all, twice: pull requests of all of GitHub.
// The activity log showed each of those calls with nothing but the action's name.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import type { ComposioTool } from '../src/modules/integrations/composio.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { approvals } from '../src/modules/orchestrator/schema.ts';
import { actionInputsOf } from '../src/modules/platform-mcp/misplaced-inputs.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeComposio, installFakeVm, mcpCall } from './fakes.ts';
import { gmailTools } from './gmail-fixture.ts';
import { chatUser, testApp } from './helpers.ts';

process.env.COMPOSIO_AUTH_CONFIGS = JSON.stringify({ gmail: 'ac_gmail', github: 'ac_github' });
resetConfig();

let vm: ReturnType<typeof installFakeVm>;
let fake: Awaited<ReturnType<typeof installFakeComposio>>;

beforeAll(() => wireModules());
afterAll(closeQueues);

const LIST_PRS = 'GITHUB_LIST_PULL_REQUESTS';
const FIND_PRS = 'GITHUB_FIND_PULL_REQUESTS';

/** GitHub's two pull-request actions, with their inputs as Composio describes them (17 Oct 2026). */
const GITHUB_TOOLS: ComposioTool[] = [
  {
    slug: LIST_PRS,
    toolkit: 'github',
    name: 'List pull requests',
    description:
      "Lists pull requests for a GitHub repository. REQUIRES 'owner' AND 'repo' parameters.",
    tags: ['readOnlyHint'],
    inputParameters: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
        per_page: { type: 'integer' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    slug: FIND_PRS,
    toolkit: 'github',
    name: 'Find Pull Requests',
    description: 'Primary tool to find and search pull requests.',
    tags: ['readOnlyHint'],
    inputParameters: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        owner: { type: 'string' },
        state: { type: 'string' },
        author: { type: 'string' },
        for_authenticated_user: { type: 'boolean' },
      },
    },
  },
];

beforeEach(async () => {
  vm = installFakeVm();
  fake = await installFakeComposio();
  fake.state.tools.set('github', GITHUB_TOOLS);
  fake.state.tools.set('gmail', gmailTools());
});

async function agent() {
  const user = await chatUser({ plan: 'max', credits: 500 });
  for (const app of ['github', 'gmail'])
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
  const mcp = (tool: string, args: Record<string, unknown> = {}) => mcpCall(token, tool, args);
  return { user, mcp };
}

const logged = async (userId: string, action: string) =>
  db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), eq(auditLog.action, action)));

describe('an action\'s inputs sent beside "action"', () => {
  it('run_app_action uses them, says where they belong, and logs them as they ran', async () => {
    const { user, mcp } = await agent();
    // As Tex sent it on 17 October: the inputs next to the action's name.
    const res = await mcp('run_app_action', {
      action: LIST_PRS,
      owner: 'rahulcoder9417',
      repo: 'Code-Smith',
      state: 'open',
    });
    expect(res.isError).toBe(false);
    // Before the fix Composio got `{}` here, and said owner and repo were missing.
    expect(fake.executed.at(-1)).toMatchObject({
      slug: LIST_PRS,
      arguments: { owner: 'rahulcoder9417', repo: 'Code-Smith', state: 'open' },
    });
    const body = JSON.parse(res.text) as { ok: boolean; inputs_note?: string };
    expect(body.ok).toBe(true);
    expect(body.inputs_note).toMatch(/owner, repo, state beside "action"; they were used/);
    expect(body.inputs_note).toMatch(/inside "arguments"/);
    const [entry] = await logged(user.id, 'run_app_action');
    expect(entry!.details).toEqual({
      args: {
        action: LIST_PRS,
        arguments: { owner: 'rahulcoder9417', repo: 'Code-Smith', state: 'open' },
      },
      inputs_moved: ['owner', 'repo', 'state'],
    });
  });

  it('a search runs with its filters, not over all of GitHub', async () => {
    const { mcp } = await agent();
    await mcp('run_app_action', {
      action: FIND_PRS,
      params: { owner: 'rahulcoder9417', state: 'open' },
    });
    expect(fake.executed.at(-1)!.arguments).toEqual({ owner: 'rahulcoder9417', state: 'open' });
  });

  it('inputs inside "arguments" run exactly as before, with no note', async () => {
    const { user, mcp } = await agent();
    const res = await mcp('run_app_action', {
      action: LIST_PRS,
      arguments: { owner: 'octocat', repo: 'hello-world' },
    });
    expect(fake.executed.at(-1)!.arguments).toEqual({ owner: 'octocat', repo: 'hello-world' });
    expect(JSON.parse(res.text)).not.toHaveProperty('inputs_note');
    const [entry] = await logged(user.id, 'run_app_action');
    expect(entry!.details).toEqual({
      args: { action: LIST_PRS, arguments: { owner: 'octocat', repo: 'hello-world' } },
    });
  });

  it('with "arguments" given, a stray name beside it is not run, and the answer says so', async () => {
    const { mcp } = await agent();
    const res = await mcp('run_app_action', {
      action: LIST_PRS,
      arguments: { owner: 'octocat', repo: 'hello-world' },
      reason: 'the user asked',
    });
    expect(fake.executed.at(-1)!.arguments).toEqual({ owner: 'octocat', repo: 'hello-world' });
    expect(JSON.parse(res.text).inputs_note).toMatch(/reason was beside "action" and not used/);
  });

  it('request_approval checks and keeps them: the user approves what will run', async () => {
    const { user, mcp } = await agent();
    const res = await mcp('request_approval', {
      summary: 'Send an email to priya@acme.com with subject "Notes"',
      action: 'GMAIL_SEND_EMAIL',
      recipient_email: 'priya@acme.com',
      subject: 'Notes',
      body: 'Hello',
    });
    expect(res.isError).toBe(false);
    const sent = JSON.parse(res.text) as { approval_id: string; inputs_note?: string };
    expect(sent.inputs_note).toMatch(/recipient_email, subject, body beside "action"/);
    const [a] = await db().select().from(approvals).where(eq(approvals.id, sent.approval_id));
    expect(a!.arguments).toEqual({
      recipient_email: 'priya@acme.com',
      subject: 'Notes',
      body: 'Hello',
    });
    const [entry] = await logged(user.id, 'request_approval');
    expect(entry!.details).toMatchObject({
      args: { action: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'priya@acme.com' } },
      inputs_moved: ['recipient_email', 'subject', 'body'],
    });
  });

  it('a plain question (no action) takes nothing from beside it', async () => {
    const { mcp } = await agent();
    const res = await mcp('request_approval', { summary: 'Book the 9am slot', note: 'x' });
    expect(res.isError).toBe(false);
    const sent = JSON.parse(res.text) as { approval_id: string };
    const [a] = await db().select().from(approvals).where(eq(approvals.id, sent.approval_id));
    expect(a!.arguments).toBeNull();
  });

  it('the tool list tells the agent where the inputs go', async () => {
    const { user } = await agent();
    const res = await testApp().request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${vm.tokens.get(user.id)}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const { result } = (await res.json()) as {
      result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
    };
    const run = result.tools.find((t) => t.name === 'run_app_action')!;
    const props = run.inputSchema.properties as Record<
      string,
      { type?: string; description?: string }
    >;
    expect(Object.keys(props)).toEqual(['action', 'arguments', 'approval_id']);
    expect(props.arguments!.type).toBe('object');
    expect(props.arguments!.description).toMatch(/Every input goes here, not beside action/);
    expect(run.inputSchema.required).toEqual(['action']);
  });
});

describe('actionInputsOf', () => {
  const known = ['action', 'arguments', 'approval_id'];
  it('takes "arguments" when it holds inputs', () => {
    expect(actionInputsOf({ action: 'A', arguments: { a: 1 } }, known)).toEqual({
      inputs: { a: 1 },
      moved: [],
      ignored: [],
    });
    expect(actionInputsOf({ action: 'A' }, known)).toEqual({
      inputs: undefined,
      moved: [],
      ignored: [],
    });
  });
  it('takes the names beside "action", or the one object they were wrapped in', () => {
    expect(actionInputsOf({ action: 'A', owner: 'o', repo: 'r' }, known)).toMatchObject({
      inputs: { owner: 'o', repo: 'r' },
      moved: ['owner', 'repo'],
    });
    expect(actionInputsOf({ action: 'A', arguments: {}, owner: 'o' }, known).inputs).toEqual({
      owner: 'o',
    });
    expect(actionInputsOf({ action: 'A', input: { owner: 'o' } }, known)).toMatchObject({
      inputs: { owner: 'o' },
      moved: ['owner'],
    });
    // A name that is not a wrapper stays one input, even when its value is an object.
    expect(actionInputsOf({ action: 'A', head: { ref: 'x' } }, known).inputs).toEqual({
      head: { ref: 'x' },
    });
  });
  it('leaves names beside a filled "arguments" out', () => {
    expect(actionInputsOf({ action: 'A', arguments: { a: 1 }, b: 2 }, known)).toEqual({
      inputs: { a: 1 },
      moved: [],
      ignored: ['b'],
    });
  });
});
