// Admin tools for one user's apps, linked chats and automations (docs/backend-report.md, "Admin
// tools"). Admins only; every action does what the user's own does (Composio calls, timers,
// triggers) and writes an audit row with the admin's id and the reason; nothing secret comes back.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { findLink } from '../src/modules/auth/links.ts';
import { channelLinks } from '../src/modules/auth/schema.ts';
import {
  createAutomation,
  getAutomation,
  resumeAfterCredits,
  setEnabled,
} from '../src/modules/automations/automations.ts';
import { enablePrReview } from '../src/modules/automations/pr-review.ts';
import { automations } from '../src/modules/automations/schema.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { composio, setComposioApi } from '../src/modules/integrations/composio.ts';
import { composioAuthConfigs, connections } from '../src/modules/integrations/tables.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeComposio } from './fakes.ts';
import { call, createUser, expectContract } from './helpers.ts';

// Gmail's setup is named in the settings; Notion's was made by the server; the rest have none.
// GitHub's is in the settings too, for pull-request review.
process.env.COMPOSIO_AUTH_CONFIGS = JSON.stringify({ gmail: 'ac_gmail', github: 'ac_github' });
process.env.COMPOSIO_MANAGED_APPS = 'googlecalendar';
process.env.ENABLED_CHANNELS = 'telegram,web';
resetConfig();

type AdminApp = {
  id: string;
  app: string;
  appName: string;
  status: string;
  accountLabel: string | null;
  setupSource: string;
  connectable: boolean;
  connectedAt: string;
  lastCheckedAt: string | null;
};
type AdminChannel = {
  id: string;
  channel: string;
  label: string;
  maskedChatId: string;
  enabled: boolean;
  blocked: boolean;
};
type AdminAutomation = {
  id: string;
  title: string;
  kind: string;
  enabled: boolean;
  pausedReason: string | null;
  failCount: number;
  completedAt: string | null;
  repo: string | null;
  preset: string | null;
  nextRunAt: string | null;
};
type Summary = {
  app: string;
  setupSource: string;
  connectable: boolean;
  users: number;
  active: number;
  pending: number;
  expired: number;
  failed: number;
};

let fake: Awaited<ReturnType<typeof installFakeComposio>>;
/** Composio accounts deleted, by id (the fake keeps no record of its own). */
let deletedAccounts: string[];
let admin: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  wireModules();
  admin = await createUser({ role: 'admin' });
  await db()
    .insert(composioAuthConfigs)
    .values({ app: 'notion', authConfigId: 'ac_made_notion' })
    .onConflictDoNothing();
});
afterAll(async () => {
  await closeQueues();
});
beforeEach(async () => {
  fake = await installFakeComposio();
  deletedAccounts = [];
  const api = composio();
  setComposioApi({
    ...api,
    deleteAccount: async (id) => {
      deletedAccounts.push(id);
    },
  });
});

async function connection(
  userId: string,
  app: string,
  status: 'pending' | 'active' | 'expired' | 'error',
  label: string | null = null,
) {
  const [row] = await db()
    .insert(connections)
    .values({
      id: newId('con'),
      userId,
      app,
      composioAccountId: `ca_${randomUUID()}`,
      status,
      accountLabel: label,
    })
    .returning();
  return row!;
}

async function link(userId: string, channel: 'telegram' | 'whatsapp', externalId: string) {
  const [row] = await db()
    .insert(channelLinks)
    .values({
      id: newId('chl'),
      userId,
      channel,
      externalId,
      displayId: channel === 'telegram' ? '@rahul' : `+${externalId}`,
    })
    .returning();
  return row!;
}

const post = (path: string, body: unknown, token = admin.token) =>
  call(path, { method: 'POST', token, body });

async function auditRows(userId: string, action: string) {
  return db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), eq(auditLog.action, action)));
}

const rowOf = async (id: string) =>
  (await db().select().from(connections).where(eq(connections.id, id)))[0];

