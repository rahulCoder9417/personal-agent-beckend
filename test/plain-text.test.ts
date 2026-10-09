// Markdown → a plain text message for a chat app (spec round 3, part 2). The agent writes
// Markdown; Telegram, WhatsApp and iMessage show a text as typed. The function is careful: text
// that is not Markdown must come out exactly as it went in.
import { describe, expect, it } from 'vitest';
import { DONE_MARK, markdownToPlainText as plain } from '../src/modules/channels/plain-text.ts';
import { buttonsAsText } from '../src/modules/channels/text-buttons.ts';
import { NEW_CHAT_TEXT } from '../src/modules/orchestrator/chats.ts';
import { linkInstructionsText } from '../src/modules/orchestrator/process-message.ts';
import {
  connectAiText,
  outOfCreditsText,
  PLATFORM_FAULT_TEXT,
} from '../src/modules/orchestrator/turn.ts';

/** Each pair: Markdown in, plain text out. */
function check(pairs: Array<[string, string]>) {
  for (const [markdown, text] of pairs) expect(plain(markdown), markdown).toBe(text);
}

/** Texts that must come out exactly as they went in. */
function unchanged(texts: string[]) {
  for (const text of texts) expect(plain(text), text).toBe(text);
}

// Markdown → plain text, for the "twice is the same as once" check at the end.
const seen: Array<[string, string]> = [];
const pairs = (list: Array<[string, string]>) => {
  seen.push(...list);
  return list;
};

describe('emphasis', () => {
  it('bold, italic and strike lose their markers', () => {
    check(
      pairs([
        ['**bold**', 'bold'],
        ['__bold__', 'bold'],
        ['*italic*', 'italic'],
        ['_italic_', 'italic'],
        ['~~strike~~', 'strike'],
        ['***both***', 'both'],
        ['___both___', 'both'],
        ['This is **very** important, *really*.', 'This is very important, really.'],
        ['**Note:** read this', 'Note: read this'],
        ['**Note**: read this', 'Note: read this'],
        ['**bold** and **bold again**', 'bold and bold again'],
        ['**bold with *italic* inside**', 'bold with italic inside'],
        ['*italic with **bold** inside*', 'italic with bold inside'],
        ['_**both ways**_ and **_both ways_**', 'both ways and both ways'],
        ['He said *"wait"* and *(maybe)*.', 'He said "wait" and (maybe).'],
        ['Total: **$1,299.00** (was ~~$1,499~~)', 'Total: $1,299.00 (was $1,499)'],
        [
          'up by **50**% and "**quoted**" and (**in brackets**)',
          'up by 50% and "quoted" and (in brackets)',
        ],
        ['**3 * 4 = 12**', '3 * 4 = 12'],
        ['emoji 👍 **done** ✅ *ok*', 'emoji 👍 done ✅ ok'],
      ]),
    );
  });

  it('works in other languages, also where words have no spaces between them', () => {
    check(
      pairs([
        ['Привет, **мир**!', 'Привет, мир!'],
        ['नमस्ते **दुनिया**', 'नमस्ते दुनिया'],
        ['これは**重要**です。', 'これは重要です。'],
        ['中文**加粗**文本', '中文加粗文本'],
      ]),
    );
  });

  it('words with underscores, web addresses and arithmetic stay exactly as they are', () => {
    unchanged([
      'snake_case_name',
      'Set MAX_RETRIES_COUNT and _private_var in my_file_name.txt',
      'A_B_C and a_b and x_1 = y_2 * z_3',
      'शब्द_एक_दो and niño_x_y',
      'https://example.com/a_b_c/*path*?q=_x_&r=__y__',
      'See http://x.test/__init__ and https://en.wikipedia.org/wiki/Foo_(bar)_baz.',
      'first_last@example.com or @some_user_name on t.me/agent_bot?start=LINK_ABCD',
      '2 * 3 * 4',
      '2 * 3 * 4 = 24 and 2*3*4 and a*b*c',
      'x**2 + y**2 and 2 ** 3 ** 4 and 2**3**4',
      '(1+2)*3*(4+5)',
      'A line with a lone * star and another * star',
      'rated 5* by users and 4* by critics',
      'card ending **** 1234',
    ]);
  });

  it('code written without backticks is not read as emphasis', () => {
    unchanged([
      'def f(*args, **kwargs): pass',
      'f(*args)*2 and char *s = *p; int *a, *b;',
      '*.ts and src/**/*.ts and **/*.md, **/*.txt',
      'a/*b*/c and /*comment*/',
      'Replace "*" with "*" and \'_\' with \'_\'',
      'if __name__ == "__main__": and the __init__ method',
      '__init__.py and __tests__/x.test.ts and ~/__pycache__/',
      '_layout.tsx and _app.tsx',
      '~/bin and about ~20 minutes',
    ]);
  });

  it('a cron line is not a list and not a rule', () => {
    unchanged([
      '* * * * *',
      '*/5 * * * *',
      '0 9 * * 1',
      '* 9 * * MON',
      'Runs at */15 9-17 * * 1-5',
    ]);
  });

  it('a marker that could not be emphasis is left, and its neighbours are not mixed up', () => {
    check(
      pairs([
        // "**API**s": a letter follows, so it is left. It must not pair with the next "**".
        ['**API**s and "**quoted**"', '**API**s and "quoted"'],
        ['5 * 4 = *20*', '5 * 4 = 20'],
        ['2*3 is *big*', '2*3 is big'],
      ]),
    );
  });
});

