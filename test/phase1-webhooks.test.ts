import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { events } from '../src/modules/events/schema.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { users } from '../src/modules/auth/schema.ts';
import { db } from '../src/shared/db/client.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { processors } from '../src/worker/processors.ts';
import { call, expectContract, signClerk, waitFor } from './helpers.ts';

afterAll(closeQueues);

const clerkUser = (id: string) => ({
  type: 'user.created',
  data: {
    id,
    first_name: 'Asha',
    last_name: 'Rao',
    primary_email_address_id: 'idn_1',
    email_addresses: [
      { id: 'idn_1', email_address: 'asha@example.com', verification: { status: 'verified' } },
    ],
    public_metadata: {},
  },
});

describe('clerk webhook intake', () => {
  it('rejects a bad signature without saving anything', async () => {
    const signed = signClerk(clerkUser('user_bad'));
    const res = await call('/webhooks/clerk', {
      method: 'POST',
      body: signed.body,
      headers: { ...signed.headers, 'svix-signature': 'v1,AAAA' },
    });
    await expectContract('webhookClerk', res, 401);
    expect(await db().select().from(events).where(eq(events.source, 'clerk'))).toHaveLength(0);
  });

  it('a signed webhook sent twice creates exactly one event and one job', async () => {
    const msgId = `msg_${randomUUID()}`;
    const signed = signClerk(clerkUser(`user_${randomUUID()}`), msgId);
    for (let i = 0; i < 2; i++) {
      await expectContract(
        'webhookClerk',
        await call('/webhooks/clerk', {
          method: 'POST',
          body: signed.body,
          headers: signed.headers,
        }),
        200,
      );
    }
    const rows = await db().select().from(events).where(eq(events.externalId, msgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('queued');
    const jobs = await queue('system').getJobs(['waiting', 'delayed', 'active', 'completed']);
    expect(jobs.filter((j) => j.id === rows[0]!.id)).toHaveLength(1);
  });

  it('the worker turns user.created into one user and one onboarding job', async () => {
    const clerkId = `user_${randomUUID()}`;
    const signed = signClerk(clerkUser(clerkId));
    await call('/webhooks/clerk', { method: 'POST', body: signed.body, headers: signed.headers });
    const workers = startWorkers(processors());
    try {
      const user = await waitFor(
        async () => (await db().select().from(users).where(eq(users.clerkId, clerkId)))[0],
      );
      expect(user).toMatchObject({
        email: 'asha@example.com',
        emailVerified: true,
        name: 'Asha Rao',
      });
      const job = await queue('system').getJob(`onboard-${user.id}`);
      expect(job).toBeDefined();
      await waitFor(async () => {
        const [e] = await db()
          .select()
          .from(events)
          .where(eq(events.externalId, signed.headers['svix-id']));
        return e?.status === 'done';
      });
    } finally {
      await Promise.all(workers.map((w) => w.close()));
    }
  });
});
