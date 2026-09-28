import { spawn } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../shared/config.ts';
import { logger } from '../../shared/logger.ts';
import { vm } from '../orchestrator/vm.ts';
import { alert } from './alerts.ts';

export type CommandRunner = (
  cmd: string,
  args: string[],
  env?: Record<string, string>,
) => Promise<void>;

const realRunner: CommandRunner = (cmd, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 500)}`)),
    );
  });

let runner: CommandRunner = realRunner;
/** Tests: fake pg_dump / upload. */
export function setCommandRunner(r: CommandRunner | undefined): void {
  runner = r ?? realRunner;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * system/backup (nightly): Postgres dump + a /data snapshot of every sandbox → off-server copy.
 * Keeps BACKUP_KEEP_DAYS days locally. Safe to re-run (same date = same folder, overwritten).
 */
export async function runBackup(
  now = new Date(),
): Promise<{ dir: string; snapshots: number; failures: string[] }> {
  const c = config();
  const date = day(now);
  const dir = join(c.BACKUP_DIR, date);
  await mkdir(dir, { recursive: true });

  // 1. Postgres (custom format, restorable with pg_restore). The URL goes via env, never args/logs.
  const url = new URL(c.DATABASE_URL);
  await runner(
    'pg_dump',
    [
      '--format=custom',
      '--no-owner',
      `--file=${join(dir, 'postgres.dump')}`,
      '--dbname',
      url.pathname.slice(1),
    ],
    {
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
    },
  );

  // 2. Every user's /data volume, via the vm-manager (it alone touches Docker).
  const failures: string[] = [];
  const { sandboxes } = await vm().listSandboxes({ states: [] });
  for (const s of sandboxes) {
    try {
      await vm().snapshotVolume({
        userId: s.userId,
        destination: join(c.BACKUP_VOLUMES_DIR, date),
      });
    } catch (err) {
      failures.push(s.userId);
      logger().warn({ userId: s.userId, err: String(err) }, 'snapshot failed');
    }
  }

  // 3. Off-server (e.g. rclone to an encrypted B2 remote).
  if (c.BACKUP_UPLOAD_CMD) {
    const cmd = c.BACKUP_UPLOAD_CMD.replaceAll('{dir}', dir).replaceAll('{date}', date);
    await runner('sh', ['-c', cmd]);
  }

  // 4. Local retention.
  const keepAfter = new Date(now.getTime() - c.BACKUP_KEEP_DAYS * 86400_000);
  for (const name of await readdir(c.BACKUP_DIR).catch(() => [] as string[])) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(name) && new Date(`${name}T00:00:00Z`) < keepAfter) {
      await rm(join(c.BACKUP_DIR, name), { recursive: true, force: true });
    }
  }

  if (failures.length) await alert('Backup: some volume snapshots failed', { failures });
  return { dir, snapshots: sandboxes.length - failures.length, failures };
}

export async function handleBackup(): Promise<unknown> {
  try {
    return await runBackup();
  } catch (err) {
    await alert('Nightly backup failed', { err: String(err) });
    throw err;
  }
}
