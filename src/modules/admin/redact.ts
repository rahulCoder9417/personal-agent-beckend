// What the admin views show of jobs and audit entries, with every secret taken out (CLAUDE.md:
// no secrets in responses). Two rules: a field whose name says it holds a secret is replaced, and
// any text is scrubbed of things shaped like a secret (bearer tokens, keys with a known prefix,
// passwords in addresses, long random strings). Job data is stricter still: only ids are shown.

export const REDACTED = '[redacted]';

/** Field names that hold a secret, or a sign-in code (the logger hides `code` the same way). */
const SECRET_NAME =
  /secret|token|passw(or)?d|passwd|key|authori[sz]ation|cookie|credential|signature|bearer|session/i;
const SECRET_NAME_ALLOWED = new Set(['idempotencyKey']);

export function isSecretName(name: string): boolean {
  if (SECRET_NAME_ALLOWED.has(name)) return false;
  return SECRET_NAME.test(name) || name === 'code' || /Code$|_code$/.test(name);
}

const TEXT_RULES: Array<[RegExp, string]> = [
  // A user name and password in an address: scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REDACTED}@`],
  // Telegram's bot token in its API path, and the token on its own.
  [/\/bot\d+:[A-Za-z0-9_-]+/g, `/bot${REDACTED}`],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, REDACTED],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // A secret in a `name=value` or `name: value` pair (a query string, JSON, a header).
  [
    /\b((?:access_|refresh_|id_)?token|api[_-]?key|apikey|key|secret|password|passwd|signature)(["']?\s*[=:]\s*["']?)[^\s&"',;}]+/gi,
    `$1$2${REDACTED}`,
  ],
  // A sign-in code or a signature in a query string.
  [/([?&](?:code|sig|auth|state)=)[^\s&"']+/gi, `$1${REDACTED}`],
  // Keys with a known prefix (OpenAI/Anthropic sk-, Stripe/Clerk sk_, webhooks whsec_, GitHub,
  // Slack, AWS, Polar) and JSON web tokens.
  [/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9+/=_-]{8,}/g, REDACTED],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bpolar_[a-z]{2,4}_[A-Za-z0-9]{8,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
];

/**
 * Any long random-looking run (40+ characters with both letters and digits) is hidden too: our
 * own ids are shorter (30), so this catches keys and tokens of unknown shape.
 */
const LONG_RUN = /[A-Za-z0-9+/_=-]{40,}/g;

/** Text with everything shaped like a secret replaced by "[redacted]". */
export function scrubText(text: string): string {
  let out = text;
  for (const [re, by] of TEXT_RULES) out = out.replace(re, by);
  return out.replace(LONG_RUN, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? REDACTED : m));
}

/** The first line of an error, at most `max` characters, scrubbed. Null when there is none. */
export function firstLineScrubbed(text: string | null | undefined, max = 300): string | null {
  if (!text) return null;
  const line = text.split('\n', 1)[0]!.trim();
  const scrubbed = scrubText(line);
  return scrubbed.length > max ? `${scrubbed.slice(0, max - 1)}…` : scrubbed;
}

/**
 * A copy of `value` safe to show: secret-named fields replaced, every string scrubbed, nesting
 * kept (to a depth of 8; deeper is cut).
 */
export function redactDetails(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map((v) => redactDetails(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = isSecretName(k) ? REDACTED : redactDetails(v, depth + 1);
    return out;
  }
  return value;
}

/** A field that holds an id: `id`, `…Id`, `…Ids` or `…_id`. */
const ID_NAME = /^(id|[A-Za-z0-9]+Id|[A-Za-z0-9]+Ids|[a-z0-9_]+_ids?)$/;
/** What an id looks like. Anything else (text, an object) is not shown. */
const ID_VALUE = /^[A-Za-z0-9_.:@+-]{1,120}$/;
/** A field name worth listing as omitted. */
const PLAIN_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;

function idValue(v: unknown): string | number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && ID_VALUE.test(v)) return scrubText(v);
  return undefined;
}

export interface JobDataSummary {
  /** The ids in the job's data, and nothing else. */
  data: Record<string, string | number | string[]>;
  /** The names of the fields left out (never their values). */
  omittedKeys: string[];
  /** The user the job is for, when it says. */
  userId: string | null;
}

/** Ids only: never message text, buttons, tokens or keys. */
export function summarizeJobData(raw: unknown): JobDataSummary {
  const data: Record<string, string | number | string[]> = {};
  const omittedKeys: string[] = [];
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as object) : {};
  for (const [k, v] of Object.entries(src)) {
    let kept: string | number | string[] | undefined;
    if (ID_NAME.test(k) && !isSecretName(k)) {
      if (Array.isArray(v)) {
        const ids = v.map(idValue).filter((x): x is string | number => x !== undefined);
        if (ids.length === v.length && v.length <= 50) kept = ids.map(String);
      } else kept = idValue(v);
    }
    if (kept !== undefined) data[k] = kept;
    else if (PLAIN_NAME.test(k) && omittedKeys.length < 30) omittedKeys.push(k);
  }
  const userId = typeof data.userId === 'string' ? data.userId : null;
  return { data, omittedKeys, userId };
}
