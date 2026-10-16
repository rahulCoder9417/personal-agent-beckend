// Automations on a canvas, phase 1 (docs/automations-flow-proposal.md): what the web app's canvas
// draws comes from the API. Each automation says where the copy of each run's answer goes
// (`copyTo`) and its trigger's settings (`trigger.config`), and `GET /v1/automations/{id}` reads one.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAutomation,
  copyToOf,
  recordRun,
  setMinIntervalMs,
} from '../src/modules/automations/automations.ts';
import { automations } from '../src/modules/automations/schema.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeComposio } from './fakes.ts';
import { call, createUser, expectContract } from './helpers.ts';

type ApiAutomation = {
  id: string;
  kind: string;
  copyTo: string | null;
  trigger: { app: string; event: string; config: Record<string, unknown> } | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
};

beforeAll(() => {
  wireModules();
  setMinIntervalMs(1000);
});
beforeEach(async () => {
  await installFakeComposio();
});

async function connectGithub(userId: string) {
  await db()
    .insert(connections)
    .values({
      id: newId('con'),
      userId,
      app: 'github',
      composioAccountId: `ca_${randomUUID()}`,
      status: 'active',
    });
}

const getOne = async (token: string, id: string, status = 200) =>
  expectContract<ApiAutomation>(
    'getAutomation',
    await call(`/v1/automations/${id}`, { token }),
    status,
  );

describe('automations on a canvas: what the API says about one', () => {
  it('copyTo is the chat app it was made in, or null for web chat', () => {
    expect(copyToOf('telegram:12345')).toBe('telegram');
    expect(copyToOf('whatsapp:+4915')).toBe('whatsapp');
    expect(copyToOf('imessage:+1555')).toBe('imessage');
    expect(copyToOf('web')).toBeNull();
    expect(copyToOf('nonsense')).toBeNull();
  });

  it('GET one: every kind, with where the copy goes and the trigger settings', async () => {
    const u = await createUser({ plan: 'max' });
    await connectGithub(u.id);
    const repeat = await createAutomation({
      userId: u.id,
      title: 'Monday PRs',
      instruction: 'List my open pull requests',
      cron: '0 9 * * 1',
      timezone: 'Asia/Kolkata',
      sessionKey: 'telegram:777',
    });
    const once = await createAutomation({
      userId: u.id,
      title: 'Call the bank',
      instruction: 'Remind the user: call the bank',
      runAt: new Date(Date.now() + 3600_000),
      sessionKey: 'web',
    });
    const event = await createAutomation({
      userId: u.id,
      title: 'New PRs in acme/web',
      instruction: 'Summarise the pull request',
      trigger: {
        app: 'github',
        event: 'GITHUB_PULL_REQUEST_EVENT',
        config: { owner: 'acme', repo: 'web' },
      },
      sessionKey: 'web',
    });

    const r = await getOne(u.token, repeat.id);
    expect(r).toMatchObject({ id: repeat.id, kind: 'repeat', copyTo: 'telegram', trigger: null });
    expect(r.nextRunAt).not.toBeNull();
    expect(await getOne(u.token, once.id)).toMatchObject({ kind: 'once', copyTo: null });
    expect(await getOne(u.token, event.id)).toMatchObject({
      kind: 'event',
      copyTo: null,
      trigger: {
        app: 'github',
        event: 'GITHUB_PULL_REQUEST_EVENT',
        config: { owner: 'acme', repo: 'web' },
      },
    });

    // The list says the same, item by item.
    const list = await expectContract<{ items: ApiAutomation[] }>(
      'listAutomations',
      await call('/v1/automations', { token: u.token }),
      200,
    );
    const byId = new Map(list.items.map((a) => [a.id, a]));
    expect(byId.get(repeat.id)?.copyTo).toBe('telegram');
    expect(byId.get(event.id)?.trigger?.config).toEqual({ owner: 'acme', repo: 'web' });
  });

  it('a trigger made without settings has an empty config', async () => {
    const u = await createUser();
    await connectGithub(u.id);
    const a = await createAutomation({
      userId: u.id,
      title: 'Any push',
      instruction: 'Tell me',
      trigger: { app: 'github', event: 'GITHUB_COMMIT_EVENT' },
      sessionKey: 'web',
    });
    expect((await getOne(u.token, a.id)).trigger?.config).toEqual({});
  });

  it("another user's automation, or an unknown id, is 404", async () => {
    const owner = await createUser();
    const other = await createUser();
    const a = await createAutomation({
      userId: owner.id,
      title: 'Mine',
      instruction: 'Do it',
      runAt: new Date(Date.now() + 3600_000),
      sessionKey: 'web',
    });
    await getOne(other.token, a.id, 404);
    await getOne(owner.token, 'aut_nope', 404);
    // Signed out: 401.
    expect((await call(`/v1/automations/${a.id}`)).status).toBe(401);
  });

  it('a finished one-time reminder is gone from the list but still found by its id', async () => {
    const u = await createUser();
    const a = await createAutomation({
      userId: u.id,
      title: 'Once',
      instruction: 'Remind the user: once',
      runAt: new Date(Date.now() + 3600_000),
      sessionKey: 'web',
    });
    await recordRun(a, true);
    const [row] = await db().select().from(automations).where(eq(automations.id, a.id));
    expect(row!.completedAt).not.toBeNull();
    const list = await expectContract<{ items: ApiAutomation[] }>(
      'listAutomations',
      await call('/v1/automations', { token: u.token }),
      200,
    );
    expect(list.items.map((x) => x.id)).not.toContain(a.id);
    const one = await getOne(u.token, a.id);
    expect(one.nextRunAt).toBeNull();
    expect(one.lastRunAt).not.toBeNull();
  });
});
