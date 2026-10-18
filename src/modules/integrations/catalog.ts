// The 25 apps we offer (HLD 7.1). `free: true` marks the 10 available on the Free plan.
// `toolkit` is the Composio toolkit slug. An app's Composio setup (auth config) comes from
// COMPOSIO_AUTH_CONFIGS, or is made by the server itself (COMPOSIO_MANAGED_APPS, see apps.ts).
export interface CatalogApp {
  slug: string;
  name: string;
  /** The company whose sign-in screen the user sees ("Continue to Google"). */
  provider: string;
  /** What the agent can do with the app, in plain words, for the connect screen. One sentence. */
  description: string;
  category:
    | 'email'
    | 'calendar'
    | 'notes'
    | 'tasks'
    | 'crm'
    | 'dev'
    | 'research'
    | 'files'
    | 'chat'
    | 'social';
  toolkit: string;
  free: boolean;
  /**
   * Composio has its own shared sign-in app for this toolkit ("Composio managed"), so the server
   * can make the setup itself. False for Exa, which signs in with an API key (docs/composio.md).
   */
  managedAuth: boolean;
  /**
   * How to ask the app who a connection is signed in as (account-identity.ts): its own read-only
   * "who am I" action, and the field of the result that names the account. Only for apps where
   * that is one cheap call; the others have no account label, and Tex asks the user once.
   */
  identity?: AccountIdentity;
}

/** An app's "who am I" action and the field of its result that names the account. */
export interface AccountIdentity {
  action: string;
  field: string;
  arguments?: Record<string, unknown>;
}

type Entry = Omit<CatalogApp, 'managedAuth'> & { managedAuth?: boolean };

