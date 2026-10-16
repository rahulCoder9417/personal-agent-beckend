// move-neon-region.sh: the second database move, from Neon in Ohio to Neon in Singapore.
// No database or Docker in the test run: the Postgres tools are small stand-ins (PG_TOOLS_DIR)
// that answer the script's queries, and SKIP_SERVICES=1 keeps Docker Compose out. That is enough
// to run the checks, the dry run, the whole move up to compose.env, and the rollback.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../infra/deploy/move-neon-region.sh', import.meta.url));

const VARS = ['BACKEND_DATABASE_URL', 'VM_MANAGER_DATABASE_URL', 'LITELLM_DATABASE_URL'] as const;
const DBS = ['agent', 'vm_manager', 'litellm'] as const;
const OLD_HOST = 'ep-old-1.c-6.us-east-2.aws.neon.tech';
const NEW_HOST = 'ep-new-2.ap-southeast-1.aws.neon.tech';
const oldUrl = (db: string) =>
  `postgresql://neondb_owner:OLDSECRET@${OLD_HOST}/${db}?sslmode=${db === 'agent' ? 'verify-full' : 'require'}&channel_binding=require`;
const newUrl = (db: string, host = NEW_HOST) =>
  `postgresql://neondb_owner:NEWSECRET@${host}/${db}?sslmode=require&channel_binding=require`;

// The stand-in psql: the old side (us-east-2) has 3 tables and 2 rows; the new side answers from
// FAKE_* settings. Every call is logged (the test URLs hold no real secret).
const PSQL = `#!/usr/bin/env bash
url= q= prev=
for a in "$@"; do
  [ "$prev" = -c ] && q=$a
  case "$a" in postgres*://*) url=$a ;; esac
  prev=$a
done
echo "psql $url :: $q" >>"$FAKE_LOG"
case "$url" in *us-east-2*) side=old ;; *) side=new ;; esac
case "$q" in
  *server_version_num*) if [ $side = old ]; then echo 180006; else echo "\${FAKE_NEW_VERSION:-180006}"; fi ;;
  *"from pg_database"*) echo "\${FAKE_NEW_EXISTS:-1}" ;;
  *"string_agg(format"*) echo "select 'public.users' as t, 2 as n" ;;
  *"select 'public.users'"*) if [ $side = old ]; then echo "public.users 2"; else echo "public.users \${FAKE_NEW_ROWS:-2}"; fi ;;
  *"count(*) from pg_tables"*) if [ $side = old ]; then echo 3; else echo "\${FAKE_NEW_TABLES:-0}"; fi ;;
  *pg_extension*) echo "" ;;
esac
`;
const PG_DUMP = `#!/usr/bin/env bash
echo "pg_dump $*" >>"$FAKE_LOG"
echo "dump of \${@: -1}"
`;
const PG_RESTORE = `#!/usr/bin/env bash
cat >/dev/null
echo "pg_restore $*" >>"$FAKE_LOG"
`;

const fullEnv = (overrides: Record<string, string | undefined> = {}) => {
  const lines = ['# compose variables', 'POSTGRES_USER=agent', 'API_DOMAIN=api.textcrew.in'];
  VARS.forEach((v, i) => lines.push(`${v}=${oldUrl(DBS[i]!)}`));
  lines.push('LITELLM_MASTER_KEY=sk-x');
  VARS.forEach((v, i) => lines.push(`NEW_${v}=${newUrl(DBS[i]!)}`));
  let text = lines.join('\n') + '\n';
  for (const [k, value] of Object.entries(overrides)) {
    text = text.replace(
      new RegExp(`^${k}=.*\\n`, 'm'),
      value === undefined ? '' : `${k}=${value}\n`,
    );
  }
  return text;
};

function setup(env: string) {
  const root = mkdtempSync(join(tmpdir(), 'neon-region-'));
  writeFileSync(join(root, 'compose.env'), env);
  const tools = join(root, 'tools');
  mkdirSync(tools);
  for (const [name, body] of [
    ['psql', PSQL],
    ['pg_dump', PG_DUMP],
    ['pg_restore', PG_RESTORE],
  ] as const) {
    writeFileSync(join(tools, name), body);
    chmodSync(join(tools, name), 0o755);
  }
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  const run = (args: string[], fake: Record<string, string> = {}) =>
    spawnSync('bash', [script, ...args], {
      env: {
        PATH: process.env.PATH,
        ROOT: root,
        SKIP_SERVICES: '1',
        PG_TOOLS_DIR: tools,
        FAKE_LOG: log,
        ...fake,
      },
      encoding: 'utf8',
    });
  const envFile = () => readFileSync(join(root, 'compose.env'), 'utf8');
  const calls = () => readFileSync(log, 'utf8');
  return { root, run, envFile, calls };
}

