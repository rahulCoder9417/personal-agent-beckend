// Markdown → a plain text message.
//
// The agent writes Markdown and the web app renders it. A chat app (Telegram, WhatsApp, iMessage)
// shows a text as it was typed, so `**bold**`, `# Heading`, backticks and table pipes would all
// be visible there. This turns such a text into what a person would type in a text message. It is
// a safety net: the agent is told to write plain text for a chat app, and models write Markdown
// anyway.
//
// It is careful on purpose. A rule fires only where the text is clearly Markdown, and everything
// else is left exactly as it is: text with no Markdown comes out unchanged, byte for byte. Where
// Markdown and ordinary text look alike (`snake_case_name`, `2 * 3 * 4`, `2*3*4`, `*.ts`, a web
// address, a cron line), the text is left alone, even if a Markdown renderer would format it.
//
// Its output is plain text, so a second run changes nothing. The one exception is by design:
// code and backslash-escaped characters are kept as written (`\*` becomes `*`, a code block keeps
// a `# comment` line), and a second run would read those as Markdown. Nothing runs it twice: the
// saved message keeps the original text and the text is converted once, on the way out.
//
// Tables. A chat app has no columns and a phone screen is narrow, so a table becomes one line per
// row with no pipes:
//   - two columns: `first: second` for every row, the header row too. The first column is almost
//     always the name of the second ("Setting | Value", "Day | Plan"), and the header line shows
//     what the pairs are.
//   - three or more: every row is `Header: value; Header: value; …`. Each value keeps its
//     column's name, so a row still makes sense after it wraps. `; ` and not `, ` because a value
//     often holds a comma ("2,000", "Mon, Wed").
// No cell is ever dropped.

/** Marks around the number of a held piece: text that later rules must not touch. */
const OPEN = '\uE000';
const CLOSE = '\uE001';
const HELD = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');

/** A done item of a task list (`- [x] call the bank` → `- ✓ call the bank`). */
export const DONE_MARK = '✓';

/** Without one of these characters no rule can fire. */
const MAYBE_MARKDOWN = /[*_~`#[|>\\+-]/;

interface Line {
  text: string;
  /** The line break that followed it. */
  eol: string;
  /** Inside a code block: kept as written. */
  code: boolean;
}

// --- blocks ----------------------------------------------------------------------------------

/** `> ` in front of a quoted line. `>=`, `>text` and `>>>` are not quotes. */
const QUOTE_MARK = /^ {0,3}>(?: |\t|$)/;
/** The first line of a code block: three or more backticks or tildes, then the language. */
const FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const FENCE_END = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
/** `---`, `***`, `___`, with or without spaces between. */
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** A cron line that starts with a star (`* * * * *`, `*\/5 9 * * 1`): not a rule, not a list. */
const CRON = /^[ \t]*\*(?:\/\d+)?(?:[ \t]+[\d*][\d*/,-]*){3}[ \t]+\S/;
/** `# Heading`, up to six `#`. `#hashtag` and `#1` have no space, so they are not headings. */
const HEADING = /^ {0,3}#{1,6}[ \t]+(\S.*?)(?:[ \t]+#+)?[ \t]*$/;
/** `- item`, `* item`, `+ item`, with an optional task box. */
const BULLET = /^([ \t]*)([-*+])([ \t]+)(?:\[([ xX])\][ \t]+)?(?=\S)/;
/** `1. item` or `1) item`, with an optional task box. */
const NUMBERED = /^([ \t]*\d{1,9}[.)][ \t]+)\[([ xX])\][ \t]+(?=\S)/;
/** The line under a table's header: `|---|:--:|`. */
const TABLE_RULE = /^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)*[ \t]*:?-+:?[ \t]*\|?[ \t]*$/;

function splitLines(text: string): Line[] {
  const parts = text.split(/(\r\n|\n|\r)/);
  const lines: Line[] = [];
  for (let i = 0; i < parts.length; i += 2)
    lines.push({ text: parts[i]!, eol: parts[i + 1] ?? '', code: false });
  return lines;
}

