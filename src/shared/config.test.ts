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

  it('CREW_AVAILABLE defaults to the three specialists and accepts only their ids, or none', () => {
    expect(loadConfig(base).CREW_AVAILABLE).toEqual(['byte', 'patch', 'scout']);
    expect(loadConfig({ ...base, CREW_AVAILABLE: '' }).CREW_AVAILABLE).toEqual([
      'byte',
      'patch',
      'scout',
    ]);
    expect(loadConfig({ ...base, CREW_AVAILABLE: ' Patch, byte ,patch' }).CREW_AVAILABLE).toEqual([
      'patch',
      'byte',
    ]);
    expect(loadConfig({ ...base, CREW_AVAILABLE: 'none' }).CREW_AVAILABLE).toEqual([]);
    // Tex is the lead: always there, never listed.
    expect(() => loadConfig({ ...base, CREW_AVAILABLE: 'tex' })).toThrow(
      /CREW_AVAILABLE.*unknown crew member tex/,
    );
    expect(() => loadConfig({ ...base, CREW_AVAILABLE: 'byte,none' })).toThrow(/CREW_AVAILABLE/);
    expect(() => loadConfig({ ...base, CREW_AVAILABLE: ' , ' })).toThrow(/CREW_AVAILABLE/);
  });

  it('ENABLED_CHANNELS defaults to Telegram + web and accepts only known channel names', () => {
    expect(loadConfig(base).ENABLED_CHANNELS).toEqual(['telegram', 'web']);
    // Empty (as in a blank .env line) means unset: the default applies.
    expect(loadConfig({ ...base, ENABLED_CHANNELS: '' }).ENABLED_CHANNELS).toEqual([
      'telegram',
      'web',
    ]);
    expect(
      loadConfig({ ...base, ENABLED_CHANNELS: ' Telegram, web ,whatsapp,imessage,web' })
        .ENABLED_CHANNELS,
    ).toEqual(['telegram', 'web', 'whatsapp', 'imessage']);
    expect(loadConfig({ ...base, ENABLED_CHANNELS: 'web' }).ENABLED_CHANNELS).toEqual(['web']);
    expect(() => loadConfig({ ...base, ENABLED_CHANNELS: 'telegram,sms' })).toThrow(
      /ENABLED_CHANNELS.*unknown channel sms/,
    );
    expect(() => loadConfig({ ...base, ENABLED_CHANNELS: ' , ' })).toThrow(/ENABLED_CHANNELS/);
  });
});
