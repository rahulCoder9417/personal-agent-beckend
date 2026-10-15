// The settings page for admins (`GET /v1/admin/config`), read-only. Built from two fixed lists,
// never by reading the whole environment: SETTINGS are shown with their value (addresses without
// any user name or password in them), SECRETS only say whether they are set. A setting in neither
// list is not shown at all.
import { config, type Config } from '../../shared/config.ts';
import { appSetups, type AppSetupRow } from '../integrations/app-setups.ts';

export type SettingValue = string | number | boolean | string[] | null;

export interface SettingView {
  name: string;
  group: string;
  value: SettingValue;
  note?: string;
}

/** An address without its user name, password, query or fragment. */
function cleanUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return null;
  }
}

const list = (raw: string) =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** COMPOSIO_AUTH_CONFIGS: the app names only, never the setup ids. */
function authConfigApps(raw: string | undefined): Noted {
  if (!raw) return { value: null };
  try {
    return {
      value: Object.keys(JSON.parse(raw) as Record<string, unknown>).sort(),
      note: 'app names only; the setup ids are not shown',
    };
  } catch {
    return { value: null, note: 'set, but not valid JSON: no app can use it' };
  }
}

type Noted = { value: SettingValue; note?: string };
type Setting = [name: string, group: string, read: (c: Config) => SettingValue | Noted];

/** The settings that are not secret and shape how the backend behaves. */
export const SETTINGS: Setting[] = [
  ['NODE_ENV', 'server', (c) => c.NODE_ENV],
  ['LOG_LEVEL', 'server', (c) => c.LOG_LEVEL],
  ['GIT_COMMIT', 'server', (c) => c.GIT_COMMIT ?? null],
  ['PUBLIC_API_URL', 'addresses', (c) => cleanUrl(c.PUBLIC_API_URL)],
  ['WEB_APP_URL', 'addresses', (c) => cleanUrl(c.WEB_APP_URL)],
  ['INTERNAL_API_URL', 'addresses', (c) => cleanUrl(c.INTERNAL_API_URL)],
  ['VM_MANAGER_URL', 'addresses', (c) => cleanUrl(c.VM_MANAGER_URL)],
  ['LITELLM_URL', 'addresses', (c) => cleanUrl(c.LITELLM_URL)],
  ['COMPOSIO_API_URL', 'addresses', (c) => cleanUrl(c.COMPOSIO_API_URL)],
  ['JEV_URL', 'addresses', (c) => cleanUrl(c.JEV_URL)],
  ['TRUST_PROXY', 'addresses', (c) => c.TRUST_PROXY],
  [
    'CLERK_AUTHORIZED_PARTIES',
    'sign-in',
    (c) => (c.CLERK_AUTHORIZED_PARTIES ? list(c.CLERK_AUTHORIZED_PARTIES) : null),
  ],
  ['ENABLED_CHANNELS', 'channels', (c) => [...c.ENABLED_CHANNELS]],
  ['TELEGRAM_BOT_USERNAME', 'channels', (c) => c.TELEGRAM_BOT_USERNAME ?? null],
  ['TELEGRAM_TYPING', 'channels', (c) => c.TELEGRAM_TYPING],
  ['WHATSAPP_DISPLAY_NUMBER', 'channels', (c) => c.WHATSAPP_DISPLAY_NUMBER ?? null],
  ['SENDBLUE_NUMBER', 'channels', (c) => c.SENDBLUE_NUMBER ?? null],
  ['AI_ACCESS_MODE', 'models', (c) => c.AI_ACCESS_MODE],
  ['LITELLM_CHEAP_MODEL', 'models', (c) => c.LITELLM_CHEAP_MODEL],
  ['LITELLM_PREMIUM_MODEL', 'models', (c) => c.LITELLM_PREMIUM_MODEL],
  ['LITELLM_AGENT_MODEL', 'models', (c) => c.LITELLM_AGENT_MODEL],
  ['LITELLM_PAID_MODELS', 'models', (c) => list(c.LITELLM_PAID_MODELS)],
  ['STT_MODEL', 'models', (c) => c.STT_MODEL],
  ['JEV_MODEL', 'routing', (c) => c.JEV_MODEL],
  ['JEV_TIMEOUT_MS', 'routing', (c) => c.JEV_TIMEOUT_MS],
  ['WAKE_WHILE_ROUTING', 'routing', (c) => c.WAKE_WHILE_ROUTING],
  [
    'COMPOSIO_MANAGED_APPS',
    'apps',
    (c) => (c.COMPOSIO_MANAGED_APPS === 'all' ? 'all' : [...c.COMPOSIO_MANAGED_APPS]),
  ],
  ['COMPOSIO_AUTH_CONFIGS', 'apps', (c) => authConfigApps(c.COMPOSIO_AUTH_CONFIGS)],
  ['CREW_AVAILABLE', 'crew', (c) => [...c.CREW_AVAILABLE]],
  ['BROWSER_AVAILABLE', 'crew', (c) => c.BROWSER_AVAILABLE],
  ['WEB_SEARCH_PROVIDER', 'web search', (c) => c.WEB_SEARCH_PROVIDER],
  ['WEB_SEARCH_COST_USD', 'web search', (c) => c.WEB_SEARCH_COST_USD],
  ['POLAR_SERVER', 'payments', (c) => c.POLAR_SERVER],
  ['POLAR_PRODUCT_PRO', 'payments', (c) => c.POLAR_PRODUCT_PRO ?? null],
  ['POLAR_PRODUCT_MAX', 'payments', (c) => c.POLAR_PRODUCT_MAX ?? null],
  ['POLAR_PRODUCT_TOPUP_10', 'payments', (c) => c.POLAR_PRODUCT_TOPUP_10 ?? null],
  ['POLAR_WAITLIST_DISCOUNT_ID', 'payments', (c) => c.POLAR_WAITLIST_DISCOUNT_ID ?? null],
  ['FREE_CREDITS_MONTHLY_CAP', 'credits', (c) => c.FREE_CREDITS_MONTHLY_CAP ?? null],
  ['RATE_LIMIT_PER_IP_PER_MIN', 'limits', (c) => c.RATE_LIMIT_PER_IP_PER_MIN],
  ['MEDIA_MAX_BYTES', 'limits', (c) => c.MEDIA_MAX_BYTES],
  ['BACKUP_KEEP_DAYS', 'backups', (c) => c.BACKUP_KEEP_DAYS],
  ['BACKUP_DIR', 'backups', (c) => c.BACKUP_DIR],
  ['BACKUP_VOLUMES_DIR', 'backups', (c) => c.BACKUP_VOLUMES_DIR],
];

