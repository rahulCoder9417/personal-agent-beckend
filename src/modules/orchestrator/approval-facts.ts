// What an app action's approval really does, made by the server from the action and its inputs,
// never from Tex's words (the Composio audit of 17 October 2026, problem 3). Until 18 October the
// question on Telegram, WhatsApp and iMessage was only Tex's own summary ("I'd like to send the
// notes to Priya"), and the real inputs were behind "Show the details" in the web app, so a wrong
// or tricked Tex could get a yes for an email to someone else. Now the question has a second line
// written here: "What will run: Gmail – send email · To: eve@evil.com · Subject: Notes". The web
// card shows the same facts (the API's `facts`).
//
// Only what the inputs say, in a fixed order: the app and the action, where it acts (the
// repository, calendar, file), who it goes to or who gets access, what is made public, the
// subject or title, and the first words of the text. Each value is cut short; anything that looks
// like a secret (a password, a token, a key) is never shown, by its name or by its look. The names
// of the other inputs are listed, so nothing is hidden by being left out.
import { actionWords, findApp } from '../integrations/catalog.ts';
import { appOfAction } from '../integrations/action-inputs.ts';
import type { approvals } from './schema.ts';
import { recipientsOf } from './skip-rules.ts';

type Approval = typeof approvals.$inferSelect;

/** One line of what will run: "To" and "priya@acme.com". */
export interface ApprovalFact {
  label: string;
  value: string;
}

/** The most of one value shown. */
const VALUE_MAX = 80;
/** The most of a text's first words shown. */
const TEXT_MAX = 100;
/** The most people or items of a list shown; the rest are counted. */
const LIST_MAX = 5;
/** The most facts on one card, the action's own line included. */
const FACTS_MAX = 8;
/** The most of the one line the chat apps get. */
const LINE_MAX = 600;

const HIDDEN = '(hidden)';

/** Inputs whose value is never shown: passwords, tokens, keys and the like. */
const SECRET_INPUT =
  /(pass(word|wd|phrase)?|secret|token|api[_-]?key|private[_-]?key|credential|cookie|authorization|^key$|_key$|encrypted)/i;
/** Values that look like a secret, whatever their input is called. */
const SECRET_VALUE =
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|sk-[\w-]{20,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|ya29\.[\w.-]{20,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}|-----BEGIN [A-Z ]*KEY-----|ssh-(rsa|ed25519) [A-Za-z0-9+/=]{20,})/;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

function cut(text: string, max: number): string {
  const one = oneLine(text);
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** A value as plain text: a list's first few, an object's first few fields. Null: nothing to show. */
function plain(v: unknown, max = VALUE_MAX, depth = 0): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    if (!v.trim()) return null;
    return SECRET_VALUE.test(v) ? HIDDEN : cut(v, max);
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const items = v.map((x) => plain(x, max, depth + 1)).filter((x): x is string => x !== null);
    if (!items.length) return null;
    const more = items.length > LIST_MAX ? ` and ${items.length - LIST_MAX} more` : '';
    return cut(`${items.slice(0, LIST_MAX).join(', ')}${more}`, max);
  }
  if (typeof v === 'object' && depth < 2) {
    const parts = Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => {
        if (SECRET_INPUT.test(k)) return `${k}: ${HIDDEN}`;
        const shown = plain(x, max, depth + 1);
        return shown === null ? null : `${k}: ${shown}`;
      })
      .filter((x): x is string => x !== null);
    return parts.length ? cut(parts.slice(0, LIST_MAX).join(', '), max) : null;
  }
  return null;
}

const isTrue = (v: unknown) => v === true || (typeof v === 'string' && v.toLowerCase() === 'true');
const isFalse = (v: unknown) =>
  v === false || (typeof v === 'string' && v.toLowerCase() === 'false');

/** Who or what may see it, when the inputs say. */
function visibility(args: Record<string, unknown>): string | null {
  if (
    isTrue(args.public) ||
    isFalse(args.private) ||
    /^public$/i.test(String(args.visibility ?? ''))
  )
    return 'public: anyone can see it';
  if (
    isFalse(args.public) ||
    isTrue(args.private) ||
    /^private$/i.test(String(args.visibility ?? ''))
  )
    return 'private';
  return null;
}

