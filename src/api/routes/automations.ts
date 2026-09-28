import {
  deleteAutomation,
  listAutomations,
  setEnabled,
  toApiAutomation,
} from '../../modules/automations/automations.ts';
import { notFound } from '../../shared/errors.ts';
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
];