describe('headings', () => {
  it('a heading becomes its text on its own line', () => {
    check(
      pairs([
        ['# Heading', 'Heading'],
        ['###### Small heading', 'Small heading'],
        ['## Closed heading ##', 'Closed heading'],
        ['## 1. **Setup** `now`', '1. Setup now'],
        [
          '# Title\n\nFirst line.\n\n## Part two\nSecond line.',
          'Title\n\nFirst line.\n\nPart two\nSecond line.',
        ],
      ]),
    );
  });

  it('a hash that is not a heading stays', () => {
    unchanged(['#hashtag and #1 priority', 'C# is fine', 'Issue #42 is open', '#', '# ']);
  });
});

describe('code', () => {
  it('code within a line loses its backticks and keeps its content', () => {
    check([
      ['Run `npm run build` first', 'Run npm run build first'],
      ['`a * b * c` and `snake_case` and `**kwargs**`', 'a * b * c and snake_case and **kwargs**'],
      ['``code with ` a backtick``', 'code with ` a backtick'],
      ['Use ```three``` on one line', 'Use three on one line'],
      ['**bold `x_y_z` end**', 'bold x_y_z end'],
    ]);
    unchanged(["it's a lone ` backtick"]);
  });

  it('a code block keeps its content and loses the fence lines and the language word', () => {
    check([
      ['```ts\nconst x = a * b * c; // **not bold**\n```', 'const x = a * b * c; // **not bold**'],
      [
        'Before\n```bash\n# install\nnpm i --save a_b_c\n```\nAfter',
        'Before\n# install\nnpm i --save a_b_c\nAfter',
      ],
      ['```\n| a | b |\n|---|---|\n- [x] kept\n```', '| a | b |\n|---|---|\n- [x] kept'],
      ['~~~python\nprint("hi")\n~~~', 'print("hi")'],
      ['````md\n```js\nlet a;\n```\n````', '```js\nlet a;\n```'],
      [
        '1. Run this:\n   ```sh\n   pnpm test\n   ```\n2. Done',
        '1. Run this:\n   pnpm test\n2. Done',
      ],
      ['```\ncode\n```\n', 'code\n'],
    ]);
  });

  it('a code block that is never closed runs to the end', () => {
    check([['Here:\n```js\nconst a = 1;\n**still code**', 'Here:\nconst a = 1;\n**still code**']]);
  });

  it('a quoted code block loses both the quote marks and the fence', () => {
    check([['> ```js\n> const a = 1;\n> ```\n> done', 'const a = 1;\ndone']]);
  });
});