/** Drive's and Calendar's sharing: who it is shared with (`type`, `scope`, `domain`). */
function sharedWith(args: Record<string, unknown>): string | null {
  const scope = args.scope as Record<string, unknown> | undefined;
  const type = String((scope && typeof scope === 'object' ? scope.type : args.type) ?? '');
  if (/^anyone$/i.test(type)) return 'anyone with the link';
  if (/^default$/i.test(type)) return 'everyone (public)';
  if (/^domain$/i.test(type))
    return `everyone at ${plain(args.domain ?? (scope && scope.value)) ?? 'a domain'}`;
  return null;
}

/**
 * The inputs shown, in this order, each with its label. The first of a row's names that has a
 * value is shown; the row's other names, when given too, are listed under "Other inputs".
 */
const ROWS: Array<{ label: string; keys: string[]; max?: number }> = [
  {
    label: 'People',
    keys: [
      'username',
      'usernames',
      'assignee',
      'assignees',
      'reviewers',
      'team_reviewers',
      'invitee',
      'invitee_id',
      'member',
      'members',
      'collaborator',
      'users',
    ],
  },
  {
    label: 'Email',
    keys: [
      'email',
      'emails',
      'email_address',
      'emailAddress',
      'forwarding_email',
      'forwardingEmail',
    ],
  },
  { label: 'Access', keys: ['role', 'permission', 'permissions', 'access_role', 'accessRole'] },
  { label: 'Calendar', keys: ['calendar_id', 'calendarId'] },
  { label: 'Branch', keys: ['branch', 'ref', 'target_commitish'] },
  { label: 'From branch', keys: ['head'] },
  { label: 'Into branch', keys: ['base'] },
  { label: 'Tag', keys: ['tag_name'] },
  { label: 'Workflow', keys: ['workflow_id'] },
  { label: 'File', keys: ['file_id', 'fileId', 'path', 'file_path', 'file_name', 'filename'] },
  { label: 'Folder', keys: ['folder_id', 'folderId', 'parent_id', 'parents'] },
  {
    label: 'Document',
    keys: [
      'document_id',
      'documentId',
      'spreadsheet_id',
      'spreadsheetId',
      'page_id',
      'database_id',
    ],
  },
  { label: 'Event', keys: ['event_id', 'eventId'] },
  { label: 'Issue or pull request', keys: ['issue_number', 'pull_number'] },
  {
    label: 'Message',
    keys: ['message_id', 'messageId', 'thread_id', 'threadId', 'draft_id', 'ts'],
  },
  { label: 'Labels added', keys: ['add_label_ids', 'addLabelIds', 'labels', 'label_ids'] },
  { label: 'Labels removed', keys: ['remove_label_ids', 'removeLabelIds'] },
  { label: 'Matches', keys: ['criteria'] },
  { label: 'Then', keys: ['action'] },
  { label: 'Sends to', keys: ['url', 'config', 'webhook_url'] },
  {
    label: 'When',
    keys: [
      'start_datetime',
      'start_time',
      'start',
      'post_at',
      'scheduled_time',
      'send_at',
      'due_string',
      'due_date',
    ],
  },
  { label: 'Subject', keys: ['subject'] },
  { label: 'Title', keys: ['title', 'name', 'summary', 'event_name'] },
  {
    label: 'Text',
    keys: [
      'body',
      'text',
      'message',
      'markdown',
      'content',
      'description',
      'message_body',
      'comment',
      'commit_message',
      'markdown_text',
    ],
    max: TEXT_MAX,
  },
];

/** Gmail's own account, as every Gmail action names it: never worth a line. */
const isMe = (k: string, v: unknown) => k === 'user_id' && v === 'me';

/** Names that hold who it goes to (the recipients of skip-rules.ts): shown as "To". */
const RECIPIENT_INPUT =
  /(^|_)(to|cc|bcc|recipient|recipients|attendee|attendees|invitee|invitees|guest|guests|channel|channels|chat|chats)(_|$)/i;

