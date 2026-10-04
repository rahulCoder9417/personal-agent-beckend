// Scout's page reader (HLD 5.1): fetches ONE public web page from the api and returns its text.
// The address comes from an agent, so it is treated as hostile: only public addresses are ever
// connected to, at every redirect, and the connection is pinned to the address that was checked.
import { lookup } from 'node:dns/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { config } from '../../shared/config.ts';
import { isInternalHostName } from './mcp-servers.ts';

export const PAGE_TIMEOUT_MS = 15_000;
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PAGE_MAX_REDIRECTS = 5;
export const PAGE_MAX_CHARS = 20_000;
/** Links returned with a page (and so the most one page can add to what may be read next). */
export const PAGE_MAX_LINKS = 50;
const USER_AGENT = 'TextcrewBot/1.0 (reads one page for a user)';

/** A refusal or failure the agent should see as it is. */
export class PageError extends Error {
  constructor(
    message: string,
    /** `refused`: the address is not allowed (worth a line in the server log). */
    readonly kind: 'refused' | 'failed' = 'failed',
  ) {
    super(message);
  }
}

const NOT_PUBLIC = 'read_page only opens public web pages; this address is not allowed.';
const refused = () => new PageError(NOT_PUBLIC, 'refused');

// --- which addresses are public ---------------------------------------------------------------

/** IPv4 that is not the public internet: private, loopback, link-local, carrier NAT, reserved. */
const NON_PUBLIC_V4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, the cloud metadata address
  ['172.16.0.0', 12], // private (Docker's networks are here)
  ['192.0.0.0', 24], // protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // old 6to4 relays
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const)
  NON_PUBLIC_V4.addSubnet(net, prefix, 'ipv4');

/** IPv6: only global unicast (2000::/3) is public… */
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');
/** …and inside it these are not: they tunnel to an IPv4 address or are set aside. */
const SPECIAL_V6 = new BlockList();
for (const [net, prefix] of [
  ['2001::', 23], // protocol assignments (Teredo is 2001::/32)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4: carries an IPv4 address
  ['3fff::', 20], // documentation
] as const)
  SPECIAL_V6.addSubnet(net, prefix, 'ipv6');

/**
 * Is this an address on the public internet? Anything that isn't a plain IPv4 or IPv6 address is
 * not. IPv4 written inside IPv6 (`::ffff:10.0.0.1`, NAT64) is outside 2000::/3, so it is refused.
 */
export function isPublicAddress(address: string): boolean {
  if (address.includes('%')) return false; // a scoped (link-local) address
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC_V4.check(address, 'ipv4');
  if (family === 6) return GLOBAL_V6.check(address, 'ipv6') && !SPECIAL_V6.check(address, 'ipv6');
  return false;
}

// --- which URLs may be asked for --------------------------------------------------------------

const PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

/** The host of a URL without the brackets of an IPv6 literal or a trailing dot, lower-cased. */
function hostOf(u: URL): string {
  return u.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/** The platform's own hosts, from the settings: never read through read_page. */
function platformHosts(): Set<string> {
  const c = config();
  const hosts = new Set<string>();
  for (const raw of [c.PUBLIC_API_URL, c.INTERNAL_API_URL, c.LITELLM_URL, c.VM_MANAGER_URL]) {
    try {
      hosts.add(hostOf(new URL(raw)));
    } catch {
      // not a URL: nothing to refuse
    }
  }
  return hosts;
}

/**
 * The first check, on the URL alone: http or https, ports 80 and 443, no credentials, and a host
 * that is either a public address or a name that could be a public site. Throws PageError.
 */
export function checkPageUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new PageError(
      'That is not a web address. Give a full one, like https://example.com/page',
    );
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new PageError('read_page only opens http and https addresses.', 'refused');
  if (u.username || u.password)
    throw new PageError(
      'read_page does not open addresses with a user name or password.',
      'refused',
    );
  if ((u.port || PORTS[u.protocol]) !== PORTS[u.protocol])
    throw new PageError('read_page only opens the standard web ports (80 and 443).', 'refused');
  const host = hostOf(u);
  if (!host) throw refused();
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw refused();
  } else if (isInternalHostName(host) || platformHosts().has(host)) {
    throw refused();
  }
  u.hash = ''; // never sent to a site
  return u;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Host name → its addresses. Swappable for tests. */