describe('links and images', () => {
  it('a link becomes "text (address)", or the address alone when the text is the address', () => {
    check(
      pairs([
        ['[the docs](https://x.com/docs)', 'the docs (https://x.com/docs)'],
        ['[https://x.com](https://x.com)', 'https://x.com'],
        ['[x.com](https://x.com/)', 'https://x.com/'],
        ['[](https://x.com)', 'https://x.com'],
        [
          'See [the docs](https://x.com/a_b "A title"), then go.',
          'See the docs (https://x.com/a_b), then go.',
        ],
        [
          '[wiki](https://en.wikipedia.org/wiki/Foo_(bar))',
          'wiki (https://en.wikipedia.org/wiki/Foo_(bar))',
        ],
        [
          '[**bold text**](https://x.com) and **[bold link](https://y.com)**',
          'bold text (https://x.com) and bold link (https://y.com)',
        ],
        [
          '[mail me](mailto:a_b@x.com) or [a_b@x.com](mailto:a_b@x.com)',
          'mail me (a_b@x.com) or a_b@x.com',
        ],
        ['[Settings](/settings/ai) and [top](#top)', 'Settings (/settings/ai) and top (#top)'],
      ]),
    );
  });

  it('an image becomes "alt (address)"', () => {
    check(
      pairs([
        ['![a chart](https://img.test/a_b.png)', 'a chart (https://img.test/a_b.png)'],
        ['![](https://img.test/a.png)', 'https://img.test/a.png'],
        [
          '[![logo](https://img.test/l.png)](https://x.com)',
          'logo (https://img.test/l.png) (https://x.com)',
        ],
      ]),
    );
  });

  it('square brackets that are not a link stay', () => {
    unchanged([
      'handlers[name](req) and arr[0](x)',
      '[1] https://x.com/a_b and [x] marks the spot',
      '[ref link][1] and a footnote[^1]',
      '[empty]()',
      'See <https://x.com/a_b_c> and Rahul <rahul_k@x.com>',
    ]);
  });
});

describe('tables', () => {
  it('three or more columns: one line per row, each value after its column name', () => {
    check(
      pairs([
        [
          '| Plan | Price | Credits |\n|------|------:|:-------:|\n| Free | $0 | 100 |\n| **Pro** | $20 | 2,000 |',
          'Plan: Free; Price: $0; Credits: 100\nPlan: Pro; Price: $20; Credits: 2,000',
        ],
        // No pipes at the edges, an empty header cell, an empty value, an escaped pipe.
        ['a | b | c\n--|--|--\n1 | 2 | 3', 'a: 1; b: 2; c: 3'],
        [
          '| | Free | Pro |\n|---|---|---|\n| Price | $0 | $20 |\n| Apps | 3 | |',
          'Price; Free: $0; Pro: $20\nApps; Free: 3',
        ],
        [
          '| Tool | Does | Cost |\n|---|---|---|\n| `read_page` | Reads a \\| b | free |',
          'Tool: read_page; Does: Reads a | b; Cost: free',
        ],
        ['| A | B | C |\n|---|---|---|', 'A; B; C'],
      ]),
    );
  });

  it('two columns: "first: second" for every row, the header row too', () => {
    check(
      pairs([
        [
          '| Setting | Value |\n|---|---|\n| Model | Opus |\n| Effort | high |',
          'Setting: Value\nModel: Opus\nEffort: high',
        ],
        ['Day | Plan\n---|---\nMon | Gym', 'Day: Plan\nMon: Gym'],
      ]),
    );
  });

  it('one column: one line per row', () => {
    check(pairs([['| Name |\n|---|\n| Asha |\n| Ravi |', 'Name\nAsha\nRavi']]));
  });

  it('the text around a table stays where it was', () => {
    check(
      pairs([
        [
          'Here are the plans:\n\n| Plan | Price |\n|---|---|\n| Pro | $20 |\n\nPick **one**.',
          'Here are the plans:\n\nPlan: Price\nPro: $20\n\nPick one.',
        ],
      ]),
    );
  });

  it('a line with a pipe that is not a table stays', () => {
    unchanged([
      'a | b',
      'cat file | grep x | wc -l',
      // The line under the header has fewer columns: not a table.
      '| x | y |\n|---|\n| 1 | 2 |',
      'yes | no\nmaybe',
    ]);
  });
});

