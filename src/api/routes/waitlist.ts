import {
  joinWaitlist,
  listWaitlist,
  toApiWaitlistEntry,
  updateWaitlistEntry,
  waitlistStats,
} from '../../modules/auth/waitlist.ts';
import { route } from '../router.ts';

export const waitlistRoutes = [
  route('joinWaitlist', async (c, { body }) => {
    await joinWaitlist(body, {
      ip: c.get('ip'),
      forwardedFor: c.req.header('x-forwarded-for') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
      acceptLanguage: c.req.header('accept-language') ?? null,
      referer: c.req.header('referer') ?? null,
      origin: c.req.header('origin') ?? null,
    });
    return c.json(
      {
        status: 'ok' as const,
        message: "You're on the list. We'll email you when it's your turn.",
      },
      202,
    );
  }),

  route('adminListWaitlist', async (c, { query }) => {
    const page = await listWaitlist({
      limit: query.limit ?? 30,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.flagged !== undefined ? { flagged: query.flagged } : {}),
      ...(query.ip ? { ip: query.ip } : {}),
    });
    return c.json({ items: page.items.map(toApiWaitlistEntry), nextCursor: page.nextCursor }, 200);
  }),

  route('adminWaitlistStats', async (c) => c.json(await waitlistStats(), 200)),

  route('adminUpdateWaitlistEntry', async (c, { params, body }) => {
    const row = await updateWaitlistEntry(params.entryId, body);
    return c.json(toApiWaitlistEntry(row), 200);
  }),
];