export type HostResolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
const dnsResolver: HostResolver = (host) => lookup(host, { all: true, verbatim: true });
let resolver: HostResolver = dnsResolver;
export function setPageResolver(fake: HostResolver | undefined): void {
  resolver = fake ?? dnsResolver;
}

/**
 * The second check, on what the host resolves to: refused if ANY of its addresses is not public
 * (a name that answers with one public and one private address is not trusted). Returns the
 * address to connect to: an IPv4 one when there is one.
 */
export async function resolvePublicAddress(u: URL): Promise<ResolvedAddress> {
  const host = hostOf(u);
  const literal = isIP(host);
  if (literal) {
    if (!isPublicAddress(host)) throw refused();
    return { address: host, family: literal as 4 | 6 };
  }
  let found: Array<{ address: string; family: number }>;
  try {
    found = await resolver(host);
  } catch {
    throw new PageError(`The site ${host} could not be found.`);
  }
  if (!found.length) throw new PageError(`The site ${host} could not be found.`);
  if (!found.every((a) => isPublicAddress(a.address))) throw refused();
  const pick = found.find((a) => a.family === 4) ?? found[0]!;
  return { address: pick.address, family: isIP(pick.address) as 4 | 6 };
}

// --- the request ------------------------------------------------------------------------------

export interface PageRequest {
  url: URL;
  /** The checked address. The connection goes here and nowhere else. */
  target: ResolvedAddress;
  signal: AbortSignal;
}

export interface PageResponse {
  status: number;
  /** Lower-case names. */
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Drops the connection (the body is not needed, or enough was read). */
  close(): void;
}

/** One GET, no redirects. Swappable for tests. */
export type PageTransport = (req: PageRequest) => Promise<PageResponse>;

const header = (res: IncomingMessage, name: string): string | undefined => {
  const v = res.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * The real request. `lookup` is pinned: whatever the host name resolves to at this moment, the
 * socket connects to the address that passed the check (no DNS rebinding). The host name is still
 * what TLS verifies the certificate against. `agent: false`: a connection of its own every time.
 */
export const pinnedTransport: PageTransport = ({ url, target, signal }) =>
  new Promise((resolve, reject) => {
    const pinned: LookupFunction = (_host, options, cb) => {
      if (options.all) cb(null, [target]);
      else cb(null, target.address, target.family);
    };
    const req = (url.protocol === 'https:' ? https : http).request(
      {
        protocol: url.protocol,
        hostname: hostOf(url),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        lookup: pinned,
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept:
            'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1',
          'accept-encoding': 'identity',
        },
      },
      (res) => {
        // A server that compresses although it was asked not to.
        const encoding = (header(res, 'content-encoding') ?? '').toLowerCase();
        const unpack =
          encoding === 'gzip' || encoding === 'x-gzip'
            ? createGunzip()
            : encoding === 'br'
              ? createBrotliDecompress()
              : encoding === 'deflate'
                ? createInflate()
                : null;
        let body: Readable = res;
        if (unpack) {
          res.on('error', (err) => unpack.destroy(err));
          body = res.pipe(unpack);
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: {
            location: header(res, 'location'),
            'content-type': header(res, 'content-type'),
          },
          body,
          close: () => {
            res.destroy();
            unpack?.destroy();
          },
        });
      },
    );
    req.on('error', reject);
    req.end();
  });

let transport: PageTransport = pinnedTransport;
export function setPageTransport(fake: PageTransport | undefined): void {
  transport = fake ?? pinnedTransport;
}

let timeoutMs = PAGE_TIMEOUT_MS;
/** Tests lower the time limit. `undefined` restores it. */
export function setPageTimeoutMs(ms: number | undefined): void {
  timeoutMs = ms ?? PAGE_TIMEOUT_MS;
}

// --- readable text ----------------------------------------------------------------------------

const TEXT_TYPE =
  /^(text\/[a-z0-9.+-]+|application\/([a-z0-9.+-]+\+)?(json|xml)|application\/xhtml\+xml)$/;
const HTML_TYPE = /^(text\/html|application\/xhtml\+xml)$/;
/** Elements whose content is not page text. */
const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object']);
/** Elements that start a new line. */
const BREAKS = new Set(
  (
    'address article aside blockquote br dd div dl dt figcaption footer form h1 h2 h3 h4 h5 h6 ' +
    'header hr li main nav ol p pre section table tr ul'
  ).split(' '),
);
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
};
const TAG_NAME = /[a-zA-Z][a-zA-Z0-9]*/y;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
    const code =
      name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return whole;
    return code < 32 && code !== 9 && code !== 10 ? ' ' : String.fromCodePoint(code);
  });
}

