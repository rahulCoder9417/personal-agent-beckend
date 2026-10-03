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
  return RISKY.test(actionSlug.toUpperCase());
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

/** What the name alone says. `unknown`: no read word and no write word. */
export function actionKindByName(actionSlug: string): ActionKind {
  const slug = actionSlug.toUpperCase();
  if (RISKY.test(slug) || WRITES.test(slug)) return 'changes';
  if (READS.test(slug)) return 'reads';
  return 'unknown';
}

/** `tags`: the tool's Composio tags, when known. They only matter for a name that says nothing. */
export function actionChangesSomething(actionSlug: string, tags: readonly string[] = []): boolean {
  const kind = actionKindByName(actionSlug);
  if (kind !== 'unknown') return kind === 'changes';
  return !tags.includes(READ_ONLY_TAG);
}
