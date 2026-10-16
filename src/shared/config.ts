import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

/** Every channel the code can serve. Which ones are on is the ENABLED_CHANNELS setting. */
export const CHANNEL_NAMES = ['telegram', 'web', 'whatsapp', 'imessage'] as const;
export type ChannelName = (typeof CHANNEL_NAMES)[number];

/** `telegram,web` → ['telegram', 'web'] (trimmed, lower-cased, no duplicates, order kept). */
const channelList = z.string().transform((value, ctx) => {
  const names = [
    ...new Set(
      value
        .split(',')
        .map((n) => n.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const unknown = names.filter((n) => !(CHANNEL_NAMES as readonly string[]).includes(n));
  if (unknown.length || names.length === 0) {
    ctx.addIssue({
      code: 'custom',
      message: unknown.length
        ? `unknown channel ${unknown.join(', ')} (use ${CHANNEL_NAMES.join(', ')})`
        : 'name at least one channel',
    });
    return z.NEVER;
  }
  return names as ChannelName[];
});

/**
 * COMPOSIO_MANAGED_APPS: `all`, or app slugs separated by commas (trimmed, lower-cased, no
 * duplicates). Empty is none. Which slugs are real apps is the integrations module's business.
 */
const managedAppList = z.string().transform((value, ctx): 'all' | string[] => {
  const names = [
    ...new Set(
      value
        .split(',')
        .map((n) => n.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (names.includes('all')) {
    if (names.length === 1) return 'all';
    ctx.addIssue({ code: 'custom', message: '`all` stands alone, without app names' });
    return z.NEVER;
  }
  const bad = names.filter((n) => !/^[a-z0-9_]{1,40}$/.test(n));
  if (bad.length) {
    ctx.addIssue({ code: 'custom', message: `not an app name: ${bad.join(', ')}` });
    return z.NEVER;
  }
  return names;
});

/**
 * COMPOSIO_TRIAL_AUTH_CONFIGS: a JSON map of app slug → Composio setup id, such as
 * `{"googlecalendar":"ac_123"}`. Empty is none. A damaged value stops the start, with the reason,
 * instead of quietly switching the trial off.
 */
const trialAuthConfigMap = z.string().transform((value, ctx): Record<string, string> => {
  if (!value.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'not JSON: write it as {"googlecalendar":"ac_…"}' });
    return z.NEVER;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    ctx.addIssue({ code: 'custom', message: 'must be a JSON object: {"googlecalendar":"ac_…"}' });
    return z.NEVER;
  }
  const out: Record<string, string> = {};
  for (const [app, id] of Object.entries(parsed)) {
    if (!/^[a-z0-9_]{1,40}$/.test(app)) {
      ctx.addIssue({ code: 'custom', message: `not an app name: ${app}` });
      return z.NEVER;
    }
    if (typeof id !== 'string' || !/^ac_[A-Za-z0-9_-]{1,100}$/.test(id)) {
      ctx.addIssue({ code: 'custom', message: `${app}: a Composio setup id starts with ac_` });
      return z.NEVER;
    }
    out[app] = id;
  }
  return out;
});

/**
 * COMPOSIO_TRIAL_USERS: who gets the trial setups, as user ids (`usr_…`) and emails separated by
 * commas (trimmed; emails lower-cased; no duplicates). Empty is nobody.
 */
const trialUserList = z.string().transform((value, ctx): string[] => {
  const items = value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (v.includes('@') ? v.toLowerCase() : v));
  const bad = items.filter(
    (v) => !/^usr_[0-9a-z]{10,40}$/.test(v) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  );
  if (bad.length) {
    ctx.addIssue({ code: 'custom', message: `not a user id or an email: ${bad.join(', ')}` });
    return z.NEVER;
  }
  return [...new Set(items)];
});

/** The crew's specialists (HLD 0.7). The lead, Tex, is always there. */
export const SPECIALIST_IDS = ['byte', 'patch', 'scout'] as const;
export type SpecialistId = (typeof SPECIALIST_IDS)[number];

/** `byte,patch` → ['byte', 'patch']; `none` → []. */
const specialistList = z.string().transform((value, ctx) => {
  const names = [
    ...new Set(
      value
        .split(',')
        .map((n) => n.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (names.length === 1 && names[0] === 'none') return [] as SpecialistId[];
  const unknown = names.filter((n) => !(SPECIALIST_IDS as readonly string[]).includes(n));
  if (unknown.length || names.length === 0) {
    ctx.addIssue({
      code: 'custom',
      message: unknown.length
        ? `unknown crew member ${unknown.join(', ')} (use ${SPECIALIST_IDS.join(', ')} or none)`
        : `name at least one of ${SPECIALIST_IDS.join(', ')}, or none`,
    });
    return z.NEVER;
  }
  return names as SpecialistId[];
});

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PORT: z.coerce.number().int().default(8080),

  DATABASE_URL: z.string().url(),
  /**
   * Database connections each process keeps open even when idle. A page of the web app asks for
   * several things at once, and opening a connection to Neon costs 1.5 to 2.5 s. 0: none kept.
   */
  DB_POOL_MIN: z.coerce.number().int().min(0).max(20).default(10),
  /** How often the idle connections are checked with a tiny query (0: never). */
  DB_PING_SECONDS: z.coerce.number().int().min(0).default(60),
  REDIS_URL: z.string().url(),
  /** Prefix for every BullMQ key (lets tests share one Redis). */
  QUEUE_PREFIX: z.string().default('pa'),

  /** Public https base of the api (used in links sent to users). */
  PUBLIC_API_URL: z.string().url().default('http://localhost:8080'),
  /** How containers reach the api through the egress proxy (only /mcp is allowed). */
  INTERNAL_API_URL: z.string().url().default('http://api:8080'),
  /** The web app (link instructions, checkout return, connect return). */
  WEB_APP_URL: z.string().url().default('http://localhost:3000'),

  /** 32 bytes, base64. Encrypts secret columns (AES-256-GCM). */
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64'),

  CLERK_SECRET_KEY: optional,
  /** PEM public key for networkless session verification (optional). */
  CLERK_JWT_KEY: optional,
  CLERK_WEBHOOK_SECRET: optional,
  CLERK_AUTHORIZED_PARTIES: optional,

  VM_MANAGER_URL: z.string().url().default('http://localhost:9090'),
  /** Shared with the vm-manager (it requires 32+ chars). */
  VM_INTERNAL_SECRET: z.string().min(32),

  LITELLM_URL: z.string().url().default('http://localhost:4000'),
  LITELLM_MASTER_KEY: optional,
  LITELLM_CHEAP_MODEL: z.string().default('cheap'),
  /** Comma-separated model names allowed on paid plans (plus the cheap one). */
  LITELLM_PAID_MODELS: z.string().default('cheap,claude,gpt'),
  /** The model name every container calls (vm-manager LITELLM_MODEL); a per-key alias. */
  LITELLM_AGENT_MODEL: z.string().default('agent-default'),
  /** What the agent model means on paid plans (Free: LITELLM_CHEAP_MODEL). */
  LITELLM_PREMIUM_MODEL: z.string().default('claude'),

  /**
   * The channels that are switched on, comma-separated (HLD 0.3). Launch: Telegram and the web
   * app. A channel that is off can't be linked, its webhook does no work, nothing is sent to it.
   */
  ENABLED_CHANNELS: z.string().default('telegram,web').pipe(channelList),

  TELEGRAM_BOT_TOKEN: optional,
  TELEGRAM_WEBHOOK_SECRET: optional,
  TELEGRAM_BOT_USERNAME: optional,
  TELEGRAM_API_URL: z.string().url().default('https://api.telegram.org'),
  /**
   * Show "typing…" in a Telegram chat while the agent works on a message from it (the Bot API's
   * sendChatAction, sent again every 4 seconds). Default on; `false` turns it off.
   */
  TELEGRAM_TYPING: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),

  WHATSAPP_ACCESS_TOKEN: optional,
  WHATSAPP_PHONE_NUMBER_ID: optional,
  WHATSAPP_APP_SECRET: optional,
  WHATSAPP_VERIFY_TOKEN: optional,
  WHATSAPP_DISPLAY_NUMBER: optional,
  WHATSAPP_API_URL: z.string().url().default('https://graph.facebook.com/v21.0'),
  WHATSAPP_TEMPLATE_REMINDER: z.string().default('reminder'),
  WHATSAPP_TEMPLATE_APPROVAL: z.string().default('approval_needed'),
  WHATSAPP_TEMPLATE_TASK_DONE: z.string().default('task_done'),
  WHATSAPP_TEMPLATE_LANG: z.string().default('en'),

  SENDBLUE_API_KEY: optional,
  SENDBLUE_API_SECRET: optional,
  SENDBLUE_SIGNING_SECRET: optional,
  SENDBLUE_NUMBER: optional,
  SENDBLUE_API_URL: z.string().url().default('https://api.sendblue.co'),

  COMPOSIO_API_KEY: optional,
  COMPOSIO_WEBHOOK_SECRET: optional,
  COMPOSIO_API_URL: z.string().url().default('https://backend.composio.dev'),
  /** JSON map of app slug → Composio auth config id, e.g. {"gmail":"ac_123"}. */
  COMPOSIO_AUTH_CONFIGS: optional,
  /**
   * Apps whose Composio setup the server may make by itself, with Composio's shared sign-in, the
   * first time someone connects them: `all`, or app slugs such as `googlecalendar,notion`.
   * Empty: none. COMPOSIO_AUTH_CONFIGS wins for an app named in both.
   */
  COMPOSIO_MANAGED_APPS: managedAppList.default([]),
  /**
   * A second setup per app, for the users in COMPOSIO_TRIAL_USERS only: our own sign-in app at a
   * provider while it is still being tried or reviewed (docs/composio.md, section 9). Everyone
   * else keeps the app's usual setup. For those users it wins over every other setup.
   */
  COMPOSIO_TRIAL_AUTH_CONFIGS: trialAuthConfigMap.default({}),
  /** The users who connect with COMPOSIO_TRIAL_AUTH_CONFIGS: user ids, or verified emails. */
  COMPOSIO_TRIAL_USERS: trialUserList.default([]),

  /** TypeSafe API root for Jev routing (default https://api.typesafe.ai, or LiteLLM's /typesafe pass-through). */
  JEV_URL: optional,
  /** Routing is on only when this is set; without it every message is a task. */
  JEV_API_KEY: optional,
  JEV_MODEL: z.string().default('jev-latest'),
  /** Jev is sub-second; past this the message is simply treated as a task. */
  JEV_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  /**
   * Start waking the container while Jev decides, so a task does not wait for the routing and the
   * wake one after the other. A message that turns out simple leaves the container idling until
   * its idle stop (awake time is charged as usual). Default on; `false` wakes only for tasks.
   */
  WAKE_WHILE_ROUTING: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
  /**
   * Whether automations with steps run (docs/backend-report.md, "Automations with steps"). Off:
   * they can still be proposed, made and changed, but a run does nothing and one line in the
   * Automations chat says steps are switched off. Default on; `false` switches them off.
   */
  AUTOMATION_STEPS: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
  /** Speech-to-text (OpenAI-compatible /audio/transcriptions), via LiteLLM by default. */
  STT_MODEL: z.string().default('whisper'),

  /** Polar organization access token (Core API: checkouts, cancel at period end). */
  POLAR_ACCESS_TOKEN: optional,
  /** The webhook endpoint's `whsec_…` secret from the Polar dashboard, as-is. */
  POLAR_WEBHOOK_SECRET: optional,
  /** sandbox → sandbox-api.polar.sh, production → api.polar.sh (tokens differ per environment). */
  POLAR_SERVER: z.enum(['sandbox', 'production']).default('sandbox'),
  POLAR_PRODUCT_PRO: optional,
  POLAR_PRODUCT_MAX: optional,
  POLAR_PRODUCT_TOPUP_10: optional,
  /** Polar discount id for the waitlist offer: 50% off, once (first billing cycle only). */
  POLAR_WAITLIST_DISCOUNT_ID: optional,
  /**
   * Auto top-up: Pro and Max users may let Polar charge their saved card for a top-up when their
   * balance drops under a line they pick. Needs Polar's off-session charges (in preview, switched
   * on by Polar for the organization). Off by default: the API says it is not available, the web
   * app hides it, and no auto top-up job charges anything.
   */
  AUTO_TOPUP_ENABLED: bool,

  /**
   * Who may pay for the AI. `platform`: Hermes on platform credits when the user brings nothing.
   * `own_only` (MVP): the user must bring their own AI (an API key or their Claude plan).
   */
  AI_ACCESS_MODE: z.enum(['platform', 'own_only']).default('platform'),

  /**
   * The specialists that are switched on, comma-separated: byte, patch, scout (or `none`). They
   * live in the agent image, which the backend can't see, so this says what the apps may show as
   * available (HLD 0.7).
   */
  CREW_AVAILABLE: z.string().default('byte,patch,scout').pipe(specialistList),

  /**
   * The deployed agent image has Scout's browser (HLD 11.3). The image is deployed apart from the
   * backend, which can't see it, so this says so. Off by default: until it is on, no container's
   * browser is switched on (whatever the plan) and the apps don't show a browser as available.
   */
  BROWSER_AVAILABLE: bool,

  /**
   * Scout's web search through Textcrew (HLD 5.1; a Max feature). The provider behind the
   * `web_search` platform tool.
   */
  WEB_SEARCH_PROVIDER: z.enum(['brave']).default('brave'),
  /** Without it `web_search` answers that search isn't set up; nothing else changes. */
  BRAVE_SEARCH_API_KEY: optional,
  BRAVE_SEARCH_API_URL: z.string().url().default('https://api.search.brave.com'),
  /**
   * The cost a search is charged for, in dollars: the user pays it × 2.5 as a paid tool (HLD 7.2).
   * 0.004 × 2.5 = $0.01, so a search is exactly 1 credit, the decided price (2026-10-04). It is
   * what the price is worked out from, not Brave's bill ($0.005 a search). 0 makes search free.
   */
  WEB_SEARCH_COST_USD: z.coerce.number().min(0).max(1).default(0.004),

  /** Optional monthly cap on free credits (sign-up + coupons). */
  FREE_CREDITS_MONTHLY_CAP: z.coerce.number().int().positive().optional(),

  BACKUP_DIR: z.string().default('/var/backups/personal-agent'),
  /** Where the vm-manager writes /data snapshots, as a path inside ITS SNAPSHOT_ROOT. */
  BACKUP_VOLUMES_DIR: z.string().default('/backups/volumes'),
  /** Off-server copy, run after each backup. `{dir}` and `{date}` are substituted. e.g. rclone copy {dir} b2crypt:backups/{date} */
  BACKUP_UPLOAD_CMD: optional,
  /**
   * Days the database dumps are kept (the privacy page says 7). The vm-manager deletes the archives
   * of users' files after its own SNAPSHOT_KEEP_DAYS: keep the two equal.
   */
  BACKUP_KEEP_DAYS: z.coerce.number().int().positive().default(7),
  /** Bearer token for GET /metrics (unset = endpoint disabled). */
  METRICS_TOKEN: optional,
  /** Optional webhook (e.g. Slack incoming webhook) for alerts. */
  ALERT_WEBHOOK_URL: optional,
  /** The deployed commit, passed on by deploy.sh; shown on the admin health page. */
  GIT_COMMIT: optional,
  /** Requests per minute per IP on every endpoint (specific endpoints have stricter limits). */
  RATE_LIMIT_PER_IP_PER_MIN: z.coerce.number().int().positive().default(600),
  ATTACHMENTS_DIR: z.string().default('.tmp/attachments'),
  /** Largest chat media file the worker downloads (Whisper's limit is 25 MB). */
  MEDIA_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),

  /** Trust X-Forwarded-For from Caddy. */
  TRUST_PROXY: bool,
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` (as in .env.example) means unset: defaults apply and numbers aren't coerced from "".
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = configSchema.safeParse(set);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${issues.join('\n')}`);
  }
  return parsed.data;
}

let cached: Config | undefined;

export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Tests only. */
export function resetConfig(): void {
  cached = undefined;
}

/** Is this channel switched on (ENABLED_CHANNELS)? */
export function isChannelEnabled(channel: ChannelName): boolean {
  return config().ENABLED_CHANNELS.includes(channel);
}