/** Spaces collapsed, lines trimmed, at most one empty line in a row. */
function tidy(text: string): string {
  return text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface RawLink {
  /** The `href` as the page wrote it (may be relative). */
  href: string;
  text: string;
}

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
/** More than are returned: some are dropped later (not http, the same address twice). */
const RAW_LINKS_MAX = PAGE_MAX_LINKS * 4;

/**
 * A page's text: markup, scripts and styles removed, block elements turned into line breaks.
 * Also the page's first links (`<a href>`), with their text. One pass over the input with no
 * backtracking, so a hostile page can't make it slow.
 */
export function htmlToText(html: string): {
  title: string | null;
  text: string;
  links: RawLink[];
} {
  const out: string[] = [];
  const links: RawLink[] = [];
  /** The link being read: its address, and where its text starts in `out`. */
  let open: { href: string; from: number } | null = null;
  const closeLink = () => {
    if (!open) return;
    const text = tidy(decodeEntities(out.slice(open.from).join(''))).replace(/\n+/g, ' ');
    links.push({ href: open.href, text: text.slice(0, 80) });
    open = null;
  };
  let title: string | null = null;
  // A line break in the page's source is only a space, except inside <pre> (code samples).
  let pre = 0;
  const text = (part: string) => out.push(pre > 0 ? part : part.replace(/\s+/g, ' '));
  let i = 0;
  // Once there is no `>` ahead there never will be: looked for at most once more, not per `<`.
  let noMoreGt = false;
  const nextGt = (from: number): number => {
    if (noMoreGt) return -1;
    const at = html.indexOf('>', from);
    if (at < 0) noMoreGt = true;
    return at;
  };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      text(html.slice(i));
      break;
    }
    text(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const closing = html[lt + 1] === '/';
    TAG_NAME.lastIndex = lt + (closing ? 2 : 1);
    const m = TAG_NAME.exec(html);
    if (!m) {
      // `<!doctype …>` and `<?xml …?>` are dropped; a bare `<` is text.
      const gt = html[lt + 1] === '!' || html[lt + 1] === '?' ? nextGt(lt + 1) : -1;
      if (gt >= 0) i = gt + 1;
      else {
        out.push('<');
        i = lt + 1;
      }
      continue;
    }
    const gt = nextGt(lt + 1);
    if (gt < 0) break; // an unfinished tag at the end
    const name = m[0].toLowerCase();
    i = gt + 1;
    if (name === 'a') {
      // A link ends at `</a>` or where the next one starts.
      closeLink();
      if (!closing && links.length < RAW_LINKS_MAX) {
        const h = HREF.exec(html.slice(lt, gt));
        const href = decodeEntities(h?.[1] ?? h?.[2] ?? h?.[3] ?? '').trim();
        if (href) open = { href, from: out.length };
      }
      continue;
    }
    if (name === 'pre') pre = closing ? Math.max(0, pre - 1) : pre + 1;
    if (closing) {
      if (BREAKS.has(name)) out.push('\n');
      continue;
    }
    if (SKIPPED.has(name) || name === 'title') {
      // Everything up to the closing tag is not page text.
      const close = new RegExp(`</${name}[\\s>/]`, 'gi');
      close.lastIndex = i;
      const end = close.exec(html);
      const inner = html.slice(i, end ? end.index : html.length);
      if (name === 'title' && title === null) title = tidy(decodeEntities(inner)).slice(0, 300);
      if (!end) break;
      const after = nextGt(end.index);
      i = after < 0 ? html.length : after + 1;
      continue;
    }
    if (BREAKS.has(name)) out.push('\n');
    else if (name === 'td' || name === 'th') out.push(' ');
  }
  closeLink();
  return { title: title || null, text: tidy(decodeEntities(out.join(''))), links };
}

// --- read_page --------------------------------------------------------------------------------

export interface PageLink {
  text: string;
  /** Absolute, http or https, without a fragment. */
  url: string;
}

export interface PageResult {
  /** The address the text came from (after redirects). */
  url: string;
  title: string | null;
  text: string;
  /** The page was longer than what is returned. */
  truncated: boolean;
  /** The page's first links (at most PAGE_MAX_LINKS), each address once. */
  links: PageLink[];
}

