// The ~25 apps we offer (HLD 7.1). `free: true` marks the 10 available on the Free plan.
// `toolkit` is the Composio toolkit slug; auth config ids come from COMPOSIO_AUTH_CONFIGS.
export interface CatalogApp {
  slug: string;
  name: string;
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
}

export const CATALOG: CatalogApp[] = [
  { slug: 'gmail', name: 'Gmail', category: 'email', toolkit: 'gmail', free: true },
  {
    slug: 'googlecalendar',
    name: 'Google Calendar',
    category: 'calendar',
    toolkit: 'googlecalendar',
    free: true,
  },
  {
    slug: 'googledrive',
    name: 'Google Drive',
    category: 'files',
    toolkit: 'googledrive',
    free: true,
  },
  { slug: 'googledocs', name: 'Google Docs', category: 'notes', toolkit: 'googledocs', free: true },
  {
    slug: 'googlesheets',
    name: 'Google Sheets',
    category: 'files',
    toolkit: 'googlesheets',
    free: true,
  },
  { slug: 'notion', name: 'Notion', category: 'notes', toolkit: 'notion', free: true },
  { slug: 'todoist', name: 'Todoist', category: 'tasks', toolkit: 'todoist', free: true },
  { slug: 'slack', name: 'Slack', category: 'chat', toolkit: 'slack', free: true },
  { slug: 'github', name: 'GitHub', category: 'dev', toolkit: 'github', free: true },
  { slug: 'exa', name: 'Exa Search', category: 'research', toolkit: 'exa', free: true },
  { slug: 'outlook', name: 'Outlook', category: 'email', toolkit: 'outlook', free: false },
  {
    slug: 'microsoft_teams',
    name: 'Microsoft Teams',
    category: 'chat',
    toolkit: 'microsoft_teams',
    free: false,
  },
  { slug: 'onedrive', name: 'OneDrive', category: 'files', toolkit: 'one_drive', free: false },
  { slug: 'dropbox', name: 'Dropbox', category: 'files', toolkit: 'dropbox', free: false },
  { slug: 'trello', name: 'Trello', category: 'tasks', toolkit: 'trello', free: false },
  { slug: 'asana', name: 'Asana', category: 'tasks', toolkit: 'asana', free: false },
  { slug: 'linear', name: 'Linear', category: 'dev', toolkit: 'linear', free: false },
  { slug: 'jira', name: 'Jira', category: 'dev', toolkit: 'jira', free: false },
  { slug: 'clickup', name: 'ClickUp', category: 'tasks', toolkit: 'clickup', free: false },
  { slug: 'airtable', name: 'Airtable', category: 'files', toolkit: 'airtable', free: false },
  { slug: 'hubspot', name: 'HubSpot', category: 'crm', toolkit: 'hubspot', free: false },
  { slug: 'salesforce', name: 'Salesforce', category: 'crm', toolkit: 'salesforce', free: false },
  { slug: 'calendly', name: 'Calendly', category: 'calendar', toolkit: 'calendly', free: false },
  { slug: 'zoom', name: 'Zoom', category: 'calendar', toolkit: 'zoom', free: false },
  { slug: 'linkedin', name: 'LinkedIn', category: 'social', toolkit: 'linkedin', free: false },
];

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
 * Actions that act on the outside world (send, delete, pay, share…). They only run with an
 * approved approval (HLD 10.2: approvals before sending to others, deleting or paying).
 */
const RISKY =
  /(^|_)(SEND|REPLY|FORWARD|DELETE|REMOVE|TRASH|ARCHIVE|PAY|PAYMENT|TRANSFER|CHARGE|REFUND|INVITE|SHARE|POST|PUBLISH|TWEET|MERGE|CLOSE|CANCEL|MOVE|UPDATE|CREATE_EVENT|ACCEPT|DECLINE)(_|$)/;

export function actionNeedsApproval(actionSlug: string): boolean {
  const slug = actionSlug.toUpperCase();
  return RISKY.test(slug) || writesGithubComment(slug);
}

// --- Does an action change something? (HLD 7.2: 1 credit if it does, reading is free) ----------
//
// Decided from the action's name, word by word like the risky check above:
//   1. it needs approval, or its name has a write word        → it changes something
//   2. its name has a read word and no write word             → it only reads
//   3. its name has neither: Composio's `readOnlyHint` tag    → it only reads
//   4. anything else                                          → it changes something
// So an action we can't place is charged, never the other way round.

/** Write words that aren't already in RISKY. */
const WRITES =
  /(^|_)(CREATE|ADD|INSERT|UPSERT|SET|EDIT|MODIFY|PATCH|PUT|WRITE|APPEND|SAVE|UPLOAD|IMPORT|COPY|DUPLICATE|RENAME|REPLACE|CLEAR|RESET|MARK|ASSIGN|UNASSIGN|ENABLE|DISABLE|RESTORE|UNTRASH|UNARCHIVE|SUBMIT|APPROVE|REJECT|RESOLVE|COMPLETE|REOPEN|LOCK|UNLOCK|SUBSCRIBE|UNSUBSCRIBE|JOIN|LEAVE|REVOKE|GRANT)(_|$)/;

/** Words that only ever read. Ambiguous ones (CHECK: "check off a task") are left out. */
const READS =
  /(^|_)(GET|LIST|SEARCH|FIND|FETCH|READ|RETRIEVE|QUERY|LOOKUP|COUNT|DESCRIBE|VIEW|SHOW|DOWNLOAD|EXPORT|PREVIEW)(_|$)/;

/** The tag Composio puts on tools that only read (the MCP `readOnlyHint` annotation). */
export const READ_ONLY_TAG = 'readOnlyHint';

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
