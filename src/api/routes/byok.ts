import { refreshBudgetQuietly } from '../../modules/billing/litellm.ts';
import { deleteByokKey, listByokKeys, setByokKey } from '../../modules/integrations/byok.ts';
import { badRequest } from '../../shared/errors.ts';
import { toByokKey } from '../billing-presenters.ts';
import { route } from '../router.ts';

export const byokRoutes = [
  route('listByokKeys', async (c) => {
    const items = await listByokKeys(c.get('user').id);
    return c.json({ items: items.map(toByokKey) }, 200);
  }),

  route('setByokKey', async (c, { params, body }) => {
    const userId = c.get('user').id;
    const saved = await setByokKey(userId, params.provider, body.apiKey, body.model ?? null);
    if (!saved) throw badRequest('The provider rejected this key', { provider: params.provider });
    await refreshBudgetQuietly(userId); // AI is no longer capped by credits
    return c.json(toByokKey(saved), 200);
  }),

  route('deleteByokKey', async (c, { params }) => {
    const userId = c.get('user').id;
    await deleteByokKey(userId, params.provider);
    await refreshBudgetQuietly(userId);
    return c.body(null, 204);
  }),
];
