// The title of the card that asks the user's OK for one of the agent's own commands (gate.ts), in
// plain words. On 17 October 2026 the founder got two cards whose title was "Run this command:
// `curl -s "https://temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com/1656612/github/…
// ?X-Amz-Algorithm=…&X-Amz-Signature=…"`": he could not tell what he was asked. Now a command that
// only downloads or sends something says so with the address's host ("Download a file from
// temp.4d4f….r2.cloudflarestorage.com (a temporary signed link)"), and any other command is shown
// with its long addresses cut to their host. The exact command is still on the card, under the
// title (the approval's details), and it is what is approved.
//
// The title is made here, from the command itself, not from words the container sends: what the
// user reads can't say something the command doesn't do. When the command is anything more than one
// download or upload (a pipe into another program, a second command, a substitution), it is shown.

/**
 * A label of a host that looks like an id (longer than this, with digits in it) is cut:
 * "4d4f16c61d89ec64e760039c4ec50717" → "4d4f…", while "cloudflarestorage" stays.
 */
const LONG_LABEL = 16;
/** An address longer than this is cut to its host inside a command shown on the card. */
const LONG_URL = 50;
/** The most of a command shown in the title. */
const COMMAND_MAX = 300;

const oneLine = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** An address's host, each long label cut. */
function shortHost(u: URL): string {
  return u.hostname
    .split('.')
    .map((l) => (l.length > LONG_LABEL && /\d.*\d.*\d/.test(l) ? `${l.slice(0, 4)}…` : l))
    .join('.');
}

/** A link that carries a signature or an expiry: a key to one file for a while. */
const isSigned = (u: URL) =>
  [...u.searchParams.keys()].some((k) =>
    /signature|^sig$|^token$|^x-amz-|^x-goog-|^expires$/i.test(k),
  );

function lastName(u: URL): string | null {
  const last = u.pathname.split('/').filter(Boolean).at(-1);
  if (!last) return null;
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // keep it as written
  }
  return name.length > 30 ? `${name.slice(0, 29)}…` : name;
}

const parse = (raw: string): URL | null => {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
};

/** Every long http(s) address in a command cut to its host: `https://temp.4d4f….r2.cloudflarestorage.com/…`. */
export function shortenUrls(command: string): string {
  return command.replace(/https?:\/\/[^\s'"`<>|;)]+/gi, (raw) => {
    if (raw.length <= LONG_URL) return raw;
    const u = parse(raw);
    return u ? `${u.protocol}//${shortHost(u)}/…` : raw;
  });
}

// --- reading a command ----------------------------------------------------------------------------

/**
 * The command as simple commands, each a list of words with the quotes taken off. Null when it
 * holds what this does not read: a substitution, a here-document, an unclosed quote.
 */
