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
