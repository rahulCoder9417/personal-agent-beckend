// Files an app action gives back as a link to Composio's temporary storage (app-files.ts). On 17
// October 2026 GitHub's raw-file action answered Patch with such a link instead of the file; Patch
// tried curl on it (two cards titled with the signed address), then reviewed without the file and
// guessed. Now the backend fetches the file and the agent gets its text, or a plain note, never the
// link.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeQueues } from '../src/modules/events/queues.ts';
import {
  FILE_MAX_BYTES,
  FILE_MAX_CHARS,
  fetchFile,
  fitText,
  inlineAppFiles,
  isComposioFileUrl,
  MAX_FILES,
  setAppFileFetcher,
  type FetchedFile,
} from '../src/modules/integrations/app-files.ts';
import { MAX_RESULT_CHARS, shapeResult } from '../src/modules/integrations/app-results.ts';
import type { ComposioTool } from '../src/modules/integrations/composio.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeComposio, installFakeVm, mcpCall } from './fakes.ts';
import { chatUser } from './helpers.ts';

process.env.COMPOSIO_AUTH_CONFIGS = JSON.stringify({ github: 'ac_github' });
resetConfig();

const RAW = 'GITHUB_GET_RAW_REPOSITORY_CONTENT';
/** The link's shape as Composio sent it on 17 October (made-up id and signature). */
const link = (id = 'f1') =>
  'https://temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com/1656612/github/' +
  `${RAW}/response/${id}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=abc%2F20261017%2Fauto` +
  '%2Fs3%2Faws4_request&X-Amz-Date=20261017T100200Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host' +
  '&X-Amz-Signature=0123456789abcdef';

const CHAT_CLIENT = [
  'from functools import lru_cache',
  '',
  'from app.config import get_settings',
  '',
  '',
  '@lru_cache',
  'def chat_client():',
  '    settings = get_settings()',
  '    return OpenAI(api_key=settings.openai_api_key.get_secret_value())',
  '',
].join('\n');

const asFile = (text: string, mimeType = 'text/plain'): FetchedFile => ({
  bytes: Buffer.from(text),
  cut: false,
  mimeType,
});

/** The URLs the fake fetcher was asked for. */
let asked: string[] = [];
const serve = (files: Record<string, FetchedFile | Error>) =>
  setAppFileFetcher(async (url) => {
    asked.push(url);
    const id = /\/response\/([^?]+)/.exec(url)?.[1] ?? '';
    const file = files[id];
    if (!file) throw new Error('status 404');
    if (file instanceof Error) throw file;
    return file;
  });

beforeEach(() => {
  asked = [];
});
afterEach(() => setAppFileFetcher(undefined));

describe("Composio's storage links", () => {
  it('are told from every other address', () => {
    expect(isComposioFileUrl(link())).toBe(true);
    expect(
      isComposioFileUrl('https://4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com/temp/x'),
    ).toBe(true);
    for (const other of [
      'http://temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com/x',
      'https://temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com:8443/x',
      'https://u:p@temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com/x',
      'https://temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com.evil.test/x',
      'https://a.b.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com/x',
      'https://temp.0000000000000000000000000000beef.r2.cloudflarestorage.com/x',
      'https://raw.githubusercontent.com/acme/web/main/README.md',
      'not a link',
    ])
      expect(isComposioFileUrl(other), other).toBe(false);
  });
});

