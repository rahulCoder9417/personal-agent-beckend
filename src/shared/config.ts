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

  /** TypeSafe API root for Jev routing (default https://api.typesafe.ai, or LiteLLM's /typesafe pass-through). */
  JEV_URL: optional,
  /** Routing is on only when this is set; without it every message is a task. */
  JEV_API_KEY: optional,
  JEV_MODEL: z.string().default('jev-latest'),
  /** Jev is sub-second; past this the message is simply treated as a task. */
  JEV_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
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
  BACKUP_KEEP_DAYS: z.coerce.number().int().positive().default(7),
  /** Bearer token for GET /metrics (unset = endpoint disabled). */
  METRICS_TOKEN: optional,
  /** Optional webhook (e.g. Slack incoming webhook) for alerts. */
  ALERT_WEBHOOK_URL: optional,
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
