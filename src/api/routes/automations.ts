import {
  deleteAutomation,
  getAutomation,
  listAutomations,
  setEnabled,
  toApiAutomation,
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
import {
  createByHand,
  createUserDraft,
  changeByHand,
  examine,
  ManualError,
  queueTestRun,
  TEST_RUNS_PER_HOUR,
  type Parts,
} from '../../modules/automations/manual.ts';
import { userHasCredits } from '../../modules/orchestrator/turn.ts';
import {
  AppError,
  badRequest,
  conflict,
  notFound,
  outOfCredits,
  planLimit,
  unavailable,
} from '../../shared/errors.ts';
import { enforce } from '../../shared/rate-limit.ts';
import { route } from '../router.ts';
import type { JsonBody } from '../types.ts';

/** The canvas's parts as the api takes them (a moment as text) → the module's. */
function partsOf(body: JsonBody<'checkAutomation'> | JsonBody<'createAutomation'>): Parts {
  return {
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.instruction !== undefined ? { instruction: body.instruction } : {}),
    runAt: body.runAt ? new Date(body.runAt) : null,
    cron: body.cron ?? null,
    timezone: body.timezone ?? null,
    trigger: body.trigger
      ? {
          app: body.trigger.app,
          event: body.trigger.event,
          ...(body.trigger.config ? { config: body.trigger.config } : {}),
        }
      : null,
    apps: body.apps ?? [],
    askFirst: body.askFirst ?? 'risky',
    copyTo: body.copyTo ?? null,
  };
}

const apiProblem = (p: { step: string | null; code: string; message: string }) => ({
  step: p.step,
  code: p.code,
  message: p.message,
});

/** A save by hand's refusal in the `Error` shape: 400 with the problems, 403, 404, 409, 503. */
function manualRefusal(err: unknown): unknown {
  if (err instanceof DraftError) return draftRefusal(err);
  if (!(err instanceof ManualError)) return err;
  switch (err.code) {
    case 'not_found':
      return notFound(err.message);
    case 'conflict':
      return err.details
        ? new AppError(409, 'conflict', err.message, err.details)
        : conflict(err.message);
    case 'unavailable':
      return unavailable(err.message);
    default: {
      const problems = err.problems.map(apiProblem);
      if (err.problems.some((p) => p.code === 'plan_limit'))
        return planLimit(err.message, { problems });
      return badRequest(err.message, { problems });
    }
  }
}

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
    case 'too_many':
      return conflict(err.message);
    default:
      return badRequest(err.message);
  }
}

export const automationRoutes = [
  route('listAutomations', async (c) => {
    const rows = await listAutomations(c.get('user').id);
    return c.json({ items: rows.map(toApiAutomation) }, 200);
  }),

  // One automation, for its own page in the web app (drawn as a flow). Filtered by the user.
  route('getAutomation', async (c, { params }) => {
    const row = await getAutomation(c.get('user').id, params.automationId);
    if (!row) throw notFound('Automation not found');
    return c.json(toApiAutomation(row), 200);
  }),

  // Building and changing by hand (manual.ts). The checks while typing save nothing.
  route('checkAutomation', async (c, { body }) => {
    const userId = c.get('user').id;
    await enforce({ key: `automation-check:user:${userId}`, max: 600, windowSeconds: 3600 });
    const replacing = body.automationId ? await getAutomation(userId, body.automationId) : null;
    if (body.automationId && !replacing) throw notFound('Automation not found');
    const found = await examine(userId, partsOf(body), { replacing });
    return c.json(
      {
        ok: found.problems.length === 0,
        problems: found.problems.map(apiProblem),
        kind: found.kind,
        nextRuns: found.nextRuns.slice(0, 3).map((d) => d.toISOString()),
      },
      200,
    );
  }),

  route('createAutomation', async (c, { body }) => {
    const userId = c.get('user').id;
    await enforce({ key: `automation-save:user:${userId}`, max: 30, windowSeconds: 3600 });
    try {
      const { automation, created } = await createByHand(userId, {
        ...partsOf(body),
        enabled: body.enabled !== false,
        draftId: body.draftId ?? null,
        clientRequestId: body.clientRequestId,
      });
      return c.json(toApiAutomation(automation), created ? 201 : 200);
    } catch (err) {
      throw manualRefusal(err);
    }
  }),

  route('changeAutomation', async (c, { params, body }) => {
    const userId = c.get('user').id;
    await enforce({ key: `automation-save:user:${userId}`, max: 30, windowSeconds: 3600 });
    try {
      const row = await changeByHand(userId, params.automationId, {
        ...partsOf(body),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        draftId: body.draftId ?? null,
      });
      return c.json(toApiAutomation(row), 200);
    } catch (err) {
      throw manualRefusal(err);
    }
  }),

  // "Run once now": a test run, on or paused, at a normal run's cost. 10 an hour.
  route('runAutomationNow', async (c, { params, body }) => {
    const userId = c.get('user').id;
    try {
      const { automation, eventId } = await queueTestRun(
        userId,
        params.automationId,
        body.clientRequestId,
        async () => {
          if (!(await userHasCredits(userId))) throw outOfCredits();
          await enforce({
            key: `automation-test:user:${userId}`,
            max: TEST_RUNS_PER_HOUR,
            windowSeconds: 3600,
          });
        },
      );
      return c.json(
        { automationId: automation.id, eventId, queuedAt: new Date().toISOString() },
        202,
      );
    } catch (err) {
      throw manualRefusal(err);
    }
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

  // Drafts the agent proposed (drafts.ts). Only the user saves one: here, or with Save in a chat app.
  route('listAutomationDrafts', async (c) => {
    const rows = await listOpenDrafts(c.get('user').id);
    return c.json({ items: rows.map(toApiDraft) }, 200);
  }),

  // "Ask Tex to change this": the user's version from the canvas, kept for Tex (manual.ts).
  route('createAutomationDraft', async (c, { body }) => {
    const userId = c.get('user').id;
    await enforce({ key: `draft-user:user:${userId}`, max: 60, windowSeconds: 3600 });
    try {
      const { draft } = await createUserDraft(userId, {
        ...partsOf(body),
        changeOf: body.changeOf ?? null,
        replaces: body.replacesDraftId ?? null,
      });
      return c.json(toApiDraft(draft), 201);
    } catch (err) {
      throw draftRefusal(err);
    }
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
      return c.json({ draft: toApiDraft(draft), automation: toApiAutomation(automation) }, 200);
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
