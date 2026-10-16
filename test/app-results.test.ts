// What an app action sends back to the agent (app-results.ts), and an action's line in
// list_app_actions (agent-apps.ts): no more than the agent needs.
import { describe, expect, it } from 'vitest';
import { LISTED_DESCRIPTION_CHARS, oneLine } from '../src/modules/integrations/agent-apps.ts';
import {
  fitResult,
  MAX_RESULT_CHARS,
  shapeResult,
  summariseEmail,
  withResultDefaults,
} from '../src/modules/integrations/app-results.ts';
import { fetchEmails } from './gmail-fixture.ts';

describe("Gmail's fetch", () => {
  it('asks Composio for no bodies, unless the agent asked for them', () => {
    expect(withResultDefaults('GMAIL_FETCH_EMAILS', { query: 'is:unread' })).toEqual({
      verbose: false,
      include_payload: false,
      query: 'is:unread',
    });
    expect(
      withResultDefaults('GMAIL_FETCH_EMAILS', { verbose: true, include_payload: true }),
    ).toEqual({ verbose: true, include_payload: true });
    // Every other action runs with exactly the agent's arguments.
    expect(withResultDefaults('GMAIL_SEND_EMAIL', { recipient_email: 'a@b.co' })).toEqual({
      recipient_email: 'a@b.co',
    });
  });

  it('summarises each email: who, what, when and a few words', () => {
    const args = withResultDefaults('GMAIL_FETCH_EMAILS', { max_results: 3 });
    const { data } = shapeResult('GMAIL_FETCH_EMAILS', args, fetchEmails(args));
    const d = data as {
      messages: Array<Record<string, unknown>>;
      next_page_token: string;
      note: string;
    };
    expect(d.messages).toHaveLength(3);
    expect(d.messages[0]).toEqual({
      id: expect.any(String),
      thread_id: expect.any(String),
      from: 'Priya 1 <priya1@acme.com>',
      to: 'rahulkum94l94@gmail.com',
      subject: 'Proposal follow-up #1',
      date: '2026-10-15T09:01:00.000Z',
      snippet: expect.stringMatching(/^Hi Rahul, following up/),
      labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
    });
    expect(d.next_page_token).toBe('page-2');
    expect(d.note).toContain('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID');
  });

  it("reads Gmail's own shape too: headers, internalDate and snippet", () => {
    expect(
      summariseEmail({
        id: 'm1',
        threadId: 't1',
        internalDate: '1760518860000',
        snippet: 'See you   at\n10',
        payload: {
          headers: [
            { name: 'From', value: 'Ann <ann@x.co>' },
            { name: 'subject', value: 'Lunch' },
          ],
        },
        attachmentList: [{ name: 'a.pdf' }],
      }),
    ).toEqual({
      id: 'm1',
      thread_id: 't1',
      from: 'Ann <ann@x.co>',
      subject: 'Lunch',
      date: new Date(1760518860000).toISOString(),
      snippet: 'See you at 10',
      attachments: 1,
    });
  });

  it('shows at most 10 emails, unless the agent asked for more', () => {
    const many = { messages: fetchEmails({ max_results: 25, verbose: false }).messages };
    const ten = shapeResult('GMAIL_FETCH_EMAILS', { verbose: false }, many).data as {
      messages: unknown[];
      note: string;
    };
    expect(ten.messages).toHaveLength(10);
    expect(ten.note).toMatch(/^Showing 10 of 25 emails\./);
    const twenty = shapeResult('GMAIL_FETCH_EMAILS', { max_results: 20, verbose: false }, many)
      .data as { messages: unknown[] };
    expect(twenty.messages).toHaveLength(20);
  });

  it('bodies asked for are sent, cut to the limit, with how to get one email whole', () => {
    const args = { max_results: 10, verbose: true, include_payload: true };
    const shaped = shapeResult('GMAIL_FETCH_EMAILS', args, fetchEmails(args));
    expect(JSON.stringify(shaped.data).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(
      (shaped.data as { messages: Array<{ messageText: string }> }).messages[0]!.messageText,
    ).toMatch(/\[cut: [\d,]+ characters in all\]$/);
    expect(shaped.note).toMatch(/too long to send whole/);
    expect(shaped.note).toContain('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID');
  });

  it('an answer of another shape is sent as it came', () => {
    expect(shapeResult('GMAIL_FETCH_EMAILS', {}, { emails: 'none' })).toEqual({
      data: { emails: 'none' },
    });
  });
});

describe('any app answer', () => {
  it('is sent whole when it fits', () => {
    const data = { items: [{ id: 1, title: 'A' }] };
    expect(fitResult(data)).toBeNull();
    expect(shapeResult('GITHUB_LIST_ISSUES', {}, data)).toEqual({ data });
  });

  it('is cut to the limit when it does not: long texts, then long lists, then the rest', () => {
    const longTexts = { files: [{ name: 'a', content: 'x'.repeat(80_000) }] };
    const longList = {
      issues: Array.from({ length: 3000 }, (_, i) => ({ id: i, title: `Issue ${i}` })),
    };
    for (const data of [longTexts, longList]) {
      const shaped = shapeResult('GITHUB_LIST_ISSUES', {}, data);
      expect(JSON.stringify(shaped.data).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
      expect(shaped.note).toMatch(/ask for less/);
      // A note about one email is only for Gmail.
      expect(shaped.note).not.toContain('GMAIL_');
    }
    const list = shapeResult('GITHUB_LIST_ISSUES', {}, longList).data as { issues: unknown[] };
    expect(list.issues.at(-1)).toBe('… [cut: 3000 items in all]');
    // Whatever the shape, never more than the limit.
    const text = fitResult('y'.repeat(100_000)) as string;
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 10);
  });
});

describe("an action's line in list_app_actions", () => {
  it('is its first sentence, on one line, cut when long', () => {
    expect(oneLine('Fetches emails.  Supports filters.\nMore here.')).toBe('Fetches emails.');
    expect(oneLine('Lists   repos\nof a user')).toBe('Lists repos of a user');
    const long = oneLine(`${'word '.repeat(60)}end.`);
    expect(long.length).toBe(LISTED_DESCRIPTION_CHARS);
    expect(long.endsWith('…')).toBe(true);
    // A version number is not the end of a sentence.
    expect(oneLine('Uses API v1.2 to list labels. Then more.')).toBe(
      'Uses API v1.2 to list labels.',
    );
  });
});
