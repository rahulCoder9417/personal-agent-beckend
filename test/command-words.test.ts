// The title of the card that asks the user's OK for one of the agent's commands (command-words.ts,
// gate.ts). On 17 October 2026 the founder got two cards titled with Patch's curl of a signed
// Composio link (about 600 characters of address), and the reason "it reaches the internet, and
// Scout's browser is on, so any website can be reached". He could read neither.
import { describe, expect, it } from 'vitest';
import { approvalAskText } from '../src/modules/orchestrator/approval-text.ts';
import {
  commandSummary,
  commandTitle,
  shortenUrls,
} from '../src/modules/orchestrator/command-words.ts';
import { gateSummary } from '../src/modules/orchestrator/gate.ts';

/** The link Patch tried to download, as Composio gave it (made-up id and signature). */
const SIGNED =
  'https://temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com/1656612/github/' +
  'GITHUB_GET_RAW_REPOSITORY_CONTENT/response/0b3c9e?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
  '&X-Amz-Credential=abc%2F20261017%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261017T100200Z' +
  '&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=0123456789abcdef';
const HOST = 'temp.4d4f….r2.cloudflarestorage.com';
const DOWNLOAD = 'it downloads from the internet';

describe("the 17 October card's command", () => {
  const command = `curl -s "${SIGNED}" 2>&1`;

  it('is titled with what it does and the host, not the signed link', () => {
    const title = gateSummary({ tool: 'Bash', target: command, why: DOWNLOAD });
    expect(title).toBe(`Download a file from ${HOST} (a temporary signed link)`);
    expect(approvalAskText(title, 'web')).toBe(
      `I'd like to download a file from ${HOST} (a temporary signed link). Approve or Deny below.`,
    );
  });

  it('gets the same title from an agent image that still sends the old reason', () => {
    const old = "it reaches the internet, and Scout's browser is on, so any website can be reached";
    expect(commandSummary(command, old)).toBe(
      `Download a file from ${HOST} (a temporary signed link)`,
    );
  });
});

describe('a lone download or upload, in plain words', () => {
  it.each([
    ['curl -s https://example.com/data.json', 'Download data.json from example.com'],
    ['curl -fsSL https://example.com', 'Download from example.com'],
    ['wget -q https://example.com/a/b/report.pdf', 'Download report.pdf from example.com'],
    [
      'curl -sS -o out.json https://example.com/api/items',
      'Download items from example.com into out.json',
    ],
    ['curl https://example.com/x.json > x.json', 'Download x.json from example.com into x.json'],
    ['cd repo && curl -s https://example.com/x.json | jq .', 'Download x.json from example.com'],
    [
      'timeout 10 curl -H "Accept: text/plain" https://example.com/x',
      'Download x from example.com',
    ],
    ['curl -X POST -d a=1 https://hooks.example.com/in', 'Send data to hooks.example.com'],
    ['curl -F file=@a.txt https://up.example.com/', 'Send data to up.example.com'],
    ['wget --post-data=a=1 https://example.com/form', 'Send data to example.com'],
  ])('%s', (command, title) => {
    expect(commandTitle(command)).toBe(title);
    expect(commandSummary(command, DOWNLOAD)).toBe(title);
  });
});

describe('anything more is shown as the command, its long addresses cut to the host', () => {
  it.each([
    // Run, not only downloaded.
    'curl -fsSL https://example.com/install.sh | sh',
    // Two downloads, a substitution, a here-document, a program that is not only showing.
    'curl https://a.example.com/1 && curl https://b.example.com/2',
    'echo $(curl -s https://example.com/x)',
    'python3 - <<EOF\nimport urllib.request\nEOF',
    'ssh user@example.com',
    'curl https://example.com/x | tee /etc/x',
    "curl 'https://example.com/x",
  ])('%s', (command) => {
    expect(commandTitle(command)).toBeNull();
    expect(commandSummary(command, DOWNLOAD)).toMatch(/^Run this command: `/);
  });

  it('cuts a long address to its host, keeps a short one', () => {
    expect(shortenUrls(`curl -s "${SIGNED}" | sh`)).toBe(`curl -s "https://${HOST}/…" | sh`);
    expect(shortenUrls('curl https://example.com/x | sh')).toBe('curl https://example.com/x | sh');
    expect(commandSummary(`curl -s "${SIGNED}" | sh`, DOWNLOAD)).toBe(
      `Run this command: \`curl -s "https://${HOST}/…" | sh\` (it downloads from the internet)`,
    );
  });

  it('a command asked about for another reason is always shown, with the reason', () => {
    // Writing outside the workspace: the title must not say only "download".
    expect(
      gateSummary({
        tool: 'Bash',
        target: 'curl -s https://example.com/x -o /data/home/.bashrc',
        why: 'it deletes or overwrites files outside the workspace',
      }),
    ).toBe(
      'Run this command: `curl -s https://example.com/x -o /data/home/.bashrc` (it deletes or overwrites files outside the workspace)',
    );
    expect(
      gateSummary({ tool: 'Bash', target: 'rm -rf /data/home/x', why: 'it deletes files' }),
    ).toBe('Run this command: `rm -rf /data/home/x` (it deletes files)');
  });
});