describe('a file given as a link (inlineAppFiles)', () => {
  it('becomes its text, and the link is gone', async () => {
    serve({ f1: asFile(CHAT_CLIENT) });
    const data = await inlineAppFiles(RAW, {
      content: { name: 'chat_client.py', mimetype: 'text/x-python', s3url: link() },
    });
    expect(asked).toEqual([link()]);
    expect(data).toEqual({
      content: { name: 'chat_client.py', mimetype: 'text/x-python', content: CHAT_CLIENT },
    });
    expect(JSON.stringify(data)).not.toMatch(/cloudflarestorage|X-Amz/);
  });

  it('a link given as a plain value becomes the text too', async () => {
    serve({ f1: asFile('hello\n') });
    expect(await inlineAppFiles(RAW, { download: link() })).toEqual({ download: 'hello\n' });
  });

  it('a long file is cut at a line, with a note saying which lines are shown', async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}: ${'x'.repeat(20)}`);
    serve({ f1: asFile(lines.join('\n')) });
    const data = (await inlineAppFiles(RAW, {
      content: { name: 'big.py', mimetype: 'text/plain', s3url: link() },
    })) as { content: { content: string; note: string } };
    const shown = data.content.content.split('\n');
    expect(shown.at(-1)).toBe(lines[shown.length - 1]);
    expect(JSON.stringify(data.content.content).length).toBeLessThanOrEqual(FILE_MAX_CHARS);
    expect(data.content.note).toBe(
      `Cut to fit: only lines 1 to ${shown.length} are shown (of 3000). Nothing after line ` +
        `${shown.length} was read, so say nothing about it as if you had. For the rest, ask for ` +
        'that part, or read the file with git.',
    );
    // Shaped as the agent gets it: not cut a second time.
    const shaped = shapeResult(RAW, {}, data);
    expect(shaped.note).toBeUndefined();
    expect(JSON.stringify(shaped.data).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  });

  it('a file larger than the download limit says the rest was not read', () => {
    const fitted = fitText('a\nb\nc\npartial li', true);
    expect(fitted.content).toBe('a\nb\nc');
    expect(fitted.note).toMatch(
      /^Cut to fit: only lines 1 to 3 are shown \(the file is larger than 1 MB, so the rest was not read\)/,
    );
    expect(fitText('short', false)).toEqual({ content: 'short' });
  });

  it("one that can't be fetched becomes a plain note, with no link", async () => {
    serve({ f1: new Error('status 403') });
    const data = (await inlineAppFiles(RAW, {
      content: { name: 'chat_client.py', mimetype: 'text/plain', s3url: link() },
    })) as { content: Record<string, unknown> };
    expect(data.content).toEqual({
      name: 'chat_client.py',
      mimetype: 'text/plain',
      note: expect.stringMatching(/^The file couldn't be fetched, so its content is not here/),
    });
    expect(String(data.content.note)).toContain('claim nothing about what it holds');
    expect(JSON.stringify(data)).not.toMatch(/cloudflarestorage|X-Amz|https:/);
  });

  it('a binary file is named, not shown', async () => {
    serve({ f1: { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]), cut: false } });
    const data = await inlineAppFiles(RAW, {
      content: { name: 'logo.png', mimetype: 'image/png', s3url: link() },
    });
    expect(data).toEqual({
      content: {
        name: 'logo.png',
        mimetype: 'image/png',
        size_bytes: 7,
        note: 'A binary file (image/png, 7 bytes): its content is not shown.',
      },
    });
  });

  it(`fetches at most ${MAX_FILES} files for one answer`, async () => {
    const files = Object.fromEntries(
      Array.from({ length: MAX_FILES + 2 }, (_, i) => [`f${i}`, asFile(`file ${i}`)]),
    );
    serve(files);
    const data = (await inlineAppFiles(
      RAW,
      Object.keys(files).map((id) => ({ s3url: link(id) })),
    )) as Array<Record<string, unknown>>;
    expect(asked).toHaveLength(MAX_FILES);
    expect(data.slice(0, MAX_FILES).map((d) => d.content)).toEqual(
      Array.from({ length: MAX_FILES }, (_, i) => `file ${i}`),
    );
    expect(data.at(-1)).toEqual({
      note: expect.stringMatching(/^Not fetched: this answer had more/),
    });
  });

  it('leaves every other answer as it is, and fetches nothing', async () => {
    serve({});
    const answer = {
      name: 'README.md',
      download_url: 'https://raw.githubusercontent.com/acme/web/main/README.md',
      s3url: 'https://example.com/not-composio',
    };
    expect(await inlineAppFiles(RAW, answer)).toBe(answer);
    expect(asked).toEqual([]);
  });
});

describe('the download (fetchFile)', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/file') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('print("hi")\n');
      } else if (req.url === '/moved') {
        res.writeHead(302, { location: '/file' });
        res.end();
      } else if (req.url === '/huge') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('y'.repeat(FILE_MAX_BYTES + 5000));
      } else {
        res.writeHead(403);
        res.end('no');
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  const signal = () => AbortSignal.timeout(5000);

  it('reads the file', async () => {
    const file = await fetchFile(`${base}/file`, signal());
    expect(file).toEqual({
      bytes: Buffer.from('print("hi")\n'),
      cut: false,
      mimeType: 'text/plain',
    });
  });

  it('follows no redirect and takes no error page', async () => {
    await expect(fetchFile(`${base}/moved`, signal())).rejects.toThrow('status 302');
    await expect(fetchFile(`${base}/expired`, signal())).rejects.toThrow('status 403');
  });

  it(`reads no more than ${FILE_MAX_BYTES.toLocaleString('en')} bytes`, async () => {
    const file = await fetchFile(`${base}/huge`, signal());
    expect(file.cut).toBe(true);
    expect(file.bytes.length).toBe(FILE_MAX_BYTES);
  });
});

describe('run_app_action', () => {
  const GITHUB_TOOLS: ComposioTool[] = [
    {
      slug: RAW,
      toolkit: 'github',
      name: 'Get raw repository content',
      description: 'Gets the raw content of a file in a repository.',
      tags: ['readOnlyHint'],
      inputParameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          path: { type: 'string' },
          ref: { type: 'string' },
        },
        required: ['owner', 'repo', 'path'],
      },
    },
  ];

  beforeAll(() => wireModules());
  afterAll(closeQueues);

  it("sends the agent the file's text, not Composio's link", async () => {
    const vm = installFakeVm();
    const fake = await installFakeComposio();
    fake.state.tools.set('github', GITHUB_TOOLS);
    fake.state.executeData.set(RAW, {
      content: { name: 'chat_client.py', mimetype: 'text/plain', s3url: link() },
    });
    serve({ f1: asFile(CHAT_CLIENT) });
    const user = await chatUser({ plan: 'max', credits: 500 });
    await db()
      .insert(connections)
      .values({
        id: newId('con'),
        userId: user.id,
        app: 'github',
        composioAccountId: `ca_${randomUUID()}`,
        status: 'active',
      });
    await ensureSandbox(user.id);
    const res = await mcpCall(vm.tokens.get(user.id)!, 'run_app_action', {
      action: RAW,
      arguments: { owner: 'rahulcoder9417', repo: 'Code-Smith', path: 'app/llm/chat_client.py' },
    });
    expect(res.isError, res.text).toBe(false);
    const body = JSON.parse(res.text) as { data: { content: Record<string, unknown> } };
    expect(body.data.content).toEqual({
      name: 'chat_client.py',
      mimetype: 'text/plain',
      content: CHAT_CLIENT,
    });
    expect(res.text).not.toMatch(/cloudflarestorage|X-Amz/);
  });
});