const APPS: Entry[] = [
  {
    slug: 'gmail',
    name: 'Gmail',
    provider: 'Google',
    description: 'Read and search your email, write drafts and send email for you.',
    category: 'email',
    toolkit: 'gmail',
    free: true,
    identity: { action: 'GMAIL_GET_PROFILE', field: 'emailAddress', arguments: { user_id: 'me' } },
  },
  {
    slug: 'googlecalendar',
    name: 'Google Calendar',
    provider: 'Google',
    description: 'See your events, find free time, and add or change events.',
    category: 'calendar',
    toolkit: 'googlecalendar',
    free: true,
  },
  {
    slug: 'googledrive',
    name: 'Google Drive',
    provider: 'Google',
    description: 'Find and read the files in your Drive, and add or organize files.',
    category: 'files',
    toolkit: 'googledrive',
    free: true,
  },
  {
    slug: 'googledocs',
    name: 'Google Docs',
    provider: 'Google',
    description: 'Read your documents, and write new ones or edit them.',
    category: 'notes',
    toolkit: 'googledocs',
    free: true,
  },
  {
    slug: 'googlesheets',
    name: 'Google Sheets',
    provider: 'Google',
    description: 'Read your spreadsheets, and add or update rows.',
    category: 'files',
    toolkit: 'googlesheets',
    free: true,
  },
  {
    slug: 'notion',
    name: 'Notion',
    provider: 'Notion',
    description: 'Search and read your pages, and write new ones.',
    category: 'notes',
    toolkit: 'notion',
    free: true,
  },
  {
    slug: 'todoist',
    name: 'Todoist',
    provider: 'Todoist',
    description: 'See your tasks, add new ones and tick them off.',
    category: 'tasks',
    toolkit: 'todoist',
    free: true,
  },
  {
    slug: 'slack',
    name: 'Slack',
    provider: 'Slack',
    description: 'Read your channels and messages, and send messages for you.',
    category: 'chat',
    toolkit: 'slack',
    free: true,
  },
  {
    slug: 'github',
    name: 'GitHub',
    provider: 'GitHub',
    description: 'Read your repos, issues and pull requests, and open or comment on them.',
    category: 'dev',
    toolkit: 'github',
    free: true,
    identity: { action: 'GITHUB_GET_THE_AUTHENTICATED_USER', field: 'login' },
  },
  {
    slug: 'exa',
    name: 'Exa Search',
    provider: 'Exa',
    description: 'Search the web and read what it finds, with your Exa account.',
    category: 'research',
    toolkit: 'exa',
    free: true,
    managedAuth: false,
  },
  {
    slug: 'outlook',
    name: 'Outlook',
    provider: 'Microsoft',
    description: 'Read and search your email and calendar, and send email for you.',
    category: 'email',
    toolkit: 'outlook',
    free: false,
  },
  {
    slug: 'microsoft_teams',
    name: 'Microsoft Teams',
    provider: 'Microsoft',
    description: 'Read your chats and channels, and send messages for you.',
    category: 'chat',
    toolkit: 'microsoft_teams',
    free: false,
  },
  {
    slug: 'onedrive',
    name: 'OneDrive',
    provider: 'Microsoft',
    description: 'Find and read the files in your OneDrive, and add or organize files.',
    category: 'files',
    toolkit: 'one_drive',
    free: false,
  },
  {
    slug: 'dropbox',
    name: 'Dropbox',
    provider: 'Dropbox',
    description: 'Find and read the files in your Dropbox, and add or organize files.',
    category: 'files',
    toolkit: 'dropbox',
    free: false,
  },
  {
    slug: 'trello',
    name: 'Trello',
    provider: 'Trello',
    description: 'See your boards and cards, and add or move cards.',
    category: 'tasks',
    toolkit: 'trello',
    free: false,
  },
  {
    slug: 'asana',
    name: 'Asana',
    provider: 'Asana',
    description: 'See your projects and tasks, and add or update tasks.',
    category: 'tasks',
    toolkit: 'asana',
    free: false,
  },
  {
    slug: 'linear',
    name: 'Linear',
    provider: 'Linear',
    description: 'See your issues and projects, and open or update issues.',
    category: 'dev',
    toolkit: 'linear',
    free: false,
  },
  {
    slug: 'jira',
    name: 'Jira',
    provider: 'Atlassian',
    description: 'See your issues and projects, and open or update issues.',
    category: 'dev',
    toolkit: 'jira',
    free: false,
  },
  {
    slug: 'clickup',
    name: 'ClickUp',
    provider: 'ClickUp',
    description: 'See your tasks and lists, and add or update tasks.',
    category: 'tasks',
    toolkit: 'clickup',
    free: false,
  },
  {
    slug: 'airtable',
    name: 'Airtable',
    provider: 'Airtable',
    description: 'Read your bases, and add or update records.',
    category: 'files',
    toolkit: 'airtable',
    free: false,
  },
  {
    slug: 'hubspot',
    name: 'HubSpot',
    provider: 'HubSpot',
    description: 'Look up contacts, companies and deals, and add or update them.',
    category: 'crm',
    toolkit: 'hubspot',
    free: false,
  },
  {
    slug: 'salesforce',
    name: 'Salesforce',
    provider: 'Salesforce',
    description: 'Look up accounts, contacts and opportunities, and add or update them.',
    category: 'crm',
    toolkit: 'salesforce',
    free: false,
  },
  {
    slug: 'calendly',
    name: 'Calendly',
    provider: 'Calendly',
    description: 'See your event types and bookings, and share your booking links.',
    category: 'calendar',
    toolkit: 'calendly',
    free: false,
  },
  {
    slug: 'zoom',
    name: 'Zoom',
    provider: 'Zoom',
    description: 'See your meetings and recordings, and schedule meetings.',
    category: 'calendar',
    toolkit: 'zoom',
    free: false,
  },
  {
    slug: 'linkedin',
    name: 'LinkedIn',
    provider: 'LinkedIn',
    description: 'See your profile, and write posts for you.',
    category: 'social',
    toolkit: 'linkedin',
    free: false,
  },
];

export const CATALOG: CatalogApp[] = APPS.map((app) => ({ managedAuth: true, ...app }));

export function findApp(slug: string): CatalogApp | undefined {
  return CATALOG.find((a) => a.slug === slug);
}

export function appForToolkit(toolkit: string): CatalogApp | undefined {
  const t = toolkit.toLowerCase();
  return CATALOG.find((a) => a.toolkit === t);
}

export function appAllowedOnPlan(app: CatalogApp, plan: 'free' | 'pro' | 'max'): boolean {
  return plan !== 'free' || app.free;
}

/**
 * Words of actions that act on the outside world or change what is there (send, delete, pay,
 * share, update…). Composio names some actions with the verb's -s form ("SLACK_DELETES_A_MESSAGE…",
 * "SLACK_SENDS_A_MESSAGE…"), so those are here too.
 */
const RISKY =
  /(^|_)(SEND|SENDS|REPLY|FORWARD|DELETE|DELETES|REMOVE|REMOVES|TRASH|ARCHIVE|PAY|PAYMENT|TRANSFER|CHARGE|REFUND|INVITE|SHARE|POST|PUBLISH|TWEET|MERGE|CLOSE|CANCEL|MOVE|UPDATE|CREATE_EVENT|ACCEPT|DECLINE)(_|$)/;

