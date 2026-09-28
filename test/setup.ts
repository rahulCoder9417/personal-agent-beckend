// Per test file: a fresh database with all migrations, and a unique queue prefix.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, inject } from 'vitest';
import { resetConfig } from '../src/shared/config.ts';

const suffix = randomBytes(6).toString('hex');
// Clerk session tokens in tests are signed with this key pair (networkless verification).
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const dbName = `t_${suffix}`;
const adminUrl = inject('pgAdminUrl');
const dbUrl = adminUrl.replace(/\/postgres$/, `/${dbName}`);

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
  DATABASE_URL: dbUrl,
  REDIS_URL: inject('redisUrl'),
  QUEUE_PREFIX: `t${suffix}`,
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  VM_INTERNAL_SECRET: 'test-internal-secret-0123456789',
  CLERK_WEBHOOK_SECRET: 'whsec_' + Buffer.from('clerk-test-secret-0123456789').toString('base64'),
  PUBLIC_API_URL: 'http://api.test',
  WEB_APP_URL: 'http://web.test',
  TELEGRAM_WEBHOOK_SECRET: 'tg-secret',
  TELEGRAM_BOT_USERNAME: 'agent_bot',
  ATTACHMENTS_DIR: `.tmp/test-attachments/${suffix}`,
  CLERK_JWT_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  TEST_JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
});
resetConfig();

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const { runMigrations } = await import('../src/shared/db/migrate.ts');
  await runMigrations();
});

afterAll(async () => {
  const { closeDb } = await import('../src/shared/db/client.ts');
  const { closeRedis } = await import('../src/shared/redis.ts');
  await closeDb();
  await closeRedis();
});
