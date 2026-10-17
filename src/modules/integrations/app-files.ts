// Files an app action gives back as a link to Composio's temporary storage, fetched here so the
// agent gets the file itself, never the link. On 17 October 2026 Patch asked GitHub for a file of
// the founder's pull request (GITHUB_GET_RAW_REPOSITORY_CONTENT). Composio answered with a signed
// link to its file storage (`{ name, mimetype, s3url }`, the `s3url` a Cloudflare R2 address valid
// for an hour) instead of the file. Patch tried to download it with curl, which asked the founder
// twice with a card whose title was that long signed address; he denied neither, so Patch reviewed
// without the file and guessed. Composio's own SDK downloads such files in its `execute`, which we
// don't use (composio.ts calls Composio's endpoint directly).
//
// So before an answer is shaped (app-results.ts), every such link is replaced: by the file's text,
// cut to fit with a plain note; by a note for a binary file; or by a plain note that the file could
// not be fetched. Only Composio's own storage is fetched: https, its host, no redirect, 10 seconds,
// 1 MB at most. The link itself is never logged (it is a key to the file for an hour).
// docs/backend-report.md, "Apps through Composio".
import { logger } from '../../shared/logger.ts';

/** Composio's account at Cloudflare R2, where its temporary files are (seen 17 October 2026). */
const COMPOSIO_R2_ACCOUNT = '4d4f16c61d89ec64e760039c4ec50717';
const R2_HOST = `${COMPOSIO_R2_ACCOUNT}.r2.cloudflarestorage.com`;

/** The most read of one file. A larger file is cut, and the note says so. */
export const FILE_MAX_BYTES = 1_000_000;
/** How long one file may take to arrive. */
export const FILE_TIMEOUT_MS = 10_000;
/**
 * The most of one file's text sent to the agent, in characters of JSON: with the rest of the answer
 * it stays under app-results.ts's MAX_RESULT_CHARS, so the text is not cut a second time.
 */
export const FILE_MAX_CHARS = 20_000;
/** Files fetched for one answer; more are named as not fetched. */
export const MAX_FILES = 5;

/**
 * A link to Composio's temporary file storage: https, on Composio's R2 account (a bucket's own host,
 * `<bucket>.<account>.r2.cloudflarestorage.com`, or the account's), with no user, password or port.
 */
export function isComposioFileUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  if (host === R2_HOST) return true;
  const dot = host.indexOf('.');
  return dot > 0 && /^[a-z0-9-]+$/.test(host.slice(0, dot)) && host.slice(dot + 1) === R2_HOST;
}

export interface FetchedFile {
  bytes: Buffer;
  /** The file was larger than FILE_MAX_BYTES: `bytes` is its start. */
  cut: boolean;
  mimeType?: string;
}

/** Fetches one file. Swappable for tests. */
export type AppFileFetcher = (url: string, signal: AbortSignal) => Promise<FetchedFile>;

/**
 * One GET, no redirect followed (a link that sends elsewhere is not Composio's file), at most
 * FILE_MAX_BYTES read. Throws on anything but a 200. Never puts the address in an error.
 */
export const fetchFile: AppFileFetcher = async (url, signal) => {
  const res = await fetch(url, { redirect: 'manual', signal });
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`status ${res.status}`);
  }
  const mimeType = res.headers.get('content-type') ?? undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  let cut = false;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = FILE_MAX_BYTES - size;
      if (value.byteLength > room) {
        chunks.push(Buffer.from(value.subarray(0, room)));
        size += room;
        cut = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(Buffer.from(value));
      size += value.byteLength;
    }
  }
  return { bytes: Buffer.concat(chunks, size), cut, ...(mimeType ? { mimeType } : {}) };
};

let fetcher: AppFileFetcher = fetchFile;

/** Tests: replace the download of Composio's files. */
export function setAppFileFetcher(fake: AppFileFetcher | undefined): void {
  fetcher = fake ?? fetchFile;
}

/**
 * The file's text, or null when it is not text (a NUL byte near the start, or not UTF-8). A file cut
 * by the size limit may end inside a character: up to 3 bytes are dropped for that.
 */
export function textOf(file: FetchedFile): string | null {
  if (file.bytes.subarray(0, 8000).includes(0)) return null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let drop = 0; drop <= (file.cut ? 3 : 0); drop++) {
    try {
      return decoder.decode(file.bytes.subarray(0, file.bytes.length - drop));
    } catch {
      // try again with one byte less (only for a cut file)
    }
  }
  return null;
}

const jsonSize = (s: string) => JSON.stringify(s).length;

/**
 * The text cut at the end of a line to FILE_MAX_CHARS characters of JSON, and a note saying which
 * lines are shown when anything was left out (by this cut or by the size limit of the download).
 */
