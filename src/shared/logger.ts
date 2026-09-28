import pino from 'pino';
import { config } from './config.ts';

// No secrets in logs (CLAUDE.md): redact anything that looks like a credential.
const redact = [
  '*.password',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.secret',
  '*.authSecret',
  '*.auth_secret',
  '*.authorization',
  '*.Authorization',
  '*.code',
  '*.litellmKey',
  'req.headers.authorization',
  'req.headers.cookie',
];

let instance: pino.Logger | undefined;

export function logger(): pino.Logger {
  instance ??= pino({
    level: config().LOG_LEVEL,
    redact: { paths: redact, censor: '[redacted]' },
    base: { service: process.env.SERVICE_NAME ?? 'backend' },
  });
  return instance;
}
