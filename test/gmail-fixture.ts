// Gmail at Composio, as the "check my email" turn of 15 October met it: 63 actions, each with a
// full input schema (about 115 thousand characters when all are listed with their schemas), and a
// fetch of 10 emails that returns their whole bodies unless asked not to. The names and inputs of
// the actions the agent uses are Composio's own (docs.composio.dev, Gmail toolkit); the others are
// stand-ins of the same size.
import type { ComposioTool } from '../src/modules/integrations/composio.ts';

const NAMES = [
  'ADD_LABEL_TO_EMAIL',
  'BATCH_DELETE_MESSAGES',
  'BATCH_MODIFY_MESSAGES',
  'CREATE_EMAIL_DRAFT',
  'CREATE_LABEL',
  'DELETE_DRAFT',
  'DELETE_LABEL',
  'DELETE_MESSAGE',
  'DELETE_THREAD',
  'FETCH_MESSAGE_BY_THREAD_ID',
  'FORWARD_MESSAGE',
  'GET_ATTACHMENT',
  'GET_CONTACTS',
  'GET_DRAFT',
  'GET_LABEL',
  'GET_PEOPLE',
  'GET_PROFILE',
  'IMPORT_MESSAGE',
  'INSERT_MESSAGE',
  'LIST_DRAFTS',
  'LIST_HISTORY',
  'LIST_LABELS',
  'LIST_THREADS',
  'MODIFY_THREAD_LABELS',
  'MOVE_TO_TRASH',
  'PATCH_LABEL',
  'REMOVE_LABEL',
  'REPLY_TO_THREAD',
  'SEARCH_PEOPLE',
  'SEND_DRAFT',
  'SETTINGS_GET_AUTO_FORWARDING',
  'SETTINGS_GET_IMAP',
  'SETTINGS_GET_POP',
  'SETTINGS_GET_VACATION',
  'SETTINGS_SEND_AS_GET',
  'LIST_SEND_AS',
  'LIST_FILTERS',
  'CREATE_FILTER',
  'DELETE_FILTER',
  'LIST_FORWARDING_ADDRESSES',
  'UNTRASH_MESSAGE',
  'UNTRASH_THREAD',
  'TRASH_THREAD',
  'UPDATE_DRAFT',
  'UPDATE_LABEL',
  'STOP_WATCH',
  'WATCH',
  'LIST_MESSAGES',
  'GET_THREAD',
  'SETTINGS_UPDATE_VACATION',
  'LIST_CSE_IDENTITIES',
  'LIST_SMIME_INFO',
  'GET_LANGUAGE_SETTINGS',
  'UPDATE_LANGUAGE_SETTINGS',
  'LIST_DELEGATES',
  'ADD_DELEGATE',
  'REMOVE_DELEGATE',
  'GET_AUTO_REPLY',
  'CREATE_SEND_AS',
  'VERIFY_SEND_AS',
];

const LOREM =
  'This parameter controls how the Gmail API request is made for the connected account. Use the ' +
  'value the user asked for, or leave it out to use the default. Values that do not match are ' +
  'rejected.';

const input = (type: string, description: string, extra: Record<string, unknown> = {}) => ({
  type,
  title: description.split(' ').slice(0, 3).join(' '),
  description,
  ...extra,
});

/** A stand-in action's schema: four inputs with Composio-length descriptions. */
function standIn(name: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    user_id: input('string', `User id, "me" by default. ${LOREM}`, { default: 'me' }),
  };
  for (let i = 1; i <= 3; i++)
    properties[`${name.toLowerCase().split('_')[0]}_option_${i}`] = input(
      i % 3 === 0 ? 'boolean' : i % 3 === 1 ? 'string' : 'integer',
      `Option ${i} of ${name.toLowerCase().replace(/_/g, ' ')}. ${LOREM}`,
      { examples: ['example-value', 'another-example'] },
    );
  return { type: 'object', properties, required: [] };
}

const FETCH_EMAILS: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: input(
      'string',
      `Gmail search syntax: from:, to:, subject:, label:, has:, is:, after:/before: (YYYY/MM/DD). ${LOREM}`,
    ),
    user_id: input('string', `Email address or "me". ${LOREM}`, { default: 'me' }),
    verbose: input(
      'boolean',
      `When false, faster metadata fetching: subject, sender, recipient, time and labels only. Bodies need true. ${LOREM}`,
      { default: true },
    ),
    ids_only: input('boolean', `Only message and thread ids, with no details. ${LOREM}`, {
      default: false,
    }),
    label_ids: input('array', `Label ids, all must match. ${LOREM}`, { items: { type: 'string' } }),
    page_token: input('string', `nextPageToken of the previous page. ${LOREM}`),
    max_results: input(
      'integer',
      `Results per page, at most 500. The default returns one message. ${LOREM}`,
      { default: 1 },
    ),
    include_payload: input(
      'boolean',
      `Headers, body and attachments, base64url in payload.parts. ${LOREM}`,
      { default: true },
    ),
    include_spam_trash: input('boolean', `Messages from SPAM and TRASH too. ${LOREM}`, {
      default: false,
    }),
  },
  required: [],
};