/** Takes up to `max` quote marks off the front of a line. */
function unquote(text: string, max = Infinity): { rest: string; levels: number } {
  let rest = text;
  let levels = 0;
  while (levels < max) {
    const mark = QUOTE_MARK.exec(rest);
    if (!mark) break;
    rest = rest.slice(mark[0].length);
    levels++;
  }
  return { rest, levels };
}

/**
 * First pass: quote marks come off, and the fence lines of a code block are dropped. What is
 * inside a code block is marked as code. A block that is never closed runs to the end.
 */
function withoutQuotesAndFences(lines: Line[]): Line[] {
  const out: Line[] = [];
  let fence: { mark: string; quoteLevels: number } | null = null;
  for (const line of lines) {
    if (fence) {
      const text = unquote(line.text, fence.quoteLevels).rest;
      const end = FENCE_END.exec(text);
      if (end && end[1]![0] === fence.mark[0] && end[1]!.length >= fence.mark.length) fence = null;
      else out.push({ ...line, text, code: true });
      continue;
    }
    const { rest, levels } = unquote(line.text);
    const start = FENCE.exec(rest);
    // The language can't hold the fence's own character: "```code```" is code within a line.
    if (start && !start[2]!.includes(start[1]![0]!))
      fence = { mark: start[1]!, quoteLevels: levels };
    else out.push({ ...line, text: rest });
  }
  return out;
}

const isBlank = (line: Line | undefined) => !line || (!line.code && line.text.trim() === '');

function tableCells(row: string): string[] {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (/(?<!\\)\|$/.test(r)) r = r.slice(0, -1);
  return r.split(/(?<!\\)\|/).map((cell) => inline(cell.trim().replace(/\\\|/g, '|')));
}

const pair = (label: string, value: string) =>
  label && value ? `${label}${label.endsWith(':') ? '' : ':'} ${value}` : label || value;

/** A table that starts at line `i`: its rows as text lines (see the top of the file), or null. */
function tableAt(lines: Line[], i: number): { rows: Line[]; next: number } | null {
  const head = lines[i]!;
  const rule = lines[i + 1];
  if (!head.text.includes('|') || !rule || rule.code || !rule.text.includes('|')) return null;
  if (!TABLE_RULE.test(rule.text)) return null;
  const header = tableCells(head.text);
  const columns = rule.text.split('|').filter((c) => c.includes('-')).length;
  if (header.length !== columns) return null;

  const source: Array<{ line: Line; cells: string[] }> = [{ line: head, cells: header }];
  let next = i + 2;
  for (; next < lines.length; next++) {
    const line = lines[next]!;
    if (line.code || !line.text.includes('|') || line.text.trim() === '') break;
    source.push({ line, cells: tableCells(line.text) });
  }
  const labelled = header.length > 2 && source.length > 1;
  const rows: Line[] = [];
  for (const { line, cells } of labelled ? source.slice(1) : source) {
    const parts =
      header.length === 2
        ? [pair(cells[0] ?? '', cells[1] ?? ''), ...cells.slice(2)]
        : cells.map((value, k) => (labelled && value ? pair(header[k] ?? '', value) : value));
    const text = parts.filter(Boolean).join('; ');
    if (text) rows.push({ ...line, text });
  }
  return { rows, next };
}

/** One line that is not code and not part of a table. */
function plainLine(text: string): string {
  const heading = HEADING.exec(text);
  if (heading) return inline(heading[1]!);
  const bullet = BULLET.exec(text);
  if (bullet) {
    const [all, indent, , gap, box] = bullet;
    const done = box && box !== ' ' ? `${DONE_MARK} ` : '';
    return `${indent}-${gap}${done}${inline(text.slice(all.length))}`;
  }
  const numbered = NUMBERED.exec(text);
  if (numbered) {
    const done = numbered[2] !== ' ' ? `${DONE_MARK} ` : '';
    return `${numbered[1]}${done}${inline(text.slice(numbered[0].length))}`;
  }
  return inline(text);
}

// --- within a line ---------------------------------------------------------------------------

