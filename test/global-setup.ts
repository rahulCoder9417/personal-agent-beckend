// Starts one real Postgres (embedded binaries) and one Redis for the whole test run.
// Each test file gets its own database and its own BullMQ key prefix (see test/setup.ts).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    redisUrl: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') srv.close(() => resolve(addr.port));
      else reject(new Error('no port'));
    });
  });
}

async function waitForPort(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.end();
        resolve(true);
      });
      s.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`port ${port} never opened`);
}

/**
 * embedded-postgres registers async-exit-hook, which ends the process with `process.exit(0)`
 * when Node is about to exit on its own. That turned a failed run (vitest sets
 * `process.exitCode = 1`) into exit code 0, so `pnpm test` could never fail in CI.
 * Keep the failure code.
 */
function keepFailureExitCode(): void {
  const exit = process.exit.bind(process);
  process.exit = ((code?: number | string | null) =>
    exit(code || process.exitCode || 0)) as typeof process.exit;
}

export default async function setup(project: TestProject) {
  keepFailureExitCode();
  const dir = mkdtempSync(join(tmpdir(), 'pa-test-'));
  const pgPort = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: join(dir, 'pg'),
    user: 'postgres',
    password: 'postgres',
    port: pgPort,
    persistent: false,
    onLog: () => {},
    postgresFlags: ['-c', 'max_connections=400', '-c', 'fsync=off'],
  });
  await pg.initialise();
  await pg.start();
  project.provide('pgAdminUrl', `postgresql://postgres:postgres@127.0.0.1:${pgPort}/postgres`);

  let redis: ChildProcess | undefined;
  if (process.env.TEST_REDIS_URL) {
    project.provide('redisUrl', process.env.TEST_REDIS_URL);
  } else {
    const redisPort = await freePort();
    redis = spawn(
      'redis-server',
      ['--port', String(redisPort), '--save', '', '--appendonly', 'no'],
      {
        stdio: 'ignore',
      },
    );
    await waitForPort(redisPort);
    project.provide('redisUrl', `redis://127.0.0.1:${redisPort}`);
  }

  return async () => {
    redis?.kill();
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
