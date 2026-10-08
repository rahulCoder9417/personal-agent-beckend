// Bring your own key (openapi tag `byok`). Saving or deleting a key switches the user's AI in
// LiteLLM at once. If that switch fails, the change is undone and the answer is 503, so the user
// is never told a key is in use (or gone) when it isn't.
import {
  ownKeyInUse,
  switchAiRouting,
  switchAiRoutingQuietly,
} from '../../modules/billing/index.ts';
import {
  deleteByokKey,
  listByokKeys,
  restoreByokKey,
  setByokKey,
  snapshotByokKey,
  type ByokProvider,
  type ByokSnapshot,
} from '../../modules/integrations/byok.ts';
import { logger } from '../../shared/logger.ts';
import { badRequest, unavailable } from '../../shared/errors.ts';
import { toByokKey } from '../billing-presenters.ts';
import { route } from '../router.ts';

/** Applies the AI switch; on failure puts the saved key back as it was and throws 503. */
async function switchOrUndo(
  userId: string,
  provider: ByokProvider,
  before: ByokSnapshot,
  message: string,
): Promise<void> {
  try {
    await switchAiRouting(userId);
  } catch (err) {
    logger().warn({ userId, provider, err: (err as Error).message }, 'own key switch failed');
    await restoreByokKey(userId, provider, before);
    // Undo whatever part of the switch went through (the 5-minute sync retries if this fails).
    await switchAiRoutingQuietly(userId);
    throw unavailable(message);
  }
}

export const byokRoutes = [
  route('listByokKeys', async (c) => {
    const userId = c.get('user').id;
    const [items, inUse] = await Promise.all([listByokKeys(userId), ownKeyInUse(userId)]);
    return c.json({ items: items.map((k) => toByokKey(k, k.provider === inUse)) }, 200);
  }),

  route('setByokKey', async (c, { params, body }) => {
    const userId = c.get('user').id;
    const before = await snapshotByokKey(userId, params.provider);
    const saved = await setByokKey(userId, params.provider, body.apiKey, body.model ?? null);
    if (!saved) throw badRequest('The provider rejected this key', { provider: params.provider });
    await switchOrUndo(
      userId,
      params.provider,
      before,
      "We couldn't switch your AI to this key right now, so it wasn't saved. Try again in a minute.",
    );
    const inUse = (await ownKeyInUse(userId)) === params.provider;
    return c.json(toByokKey(saved, inUse), 200);
  }),

  route('deleteByokKey', async (c, { params }) => {
    const userId = c.get('user').id;
    const before = await snapshotByokKey(userId, params.provider);
    if (!before) return c.body(null, 204);
    await deleteByokKey(userId, params.provider);
    await switchOrUndo(
      userId,
      params.provider,
      before,
      "We couldn't stop using this key right now, so it wasn't removed. Try again in a minute.",
    );
    return c.body(null, 204);
  }),
];