describe('admin apps, chats and automations: admins only', () => {
  it('every operation answers 403 to a user who is not an admin, and 401 with no session', async () => {
    const user = await createUser();
    const target = await createUser();
    const reason = { reason: 'support ticket 12' };
    const calls: Array<[string, string, unknown?]> = [
      ['GET', `/v1/admin/users/${target.id}/apps`],
      ['POST', `/v1/admin/users/${target.id}/apps/con_x/disconnect`, reason],
      ['POST', `/v1/admin/users/${target.id}/apps/con_x/recheck`, reason],
      ['GET', `/v1/admin/users/${target.id}/channels`],
      ['POST', `/v1/admin/users/${target.id}/channels/chl_x/unlink`, reason],
      ['GET', `/v1/admin/users/${target.id}/automations`],
      ['POST', '/v1/admin/automations/aut_x/pause', reason],
      ['POST', '/v1/admin/automations/aut_x/resume', reason],
      ['DELETE', '/v1/admin/automations/aut_x', reason],
      ['GET', '/v1/admin/apps/summary'],
    ];
    for (const [method, path, body] of calls) {
      const res = await call(path, { method, token: user.token, body });
      const json = (await res.json()) as { error: { code: string } };
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(json.error.code).toBe('forbidden');
      expect((await call(path, { method, body })).status, `${method} ${path}`).toBe(401);
    }
  });

  it('a missing or blank reason is refused, and nothing happens', async () => {
    const target = await createUser();
    const conn = await connection(target.id, 'gmail', 'active');
    const path = `/v1/admin/users/${target.id}/apps/${conn.id}/disconnect`;
    for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
      const res = await post(path, body);
      await expectContract('adminDisconnectUserApp', res, 400);
    }
    expect(await rowOf(conn.id)).toBeDefined();
    expect(deletedAccounts).toEqual([]);
  });

  it('an unknown user answers 404', async () => {
    for (const path of ['apps', 'channels', 'automations']) {
      const res = await call(`/v1/admin/users/usr_nobody/${path}`, { token: admin.token });
      expect(res.status).toBe(404);
    }
  });
});

