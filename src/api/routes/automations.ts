import {
  deleteAutomation,
  listAutomations,
  setEnabled,
  toApiAutomation,
} from '../../modules/automations/automations.ts';
import {
  disablePrReview,
  enablePrReview,
  listPrReviews,
  toApiPrReview,
} from '../../modules/automations/pr-review.ts';
import { notFound } from '../../shared/errors.ts';
import { enforce } from '../../shared/rate-limit.ts';
import { route } from '../router.ts';

export const automationRoutes = [
  route('listAutomations', async (c) => {
    const rows = await listAutomations(c.get('user').id);
    return c.json({ items: rows.map(toApiAutomation) }, 200);
  }),

  route('updateAutomation', async (c, { params, body }) => {
    const row = await setEnabled(c.get('user').id, params.automationId, body.enabled, 'user');
    if (!row) throw notFound('Automation not found');
    return c.json(toApiAutomation(row), 200);
  }),

  route('deleteAutomation', async (c, { params }) => {
    if (!(await deleteAutomation(c.get('user').id, params.automationId)))
      throw notFound('Automation not found');
    return c.body(null, 204);
  }),

  // Pull-request review per GitHub repo (HLD 0.8). Each repo that is on is an automation.
  route('listPrReviews', async (c) => {
    const rows = await listPrReviews(c.get('user').id);
    return c.json({ items: rows.map(toApiPrReview) }, 200);
  }),

  route('enablePrReview', async (c, { params }) => {
    const userId = c.get('user').id;
    await enforce({ key: `pr-review:user:${userId}`, max: 30, windowSeconds: 3600 });
    return c.json(toApiPrReview(await enablePrReview(userId, params)), 200);
  }),

  route('disablePrReview', async (c, { params }) => {
    if (!(await disablePrReview(c.get('user').id, params)))
      throw notFound('Pull-request review is not on for this repo');
    return c.body(null, 204);
  }),
];