// --- Which actions ask first (founder's decision, 18 October 2026) -----------------------------
//
// Until 18 October an action asked only when its name had a word such as SEND or DELETE. The
// Composio audit of 17 October counted about 900 actions that change or share things and did not
// ask (deleting every event of a calendar, sharing a Drive file with anyone, adding a collaborator
// to a GitHub repository, committing straight to the main branch…). Now it is the other way round:
//   1. an action on the short list below (SAFE_CHANGES) runs without asking: it only adds something
//      new and private, or tidies the user's own mail, and can be undone;
//   2. every other action whose name has a word that changes (send, create, update, delete, add,
//      share…) asks first;
//   3. an action whose name only reads (GET, LIST, SEARCH…) does not ask;
//   4. a name that says neither asks, unless Composio's own description of the action marks it
//      `readOnlyHint` and not `destructiveHint`. When Composio can't be asked, it asks.
// So an action we can't place asks, never the other way round.

/** The tag Composio puts on tools that only read (the MCP `readOnlyHint` annotation). */
export const READ_ONLY_TAG = 'readOnlyHint';
/** The tag Composio puts on tools that delete or overwrite (the MCP `destructiveHint` annotation). */
export const DESTRUCTIVE_TAG = 'destructiveHint';

/** Gmail's system labels that move mail: out of the inbox (archive), to Trash or to Spam. */
const MAIL_MOVING_LABELS = new Set(['INBOX', 'TRASH', 'SPAM']);

/** The label ids an input holds (one id, a list, or ids separated by commas), upper case. */
function labelIds(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return list.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toUpperCase());
}

/**
 * Only labels that don't move mail: read or unread, starred, important, a category, the user's own
 * labels. Archiving (taking INBOX off), Trash and Spam ask, like moving to Trash does.
 */
function labelsOnly(args: Record<string, unknown>): boolean {
  const keys = ['add_label_ids', 'remove_label_ids', 'addLabelIds', 'removeLabelIds', 'label_ids'];
  return keys.every((k) => labelIds(args[k]).every((id) => !MAIL_MOVING_LABELS.has(id)));
}

/** A harmless change: why it needs no OK, and, when its inputs matter, which inputs keep it so. */
interface SafeChange {
  why: string;
  /** False: with these inputs it is not harmless, and it asks like any other change. */
  safeWith?: (args: Record<string, unknown>) => boolean;
}

/**
 * The changes that run without asking, by exact name. Kept short on purpose; anything not here
 * that changes something asks. Each one adds something new that only the user sees, or tidies the
 * user's own mail, and can be undone in the app. Each still costs 1 credit when it runs.
 */
export const SAFE_CHANGES: Readonly<Record<string, SafeChange>> = {
  GMAIL_CREATE_EMAIL_DRAFT: {
    why: 'A draft stays in the Drafts folder: nothing is sent. Sending it (GMAIL_SEND_DRAFT) asks.',
  },
  GMAIL_CREATE_LABEL: { why: 'A new, empty label in the mailbox: no mail moves.' },
  GMAIL_ADD_LABEL_TO_EMAIL: {
    why: 'Marks one email read or unread, starred, or adds a label. Archiving, Trash and Spam ask.',
    safeWith: labelsOnly,
  },
  GMAIL_MODIFY_THREAD_LABELS: {
    why: 'The same for one conversation. Archiving, Trash and Spam ask.',
    safeWith: labelsOnly,
  },
  GOOGLEDOCS_CREATE_DOCUMENT: { why: 'A new document, private to the user: nothing changes.' },
  GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN: { why: 'The same, written from Markdown.' },
  GOOGLESHEETS_CREATE_GOOGLE_SHEET1: { why: 'A new, empty spreadsheet, private to the user.' },
  GOOGLEDRIVE_CREATE_FOLDER: { why: 'A new, empty folder: no file moves or is shared.' },
  TODOIST_CREATE_TASK: {
    why: "A new task in the user's own list, ticked off or deleted any time.",
  },
};

/** Whether this action, with these inputs (when known), is on the short list of harmless changes. */
export function isSafeChange(actionSlug: string, args?: Record<string, unknown>): boolean {
  const slug = actionSlug.toUpperCase();
  const safe = Object.hasOwn(SAFE_CHANGES, slug) ? SAFE_CHANGES[slug] : undefined;
  if (!safe) return false;
  return !args || !safe.safeWith || safe.safeWith(args);
}