/** A commit's files: how many and their names (an object of name → content, or a list of paths). */
function filesOf(v: unknown): string | null {
  const names = Array.isArray(v)
    ? v
        .map((f) =>
          typeof f === 'string'
            ? f
            : f && typeof f === 'object'
              ? ((f as Record<string, unknown>).path ?? (f as Record<string, unknown>).filename)
              : null,
        )
        .filter((x): x is string => typeof x === 'string')
    : v && typeof v === 'object'
      ? Object.keys(v as Record<string, unknown>)
      : [];
  if (!names.length) return null;
  return cut(
    `${names.length} ${names.length === 1 ? 'file' : 'files'}: ${names.slice(0, LIST_MAX).join(', ')}`,
    VALUE_MAX,
  );
}

/**
 * The facts of an app action's request, from its action and inputs. Empty for anything that is
 * not an app action (a command, a push, a crew job: their summary is the server's own already).
 */
export function approvalFacts(a: Pick<Approval, 'app' | 'action' | 'arguments'>): ApprovalFact[] {
  if (!a.action || !a.arguments || a.action.toUpperCase().startsWith('TEXTCREW_')) return [];
  const app = (a.app ? findApp(a.app) : undefined) ?? appOfAction(a.action);
  if (!app) return [];
  const args = a.arguments;
  const words = actionWords(a.action);
  const facts: ApprovalFact[] = [
    { label: 'Action', value: `${app.name} – ${words.charAt(0).toLowerCase()}${words.slice(1)}` },
  ];
  const used = new Set<string>();
  const github = a.action.toUpperCase().startsWith('GITHUB_');
  if (github && typeof args.owner === 'string' && typeof args.repo === 'string') {
    facts.push({ label: 'Repository', value: cut(`${args.owner}/${args.repo}`, VALUE_MAX) });
    used.add('owner').add('repo');
  }
  if (!github) {
    const to = recipientsOf(a.action, args);
    if (to.length) {
      const more = to.length > LIST_MAX ? ` and ${to.length - LIST_MAX} more` : '';
      facts.push({ label: 'To', value: cut(`${to.slice(0, LIST_MAX).join(', ')}${more}`, 200) });
    }
    for (const k of Object.keys(args)) if (RECIPIENT_INPUT.test(k)) used.add(k);
  }
  const shared = sharedWith(args);
  if (shared) {
    facts.push({ label: 'Shared with', value: shared });
    used.add('type').add('scope').add('domain');
  }
  const seen = visibility(args);
  if (seen) {
    facts.push({ label: 'Visibility', value: seen });
    used.add('public').add('private').add('visibility');
  }
  for (const row of ROWS) {
    const key = row.keys.find(
      (k) => Object.hasOwn(args, k) && !used.has(k) && plain(args[k]) !== null,
    );
    if (!key) continue;
    used.add(key);
    const value = SECRET_INPUT.test(key) ? HIDDEN : plain(args[key], row.max ?? VALUE_MAX)!;
    facts.push({
      label: row.label,
      value: row.label === 'Issue or pull request' ? `#${value}` : value,
    });
  }
  for (const k of ['files', 'changes', 'tree']) {
    if (!Object.hasOwn(args, k)) continue;
    used.add(k);
    const files = filesOf(args[k]);
    if (files) facts.push({ label: 'Files', value: files });
  }
  const shown = facts.slice(0, FACTS_MAX);
  const left = facts.slice(FACTS_MAX).map((f) => f.label.toLowerCase());
  const others = Object.keys(args).filter(
    (k) =>
      !used.has(k) &&
      !isMe(k, args[k]) &&
      args[k] !== null &&
      args[k] !== undefined &&
      args[k] !== '',
  );
  if (left.length || others.length)
    shown.push({ label: 'Other inputs', value: cut([...left, ...others].join(', '), VALUE_MAX) });
  return shown;
}

/**
 * The facts as one line for the chat apps: "Gmail – send email · To: priya@acme.com · Subject:
 * Notes". The action's own fact has no label. Empty when there are none.
 */
export function factsLine(facts: ApprovalFact[]): string {
  const line = facts
    .map((f) => (f.label === 'Action' ? f.value : `${f.label}: ${f.value}`))
    .join(' · ');
  return cut(line, LINE_MAX);
}