/** A page's links as full addresses: http and https only, no fragment, each one once. */
function pageLinks(raw: RawLink[], base: URL): PageLink[] {
  const seen = new Set<string>();
  const out: PageLink[] = [];
  for (const link of raw) {
    if (out.length >= PAGE_MAX_LINKS) break;
    let u: URL;
    try {
      u = new URL(link.href, base);
    } catch {
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    u.hash = '';
    const url = u.toString();
    if (url.length > 2000 || seen.has(url)) continue;
    seen.add(url);
    out.push({ text: link.text, url });
  }
  return out;
}

export interface ReadPageOptions {
  /**
   * Asked before a redirect is followed, after the address checks: may the page at `from` send
   * the reader on to `next`? False refuses the redirect. Default: every redirect that passes the
   * address checks is followed.
   */
  mayFollow?(next: URL, from: URL): boolean | Promise<boolean>;
}

/** Rejects when the deadline passes first. */
function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new PageError('The page took too long to answer.'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function readBody(res: PageResponse): Promise<{ bytes: Buffer; cut: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for await (const chunk of res.body) {
    const room = PAGE_MAX_BYTES - size;
    if (chunk.length > room) {
      chunks.push(chunk.subarray(0, room));
      cut = true;
      break;
    }
    chunks.push(chunk);
    size += chunk.length;
  }
  return { bytes: Buffer.concat(chunks), cut };
}

function decode(bytes: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*"?([a-z0-9._-]{1,40})/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Reads one public web page (HLD 5.1). Every hop, the first address and each redirect, goes
 * through both checks: the URL, then what its host resolves to. Limits: 15 s in total, 5
 * redirects, 2 MB, text types only, 20,000 characters returned. Throws PageError.
 */
export async function readPage(rawUrl: string, opts: ReadPageOptions = {}): Promise<PageResult> {
  const deadline = AbortSignal.timeout(timeoutMs);
  let url = checkPageUrl(rawUrl.trim());
  for (let hop = 0; ; hop++) {
    const target = await within(resolvePublicAddress(url), deadline);
    let res: PageResponse;
    try {
      res = await within(transport({ url, target, signal: deadline }), deadline);
    } catch (err) {
      if (err instanceof PageError) throw err;
      throw new PageError(
        deadline.aborted ? 'The page took too long to answer.' : 'The page could not be reached.',
      );
    }
    try {
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        if (hop >= PAGE_MAX_REDIRECTS) throw new PageError('The page redirects too many times.');
        let next: string;
        try {
          next = new URL(res.headers.location, url).toString();
        } catch {
          throw new PageError('The page redirects to something that is not a web address.');
        }
        const to = checkPageUrl(next);
        if (opts.mayFollow && !(await opts.mayFollow(to, url)))
          throw new PageError(
            'The page redirects to another address, and that address has not been seen ' +
              '(it is not from your user, a search result or a link on a page you read), ' +
              'so it was not followed.',
            'refused',
          );
        url = to;
        continue;
      }
      if (res.status < 200 || res.status >= 300)
        throw new PageError(`The page answered with status ${res.status}.`);
      const contentType = (res.headers['content-type'] ?? '').toLowerCase();
      const type = contentType.split(';')[0]!.trim();
      if (!TEXT_TYPE.test(type))
        throw new PageError(
          `That address is not a text page (${type || 'no content type'}); read_page reads HTML, plain text, JSON and XML.`,
        );
      let body: { bytes: Buffer; cut: boolean };
      try {
        body = await within(readBody(res), deadline);
      } catch (err) {
        if (err instanceof PageError) throw err;
        throw new PageError(
          deadline.aborted ? 'The page took too long to answer.' : 'The page could not be read.',
        );
      }
      const raw = decode(body.bytes, contentType);
      const page = HTML_TYPE.test(type)
        ? htmlToText(raw)
        : { title: null, text: raw.trim(), links: [] };
      return {
        url: url.toString(),
        title: page.title,
        text: page.text.slice(0, PAGE_MAX_CHARS),
        truncated: body.cut || page.text.length > PAGE_MAX_CHARS,
        links: pageLinks(page.links, url),
      };
    } finally {
      res.close();
    }
  }
}

/** A page address for the activity log: no query string, no fragment (they can hold secrets). */
export function pageAddressForLog(raw: string): string {
  try {
    const u = new URL(raw.trim());
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300);
  } catch {
    return '(not a web address)';
  }
}