describe("admin: a user's apps", () => {
  it('lists every connection with its setup, and no Composio account id', async () => {
    const target = await createUser();
    const gmail = await connection(target.id, 'gmail', 'active', 'work@acme.com');
    const notion = await connection(target.id, 'notion', 'pending');
    const slack = await connection(target.id, 'slack', 'expired');
    const body = await expectContract<{ items: AdminApp[] }>(
      'adminListUserApps',
      await call(`/v1/admin/users/${target.id}/apps`, { token: admin.token }),
      200,
    );
    const byId = new Map(body.items.map((i) => [i.id, i]));
    expect(byId.get(gmail.id)).toMatchObject({
      app: 'gmail',
      appName: 'Gmail',
      status: 'active',
      accountLabel: 'work@acme.com',
      setupSource: 'settings',
      connectable: true,
      lastCheckedAt: null,
    });
    expect(byId.get(notion.id)).toMatchObject({
      status: 'pending',
      setupSource: 'server_made',
      connectable: true,
    });
    expect(byId.get(slack.id)).toMatchObject({
      status: 'expired',
      setupSource: 'none',
      connectable: false,
    });
    const text = JSON.stringify(body);
    for (const c of [gmail, notion, slack]) expect(text).not.toContain(c.composioAccountId);
    // Read from our table only.
    expect(fake.state.accountGets).toEqual([]);
  });

  it("disconnects the way the user's own disconnect does, and audits it", async () => {
    const target = await createUser();
    const conn = await connection(target.id, 'gmail', 'active', 'work@acme.com');
    const res = await post(`/v1/admin/users/${target.id}/apps/${conn.id}/disconnect`, {
      reason: 'user asked by email',
    });
    await expectContract('adminDisconnectUserApp', res, 204);
    expect(await rowOf(conn.id)).toBeUndefined();
    expect(deletedAccounts).toEqual([conn.composioAccountId]);
    const [row] = await auditRows(target.id, 'app_disconnected');
    expect(row).toMatchObject({
      actor: 'admin',
      summary: 'Textcrew support disconnected Gmail (work@acme.com)',
      details: {
        adminId: admin.id,
        reason: 'user asked by email',
        app: 'gmail',
        connectionId: conn.id,
      },
    });
    // The user's activity log shows it, without the reason.
    const activity = await call('/v1/activity', { token: target.token });
    const text = await activity.text();
    expect(text).toContain('Textcrew support disconnected Gmail');
    expect(text).not.toContain('user asked by email');
  });

  it("leaves the user's app-event automations as the user's own disconnect does", async () => {
    const target = await createUser({ plan: 'pro' });
    const conn = await connection(target.id, 'gmail', 'active');
    const a = await createAutomation({
      userId: target.id,
      title: 'boss mail',
      instruction: 'Summarise it',
      sessionKey: 'web',
      trigger: { app: 'gmail', event: 'GMAIL_NEW_GMAIL_MESSAGE' },
    });
    await post(`/v1/admin/users/${target.id}/apps/${conn.id}/disconnect`, { reason: 'ticket 7' });
    expect(await getAutomation(target.id, a.id)).toMatchObject({ enabled: true });
    expect(fake.triggers.map((t) => t.triggerId)).toContain(a.triggerRef);
  });

  it("answers 404 for another user's connection, and changes nothing", async () => {
    const target = await createUser();
    const other = await createUser();
    const conn = await connection(other.id, 'gmail', 'active');
    for (const action of ['disconnect', 'recheck']) {
      const res = await post(`/v1/admin/users/${target.id}/apps/${conn.id}/${action}`, {
        reason: 'ticket 9',
      });
      expect(res.status).toBe(404);
    }
    expect(await rowOf(conn.id)).toMatchObject({ status: 'active', checkedAt: null });
    expect(deletedAccounts).toEqual([]);
  });

  it("rechecks: copies Composio's answer, records when, and audits it", async () => {
    const target = await createUser();
    const conn = await connection(target.id, 'gmail', 'pending');
    fake.state.accounts.set(target.id, [
      { id: conn.composioAccountId, toolkit: 'gmail', status: 'ACTIVE', label: 'me@acme.com' },
    ]);
    const body = await expectContract<{
      connection: AdminApp;
      composioStatus: string | null;
      checksQueued: boolean;
    }>(
      'adminRecheckUserApp',
      await post(`/v1/admin/users/${target.id}/apps/${conn.id}/recheck`, { reason: 'stuck' }),
      200,
    );
    expect(body).toMatchObject({
      connection: { id: conn.id, status: 'active', accountLabel: 'me@acme.com' },
      composioStatus: 'ACTIVE',
      checksQueued: false,
    });
    expect(body.connection.lastCheckedAt).not.toBeNull();
    expect(JSON.stringify(body)).not.toContain(conn.composioAccountId);
    expect(fake.state.accountGets).toEqual([conn.composioAccountId]);
    const [row] = await auditRows(target.id, 'app_rechecked');
    expect(row).toMatchObject({
      actor: 'admin',
      details: { adminId: admin.id, reason: 'stuck', status: 'active', composioStatus: 'ACTIVE' },
    });
    // The list now says when it was last checked.
    const list = await expectContract<{ items: AdminApp[] }>(
      'adminListUserApps',
      await call(`/v1/admin/users/${target.id}/apps`, { token: admin.token }),
      200,
    );
    expect(list.items[0]!.lastCheckedAt).toBe(body.connection.lastCheckedAt);
  });

  it('rechecks an active connection too: expired at Composio, or gone there', async () => {
    const target = await createUser();
    const a = await connection(target.id, 'gmail', 'active');
    const b = await connection(target.id, 'github', 'active');
    fake.state.accounts.set(target.id, [
      { id: a.composioAccountId, toolkit: 'gmail', status: 'EXPIRED', label: null },
    ]);
    const ra = await post(`/v1/admin/users/${target.id}/apps/${a.id}/recheck`, { reason: 'x' });
    expect(((await ra.json()) as { connection: AdminApp }).connection.status).toBe('expired');
    const rb = await expectContract<{ connection: AdminApp; composioStatus: string | null }>(
      'adminRecheckUserApp',
      await post(`/v1/admin/users/${target.id}/apps/${b.id}/recheck`, { reason: 'x' }),
      200,
    );
    expect(rb).toMatchObject({ connection: { status: 'error' }, composioStatus: null });
  });

  it('a connection still being set up stays pending and gets a fresh series of checks', async () => {
    const target = await createUser();
    const conn = await connection(target.id, 'gmail', 'pending');
    fake.state.accounts.set(target.id, [
      { id: conn.composioAccountId, toolkit: 'gmail', status: 'INITIATED', label: null },
    ]);
    const body = await expectContract<{ connection: AdminApp; checksQueued: boolean }>(
      'adminRecheckUserApp',
      await post(`/v1/admin/users/${target.id}/apps/${conn.id}/recheck`, { reason: 'x' }),
      200,
    );
    expect(body).toMatchObject({ connection: { status: 'pending' }, checksQueued: true });
    const jobs = (await queue('system').getJobs(['delayed'])).filter(
      (j) => j.name === 'check-connection' && j.data.connectionId === conn.id,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({ userId: target.id, attempt: 0 });
  });

  it('Composio down: 503, nothing changes and nothing is audited', async () => {
    const target = await createUser();
    const conn = await connection(target.id, 'gmail', 'active');
    fake.state.accountsError = new Error('composio is down');
    const res = await post(`/v1/admin/users/${target.id}/apps/${conn.id}/recheck`, { reason: 'x' });
    await expectContract('adminRecheckUserApp', res, 503);
    expect(await rowOf(conn.id)).toMatchObject({ status: 'active', checkedAt: null });
    expect(await auditRows(target.id, 'app_rechecked')).toEqual([]);
  });

  it('the summary gives numbers per app, with its setup', async () => {
    const before = await expectContract<{ items: Summary[] }>(
      'adminAppsSummary',
      await call('/v1/admin/apps/summary', { token: admin.token }),
      200,
    );
    const u1 = await createUser();
    const u2 = await createUser();
    await connection(u1.id, 'todoist', 'active');
    await connection(u1.id, 'todoist', 'error');
    await connection(u2.id, 'todoist', 'pending');
    await connection(u2.id, 'todoist', 'expired');
    await connection(u2.id, 'todoist', 'active');
    const after = await expectContract<{ items: Summary[] }>(
      'adminAppsSummary',
      await call('/v1/admin/apps/summary', { token: admin.token }),
      200,
    );
    const was = before.items.find((i) => i.app === 'todoist')!;
    const now = after.items.find((i) => i.app === 'todoist')!;
    expect({
      users: now.users - was.users,
      active: now.active - was.active,
      pending: now.pending - was.pending,
      expired: now.expired - was.expired,
      failed: now.failed - was.failed,
    }).toEqual({ users: 2, active: 2, pending: 1, expired: 1, failed: 1 });
    const setup = (app: string) => after.items.find((i) => i.app === app)!;
    expect(setup('gmail')).toMatchObject({ setupSource: 'settings', connectable: true });
    expect(setup('notion')).toMatchObject({ setupSource: 'server_made', connectable: true });
    expect(setup('googlecalendar')).toMatchObject({ setupSource: 'none', connectable: true });
    expect(setup('slack')).toMatchObject({ setupSource: 'none', connectable: false });
    // Numbers only: no user ids.
    const text = JSON.stringify(after);
    expect(text).not.toContain(u1.id);
    expect(text).not.toContain(u2.id);
  });
});

describe("admin: a user's linked chats", () => {
  it('lists them with the chat id masked, and whether the channel is on', async () => {
    const target = await createUser();
    const tg = await link(target.id, 'telegram', '918273645');
    const wa = await link(target.id, 'whatsapp', '919876543210');
    const body = await expectContract<{ items: AdminChannel[] }>(
      'adminListUserChannels',
      await call(`/v1/admin/users/${target.id}/channels`, { token: admin.token }),
      200,
    );
    const byId = new Map(body.items.map((i) => [i.id, i]));
    expect(byId.get(tg.id)).toMatchObject({
      channel: 'telegram',
      label: '@rahul',
      maskedChatId: '•••• 3645',
      enabled: true,
      blocked: false,
    });
    expect(byId.get(wa.id)).toMatchObject({
      channel: 'whatsapp',
      label: '+91 •••• ••32 10',
      maskedChatId: '+91 •••• ••32 10',
      enabled: false,
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain('918273645');
    expect(text).not.toContain('919876543210');
  });

  it('a Telegram chat saved under its id shows masked, not the id', async () => {
    const target = await createUser();
    await db()
      .insert(channelLinks)
      .values({
        id: newId('chl'),
        userId: target.id,
        channel: 'telegram',
        externalId: '5551234567',
        displayId: '5551234567',
      });
    const res = await call(`/v1/admin/users/${target.id}/channels`, { token: admin.token });
    const text = await res.text();
    expect(text).not.toContain('5551234567');
    expect(text).toContain('•••• 4567');
  });

  it("unlinks the way the user's own unlink does, activity log entry included", async () => {
    const target = await createUser();
    const mine = await link(target.id, 'telegram', String(Math.floor(Math.random() * 1e9)));
    const theirs = await link(target.id, 'telegram', String(Math.floor(Math.random() * 1e9)));
    // The user's own unlink, for comparison.
    expect(
      (await call(`/v1/channels/${mine.id}`, { method: 'DELETE', token: target.token })).status,
    ).toBe(204);
    const res = await post(`/v1/admin/users/${target.id}/channels/${theirs.id}/unlink`, {
      reason: 'lost phone',
    });
    await expectContract('adminUnlinkUserChannel', res, 204);
    expect(await findLink('telegram', theirs.externalId)).toBeUndefined();
    const rows = await auditRows(target.id, 'channel_unlinked');
    expect(rows).toHaveLength(2);
    const user = rows.find((r) => r.actor === 'user')!;
    const byAdmin = rows.find((r) => r.actor === 'admin')!;
    expect(byAdmin.summary).toBe(user.summary);
    expect(byAdmin.details).toEqual({ adminId: admin.id, reason: 'lost phone', linkId: theirs.id });
    expect(user.details).toBeNull();
    // Gone: a second unlink answers 404.
    const again = await post(`/v1/admin/users/${target.id}/channels/${theirs.id}/unlink`, {
      reason: 'again',
    });
    expect(again.status).toBe(404);
  });

  it("answers 404 for another user's chat, and leaves it linked", async () => {
    const target = await createUser();
    const other = await createUser();
    const l = await link(other.id, 'telegram', String(Math.floor(Math.random() * 1e9)));
    const res = await post(`/v1/admin/users/${target.id}/channels/${l.id}/unlink`, { reason: 'x' });
    expect(res.status).toBe(404);
    expect(await findLink('telegram', l.externalId)).toBeDefined();
  });
});

describe("admin: a user's automations", () => {
  const scheduler = (id: string) => queue('scheduled').getJobScheduler(`auto-${id}`);

  async function repeating(userId: string, title = 'Daily summary') {
    return createAutomation({
      userId,
      title,
      instruction: 'Send me my day',
      sessionKey: 'telegram:123456789',
      cron: '0 9 * * *',
    });
  }

  it('lists every automation, finished reminders too, without the instruction', async () => {
    const target = await createUser({ plan: 'pro' });
    const daily = await repeating(target.id);
    const once = await createAutomation({
      userId: target.id,
      title: 'Call the bank',
      instruction: 'Remind me to call the bank',
      sessionKey: 'web',
      runAt: new Date(Date.now() + 3600_000),
    });
    await db()
      .update(automations)
      .set({ completedAt: new Date(), enabled: false })
      .where(eq(automations.id, once.id));
    const body = await expectContract<{ items: AdminAutomation[] }>(
      'adminListUserAutomations',
      await call(`/v1/admin/users/${target.id}/automations`, { token: admin.token }),
      200,
    );
    const byId = new Map(body.items.map((i) => [i.id, i]));
    expect(byId.get(daily.id)).toMatchObject({
      title: 'Daily summary',
      kind: 'repeat',
      enabled: true,
      pausedReason: null,
      failCount: 0,
      completedAt: null,
    });
    expect(byId.get(daily.id)!.nextRunAt).not.toBeNull();
    expect(byId.get(once.id)!.completedAt).not.toBeNull();
    const text = JSON.stringify(body);
    expect(text).not.toContain('Send me my day');
    expect(text).not.toContain('123456789');
  });

  it('pauses with the reason `admin`: timer removed, credits do not resume it; audited', async () => {
    const target = await createUser({ plan: 'pro' });
    const a = await repeating(target.id);
    const b = await repeating(target.id, 'Weekly');
    expect(await scheduler(a.id)).toBeDefined();
    const body = await expectContract<AdminAutomation>(
      'adminPauseAutomation',
      await post(`/v1/admin/automations/${a.id}/pause`, { reason: 'spamming the user' }),
      200,
    );
    expect(body).toMatchObject({ id: a.id, enabled: false, pausedReason: 'admin' });
    expect(await scheduler(a.id)).toBeUndefined();
    // The user sees why, in their own list.
    const mine = await call('/v1/automations', { token: target.token });
    const items = ((await mine.json()) as { items: AdminAutomation[] }).items;
    expect(items.find((i) => i.id === a.id)).toMatchObject({ pausedReason: 'admin' });
    // Credits added: only the out-of-credits pause ends.
    await setEnabled(target.id, b.id, false, 'out_of_credits');
    await resumeAfterCredits(target.id);
    expect(await getAutomation(target.id, a.id)).toMatchObject({
      enabled: false,
      pausedReason: 'admin',
    });
    expect(await getAutomation(target.id, b.id)).toMatchObject({ enabled: true });
    const [row] = await auditRows(target.id, 'automation_paused');
    expect(row).toMatchObject({
      actor: 'admin',
      summary: 'Textcrew support paused "Daily summary"',
      details: { adminId: admin.id, reason: 'spamming the user', automationId: a.id },
    });
  });

  it('resumes: timer set again, failure count back to 0; audited', async () => {
    const target = await createUser({ plan: 'pro' });
    const a = await repeating(target.id);
    await db()
      .update(automations)
      .set({ failCount: 3, enabled: false, pausedReason: 'failures' })
      .where(eq(automations.id, a.id));
    await queue('scheduled').removeJobScheduler(`auto-${a.id}`);
    const body = await expectContract<AdminAutomation>(
      'adminResumeAutomation',
      await post(`/v1/admin/automations/${a.id}/resume`, { reason: 'fixed upstream' }),
      200,
    );
    expect(body).toMatchObject({ enabled: true, pausedReason: null, failCount: 0 });
    expect((await scheduler(a.id))?.pattern).toBe('0 9 * * *');
    const [row] = await auditRows(target.id, 'automation_resumed');
    expect(row).toMatchObject({ actor: 'admin', details: { reason: 'fixed upstream' } });
  });

  it('a one-time reminder that already ran answers 409 to pause and resume', async () => {
    const target = await createUser({ plan: 'pro' });
    const once = await createAutomation({
      userId: target.id,
      title: 'Call the bank',
      instruction: 'Remind me',
      sessionKey: 'web',
      runAt: new Date(Date.now() + 3600_000),
    });
    await db()
      .update(automations)
      .set({ completedAt: new Date(), enabled: false })
      .where(eq(automations.id, once.id));
    for (const action of ['pause', 'resume']) {
      const res = await post(`/v1/admin/automations/${once.id}/${action}`, { reason: 'x' });
      await expectContract(
        action === 'pause' ? 'adminPauseAutomation' : 'adminResumeAutomation',
        res,
        409,
      );
    }
    expect(await auditRows(target.id, 'automation_paused')).toEqual([]);
  });

  it('deletes: timer removed, Composio trigger deleted; audited', async () => {
    const target = await createUser({ plan: 'pro' });
    const timer = await repeating(target.id);
    await connection(target.id, 'gmail', 'active');
    const event = await createAutomation({
      userId: target.id,
      title: 'Boss mail',
      instruction: 'Summarise it',
      sessionKey: 'web',
      trigger: { app: 'gmail', event: 'GMAIL_NEW_GMAIL_MESSAGE' },
    });
    expect(fake.triggers.map((t) => t.triggerId)).toContain(event.triggerRef);
    for (const a of [timer, event]) {
      const res = await call(`/v1/admin/automations/${a.id}`, {
        method: 'DELETE',
        token: admin.token,
        body: { reason: 'user asked' },
      });
      await expectContract('adminDeleteAutomation', res, 204);
      expect(await getAutomation(target.id, a.id)).toBeUndefined();
    }
    expect(await scheduler(timer.id)).toBeUndefined();
    expect(fake.triggers.map((t) => t.triggerId)).not.toContain(event.triggerRef);
    const rows = await auditRows(target.id, 'automation_deleted');
    expect(rows.map((r) => r.summary).sort()).toEqual([
      'Textcrew support deleted "Boss mail"',
      'Textcrew support deleted "Daily summary"',
    ]);
    // A delete needs a reason too.
    const noReason = await call(`/v1/admin/automations/${timer.id}`, {
      method: 'DELETE',
      token: admin.token,
    });
    expect(noReason.status).toBe(400);
  });

  it("deletes pull-request review: the repo's watch goes, and the standing approval with it", async () => {
    const target = await createUser({ plan: 'pro' });
    await connection(target.id, 'github', 'active');
    const a = await enablePrReview(target.id, { owner: 'acme', repo: 'website' });
    expect(fake.triggers.map((t) => t.triggerId)).toContain(a.triggerRef);
    const list = await expectContract<{ items: AdminAutomation[] }>(
      'adminListUserAutomations',
      await call(`/v1/admin/users/${target.id}/automations`, { token: admin.token }),
      200,
    );
    expect(list.items[0]).toMatchObject({ preset: 'pr_review', repo: 'acme/website' });
    const res = await call(`/v1/admin/automations/${a.id}`, {
      method: 'DELETE',
      token: admin.token,
      body: { reason: 'repo deleted' },
    });
    await expectContract('adminDeleteAutomation', res, 204);
    expect(fake.triggers.map((t) => t.triggerId)).not.toContain(a.triggerRef);
    const reviews = await call('/v1/pr-reviews', { token: target.token });
    expect(((await reviews.json()) as { items: unknown[] }).items).toEqual([]);
    const [row] = await auditRows(target.id, 'automation_deleted');
    expect(row).toMatchObject({
      summary: 'Textcrew support turned off pull-request review for acme/website',
      details: { preset: 'pr_review', repo: 'acme/website', reason: 'repo deleted' },
    });
  });

  it('an unknown automation answers 404', async () => {
    for (const [method, path] of [
      ['POST', '/v1/admin/automations/aut_nope/pause'],
      ['POST', '/v1/admin/automations/aut_nope/resume'],
      ['DELETE', '/v1/admin/automations/aut_nope'],
    ] as const) {
      const res = await call(path, { method, token: admin.token, body: { reason: 'x' } });
      expect(res.status).toBe(404);
    }
  });
});
