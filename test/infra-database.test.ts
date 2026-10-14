// The databases live on Neon on the server; the compose `postgres` is for the laptop only.
// Docker isn't available in the test run, so this reads the compose file and the deploy scripts,
// and runs move-to-neon.sh only as far as its checks that need no database.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
type Service = {
  environment?: Record<string, string>;
  depends_on?: Record<string, { required?: boolean }>;
  profiles?: string[];
};
const compose = parse(read('../infra/docker-compose.yml')) as { services: Record<string, Service> };
const s = compose.services;

describe('compose: database addresses', () => {
  it('the local postgres starts only with the localdb profile', () => {
    expect(s.postgres!.profiles).toEqual(['localdb']);
  });

  it.each([
    ['api', 'BACKEND_DATABASE_URL', 'agent'],
    ['worker', 'BACKEND_DATABASE_URL', 'agent'],
    ['vm-manager', 'VM_MANAGER_DATABASE_URL', 'vm_manager'],
    ['litellm', 'LITELLM_DATABASE_URL', 'litellm'],
  ])('%s takes its database from %s, the local one by default', (svc, variable, db) => {
    expect(s[svc]!.environment!.DATABASE_URL).toBe(
      `\${${variable}:-postgresql://\${POSTGRES_USER:-agent}:\${POSTGRES_PASSWORD:-agent}@postgres:5432/${db}}`,
    );
    // It waits for the local postgres only when that runs.
    expect(s[svc]!.depends_on!.postgres).toMatchObject({ required: false });
  });

  it('no service hard-codes the local database any more', () => {
    for (const [name, svc] of Object.entries(s))
      for (const value of Object.values(svc.environment ?? {}))
        if (String(value).includes('@postgres:'))
          expect(String(value), name).toMatch(/^\$\{[A-Z_]+_DATABASE_URL:-/);
  });
});

describe('deploy.sh', () => {
  const deploy = read('../infra/deploy/deploy.sh');
  it('no longer starts postgres and stops when the Neon addresses are missing', () => {
    expect(deploy).not.toMatch(/up -d --wait postgres/);
    expect(deploy).toContain('compose up -d --wait redis');
    for (const v of ['BACKEND_DATABASE_URL', 'VM_MANAGER_DATABASE_URL', 'LITELLM_DATABASE_URL'])
      expect(deploy).toContain(v);
  });
});

describe('move-to-neon.sh', () => {
  const script = fileURLToPath(new URL('../infra/deploy/move-to-neon.sh', import.meta.url));
  const run = (env: string, ...args: string[]) => {
    const root = mkdtempSync(join(tmpdir(), 'move-'));
    writeFileSync(join(root, 'compose.env'), env);
    return spawnSync('bash', [script, ...args], {
      env: { PATH: process.env.PATH, ROOT: root, SKIP_SERVICES: '1' },
      encoding: 'utf8',
    });
  };

  it('parses', () => {
    expect(spawnSync('bash', ['-n', script]).status).toBe(0);
  });

  it('refuses to start without the three Neon addresses', () => {
    const r = run(
      'POSTGRES_USER=agent\nBACKEND_DATABASE_URL=postgresql://u:p@ep-x.neon.tech/agent\n',
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('compose.env has no VM_MANAGER_DATABASE_URL');
  });

  it('refuses an address that still points at the local database', () => {
    const r = run(
      [
        'BACKEND_DATABASE_URL=postgresql://u:p@ep-x.neon.tech/agent',
        'VM_MANAGER_DATABASE_URL=postgresql://agent:agent@postgres:5432/vm_manager',
        'LITELLM_DATABASE_URL=postgresql://u:p@ep-x.neon.tech/litellm',
      ].join('\n'),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('VM_MANAGER_DATABASE_URL still points at the local database');
  });

  it('rejects an unknown option', () => {
    expect(run('', '--yes').status).toBe(2);
  });
});
