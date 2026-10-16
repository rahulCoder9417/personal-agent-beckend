import {
  copyChannel,
  copyRules,
  deleteAutomation,
  getAutomation,
  listAutomations,
  setEnabled,
  toApiAutomation,
  type Automation,
} from '../../modules/automations/automations.ts';
import {
  discardDraft,
  DraftError,
  getDraft,
  listOpenDrafts,
  saveDraft,
  toApiDraft,
} from '../../modules/automations/drafts.ts';
import {
  disablePrReview,
  enablePrReview,
  listPrReviews,
  toApiPrReview,
} from '../../modules/automations/pr-review.ts';
import { AppError, badRequest, notFound, planLimit, unavailable } from '../../shared/errors.ts';
import { enforce } from '../../shared/rate-limit.ts';
import { route } from '../router.ts';

/** A draft's refusal in the `Error` shape: 404, 409 (not open), 403 (plan), 400, 503. */
function draftRefusal(err: unknown): unknown {
  if (!(err instanceof DraftError)) return err;
  switch (err.code) {
    case 'not_found':
      return notFound('Draft not found');
    case 'not_open':
      return new AppError(409, 'conflict', err.message, err.details);
    case 'plan_limit':
      return planLimit(err.message, err.details);
    case 'unavailable':
      return unavailable(err.message);
    default:
      return badRequest(err.message);
  }
}

/** The automation for the API, with where a copy of its answers goes now (the user's switches). */
async function withCopyTo(a: Automation) {
  return toApiAutomation(a, copyChannel(await copyRules(a.userId), a));
}

export const automationRoutes = [
  route('listAutomations', async (c) => {
    const userId = c.get('user').id;
    const [rows, rule] = await Promise.all([listAutomations(userId), copyRules(userId)]);
    return c.json({ items: rows.map((a) => toApiAutomation(a, copyChannel(rule, a))) }, 200);
  }),

  // One automation, for its own page in the web app (drawn as a flow). Filtered by the user.
  route('getAutomation', async (c, { params }) => {
    const row = await getAutomation(c.get('user').id, params.automationId);
    if (!row) throw notFound('Automation not found');
    return c.json(await withCopyTo(row), 200);
  }),

  route('updateAutomation', async (c, { params, body }) => {
    const row = await setEnabled(c.get('user').id, params.automationId, body.enabled, 'user');
    if (!row) throw notFound('Automation not found');
    return c.json(await withCopyTo(row), 200);
  }),

  route('deleteAutomation', async (c, { params }) => {
    if (!(await deleteAutomation(c.get('user').id, params.automationId)))
      throw notFound('Automation not found');
    return c.body(null, 204);
  }),

  // Drafts the agent proposed (drafts.ts). Only the user saves one: here, or with Save in a chat app.
  route('listAutomationDrafts', async (c) => {
    const rows = await listOpenDrafts(c.get('user').id);
    return c.json({ items: rows.map(toApiDraft) }, 200);
  }),

  route('getAutomationDraft', async (c, { params }) => {
    const row = await getDraft(c.get('user').id, params.draftId);
    if (!row) throw notFound('Draft not found');
    return c.json(toApiDraft(row), 200);
  }),

  route('saveAutomationDraft', async (c, { params, body }) => {
    const userId = c.get('user').id;
    await enforce({ key: `draft-save:user:${userId}`, max: 30, windowSeconds: 3600 });
    try {
      const { draft, automation } = await saveDraft(userId, params.draftId, {
        enabled: body?.enabled !== false,
        via: 'web',
      });
      return c.json({ draft: toApiDraft(draft), automation: await withCopyTo(automation) }, 200);
    } catch (err) {
      throw draftRefusal(err);
    }
  }),

  route('discardAutomationDraft', async (c, { params }) => {
    try {
      return c.json(toApiDraft(await discardDraft(c.get('user').id, params.draftId)), 200);
    } catch (err) {
      throw draftRefusal(err);
    }
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
