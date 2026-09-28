import { reregisterAll } from '../modules/automations/automations.ts';
import { requeuePendingEvents } from '../modules/events/intake.ts';
import { closeQueues } from '../modules/events/queues.ts';
import { closeDb } from '../shared/db/client.ts';
import { logger } from '../shared/logger.ts';
import { closeRedis } from '../shared/redis.ts';
import { wireModules } from '../wiring.ts';
import { processors } from './processors.ts';
import { startWorkers } from './runner.ts';
import { registerSystemSchedules } from './schedules.ts';

process.env.SERVICE_NAME ??= 'worker';
const log = logger();
wireModules();

const workers = startWorkers(processors());
// Redis lost: rebuild jobs from `events` (jobIds dedupe anything still queued).
const requeued = await requeuePendingEvents();
// Automations: Postgres is the source of truth; re-register every enabled timer.
const automations = await reregisterAll();
await registerSystemSchedules();
log.info({ requeued, automations, queues: workers.map((w) => w.name) }, 'worker started');

async function shutdown() {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  await closeRedis();
  await closeDb();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
