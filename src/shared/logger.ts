import pino from 'pino';
import { config } from './config.ts';
import { currentRequestId } from './request-context.ts';

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
  // The code from Anthropic's sign-in page (Claude plan) must never reach a log.
  'code',
  '*.code',
  '*.*.code',
  '*.litellmKey',
  'req.headers.authorization',
  'req.headers.cookie',
];

let instance: pino.Logger | undefined;

/** The app logger config, optionally writing to `dest` (tests capture output this way). */
export function buildLogger(dest?: pino.DestinationStream, level?: string): pino.Logger {
  const options = {
    level: level ?? config().LOG_LEVEL,
    redact: { paths: redact, censor: '[redacted]' },
    base: { service: process.env.SERVICE_NAME ?? 'backend' },
    // Inside an api request, every line carries the request's id (a field the line sets wins).
    mixin: () => {
      const requestId = currentRequestId();
      return requestId ? { requestId } : {};
    },
  };
  return dest ? pino(options, dest) : pino(options);
}

export function logger(): pino.Logger {
  instance ??= buildLogger();
  return instance;
}

/** Tests: swap the logger (e.g. one that captures output). `undefined` restores the default. */
export function setLogger(l: pino.Logger | undefined): void {
  instance = l;
}