describe('move-neon-region.sh: refusals', () => {
  it('parses', () => {
    expect(spawnSync('bash', ['-n', script]).status).toBe(0);
  });

  it('rejects an unknown option', () => {
    const r = setup(fullEnv()).run(['--yes']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown option: --yes');
  });

  it('refuses without one of the three new addresses', () => {
    const t = setup(fullEnv({ NEW_VM_MANAGER_DATABASE_URL: undefined }));
    const r = t.run(['--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "compose.env has no NEW_VM_MANAGER_DATABASE_URL (the new project's address for the 'vm_manager' database)",
    );
    expect(t.calls()).toBe('');
  });

  it('refuses an empty new address', () => {
    const r = setup(fullEnv({ NEW_LITELLM_DATABASE_URL: '' })).run(['--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('compose.env has no NEW_LITELLM_DATABASE_URL');
  });

  it('refuses without the addresses in use now', () => {
    const r = setup(fullEnv({ BACKEND_DATABASE_URL: undefined })).run(['--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('compose.env has no BACKEND_DATABASE_URL (the database in use now)');
  });

  it('refuses a new address that points at the old host', () => {
    const t = setup(fullEnv({ NEW_LITELLM_DATABASE_URL: newUrl('litellm', OLD_HOST) }));
    const r = t.run(['--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'NEW_LITELLM_DATABASE_URL points at the old host (Neon us-east-2); it must be the new Neon project',
    );
    expect(r.stderr).not.toContain('SECRET');
    expect(t.calls()).toBe('');
  });

  it('refuses a pooled address', () => {
    const pooled = newUrl('agent', 'ep-new-2-pooler.ap-southeast-1.aws.neon.tech');
    const r = setup(fullEnv({ NEW_BACKEND_DATABASE_URL: pooled })).run(['--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('NEW_BACKEND_DATABASE_URL is a pooled address');
  });

  it('refuses a new address that names another database', () => {
    const r = setup(fullEnv({ NEW_VM_MANAGER_DATABASE_URL: newUrl('neondb') })).run(['--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "NEW_VM_MANAGER_DATABASE_URL names the database 'neondb'; it must be 'vm_manager'",
    );
  });

  it('refuses a new database that already has tables, before stopping anything', () => {
    const t = setup(fullEnv());
    const before = t.envFile();
    const r = t.run([], { FAKE_NEW_TABLES: '4' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "REFUSED: the new database 'agent' is not empty. Nothing was changed.",
    );
    expect(t.envFile()).toBe(before);
    expect(t.calls()).not.toContain('pg_dump');
    expect(existsSync(join(t.root, 'backups'))).toBe(false);
  });

  it('refuses a new project on another Postgres version', () => {
    const r = setup(fullEnv()).run([], { FAKE_NEW_VERSION: '170005' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('REFUSED: the new project runs Postgres 17, the old one 18.');
  });
});

describe('move-neon-region.sh: dry run', () => {
  it('prints the plan and the checks, and changes nothing', () => {
    const t = setup(fullEnv());
    const before = t.envFile();
    const r = t.run(['--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('== plan (nothing has been changed yet)');
    for (const db of DBS)
      expect(r.stdout).toMatch(new RegExp(`${db}\\s+Neon us-east-2 -> Neon ap-southeast-1`));
    expect(r.stdout).toContain('2. stop api, worker, vm-manager and litellm');
    expect(r.stdout).toContain('5. switch the three addresses in compose.env');
    expect(r.stdout).toContain('Postgres: old 18, new 18');
    // The backend's address in use says verify-full; the pasted one says require.
    expect(r.stdout).toContain(
      'note: NEW_BACKEND_DATABASE_URL says sslmode=require, BACKEND_DATABASE_URL says sslmode=verify-full; better the same',
    );
    expect(r.stdout).not.toContain('note: NEW_VM_MANAGER_DATABASE_URL');
    expect(r.stdout).toContain('new: exists, 0 tables');
    expect(r.stdout).toContain('dry run: all checks passed, nothing was changed');
    expect(r.stdout + r.stderr).not.toContain('SECRET');
    expect(t.envFile()).toBe(before);
    expect(t.calls()).not.toMatch(/pg_dump|pg_restore|create database/);
    expect(existsSync(join(t.root, 'backups'))).toBe(false);
  });

  it('a missing new database is reported, and created only by the move', () => {
    const t = setup(fullEnv());
    const r = t.run(['--dry-run'], { FAKE_NEW_EXISTS: '0' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('new: missing, will be created');
    expect(t.calls()).not.toContain('create database');
  });
});

describe('move-neon-region.sh: the move and the rollback', () => {
  it('copies all three, then switches compose.env and keeps the old addresses as OLD_*', () => {
    const t = setup(fullEnv());
    const before = t.envFile();
    const r = t.run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('restored: 1 tables, 2 rows, counts match');
    expect(r.stdout).toContain('move done');
    expect(r.stdout + r.stderr).not.toContain('SECRET');

    // Each old database dumped, each restored into the new one, in one transaction.
    for (const db of DBS) {
      expect(t.calls()).toContain(
        `pg_dump --format=custom --no-owner --no-privileges --no-statistics ${oldUrl(db)}`,
      );
      expect(t.calls()).toMatch(
        new RegExp(
          `pg_restore .*--single-transaction --dbname ${newUrl(db).replace(/[?.]/g, '\\$&')}`,
        ),
      );
    }
    // The backend's verify-full address is read with the system's root certificates.
    expect(t.calls()).toContain(`${oldUrl('agent')}&sslrootcert=system`);

    const env = t.envFile();
    VARS.forEach((v, i) => {
      expect(env).toContain(`\n${v}=${newUrl(DBS[i]!)}\n`);
      expect(env).toContain(`\nOLD_${v}=${oldUrl(DBS[i]!)}\n`);
      expect(env).not.toContain(`NEW_${v}=`);
    });
    // Everything else is kept, in its place.
    expect(
      env.startsWith('# compose variables\nPOSTGRES_USER=agent\nAPI_DOMAIN=api.textcrew.in\n'),
    ).toBe(true);
    expect(env).toContain('\nLITELLM_MASTER_KEY=sk-x\n');
    expect(statSync(join(t.root, 'compose.env')).mode & 0o777).toBe(0o600);

    // The file as it was is kept next to it; the dumps and counts in backups/.
    const bak = readdirSync(t.root).filter((f) => f.startsWith('compose.env.bak-'));
    expect(bak).toHaveLength(1);
    expect(readFileSync(join(t.root, bak[0]!), 'utf8')).toBe(before);
    const [dir] = readdirSync(join(t.root, 'backups'));
    expect(dir).toMatch(/^neon-region-move-\d{8}T\d{6}Z$/);
    expect(readdirSync(join(t.root, 'backups', dir!))).toEqual(
      expect.arrayContaining([
        'agent.dump',
        'agent.counts.old',
        'agent.counts.new',
        'litellm.dump',
      ]),
    );

    // Rollback: a dry run changes nothing; the rollback is one swap back.
    const dry = t.run(['--rollback', '--dry-run']);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/agent\s+Neon ap-southeast-1 -> back to Neon us-east-2/);
    expect(t.envFile()).toBe(env);

    const back = t.run(['--rollback']);
    expect(back.status, back.stderr).toBe(0);
    expect(back.stdout).toContain('rollback done');
    const after = t.envFile();
    VARS.forEach((v, i) => {
      expect(after).toContain(`\n${v}=${oldUrl(DBS[i]!)}\n`);
      expect(after).toContain(`\nNEW_${v}=${newUrl(DBS[i]!)}\n`);
      expect(after).not.toContain(`OLD_${v}=`);
    });

    // A second rollback has nothing to go back to.
    const again = t.run(['--rollback']);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('compose.env has no OLD_BACKEND_DATABASE_URL');
  });

  it('a missing new database is created before the copy', () => {
    const t = setup(fullEnv());
    const r = t.run([], { FAKE_NEW_EXISTS: '0' });
    expect(r.status, r.stderr).toBe(0);
    expect(t.calls()).toContain('create database "agent"');
    expect(t.calls()).toContain('create database "litellm"');
  });

  it('row counts that differ stop the move before the switch; compose.env is untouched', () => {
    const t = setup(fullEnv());
    const before = t.envFile();
    const r = t.run([], { FAKE_NEW_ROWS: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('row counts differ for agent');
    expect(r.stderr).toContain('MOVE FAILED before the switch. compose.env is unchanged');
    expect(t.envFile()).toBe(before);
    expect(readdirSync(t.root).some((f) => f.startsWith('compose.env.bak-'))).toBe(false);
  });

  it('rollback refuses when there was no move', () => {
    const r = setup(fullEnv()).run(['--rollback']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('there is nothing to roll back to');
  });
});
