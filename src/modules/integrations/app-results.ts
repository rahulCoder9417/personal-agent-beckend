// What the agent gets back from an app action (run_app_action): no more than it needs. On 15
// October one Gmail fetch of 10 emails sent the agent their whole bodies and raw payloads (about 90
// thousand characters), because Composio's fetch returns them unless told not to. Every character
// sent back is read by the model again on each later round of the turn.
// docs/backend-report.md, "Apps through Composio".

/** The most an app's answer may be, in characters of JSON: about 8,500 tokens. */
export const MAX_RESULT_CHARS = 30_000;

/** At most this many emails are summarised, unless the agent asked for more (`max_results`). */
export const SUMMARISED_EMAILS = 10;

/** An email's snippet, at most this long. */
const SNIPPET_CHARS = 200;

const FETCH_EMAILS = 'GMAIL_FETCH_EMAILS';
const READ_ONE_EMAIL =
  'To read one email in full, run GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID with its message_id.';

/**
 * The agent's arguments with our defaults for the actions whose own defaults send far too much.
 * Gmail's fetch: no bodies and no raw payload (Composio's `verbose` and `include_payload` are true
 * by default), which also makes Composio about 75% faster. The agent can still ask for them.
 */
export function withResultDefaults(
  action: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (action.toUpperCase() !== FETCH_EMAILS) return args;
  return { verbose: false, include_payload: false, ...args };
}

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/** A time as Composio or Gmail gives it (ISO text, or Gmail's `internalDate` in milliseconds). */
function dateOf(v: unknown): string | undefined {
  if (typeof v === 'number' || (typeof v === 'string' && /^\d{12,14}$/.test(v))) {
    const d = new Date(Number(v));
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return text(v);
}

function header(email: Record<string, unknown>, name: string): string | undefined {
  const headers = (email.payload as { headers?: unknown } | undefined)?.headers;
  if (!Array.isArray(headers)) return undefined;
  const found = headers.find(
    (h) =>
      h &&
      typeof h === 'object' &&
      String((h as { name?: unknown }).name).toLowerCase() === name.toLowerCase(),
  ) as { value?: unknown } | undefined;
  return text(found?.value);
}

function cut(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** One email as the agent needs it to tell what came in: who, what, when, and a few words. */
export function summariseEmail(email: Record<string, unknown>): Record<string, unknown> {
  const preview = email.preview as { subject?: unknown; body?: unknown } | string | undefined;
  const previewBody = typeof preview === 'string' ? preview : preview?.body;
  const out: Record<string, unknown> = {
    id: text(email.messageId) ?? text(email.id),
    thread_id: text(email.threadId) ?? text(email.thread_id),
    from: text(email.sender) ?? text(email.from) ?? header(email, 'From'),
    to: text(email.to) ?? text(email.recipient) ?? header(email, 'To'),
    subject:
      text(email.subject) ??
      (typeof preview === 'object' ? text(preview?.subject) : undefined) ??
      header(email, 'Subject'),
    date:
      dateOf(email.messageTimestamp) ??
      dateOf(email.internalDate) ??
      dateOf(email.date) ??
      header(email, 'Date'),
    snippet: cut(
      text(email.snippet) ?? text(previewBody) ?? text(email.messageText),
      SNIPPET_CHARS,
    ),
    labels: Array.isArray(email.labelIds) ? email.labelIds : undefined,
    attachments:
      Array.isArray(email.attachmentList) && email.attachmentList.length > 0
        ? email.attachmentList.length
        : undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/**
 * Gmail's fetch, when no body was asked for: each email summarised (at most SUMMARISED_EMAILS, or
 * the `max_results` asked for), with the next page's token. Null when the answer is not the
 * shape Composio gives (it is then sent as it came, within the size limit).
 */
function summariseFetch(args: Record<string, unknown>, data: unknown): unknown {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.messages)) return null;
  const asked = typeof args.max_results === 'number' ? args.max_results : 0;
  const most = Math.max(SUMMARISED_EMAILS, asked);
  const emails = d.messages.filter((m): m is Record<string, unknown> =>
    Boolean(m && typeof m === 'object'),
  );
  const shown = emails.slice(0, most);
  const next = text(d.nextPageToken) ?? text(d.next_page_token);
  return {
    messages: shown.map(summariseEmail),
    ...(next ? { next_page_token: next } : {}),
    ...(typeof d.resultSizeEstimate === 'number'
      ? { result_size_estimate: d.resultSizeEstimate }
      : {}),
    note:
      `${shown.length < emails.length ? `Showing ${shown.length} of ${emails.length} emails. ` : ''}` +
      `Sender, subject, date and a snippet of each. ${READ_ONE_EMAIL}`,
  };
}

/** Whether the agent asked Gmail's fetch for the bodies. */
const wantsBodies = (args: Record<string, unknown>) =>
  args.verbose === true || args.include_payload === true;

/** Strings longer than `max` cut, lists longer than `items` cut, at every depth. */
function shrink(value: unknown, max: number, items: number): unknown {
  if (typeof value === 'string')
    return value.length <= max
      ? value
      : `${value.slice(0, max)}… [cut: ${value.length.toLocaleString('en')} characters in all]`;
  if (Array.isArray(value)) {
    const kept = value.slice(0, items).map((v) => shrink(v, max, items));
    if (value.length > items) kept.push(`… [cut: ${value.length} items in all]`);
    return kept;
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shrink(v, max, items)]),
    );
  return value;
}

const sizeOf = (value: unknown) => JSON.stringify(value ?? null).length;

/**
 * An answer cut to fit MAX_RESULT_CHARS: long texts first (bodies, encoded files), then long
 * lists, then whatever is left as text. Returns null when it fits as it is.
 */
export function fitResult(data: unknown, maxChars = MAX_RESULT_CHARS): unknown {
  if (sizeOf(data) <= maxChars) return null;
  for (const [max, items] of [
    [4000, Infinity],
    [2000, Infinity],
    [1000, 100],
    [500, 50],
    [300, 20],
    [200, 10],
    [100, 5],
  ] as const) {
    const smaller = shrink(data, max, items);
    if (sizeOf(smaller) <= maxChars) return smaller;
  }
  return `${JSON.stringify(data).slice(0, maxChars)}… [cut]`;
}

/**
 * What run_app_action sends back for an action's answer, and a note when it was trimmed:
 * - Gmail's fetch without bodies asked for: a summary of each email;
 * - any answer longer than MAX_RESULT_CHARS: cut to fit, with how to ask for less.
 */
export function shapeResult(
  action: string,
  args: Record<string, unknown>,
  data: unknown,
): { data: unknown; note?: string } {
  const isFetch = action.toUpperCase() === FETCH_EMAILS;
  const shaped = isFetch && !wantsBodies(args) ? (summariseFetch(args, data) ?? data) : data;
  const fitted = fitResult(shaped);
  if (fitted === null) return { data: shaped };
  const size = sizeOf(shaped).toLocaleString('en');
  return {
    data: fitted,
    note:
      `The app's answer was ${size} characters, too long to send whole, so long texts and lists ` +
      'were cut. To get what you need, ask for less: narrower filters or search words, a smaller ' +
      `max_results, or one item by its id.${action.toUpperCase().startsWith('GMAIL_') ? ` ${READ_ONE_EMAIL}` : ''}`,
  };
}