/**
 * Whether the action asks the user first (the rules above). `tags`: its Composio tags, when known
 * (they only decide for a name that says nothing). `args`: the
 * request's inputs, when known: a change on the short list asks when its inputs make it more than
 * harmless (Gmail labels that archive, trash or mark as spam).
 */
export function actionNeedsApproval(
  actionSlug: string,
  opts: { tags?: readonly string[]; args?: Record<string, unknown> } = {},
): boolean {
  const slug = actionSlug.toUpperCase();
  if (isSafeChange(slug, opts.args)) return false;
  const kind = actionKindByName(slug);
  if (kind !== 'unknown') return kind === 'changes';
  const tags = opts.tags ?? [];
  return !tags.includes(READ_ONLY_TAG) || tags.includes(DESTRUCTIVE_TAG);
}

// --- Which actions a skip rule may never cover (founder's decisions, 17 and 18 October) --------
//
// The user may say "don't ask again" for an action that asks (orchestrator/skip-rules.ts). Never
// for these, whatever a rule says, also one written straight into the database:
//   - deleting: DELETE, REMOVE, TRASH, and ARCHIVE (our own approvals table counts it as deleting);
//     DESTROY, PURGE, ERASE and WIPE too, should an action be named so; CLEAR (a calendar's events,
//     a sheet's cells); a harmless Gmail label change whose labels archive, trash or mark as spam;
//   - paying: PAY, PAYMENT, TRANSFER, CHARGE, REFUND, PURCHASE, BUY;
//   - MERGE: a merge writes to the target branch, usually the default one, which may deploy to
//     production; it can't simply be taken back, and the git gateway never lets the agent write to
//     a default branch by itself either. Writing files or moving a branch straight through GitHub's
//     API (a commit, a file's contents, a branch reference) is the same, so it never skips either;
//   - giving someone access to the account or its things, or sending its data elsewhere for good:
//     collaborators, members, invitations, permissions and ACLs, sharing, keys, secrets, tokens,
//     webhooks, mail forwarding, delegates and filters (a filter can delete or forward every mail
//     that matches); on GitHub, an email address and anything else on the user's own account
//     (`…_AUTHENTICATED_USER`);
//   - making something public: PUBLIC and VISIBILITY in the name, or inputs that make it public
//     (a gist with `public` true, a repository with `private` false or `visibility` "public",
//     a share with `type` "anyone");
//   - the platform's own (TEXTCREW_…): Tex's commands and file changes, pushes, crew jobs and
//     running a crew job again;
//   - a GitHub review that approves or requests changes (`event` other than COMMENT): an approval
//     can set off an auto-merge.
const NEVER_SKIPPED =
  /(^|_)(DELETE|DELETES|REMOVE|REMOVES|TRASH|ARCHIVE|ARCHIVES|DESTROY|PURGE|ERASE|WIPE|CLEAR|CLEARS|PAY|PAYMENT|TRANSFER|CHARGE|REFUND|PURCHASE|BUY|MERGE)(_|$)/;
const NEVER_SKIPPED_ACCESS =
  /(^|_)(COLLABORATOR|COLLABORATORS|MEMBER|MEMBERS|MEMBERSHIP|MEMBERSHIPS|INVITATION|INVITATIONS|PERMISSION|PERMISSIONS|ACL|SHARE|SHARES|SHARING|KEY|KEYS|SECRET|SECRETS|TOKEN|TOKENS|WEBHOOK|WEBHOOKS|HOOK|HOOKS|FORWARDING|DELEGATE|DELEGATES|FILTER|FILTERS|ADMIN|ADMINS|OWNER|OWNERS|PUBLIC|VISIBILITY)(_|$)/;
/** GitHub: the user's own account, its email addresses, and writing files or branches directly. */
const NEVER_SKIPPED_GITHUB =
  /(^|_)(AUTHENTICATED_USER|EMAIL|EMAILS|COMMIT|COMMITS|FILE|FILES|CONTENTS|REFERENCE|REFERENCES|REF|TREE|BLOB)(_|$)/;

const isTrue = (v: unknown) => v === true || (typeof v === 'string' && v.toLowerCase() === 'true');
const isFalse = (v: unknown) =>
  v === false || (typeof v === 'string' && v.toLowerCase() === 'false');
