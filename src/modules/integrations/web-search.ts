// Scout's web search (HLD 5.1): a small provider interface chosen by WEB_SEARCH_PROVIDER, with
// one provider built, the Brave Search API. It runs in the api; the key never enters a container.
import { config } from '../../shared/config.ts';
import { htmlToText } from './web-page.ts';

export const WEB_SEARCH_MAX_RESULTS = 10;
export const WEB_SEARCH_DEFAULT_RESULTS = 5;
const SEARCH_TIMEOUT_MS = 10_000;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProvider {
  readonly name: string;
  /** Up to `count` results. Throws when the provider can't answer. */
  search(query: string, count: number): Promise<WebSearchResult[]>;
}

/** Titles and snippets come with highlight markup (`<strong>`) and entities. */
const plain = (v: unknown, max: number): string =>
  typeof v === 'string' ? htmlToText(v).text.replace(/\s+/g, ' ').slice(0, max) : '';

/**
 * Brave Search API: `GET /res/v1/web/search?q=…&count=…` with the key in `X-Subscription-Token`.
 * The results are in `web.results[]` (`title`, `url`, `description`).
 */
export function braveSearch(apiKey: string, baseUrl: string): WebSearchProvider {
  return {
    name: 'brave',
    async search(query, count) {
      const u = new URL('/res/v1/web/search', baseUrl);
      u.searchParams.set('q', query);
      u.searchParams.set('count', String(count));
      const res = await fetch(u, {
        headers: { accept: 'application/json', 'x-subscription-token': apiKey },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`brave search answered ${res.status}`);
      }
      const body = (await res.json()) as { web?: { results?: unknown } };
      const rows = Array.isArray(body.web?.results) ? body.web.results : [];
      return rows
        .map((r) => {
          const row = (r ?? {}) as Record<string, unknown>;
          return {
            title: plain(row.title, 200),
            url: typeof row.url === 'string' ? row.url : '',
            snippet: plain(row.description, 500),
          };
        })
        .filter((r) => /^https?:\/\//i.test(r.url))
        .slice(0, count);
    },
  };
}

let override: WebSearchProvider | null | undefined;

/** Tests: a fake provider, or `null` for "not set up". `undefined` goes back to the settings. */
export function setWebSearchProvider(fake: WebSearchProvider | null | undefined): void {
  override = fake;
}

/** The provider the settings name, or null when its key isn't set (search isn't set up). */
export function webSearchProvider(): WebSearchProvider | null {
  if (override !== undefined) return override;
  const c = config();
  // One provider today. A second one is another case here and another value of the setting.
  if (c.WEB_SEARCH_PROVIDER === 'brave' && c.BRAVE_SEARCH_API_KEY)
    return braveSearch(c.BRAVE_SEARCH_API_KEY, c.BRAVE_SEARCH_API_URL);
  return null;
}
