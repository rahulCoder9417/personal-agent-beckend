import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

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

  DODO_API_KEY: optional,
  DODO_WEBHOOK_SECRET: optional,
  DODO_API_URL: z.string().url().default('https://test.dodopayments.com'),
  DODO_PRODUCT_PRO: optional,
  DODO_PRODUCT_MAX: optional,
  DODO_PRODUCT_TOPUP_10: optional,

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
  const parsed = configSchema.safeParse(env);
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
