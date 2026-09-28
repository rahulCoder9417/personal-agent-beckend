import { getBalance, listBalanceGrants, listLedger } from '../../modules/billing/credits.ts';
import { listUsagePeriods } from '../../modules/billing/usage.ts';
import { badRequest } from '../../shared/errors.ts';
import { toBalance, toLedgerEntry, toUsagePeriod } from '../billing-presenters.ts';
import { route } from '../router.ts';

export const creditRoutes = [
  route('getCredits', async (c) => {
    const userId = c.get('user').id;
    const now = new Date();
    const [balance, grants] = await Promise.all([
      getBalance(userId, now),
      listBalanceGrants(userId, now),
    ]);
    return c.json(toBalance(balance, grants), 200);
  }),

  route('listLedger', async (c, { query }) => {
    const page = await listLedger(c.get('user').id, {
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit ?? 30,
    });
    return c.json({ items: page.items.map(toLedgerEntry), nextCursor: page.nextCursor }, 200);
  }),

  route('getUsage', async (c, { query }) => {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (!(from < to)) throw badRequest('`from` must be before `to`');
    const items = (await listUsagePeriods(c.get('user').id, from, to)).map(toUsagePeriod);
    const sum = (k: 'aiCredits' | 'awakeCredits' | 'toolCredits' | 'totalCredits') =>
      items.reduce((n, p) => n + p[k], 0);
    return c.json(
      {
        items,
        totals: {
          aiCredits: sum('aiCredits'),
          awakeCredits: sum('awakeCredits'),
          toolCredits: sum('toolCredits'),
          totalCredits: sum('totalCredits'),
        },
      },
      200,
    );
  }),
];
