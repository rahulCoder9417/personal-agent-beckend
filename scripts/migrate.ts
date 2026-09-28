import { closeDb } from '../src/shared/db/client.ts';
import { runMigrations } from '../src/shared/db/migrate.ts';

await runMigrations();
await closeDb();
console.log('migrations applied');