const lowerText = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** Inputs that make something public or open to anyone. */
function makesPublic(args: Record<string, unknown>): boolean {
  if (isTrue(args.public) || isFalse(args.private)) return true;
  if (lowerText(args.visibility) === 'public') return true;
  if (lowerText(args.type) === 'anyone' || lowerText(args.type) === 'domain') return true;
  const scope = args.scope as Record<string, unknown> | undefined;
  return Boolean(scope && typeof scope === 'object' && lowerText(scope.type) === 'default');
}

/** Whether a rule may never cover this action (the list above), whatever the user said. */
function neverSkipped(slug: string, args?: Record<string, unknown>): boolean {
  if (slug.startsWith('TEXTCREW_')) return true;
  if (NEVER_SKIPPED.test(slug) || NEVER_SKIPPED_ACCESS.test(slug)) return true;
  if (slug.startsWith('GITHUB_') && NEVER_SKIPPED_GITHUB.test(slug)) return true;
  // A harmless change that asks because of its inputs: archive, Trash or Spam.
  if (Object.hasOwn(SAFE_CHANGES, slug)) return true;
  return Boolean(args && makesPublic(args));
}

/**
 * Whether a skip rule may let this action run without asking. False for one that does not ask
 * (there is nothing to skip) and for the kinds above. `args`, when given, are the request's
 * inputs: a GitHub review is skippable only as a plain comment, and inputs that make something
 * public never are.
 */
export function approvalSkippable(actionSlug: string, args?: Record<string, unknown>): boolean {
  const slug = actionSlug.toUpperCase();
  if (neverSkipped(slug, args) || !actionNeedsApproval(slug, args ? { args } : {})) return false;
  if (slug.startsWith('GITHUB_') && GITHUB_COMMENT.test(slug) && args && given(args.event)) {
    return typeof args.event === 'string' && args.event.toUpperCase() === 'COMMENT';
  }
  return true;
}

/**
 * Whether the action's name says it sends to someone (an email, a message, a post, an invite), so
 * a rule for it is about who it goes to. Others (update, move, close…) change what is there.
 */
const SENDS = /(^|_)(SEND|SENDS|REPLY|FORWARD|POST|PUBLISH|TWEET|SHARE|INVITE|CREATE_EVENT)(_|$)/;
export function actionSendsToOthers(actionSlug: string): boolean {
  return SENDS.test(actionSlug.toUpperCase());
}

/** The action in words: GMAIL_SEND_EMAIL → "Send email" (the app's own prefix left out). */
export function actionWords(actionSlug: string): string {
  const slug = actionSlug.toUpperCase();
  const app = CATALOG.filter((a) => slug.startsWith(`${a.toolkit.toUpperCase()}_`)).sort(
    (a, b) => b.toolkit.length - a.toolkit.length,
  )[0];
  const rest = (app ? slug.slice(app.toolkit.length + 1) : slug).replace(/_+/g, ' ').trim();
  const lower = rest.toLowerCase();
  return lower ? lower.charAt(0).toUpperCase() + lower.slice(1) : actionSlug;
}

// --- Does an action change something? (HLD 7.2: 1 credit if it does, reading is free) ----------
//
// Decided from the action's name, word by word:
//   1. its name has a risky or a write word (or it writes a GitHub comment) → it changes something
//   2. its name has a read word and no write word             → it only reads
//   3. its name has neither: Composio's `readOnlyHint` tag    → it only reads
//   4. anything else                                          → it changes something
// So an action we can't place is charged, never the other way round.

/** Write words that aren't already in RISKY. */
const WRITES =
  /(^|_)(CREATE|CREATES|ADD|ADDS|INSERT|UPSERT|SET|EDIT|EDITS|MODIFY|PATCH|PUT|WRITE|APPEND|SAVE|UPLOAD|UPLOADS|IMPORT|COPY|DUPLICATE|RENAME|REPLACE|CLEAR|CLEARS|RESET|MARK|ASSIGN|UNASSIGN|ENABLE|DISABLE|RESTORE|UNTRASH|UNARCHIVE|SUBMIT|APPROVE|REJECT|RESOLVE|COMPLETE|REOPEN|LOCK|UNLOCK|SUBSCRIBE|UNSUBSCRIBE|JOIN|LEAVE|REVOKE|GRANT)(_|$)/;

/** Words that only ever read. Ambiguous ones (CHECK: "check off a task") are left out. */
const READS =
  /(^|_)(GET|LIST|SEARCH|FIND|FETCH|READ|RETRIEVE|QUERY|LOOKUP|COUNT|DESCRIBE|VIEW|SHOW|DOWNLOAD|EXPORT|PREVIEW)(_|$)/;