/** `\*` is a plain `*`. Only the characters Markdown reads; `C:\Users` and `\d+\.` stay. */
const ESCAPABLE = new Set([...'*_`#~|>$']);
/** `[text](address "title")` and `![alt](address)`. One level of brackets inside either part. */
const LINK =
  /(?:(?<![\p{L}\p{N}])(!))?\[((?:[^[\]]|\[[^[\]]*\])*)\]\(\s*(<[^<>]*>|(?:[^\s()<>]|\([^\s()]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/gu;
/** What a link may point at. `handlers[name](req)` is code, not a link. */
const ADDRESS = /^(?:https?:\/\/|mailto:|tel:|www\.|\/|#|\.{1,2}\/)/i;
const BARE_URL = /https?:\/\/[^\s<>]+/gi;
/** Characters at the end of an address that more likely end the sentence, or the emphasis. */
const URL_TAIL = /[*_~.,;:!?)\]}'"]+$/;
/** A marker in quotes is the character itself: "*", '__'. */
const QUOTED_MARK = /(["'])[*_~]{1,3}\1/g;
/**
 * Names that code writes with two underscores on each side. `__init__` is a method, not the word
 * "init" in bold. Any other `__word__` is bold, as Markdown says.
 */
const CODE_NAME = new RegExp(
  `(?<![A-Za-z0-9_])__(?:${[
    'init|main|name|file|all|doc|dict|class|str|repr|len|call|new|del|eq|ne|lt|le|gt|ge|hash|bool',
    'iter|next|enter|exit|getitem|setitem|delitem|getattr|setattr|contains|version|slots|future',
    'path|package|module|annotations|builtins|debug|import|pycache|proto|tests|mocks|snapshots',
    'fixtures|typename|FILE|LINE|DATE|TIME|func',
  ].join('|')})__(?![A-Za-z0-9_])`,
  'g',
);

// Emphasis. A pair of markers counts only where a word could start and end:
//   - before the first marker: the start, a space, an opening bracket or quote, a dash or `:;,!?`
//   - after the last marker: the end, a space, a closing bracket or quote, a dash or `:;,!?.%<`
//     (a dot only when no letter or digit follows it: `__init__.py` is a file name)
//   - the text inside starts and ends with something other than a space.
// So `snake_case_name`, `2*3*4`, `f(*args)*2`, `*.ts` and `src/**/*.ts` are not emphasis.
// A character that is not ASCII counts as a letter if it is one, except in scripts written
// without spaces between words (Chinese, Japanese, Korean, Thai), where emphasis sits right
// against the words around it.
const NOT_A_WORD =
  '[^\\x00-\\x7F\\p{L}\\p{N}\\p{M}]|[\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Hangul}\\p{sc=Thai}]';
const before = (others: string) => `(?<=^|[\\s(\\[{"'\\-:;,!?${others}]|${NOT_A_WORD})`;
const after = (others: string) =>
  `(?=$|[\\s)\\]}"'\\-:;,!?.%<${others}]|${NOT_A_WORD})(?!\\.[A-Za-z0-9])`;
/** A run of markers as long as the one that opened: where the emphasis has to end. */
const sameRun = (mark: string, run: string) => `(?<!${mark})\\k<${run}>(?!${mark})`;
const marked = (mark: string, others: string, run: string) =>
  `${before(others)}(?<!${mark})(?<${run}>${mark}{1,3})(?!${mark})(?=[^\\s.,;:!?)\\]}/\\\\])` +
  `((?:(?!${sameRun(mark, run)}).)+?)` +
  `(?<=[^\\s(\\[{/\\\\])${sameRun(mark, run)}${after(others)}`;
/** `*x*`, `**x**`, `***x***`, the same with `_`, and `~~x~~`. */
const EMPHASIS = new RegExp(
  [
    marked('\\*', '_~', 'stars'),
    marked('_', '*~', 'lines'),
    '(?<!~)~~(?!~)(?=\\S)(.+?)(?<=\\S)(?<!~)~~(?!~)',
  ].join('|'),
  'gu',
);

function emphasis(text: string): string {
  if (!/[*_~]/.test(text)) return text;
  return text.replace(
    EMPHASIS,
    (_all, _stars, starred?: string, _lines?: string, underlined?: string, struck?: string) =>
      emphasis(starred ?? underlined ?? struck ?? ''),
  );
}

/** Code within a line: the text between two equal runs of backticks, kept as written. */
function codeEnd(text: string, from: number, ticks: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== '`') continue;
    let j = i;
    while (text[j] === '`') j++;
    if (j - i === ticks) return i;
    i = j;
  }
  return -1;
}

const sameAddress = (a: string, b: string) => {
  const bare = (s: string) =>
    s
      .trim()
      .replace(/^(?:https?:\/\/|mailto:|tel:)/i, '')
      .replace(/\/$/, '')
      .toLowerCase();
  return bare(a) === bare(b);
};

function inline(source: string): string {
  if (!/[*_~`\\[]/.test(source)) return source;
  const held: string[] = [];
  const hold = (piece: string) => `${OPEN}${held.push(piece) - 1}${CLOSE}`;
  const release = (text: string) => {
    let out = text;
    for (let n = 0; n <= held.length && out.includes(OPEN); n++)
      out = out.replace(HELD, (_m, k: string) => held[Number(k)] ?? '');
    return out;
  };

  // Code and escaped characters first: nothing inside them is Markdown.
  let text = '';
  for (let i = 0; i < source.length;) {
    const ch = source[i]!;
    if (ch === '\\' && ESCAPABLE.has(source[i + 1] ?? '')) {
      text += hold(source[i + 1]!);
      i += 2;
    } else if (ch === '`') {
      let j = i;
      while (source[j] === '`') j++;
      const end = codeEnd(source, j, j - i);
      if (end < 0) {
        text += source.slice(i, j);
        i = j;
      } else {
        const code = source.slice(j, end);
        const padded = code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '';
        text += hold(padded ? code.slice(1, -1) : code);
        i = end + (j - i);
      }
    } else {
      text += ch;
      i++;
    }
  }

  // Links and images: "text (address)", or the address alone when the text says nothing more.
  const links = (t: string): string =>
    t.replace(LINK, (all: string, _image: string | undefined, label: string, target: string) => {
      const address = target.startsWith('<') ? target.slice(1, -1).trim() : target;
      if (!ADDRESS.test(release(address))) return all;
      const shown = hold(address.replace(/^(?:mailto|tel):/i, ''));
      const words = links(label).trim();
      return !words || sameAddress(release(words), release(address))
        ? shown
        : `${words} (${shown})`;
    });
  text = links(text);

  // An address is never read as emphasis, whatever `_` or `*` it holds.
  text = text.replace(BARE_URL, (url) => {
    const tail = URL_TAIL.exec(url)?.[0] ?? '';
    return hold(url.slice(0, url.length - tail.length)) + tail;
  });

  text = text.replace(QUOTED_MARK, hold).replace(CODE_NAME, hold);

  return release(emphasis(text));
}

// --- the whole text --------------------------------------------------------------------------

/**
 * Turns Markdown into a plain text message for a chat app. Text with no Markdown comes back
 * unchanged. See the top of this file for the rules it follows.
 */
export function markdownToPlainText(markdown: string): string {
  if (!MAYBE_MARKDOWN.test(markdown)) return markdown;
  // Our own marks in the text (never seen in practice): leave it alone.
  if (markdown.includes(OPEN) || markdown.includes(CLOSE)) return markdown;

  const lines = withoutQuotesAndFences(splitLines(markdown));
  const out: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.code || CRON.test(line.text)) {
      out.push(line);
      continue;
    }
    if (RULE.test(line.text)) {
      // The rule goes, and with it one of the two empty lines it stood between.
      if (isBlank(out.at(-1)) && i + 1 < lines.length && isBlank(lines[i + 1])) i++;
      else if (i + 1 === lines.length && out.length && isBlank(out.at(-1))) out.pop();
      continue;
    }
    const table = tableAt(lines, i);
    if (table) {
      out.push(...table.rows);
      i = table.next - 1;
      continue;
    }
    out.push({ ...line, text: plainLine(line.text) });
  }
  return out.map((line, k) => line.text + (k < out.length - 1 ? line.eol : '')).join('');
}
