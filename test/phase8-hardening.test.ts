import { mkdtemp, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pgDumpConnection, runBackup, setCommandRunner } from '../src/modules/admin/backup.ts';
import { handleHealthCheck } from '../src/modules/admin/health.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { setVmClient, type VmClient } from '../src/modules/orchestrator/vm.ts';
import { resetConfig } from '../src/shared/config.ts';
import { call, testApp } from './helpers.ts';

afterAll(closeQueues);

describe('backups', () => {
  it('dumps Postgres, snapshots every volume, uploads off-server and keeps N days', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'backup-'));
    await mkdir(join(dir, '2020-01-01'));
    process.env.BACKUP_DIR = dir;
    process.env.BACKUP_UPLOAD_CMD = 'rclone copy {dir} b2crypt:pa/{date}';
    resetConfig();
    const commands: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];
    setCommandRunner(
      async (cmd, args, env) => void commands.push({ cmd, args, ...(env ? { env } : {}) }),
    );
    const snapshots: string[] = [];
    setVmClient({
      async listSandboxes() {
        return { sandboxes: [{ userId: 'usr_a' }, { userId: 'usr_b' }] };
      },
      async snapshotVolume(req: { userId: string }) {
        if (req.userId === 'usr_b') throw new Error('disk full');
        snapshots.push(req.userId);
        return { location: 'x', sizeBytes: 1n };
      },
    } as unknown as VmClient);
    try {
      const res = await runBackup(new Date('2026-10-01T02:00:00Z'));
      expect(res.dir).toBe(join(dir, '2026-10-01'));
      expect(commands[0]!.cmd).toBe('pg_dump');
      // The database password never appears in the arguments.
      expect(commands[0]!.args.join(' ')).not.toContain('postgres@');
      expect(commands[0]!.env?.PGPASSWORD).toBe('postgres');
      expect(commands[1]).toEqual({
        cmd: 'sh',
        args: ['-c', `rclone copy ${join(dir, '2026-10-01')} b2crypt:pa/2026-10-01`],
      });
      expect(snapshots).toEqual(['usr_a']);
      expect(res.failures).toEqual(['usr_b']);
      expect(await readdir(dir)).toEqual(['2026-10-01']);
    } finally {
      setCommandRunner(undefined);
      delete process.env.BACKUP_DIR;
      delete process.env.BACKUP_UPLOAD_CMD;
      resetConfig();
    }
  });

  it('pg_dump reaches Neon with its TLS settings, the password only in the environment', () => {
    const { dbname, env } = pgDumpConnection(
      'postgresql://owner:p%40ss@ep-x-1.us-east-2.aws.neon.tech/agent?sslmode=verify-full&channel_binding=require',
    );
    expect(dbname).toBe('agent');
    expect(env).toEqual({
      PGHOST: 'ep-x-1.us-east-2.aws.neon.tech',
      PGPORT: '5432',
      PGUSER: 'owner',
      PGPASSWORD: 'p@ss',
      PGSSLMODE: 'verify-full',
      PGCHANNELBINDING: 'require',
      // libpq needs a root certificate for verify-full: the system's.
      PGSSLROOTCERT: 'system',
    });
    // A named root certificate is kept; `require` needs none.
    expect(
      pgDumpConnection('postgresql://a:b@h/x?sslmode=verify-ca&sslrootcert=/ca.pem').env
        .PGSSLROOTCERT,
    ).toBe('/ca.pem');
    expect(pgDumpConnection('postgresql://a:b@h:6543/x?sslmode=require').env).toMatchObject({
      PGPORT: '6543',
      PGSSLMODE: 'require',
    });
    expect(pgDumpConnection('postgresql://a:b@h/x?sslmode=require').env.PGSSLROOTCERT).toBe(
      undefined,
    );
    // The laptop's local database: no TLS settings at all.
    const local = pgDumpConnection('postgresql://agent:agent@localhost:5432/agent').env;
    expect(Object.keys(local).sort()).toEqual(['PGHOST', 'PGPASSWORD', 'PGPORT', 'PGUSER']);
  });
});

describe('ops endpoints and limits', () => {
  it('/metrics needs the metrics token', async () => {
    expect((await call('/metrics')).status).toBe(404);
    process.env.METRICS_TOKEN = 'm-token';
    resetConfig();
    try {
      expect((await call('/metrics', { headers: { authorization: 'Bearer wrong' } })).status).toBe(
        404,
      );
      await call('/healthz');
      const res = await call('/metrics', { headers: { authorization: 'Bearer m-token' } });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('http_requests_total');
      expect(text).toContain('bullmq_jobs{queue="inbound"');
    } finally {
      delete process.env.METRICS_TOKEN;
      resetConfig();
    }
  });

  it('rate limits by client IP', async () => {
    process.env.RATE_LIMIT_PER_IP_PER_MIN = '5';
    process.env.TRUST_PROXY = 'true';
    resetConfig();
    try {
      const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        statuses.push(
          (await testApp().request('/healthz', { headers: { 'x-forwarded-for': ip } })).status,
        );
      }
      expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
      expect(statuses[6]).toBe(429);
      const other = await testApp().request('/healthz', {
        headers: { 'x-forwarded-for': '198.51.100.7' },
      });
      expect(other.status).toBe(200);
    } finally {
      delete process.env.RATE_LIMIT_PER_IP_PER_MIN;
      delete process.env.TRUST_PROXY;
      resetConfig();
    }
  });

  it('health check alerts when the vm-manager is unreachable', async () => {
    setVmClient({
      async listSandboxes() {
        throw new Error('connect ECONNREFUSED');
      },
    } as unknown as VmClient);
    const res = (await handleHealthCheck()) as { problems: string[] };
    expect(res.problems.join()).toContain('vm-manager unreachable');
  });
});

describe('schedules', () => {
  it('registers every repeating system job', async () => {
    const { registerSystemSchedules } = await import('../src/worker/schedules.ts');
    const { registerBillingSchedules } = await import('../src/modules/billing/jobs.ts');
    const { queue } = await import('../src/modules/events/queues.ts');
    await registerSystemSchedules();
    await registerBillingSchedules();
    const ids = (await queue('system').getJobSchedulers()).map((s) => s.key ?? s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'expire-approvals',
        'cleanup',
        'backup',
        'health-check',
        'sync-usage',
        'expire-credits',
      ]),
    );
  });
});
