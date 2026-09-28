import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from './client.ts';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

export async function runMigrations(): Promise<void> {
  await migrate(db(), { migrationsFolder });
}
