import { serve } from '@hono/node-server';
import { syncTelegramCommandsAtStart } from '../modules/channels/telegram-commands.ts';
import { closeQueues } from '../modules/events/queues.ts';
import { config } from '../shared/config.ts';
import { closeDb, keepDbWarm } from '../shared/db/client.ts';
import { laterSettled } from '../shared/later.ts';
import { logger } from '../shared/logger.ts';
import { closeRedis } from '../shared/redis.ts';
import { createApp } from './app.ts';

process.env.SERVICE_NAME ??= 'api';
const cfg = config();
const server = serve({ fetch: createApp().fetch, port: cfg.PORT }, (info) =>
  logger().info({ port: info.port }, 'api listening'),
);
// Database connections opened now and kept open, so a page doesn't wait for new ones.
void keepDbWarm();
// The Telegram bot's "/" menu (/new, /help), set only when Telegram's copy differs.
void syncTelegramCommandsAtStart();

async function shutdown() {
  server.close();
  // Writes the answers did not wait for (a tool call's activity-log entry, an event's mark).
  await laterSettled();
  await closeQueues();
  await closeRedis();
  await closeDb();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
