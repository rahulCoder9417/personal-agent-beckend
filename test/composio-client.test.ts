// The real Composio wiring (composio.ts), with the SDK replaced by a stand-in that records what is
// asked of it: one SDK client per process with no npm version check, and an action run without
// asking Composio for the action's description each time (before: about 0.3 s per run).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const made: Array<Record<string, unknown>> = [];
const executes: Array<{ slug: string; body: Record<string, unknown>; options: unknown }> = [];
const toolFetches: string[] = [];
const sdkExecutes: string[] = [];

const GMAIL_SEND = {
  slug: 'GMAIL_SEND_EMAIL',
  name: 'Send email',
  description: 'Sends an email.',
  toolkit: { slug: 'gmail' },
  inputParameters: {
    type: 'object',
    properties: {
      recipient_email: { type: 'string' },
      subject: { type: 'string' },
      attachment: { type: 'object', file_uploadable: true },
    },
  },
  tags: [],
};

vi.mock('@composio/core', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@composio/core')>();
  class FakeComposio {
    tools = {
      getRawComposioToolBySlug: async (slug: string) => {
        toolFetches.push(slug);
        return slug === GMAIL_SEND.slug ? GMAIL_SEND : { ...GMAIL_SEND, slug, inputParameters: {} };
      },
      getRawComposioTools: async () => [GMAIL_SEND],
      execute: async (slug: string) => {
        sdkExecutes.push(slug);
        return { successful: true, data: {}, error: null };
      },
    };
    constructor(opts: Record<string, unknown>) {
      made.push(opts);
    }
    getClient() {
      return {
        tools: {
          execute: async (slug: string, body: Record<string, unknown>, options: unknown) => {
            executes.push({ slug, body, options });
            return { successful: true, data: { id: 'msg_1' }, error: null, log_id: 'log_1' };
          },
        },
      };
    }
  }
  return { ...orig, Composio: FakeComposio };
});

process.env.COMPOSIO_API_KEY = 'ck_test_key';
const { resetConfig } = await import('../src/shared/config.ts');
resetConfig();
const { composio, setComposioApi, toolkitTools, withoutEmptyFiles } =
  await import('../src/modules/integrations/composio.ts');

beforeEach(() => {
  setComposioApi(undefined); // the real wiring, with empty caches
  made.length = 0;
  executes.length = 0;
  toolFetches.length = 0;
  sdkExecutes.length = 0;
});

const run = (args: Record<string, unknown> = { recipient_email: 'a@b.co' }) =>
  composio().execute('GMAIL_SEND_EMAIL', {
    userId: 'usr_1',
    connectedAccountId: 'ca_1',
    arguments: args,
  });

describe('the Composio client', () => {
  it('is made once per process, without asking npm for a newer SDK', async () => {
    await run();
    await run();
    await composio().listTools(['gmail']);
    expect(made).toEqual([{ apiKey: 'ck_test_key', disableVersionCheck: true }]);
  });

  it('runs an action without fetching its description every time, and never retries a run', async () => {
    const first = await run({ recipient_email: 'a@b.co', subject: 'Hi' });
    await run({ recipient_email: 'a@b.co', subject: 'Again' });
    expect(first).toEqual({ successful: true, data: { id: 'msg_1' }, error: null });
    // Asked once, then kept; the SDK's own execute (which fetches it each time) is not used.
    expect(toolFetches).toEqual(['GMAIL_SEND_EMAIL']);
    expect(sdkExecutes).toEqual([]);
    expect(executes).toHaveLength(2);
    expect(executes[0]).toEqual({
      slug: 'GMAIL_SEND_EMAIL',
      body: {
        user_id: 'usr_1',
        connected_account_id: 'ca_1',
        arguments: { recipient_email: 'a@b.co', subject: 'Hi' },
        version: 'latest',
      },
      options: { maxRetries: 0 },
    });
  });

  it("uses the app's listing when it is kept: no description asked at all", async () => {
    await toolkitTools('gmail');
    await run();
    expect(toolFetches).toEqual([]);
    expect(executes).toHaveLength(1);
  });

  it('sends an empty file input as no input, as the SDK does', async () => {
    await run({ recipient_email: 'a@b.co', attachment: '' });
    expect(executes[0]!.body.arguments).toEqual({ recipient_email: 'a@b.co' });
    expect(
      withoutEmptyFiles(
        { attachment: null, subject: '' },
        GMAIL_SEND.inputParameters as Record<string, unknown>,
      ),
    ).toEqual({ subject: '' });
  });
});