function simpleCommands(command: string): string[][] | null {
  if (/\$\(|`|<</.test(command)) return null;
  const out: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (/[;&|()\n]/.test(c)) {
      // `2>&1` and `&>file`: the & belongs to a redirection, not a separator.
      if (c === '&' && (/\d*>$/.test(word) || command[i + 1] === '>')) {
        word += c;
        inWord = true;
        continue;
      }
      endCommand();
    } else if (/\s/.test(c)) endWord();
    else {
      word += c;
      inWord = true;
    }
  }
  if (quote) return null;
  endCommand();
  return out;
}

const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'nice', 'timeout', 'stdbuf', 'command']);
/** Programs that only show what they are given: piping a download into them changes nothing. */
const SHOWS = new Set([
  'cd',
  'pushd',
  'popd',
  'echo',
  'printf',
  'head',
  'tail',
  'cat',
  'jq',
  'grep',
  'wc',
  'sort',
  'uniq',
  'less',
  'more',
  'true',
  'cut',
  'tr',
  'column',
]);

/** The program and its arguments, past `VAR=value` and wrappers such as `timeout 5`; redirections out. */
function programOf(words: string[]): { program: string; args: string[]; writes: string[] } {
  const args: string[] = [];
  const writes: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const r = /^(\d*|&)(>>?|<)(.*)$/.exec(w);
    if (r) {
      const target = r[3] || words[++i] || '';
      if (r[2] !== '<' && !target.startsWith('&') && target !== '/dev/null') writes.push(target);
      continue;
    }
    args.push(w);
  }
  let i = 0;
  while (i < args.length) {
    const w = args[i]!;
    const name = w.split('/').at(-1)!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
    else if (WRAPPERS.has(name)) {
      i++;
      while (i < args.length && (args[i]!.startsWith('-') || /^[0-9.]+[smhd]?$/.test(args[i]!)))
        i++;
    } else return { program: name, args: args.slice(i + 1), writes };
  }
  return { program: '', args: [], writes };
}

const SENDS =
  /^--(data|data-[a-z]+|form|form-string|upload-file|json|post-data|post-file|body-data|body-file)(=|$)/;
const CURL_SENDS_SHORT = /^-[a-zA-Z]*[dFT]/;
const SEND_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** curl's and wget's options that take a value (so the value is not read as the address). */
const TAKES_VALUE: Record<string, RegExp> = {
  curl: /^-[oHXdFTAeuUwrmxEbcKyYz]$/,
  wget: /^-[oOTtweUaPQ]$/,
};
const LONG_TAKES_VALUE =
  /^--(output|output-document|header|request|method|data[a-z-]*|form[a-z-]*|upload-file|user-agent|referer|user|proxy|max-time|connect-timeout|retry|cookie|cookie-jar|config|json|post-data|post-file|body-data|body-file|timeout|tries|wait)$/;

function sends(program: string, args: string[]): boolean {
  return args.some((a, i) => {
    if (SENDS.test(a) || (program === 'curl' && CURL_SENDS_SHORT.test(a))) return true;
    const method = /^--(request|method)=/.test(a)
      ? a.split('=')[1]
      : ['-X', '--request', '--method'].includes(a)
        ? args[i + 1]
        : '';
    return SEND_METHODS.has((method ?? '').toUpperCase());
  });
}

/** The file a download is saved into, when the command names one. */
function savedInto(program: string, args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const long = /^--(output|output-document)=(.+)$/.exec(a);
    if (long) return long[2]!;
    const flag = program === 'curl' ? ['-o', '--output'] : ['-O', '--output-document'];
    if (flag.includes(a)) return args[i + 1] ?? null;
  }
  return null;
}

/** The addresses among a download's arguments (option values left out). */
function urlsOf(program: string, args: string[]): URL[] {
  const out: URL[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('-')) {
      if (TAKES_VALUE[program]!.test(a) || LONG_TAKES_VALUE.test(a)) i++;
      continue;
    }
    const u = parse(a);
    if (u) out.push(u);
  }
  return out;
}

/** What a download or upload does, or null when the command is more than that. */
function transferTitle(program: string, args: string[], writes: string[]): string | null {
  const urls = urlsOf(program, args);
  if (urls.length !== 1) return null;
  const u = urls[0]!;
  const host = shortHost(u);
  if (sends(program, args)) return `Send data to ${host}`;
  const into = savedInto(program, args) ?? writes[0];
  const where = into && into !== '-' ? ` into ${oneLine(into, 80)}` : '';
  if (isSigned(u)) return `Download a file from ${host} (a temporary signed link)${where}`;
  const name = lastName(u);
  return name ? `Download ${name} from ${host}${where}` : `Download from ${host}${where}`;
}

/**
 * The title for a command, in plain words: what a lone download or upload does, with the address
 * cut to its host; otherwise the command itself with its long addresses cut. Null: nothing plainer
 * than the command could be said (the caller shows the command).
 */
export function commandTitle(command: string): string | null {
  const commands = simpleCommands(command);
  if (!commands) return null;
  let title: string | null = null;
  for (const words of commands) {
    const { program, args, writes } = programOf(words);
    if (!program) continue;
    if (program === 'curl' || program === 'wget') {
      if (title) return null; // a second download: show the command
      title = transferTitle(program, args, writes);
      if (!title) return null;
    } else if (!SHOWS.has(program) || writes.length) return null;
  }
  return title;
}

/** Whether the gate's reason is one of its network reasons (the title then says the same). */
export const isNetworkReason = (why: string) =>
  /^it (downloads from|sends data over|connects to|reaches) the internet/.test(why);

/**
 * The card's title for a command: plain words for a lone download or upload, else the command with
 * its long addresses cut to their host, and the reason. COMMAND_MAX characters of the command at most.
 */
export function commandSummary(command: string, why: string): string {
  const title = isNetworkReason(why) ? commandTitle(command) : null;
  if (title) return title;
  const reason = why ? ` (${oneLine(why, 120)})` : '';
  return `Run this command: \`${oneLine(shortenUrls(command), COMMAND_MAX)}\`${reason}`;
}