const SEND_EMAIL: Record<string, unknown> = {
  type: 'object',
  properties: {
    recipient_email: input('string', `Primary recipient, a full address. ${LOREM}`),
    extra_recipients: input('array', `More To recipients. ${LOREM}`, { items: { type: 'string' } }),
    cc: input('array', `CC recipients. ${LOREM}`, { items: { type: 'string' } }),
    bcc: input('array', `BCC recipients. ${LOREM}`, { items: { type: 'string' } }),
    subject: input('string', `Subject line. ${LOREM}`),
    body: input('string', `Plain text or HTML. ${LOREM}`),
    is_html: input('boolean', `True when the body is HTML. ${LOREM}`, { default: false }),
    attachment: { ...input('object', `One file. ${LOREM}`), file_uploadable: true },
    from_email: input('string', `Sender address. ${LOREM}`),
    user_id: input('string', `Email address or "me". ${LOREM}`, { default: 'me' }),
  },
  required: [],
};

const FETCH_BY_ID: Record<string, unknown> = {
  type: 'object',
  properties: {
    message_id: input('string', `Hex Gmail message id from a list or search. ${LOREM}`),
    format: input('string', `minimal, metadata, full or raw. ${LOREM}`, { default: 'full' }),
    user_id: input('string', `Email address or "me". ${LOREM}`, { default: 'me' }),
  },
  required: ['message_id'],
};

const DESCRIPTION =
  ' Supports filtering, pagination and optional full content retrieval. Returns the Gmail API ' +
  'response for the connected account. Use the documented formats for every input: values that ' +
  'do not match are rejected by Gmail. Rate limits apply per user and per project.';

function tool(
  slug: string,
  schema: Record<string, unknown>,
  first: string,
  readOnly: boolean,
): ComposioTool {
  return {
    slug,
    toolkit: 'gmail',
    name: slug
      .replace(/^GMAIL_/, '')
      .toLowerCase()
      .replace(/_/g, ' '),
    description: `${first}${DESCRIPTION}`,
    inputParameters: schema,
    tags: readOnly ? ['readOnlyHint'] : [],
  };
}

/** The 63 Gmail actions. */
export function gmailTools(): ComposioTool[] {
  return [
    tool(
      'GMAIL_FETCH_EMAILS',
      FETCH_EMAILS,
      'Fetches a list of email messages from a Gmail account.',
      true,
    ),
    tool(
      'GMAIL_SEND_EMAIL',
      SEND_EMAIL,
      'Sends an email via the Gmail API using the authenticated user profile.',
      false,
    ),
    tool(
      'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
      FETCH_BY_ID,
      'Fetches one email message by its Gmail message id.',
      true,
    ),
    ...NAMES.map((n) =>
      tool(
        `GMAIL_${n}`,
        standIn(n),
        `${n.charAt(0)}${n.slice(1).toLowerCase().replace(/_/g, ' ')} in Gmail.`,
        /^(GET|LIST|SEARCH|FETCH|SETTINGS_GET)/.test(n),
      ),
    ),
  ];
}

const BODY_LINE =
  'Hi Rahul, following up on the proposal we discussed last week. Please find the updated numbers ' +
  'below, along with the timeline and the open questions from the team. ';

/** One email as Composio's fetch returns it. `full`: with its body and payload (verbose, include_payload). */
function email(i: number, full: boolean): Record<string, unknown> {
  const meta = {
    messageId: `18f${(1000 + i).toString(16)}a9c0d${i}`,
    threadId: `18f${(1000 + i).toString(16)}a9c0d0`,
    messageTimestamp: new Date(Date.UTC(2026, 9, 15, 9, i)).toISOString(),
    labelIds: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
    subject: `Proposal follow-up #${i}`,
    sender: `Priya ${i} <priya${i}@acme.com>`,
    to: 'rahulkum94l94@gmail.com',
    preview: { subject: `Proposal follow-up #${i}`, body: `${BODY_LINE.slice(0, 140)}…` },
  };
  if (!full) return meta;
  const text = BODY_LINE.repeat(12);
  const html = Buffer.from(
    `<html><body><table>${'<tr><td>' + BODY_LINE + '</td></tr>'.repeat(1)}</table></body></html>`.repeat(
      8,
    ),
  ).toString('base64');
  return {
    ...meta,
    messageText: text,
    attachmentList: [],
    payload: {
      mimeType: 'multipart/alternative',
      headers: Array.from({ length: 16 }, (_, h) => ({
        name: `X-Header-${h}`,
        value: `value ${h} for message ${i} with routing details`,
      })),
      parts: [
        {
          mimeType: 'text/plain',
          body: { size: text.length, data: Buffer.from(text).toString('base64') },
        },
        { mimeType: 'text/html', body: { size: html.length, data: html } },
      ],
    },
  };
}

/**
 * GMAIL_FETCH_EMAILS at Composio: `max_results` emails (1 when not given), with bodies and payload
 * unless `verbose` or `include_payload` is false (Composio's defaults are true).
 */
export function fetchEmails(args: Record<string, unknown>): Record<string, unknown> {
  const n = typeof args.max_results === 'number' ? Math.min(args.max_results, 50) : 1;
  const full = args.verbose !== false && args.include_payload !== false;
  return {
    messages: Array.from({ length: n }, (_, i) => email(i + 1, full)),
    nextPageToken: 'page-2',
    resultSizeEstimate: 241,
  };
}