export function fitText(
  text: string,
  downloadCut: boolean,
  maxChars = FILE_MAX_CHARS,
): { content: string; note?: string } {
  const lines = text.split('\n');
  const total = text.endsWith('\n') ? lines.length - 1 : lines.length;
  if (jsonSize(text) <= maxChars && !downloadCut) return { content: text };
  let used = 2;
  let shown = 0;
  for (const line of lines) {
    const size = jsonSize(`${line}\n`) - 2;
    if (used + size > maxChars) break;
    used += size;
    shown++;
  }
  let content = lines.slice(0, shown).join('\n');
  // The last line of a cut download may be incomplete: it is not counted as shown.
  if (downloadCut && shown >= total && shown > 1) {
    shown = total - 1;
    content = lines.slice(0, shown).join('\n');
  }
  const of = downloadCut ? 'the file is larger than 1 MB, so the rest was not read' : `of ${total}`;
  const after =
    'so say nothing about it as if you had. For the rest, ask for that part, or read the file with git.';
  // One line longer than the room: its start only.
  if (shown === 0)
    return {
      content: text.slice(0, Math.floor(maxChars / 2)),
      note: `Cut to fit: only the start of line 1 is shown (${of}). The rest was not read, ${after}`,
    };
  return {
    content,
    note: `Cut to fit: only lines 1 to ${shown} are shown (${of}). Nothing after line ${shown} was read, ${after}`,
  };
}

const NOT_FETCHED =
  "The file couldn't be fetched, so its content is not here (there is no link to it either). Try the " +
  "action again, or get the file another way (a repository's code: clone it with git). Until then, " +
  'say plainly that you could not read it, and claim nothing about what it holds.';
const TOO_MANY = `Not fetched: this answer had more than ${MAX_FILES} files. Ask for fewer at a time.`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** A file reference in Composio's shape: an object whose `s3url` is a link to its storage. */
const isFileRef = (v: unknown): v is Record<string, unknown> & { s3url: string } =>
  isRecord(v) && typeof v.s3url === 'string' && isComposioFileUrl(v.s3url);

type Outcome =
  | { kind: 'text'; content: string; note?: string }
  | { kind: 'binary'; size: number; mimeType?: string }
  | { kind: 'failed'; note: string };

/** Counts the files of one answer, so no more than MAX_FILES are fetched. */
interface Budget {
  left: number;
  action: string;
}

async function fetchOne(url: string, mimetype: unknown, budget: Budget): Promise<Outcome> {
  if (budget.left <= 0) return { kind: 'failed', note: TOO_MANY };
  budget.left--;
  try {
    const file = await fetcher(url, AbortSignal.timeout(FILE_TIMEOUT_MS));
    const text = textOf(file);
    const mimeType = typeof mimetype === 'string' && mimetype ? mimetype : file.mimeType;
    if (text === null)
      return { kind: 'binary', size: file.bytes.length, ...(mimeType ? { mimeType } : {}) };
    return { kind: 'text', ...fitText(text, file.cut) };
  } catch (err) {
    // The host only: the address is a key to the file for an hour.
    logger().warn(
      { action: budget.action, host: new URL(url).hostname, err: String(err) },
      'app file could not be fetched',
    );
    return { kind: 'failed', note: NOT_FETCHED };
  }
}

const binaryNote = (o: Extract<Outcome, { kind: 'binary' }>) =>
  `A binary file (${o.mimeType ?? 'not text'}, ${o.size.toLocaleString('en')} bytes): its content is not shown.`;

async function walk(value: unknown, budget: Budget): Promise<unknown> {
  if (isFileRef(value)) {
    const { s3url, ...rest } = value;
    const o = await fetchOne(s3url, value.mimetype, budget);
    // What else the reference holds (its name, its type), without any other link to the storage.
    const kept = (await walk(rest, budget)) as Record<string, unknown>;
    if (o.kind === 'text')
      return { ...kept, content: o.content, ...(o.note ? { note: o.note } : {}) };
    if (o.kind === 'binary') return { ...kept, size_bytes: o.size, note: binaryNote(o) };
    return { ...kept, note: o.note };
  }
  if (typeof value === 'string' && isComposioFileUrl(value)) {
    const o = await fetchOne(value, undefined, budget);
    if (o.kind === 'text') return o.note ? `${o.content}\n[${o.note}]` : o.content;
    return o.kind === 'binary' ? binaryNote(o) : o.note;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) out.push(await walk(v, budget));
    return out;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await walk(v, budget);
    return out;
  }
  return value;
}

/** Whether the answer holds a link to Composio's storage anywhere (most answers don't). */
function holdsFileLink(value: unknown): boolean {
  if (typeof value === 'string') return isComposioFileUrl(value);
  if (Array.isArray(value)) return value.some(holdsFileLink);
  if (isRecord(value)) return Object.values(value).some(holdsFileLink);
  return false;
}

/** Every link to Composio's storage replaced by the plain note, nothing fetched. */
function withoutLinks(value: unknown): unknown {
  if (isFileRef(value)) {
    const { s3url: _link, ...rest } = value;
    return { ...(withoutLinks(rest) as Record<string, unknown>), note: NOT_FETCHED };
  }
  if (typeof value === 'string') return isComposioFileUrl(value) ? NOT_FETCHED : value;
  if (Array.isArray(value)) return value.map(withoutLinks);
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutLinks(v)]));
  return value;
}

/**
 * An app action's answer with every link to Composio's temporary storage replaced by what it points
 * to (see the top of this file). An answer without such a link is returned as it is. Never throws:
 * it runs after the action did, and whatever goes wrong leaves notes in place of the links.
 */
export async function inlineAppFiles(action: string, data: unknown): Promise<unknown> {
  try {
    if (!holdsFileLink(data)) return data;
    return await walk(data, { left: MAX_FILES, action });
  } catch (err) {
    logger().error({ action, err: String(err) }, 'app files could not be inlined');
    return withoutLinks(data);
  }
}
