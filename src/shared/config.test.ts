import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const base = {
  DATABASE_URL: 'postgresql://a:b@localhost:5432/x',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  VM_INTERNAL_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('accepts a minimal valid env and applies defaults', () => {
    const c = loadConfig(base);
    expect(c.PORT).toBe(8080);
    expect(c.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it('treats empty strings as unset for optional values', () => {
    expect(loadConfig({ ...base, TELEGRAM_BOT_TOKEN: '' }).TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it('treats empty numbers as unset (FREE_CREDITS_MONTHLY_CAP= from .env.example)', () => {
    const c = loadConfig({ ...base, FREE_CREDITS_MONTHLY_CAP: '', JEV_TIMEOUT_MS: '' });
    expect(c.FREE_CREDITS_MONTHLY_CAP).toBeUndefined();
    expect(c.JEV_TIMEOUT_MS).toBe(3000);
  });

  it('loads .env.example as-is once the one secret without a default is filled in', () => {
    const env: Record<string, string> = {};
    for (const line of readFileSync(new URL('../../.env.example', import.meta.url), 'utf8').split(
      '\n',
    )) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) env[m[1]!] = m[2]!;
    }
    expect(() => loadConfig({ ...env, ENCRYPTION_KEY: base.ENCRYPTION_KEY })).not.toThrow();
  });

  it('rejects a bad encryption key and missing required vars with a readable error', () => {
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: 'short' })).toThrow(/ENCRYPTION_KEY/);
    expect(() => loadConfig({ REDIS_URL: base.REDIS_URL })).toThrow(/DATABASE_URL/);
  });

  it('AI_ACCESS_MODE defaults to platform and accepts only platform | own_only', () => {
    expect(loadConfig(base).AI_ACCESS_MODE).toBe('platform');
    expect(loadConfig({ ...base, AI_ACCESS_MODE: 'own_only' }).AI_ACCESS_MODE).toBe('own_only');
    expect(() => loadConfig({ ...base, AI_ACCESS_MODE: 'free' })).toThrow(/AI_ACCESS_MODE/);
  });
});
