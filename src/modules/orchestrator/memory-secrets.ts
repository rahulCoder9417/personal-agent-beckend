// The check that keeps obvious secrets out of the shared memory (HLD 0.9). It looks at the shape
// of the text only. It is a safety net, not a guarantee: a short password in a plain sentence
// passes, and some harmless text is refused.

export type SecretKind = 'key' | 'password' | 'card' | 'link';

/** Keys and tokens with a shape of their own. */
const KEY_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI, Anthropic, LiteLLM
  /\b[spr]k_(?:live|test)_[A-Za-z0-9]{10,}/, // Stripe
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, // a Telegram bot token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // a JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
];

/**
 * A secret word and then its value: "password is hunter2", "PIN: 4821", "API key = abc",
 * "the password for the wifi is hunter2". "Their password manager is Bitwarden" is not one: the
 * word must be followed by is, was, a colon or an equals sign, or by a short "for the …" first.
 */
const SECRET_WORD =
  /\b(?:password|passcode|passphrase|passwd|pwd|pin(?:\s+code)?|secret(?:\s+key)?|api[\s_-]?key|access[\s_-]?key|private[\s_-]?key|(?:access[\s_-]|auth[\s_-]|api[\s_-]|bearer[\s_-]|refresh[\s_-])?token|otp|one[\s-]time\s+code|cvv|cvc)\b(?:\s+(?:for|to|of|on)\s+(?:\S+\s+){1,4}?)?\s*(?:(?:is|was)\b|[:=])\s*\S/i;

const WEB_ADDRESS = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** A parameter of a web address that is named like a secret and has a value. */
const SECRET_PARAM =
  /[?&#](?:[\w.-]*[_.-])?(?:token|secret|password|passwd|pwd|signature|sig|apikey|key|auth|authorization|session|sessionid|sid)=[^&#\s]{6,}/i;
/** `https://name:password@host`. */
const ADDRESS_PASSWORD = /^https?:\/\/[^/\s@:]+:[^/\s@]+@/i;

/** Digits that may be a card number: 13 to 19 of them, single spaces or dashes allowed between. */
const CARD_DIGITS = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;

/**
 * A hash or a random key: 32 or more letters and digits in a row, with at least three of each.
 * No slash in the run, so a file path is not one; a long name with a digit or two is not one.
 */
const LONG_RUN = /[A-Za-z0-9_]{32,}/g;
const looksRandom = (run: string) =>
  run.replace(/\D/g, '').length >= 3 && run.replace(/[^A-Za-z]/g, '').length >= 3;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** The kind of secret the text looks like it holds, or null. Never returns the text itself. */
export function secretIn(text: string): SecretKind | null {
  if (KEY_SHAPES.some((re) => re.test(text))) return 'key';
  for (const address of text.match(WEB_ADDRESS) ?? [])
    if (ADDRESS_PASSWORD.test(address) || SECRET_PARAM.test(address)) return 'link';
  if (SECRET_WORD.test(text)) return 'password';
  for (const found of text.match(CARD_DIGITS) ?? [])
    if (luhn(found.replace(/\D/g, ''))) return 'card';
  // A web address may hold a long id (a shared document); what is left may not.
  for (const run of text.replace(WEB_ADDRESS, ' ').match(LONG_RUN) ?? [])
    if (looksRandom(run)) return 'key';
  return null;
}

const HIDDEN = '[hidden]';
/** A hash (a commit id, a checksum): long, but only hex digits. Not a secret, and worth reading. */
const HEX_ONLY = /^[0-9a-f]+$/i;
const ADDRESS_OR_LONG_RUN = new RegExp(`${WEB_ADDRESS.source}|${LONG_RUN.source}`, 'gi');

/**
 * The same text with what looks like a secret blanked out, for tools that print stored text (the
 * dev script). Keys and tokens with a known shape, web addresses that carry a password or a
 * token, the value after a secret word ("password is …": the rest of that line), card numbers,
 * and long random runs that are not a plain hash. Like `secretIn`, it is a safety net.
 */
export function hideSecrets(text: string): string {
  let out = text;
  for (const shape of KEY_SHAPES)
    out = out.replace(new RegExp(shape.source, `${shape.flags}g`), HIDDEN);
  out = out.replace(WEB_ADDRESS, (address) =>
    ADDRESS_PASSWORD.test(address) || SECRET_PARAM.test(address) ? HIDDEN : address,
  );
  out = out
    .split('\n')
    .map((line) => {
      const found = SECRET_WORD.exec(line);
      return found ? `${line.slice(0, found.index)}${HIDDEN}` : line;
    })
    .join('\n');
  out = out.replace(CARD_DIGITS, (digits) => (luhn(digits.replace(/\D/g, '')) ? HIDDEN : digits));
  // A web address may hold a long id (a shared document), so addresses are stepped over whole;
  // elsewhere a long random run is hidden.
  return out.replace(ADDRESS_OR_LONG_RUN, (found) =>
    /^https?:/i.test(found) || !looksRandom(found) || HEX_ONLY.test(found) ? found : HIDDEN,
  );
}

const WHAT: Record<SecretKind, string> = {
  key: 'an API key or a token',
  password: 'a password, a PIN or a code',
  card: 'a card number',
  link: 'a web address with a password or a token in it',
};

/** The kind of secret in plain words, for a refusal and for the activity log. */
export const secretName = (kind: SecretKind): string => WHAT[kind];

/** What the agent is told when a save is refused. It names the kind, never the text. */
export function secretRefusal(kind: SecretKind): string {
  return (
    `Not saved: this looks like it holds ${WHAT[kind]}. Memory never keeps passwords, keys, ` +
    'tokens, codes or card numbers. If the fact is worth keeping without the secret, save it ' +
    'again without it. Tell your user to keep secrets in a password manager.'
  );
}
