import { appActionCreditsFor } from '../../modules/billing/app-actions.ts';
import { getBalanceAndGrants, listLedger } from '../../modules/billing/credits.ts';
import { paidToolCreditsFor } from '../../modules/billing/paid-tools.ts';
import { listUsagePeriods } from '../../modules/billing/usage.ts';
import { wakeCreditsFor } from '../../modules/billing/wake-fee.ts';
import { badRequest } from '../../shared/errors.ts';
import { toBalance, toLedgerEntry, toUsagePeriod } from '../billing-presenters.ts';
import { route } from '../router.ts';

export const creditRoutes = [
  route('getCredits', async (c) => {
    const { balance, grants } = await getBalanceAndGrants(c.get('user').id);
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
    const userId = c.get('user').id;
    const periods = await listUsagePeriods(userId, from, to);
    const [appActions, paidTools, wakes] = await Promise.all([
      appActionCreditsFor(userId, periods),
      paidToolCreditsFor(userId, periods),
      wakeCreditsFor(userId, periods),
    ]);
    const items = periods.map((p, i) =>
      toUsagePeriod(p, appActions[i] ?? 0, paidTools[i] ?? 0, wakes[i] ?? 0),
    );
    const sum = (
      k:
        | 'aiCredits'
        | 'awakeCredits'
        | 'wakeCredits'
        | 'appActionCredits'
        | 'browserCredits'
        | 'toolCredits'
        | 'totalCredits',
    ) => items.reduce((n, p) => n + p[k], 0);
    return c.json(
      {
        items,
        totals: {
          aiCredits: sum('aiCredits'),
          awakeCredits: sum('awakeCredits'),
          wakeCredits: sum('wakeCredits'),
          appActionCredits: sum('appActionCredits'),
          browserCredits: sum('browserCredits'),
          toolCredits: sum('toolCredits'),
          totalCredits: sum('totalCredits'),
        },
      },
      200,
    );
  }),
];