export type ActionKind = 'changes' | 'reads' | 'unknown';

/**
 * GitHub actions that write a comment or a review (their name has COMMENT or REVIEW and isn't a
 * read). Other people read those, so they need approval like sending a message (HLD 5.1). The one
 * exception is a repo with pull-request review on (`prCommentTarget` below, HLD 0.8).
 */
const GITHUB_COMMENT = /(^|_)(COMMENT|COMMENTS|REVIEW|REVIEWS)(_|$)/;

function writesGithubComment(slug: string): boolean {
  if (!slug.startsWith('GITHUB_') || !GITHUB_COMMENT.test(slug)) return false;
  const onlyReads = READS.test(slug) && !WRITES.test(slug) && !RISKY.test(slug);
  return !onlyReads;
}

/** What the name alone says. `unknown`: no read word and no write word. */
export function actionKindByName(actionSlug: string): ActionKind {
  const slug = actionSlug.toUpperCase();
  if (RISKY.test(slug) || WRITES.test(slug) || writesGithubComment(slug)) return 'changes';
  if (READS.test(slug)) return 'reads';
  return 'unknown';
}

/** `tags`: the tool's Composio tags, when known. They only matter for a name that says nothing. */
export function actionChangesSomething(actionSlug: string, tags: readonly string[] = []): boolean {
  const kind = actionKindByName(actionSlug);
  if (kind !== 'unknown') return kind === 'changes';
  return !tags.includes(READ_ONLY_TAG);
}

// --- Pull-request review: which comment the standing permission covers (HLD 0.8) --------------

/** The pull request a GitHub action would post a new review or comment on. */
export interface PrCommentTarget {
  owner: string;
  repo: string;
  number: number;
  /** The action names a pull request (`pull_number`). False: it takes an issue number. */
  byPullNumber: boolean;
}

/**
 * The GitHub actions the standing permission can cover, by exact name, with the argument that
 * holds the pull request's number. The list is exact on purpose: other actions also have a
 * comment word and a create word in their name (a gist comment, a team discussion comment, a
 * commit comment, a reaction) and are not a pull-request comment. An action that is not here
 * needs approval, whatever its arguments say.
 */
const PR_COMMENT_ACTIONS: Record<string, 'pull_number' | 'issue_number'> = {
  GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST: 'pull_number',
  GITHUB_SUBMIT_A_REVIEW_FOR_A_PULL_REQUEST: 'pull_number',
  GITHUB_CREATE_A_REVIEW_COMMENT_FOR_A_PULL_REQUEST: 'pull_number',
  // GitHub treats a pull request as an issue. Covered only for one the platform asked a review for.
  GITHUB_CREATE_AN_ISSUE_COMMENT: 'issue_number',
};
const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

function wholeNumber(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

const given = (v: unknown) => v !== undefined && v !== null;

/**
 * Is this GitHub action posting a NEW review or comment on a pull request, and on which one?
 * Null means "not that": the action then needs approval like any other risky one. All of these
 * must hold:
 *   - it is one of the four actions in `PR_COMMENT_ACTIONS` (so no reply, edit, delete, dismiss,
 *     merge or close, and no comment on anything that isn't a pull request);
 *   - `event` is COMMENT or not given: approving or requesting changes is not commenting (an
 *     approval can set off an auto-merge);
 *   - it is not a reply to someone's comment (`in_reply_to`);
 *   - the arguments name the repo (`owner` and `repo`, each a plain name) and the number.
 * Whether review is on for that repo is the automations module's question (`prCommentAllowed`).
 */
export function prCommentTarget(
  actionSlug: string,
  args: Record<string, unknown>,
): PrCommentTarget | null {
  const numberArg = Object.hasOwn(PR_COMMENT_ACTIONS, actionSlug.toUpperCase())
    ? PR_COMMENT_ACTIONS[actionSlug.toUpperCase()]
    : undefined;
  if (!numberArg) return null;
  if (given(args.event)) {
    if (typeof args.event !== 'string' || args.event.toUpperCase() !== 'COMMENT') return null;
  }
  if (given(args.in_reply_to)) return null;
  const { owner, repo } = args;
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) return null;
  const number = wholeNumber(args[numberArg]);
  if (number === null) return null;
  return { owner, repo, number, byPullNumber: numberArg === 'pull_number' };
}