describe('quotes, rules and lists', () => {
  it('a quote loses its marker', () => {
    check(
      pairs([
        ['> quoted line', 'quoted line'],
        ['> first\n> second\n>\n> third', 'first\nsecond\n\nthird'],
        ['> > nested', 'nested'],
        ['> **Note**\n> - item\n> ## Head', 'Note\n- item\nHead'],
      ]),
    );
    unchanged(['>= 10 stays', '>>> print(1)', '>text', 'a > b and 5 > 3', '-> next']);
  });

  it('a rule line is dropped, with one of the empty lines around it', () => {
    check(
      pairs([
        ['above\n\n---\n\nbelow', 'above\n\nbelow'],
        ['above\n***\nbelow', 'above\nbelow'],
        ['above\n\n___\n\nbelow', 'above\n\nbelow'],
        ['above\n\n- - -\n\nbelow', 'above\n\nbelow'],
        ['---\n\nfirst\n\n---', 'first'],
      ]),
    );
    unchanged(['--', 'a -- b', '-- \nRahul', '+-----+-----+', '-----BEGIN-----']);
  });

  it('"* item" and "+ item" become "- item"; "- item" and numbered items stay', () => {
    check(
      pairs([
        ['* one\n* two', '- one\n- two'],
        ['+ one\n+ two', '- one\n- two'],
        ['* top\n  * nested\n    + deeper', '- top\n  - nested\n    - deeper'],
        ['* **Name:** Rahul\n* *Plan:* Pro', '- Name: Rahul\n- Plan: Pro'],
      ]),
    );
    unchanged([
      '- one\n- two\n  - nested',
      '1. first\n2. second\n10. tenth',
      '1) first\n2) second',
      '- 5 degrees outside',
      '+1 555 000 1111 and +91 98765 43210',
      '*',
      '- ',
    ]);
  });

  it(`a task list loses its box; a done item gets a ${DONE_MARK}`, () => {
    check(
      pairs([
        ['- [ ] call the bank', '- call the bank'],
        ['- [x] call the bank', `- ${DONE_MARK} call the bank`],
        ['* [X] call the bank', `- ${DONE_MARK} call the bank`],
        ['1. [x] first\n2. [ ] second', `1. ${DONE_MARK} first\n2. second`],
        ['- [x] `a_b`\n  - [ ] **nested**', `- ${DONE_MARK} a_b\n  - nested`],
      ]),
    );
    unchanged(['- [1] a citation', '[ ] no bullet', '- [maybe] later']);
  });
});

describe('backslash escapes', () => {
  it('an escaped Markdown character becomes the plain character', () => {
    check([
      ['\\*not italic\\*', '*not italic*'],
      ['snake\\_case\\_name', 'snake_case_name'],
      ['\\# not a heading', '# not a heading'],
      [
        '2 \\* 3 and \\$5 and a \\| b and \\`tick\\` and \\~x\\~ and \\> y',
        '2 * 3 and $5 and a | b and `tick` and ~x~ and > y',
      ],
      ['**bold \\* star**', 'bold * star'],
    ]);
  });

  it('a backslash before anything else stays', () => {
    unchanged([
      'C:\\Users\\rahul\\notes.txt',
      'the regex \\d+\\.\\d+',
      '\\(a + b\\) and \\[x\\]',
      'ends with \\',
    ]);
  });
});