/** Secrets: only whether each is set is ever shown. */
export const SECRETS = [
  'DATABASE_URL',
  'REDIS_URL',
  'ENCRYPTION_KEY',
  'CLERK_SECRET_KEY',
  'CLERK_JWT_KEY',
  'CLERK_WEBHOOK_SECRET',
  'VM_INTERNAL_SECRET',
  'LITELLM_MASTER_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'SENDBLUE_API_KEY',
  'SENDBLUE_API_SECRET',
  'SENDBLUE_SIGNING_SECRET',
  'COMPOSIO_API_KEY',
  'COMPOSIO_WEBHOOK_SECRET',
  'JEV_API_KEY',
  'POLAR_ACCESS_TOKEN',
  'POLAR_WEBHOOK_SECRET',
  'BRAVE_SEARCH_API_KEY',
  'METRICS_TOKEN',
  'ALERT_WEBHOOK_URL',
  'BACKUP_UPLOAD_CMD',
] as const satisfies ReadonlyArray<keyof Config>;

export interface ConfigView {
  environment: Config['NODE_ENV'];
  settings: SettingView[];
  secrets: Array<{ name: string; set: boolean }>;
  apps: AppSetupRow[];
}

export async function configView(): Promise<ConfigView> {
  const c = config();
  const settings: SettingView[] = SETTINGS.map(([name, group, read]) => {
    const v = read(c);
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? { name, group, ...v }
      : { name, group, value: v };
  });
  settings.push({
    name: 'AWAKE_CAP',
    group: 'vm-manager',
    value: null,
    note: "the vm-manager's own setting (20 if not set); the backend cannot read it",
  });
  return {
    environment: c.NODE_ENV,
    settings,
    secrets: SECRETS.map((name) => ({ name, set: Boolean(c[name]) })),
    apps: await appSetups(),
  };
}