describe('text that is not Markdown', () => {
  it('raw HTML is left alone', () => {
    unchanged(['<b>bold</b> and <br> and &amp; and <a href="https://x.com/a_b">x</a>']);
  });

  it('comes out unchanged, byte for byte', () => {
    unchanged([
      '',
      ' ',
      '\n',
      'Done, I emailed Priya the notes.',
      'Line one\nLine two\n\nLine four\n',
      'Windows line\r\nends stay\r\n',
      'Trailing spaces stay  \n\tand tabs\t',
      'Prices: $5, €10 & 20% off (today only!)',
      'Meeting at 10:30 - bring your laptop; see you @ 5.',
      'Title\n=====',
      "It's 5 > 3 and 2 < 4, isn't it?",
      'Call +1 555 000 1111 or +91 98765 43210',
      '1. First\n2. Second\n   - a detail\n3. Third',
      '😀 नमस्ते 你好 مرحبا',
      '   three spaces before',
    ]);
  });

  it('our own messages are untouched', () => {
    unchanged([
      linkInstructionsText(),
      NEW_CHAT_TEXT,
      PLATFORM_FAULT_TEXT,
      connectAiText(),
      outOfCreditsText('telegram'),
      outOfCreditsText('whatsapp'),
      outOfCreditsText('imessage'),
      buttonsAsText([
        { id: 'apr:1:yes', title: '✅ Approve' },
        { id: 'apr:1:no', title: '❌ Reject' },
      ]),
      // The ones written where they are sent (process-message, approvals, automations, billing).
      '✅ Linked! You can chat with your agent right here. What can I do for you?',
      'This chat is already linked to your account.',
      'That code is invalid or expired. Get a new one in the web app (codes last 10 minutes).',
      'Too many attempts. Please try again in an hour.',
      'Approval needed: Send email to priya@acme.com: "Report delayed to Monday" (GMAIL_SEND_EMAIL)',
      'That approval was already answered or has expired.',
      'I paused the automation "Monday PRs" because it failed 3 times in a row. You can resume it in the web app.',
      '🎉 +100 credits added, they expire on 2026-12-31. Balance: 1,100.',
      "I couldn't finish that: the request timed out (error_code=E_TIMEOUT)",
    ]);
  });
});

describe('a whole reply', () => {
  const reply = [
    '# Your week',
    '',
    'Here is the **plan** for `acme/repo`:',
    '',
    '1. **Monday**: review [PR #7](https://github.com/acme/repo/pull/7)',
    '2. *Tuesday*: fix `parse_user_name`',
    '',
    '| Day | Task | Hours |',
    '|-----|------|------:|',
    '| Mon | Review | 2 |',
    '| Tue | Fix | 3 |',
    '',
    '> Do not forget the stand-up.',
    '',
    '---',
    '',
    '```sh',
    'pnpm test -- --run my_test',
    '```',
    '',
    '- [x] calendar updated',
    '- [ ] email Priya',
  ].join('\n');
  const message = [
    'Your week',
    '',
    'Here is the plan for acme/repo:',
    '',
    '1. Monday: review PR #7 (https://github.com/acme/repo/pull/7)',
    '2. Tuesday: fix parse_user_name',
    '',
    'Day: Mon; Task: Review; Hours: 2',
    'Day: Tue; Task: Fix; Hours: 3',
    '',
    'Do not forget the stand-up.',
    '',
    'pnpm test -- --run my_test',
    '',
    `- ${DONE_MARK} calendar updated`,
    '- email Priya',
  ].join('\n');

  it('reads as a text message, with no Markdown symbols left', () => {
    expect(plain(reply)).toBe(message);
    // "PR #7" keeps its hash: only a hash or a ">" that starts a line is Markdown.
    expect(plain(reply)).not.toMatch(/[*`|]|^#|^>|\]\(/m);
  });

  it('a long reply stays quick', () => {
    const long = `${reply}\n\n`.repeat(20).slice(0, 8000);
    const started = Date.now();
    plain(long);
    plain('*a '.repeat(2600));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('applying it twice gives the same as once', () => {
    expect(plain(message)).toBe(message);
    expect(seen.length).toBeGreaterThan(60);
    for (const [markdown, text] of seen) expect(plain(text), markdown).toBe(text);
  });

  it('code and escaped characters are the one exception: they are kept as written', () => {
    // The first run keeps what was protected. Read as Markdown again, it would be formatting.
    // Nothing runs it twice: the saved message keeps the original and it is converted once.
    expect(plain('`**kwargs**`')).toBe('**kwargs**');
    expect(plain('\\*literal\\*')).toBe('*literal*');
    expect(plain('```sh\n# a comment\n```')).toBe('# a comment');
  });
});
