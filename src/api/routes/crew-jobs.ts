// Crew jobs (docs/backend-report.md, "The crew"): the user gives Patch a review or Byte a job,
// with a brief; the worker runs it as one turn of the agent.
import {
  checkBrief,
  createCrewJob,
  CrewJobError,
  crewJobForRequest,
  getCrewJob,
  listCrewJobs,
  reportSession,
  toApiCrewJob,
} from '../../modules/automations/crew-jobs.ts';
import {
  GithubNotConnected,
  GithubUnavailable,
  listGithubRepos,
} from '../../modules/integrations/github-repos.ts';
import { userHasCredits } from '../../modules/orchestrator/turn.ts';
import {
  AppError,
  badRequest,
  conflict,
  notFound,
  outOfCredits,
  unavailable,
} from '../../shared/errors.ts';
import { enforce } from '../../shared/rate-limit.ts';
import { route } from '../router.ts';

function apiError(err: unknown): unknown {
  if (err instanceof CrewJobError)
    return err.code === 'invalid' ? badRequest(err.message) : conflict(err.message);
  return err;
}

export const crewJobRoutes = [
  route('listGithubRepos', async (c) => {
    const userId = c.get('user').id;
    await enforce({ key: `github-repos:user:${userId}`, max: 30, windowSeconds: 60 });
    try {
      return c.json({ items: await listGithubRepos(userId) }, 200);
    } catch (err) {
      if (err instanceof GithubNotConnected) throw conflict(err.message);
      if (err instanceof GithubUnavailable) throw unavailable(err.message);
      throw err;
    }
  }),

  route('listCrewJobs', async (c, { query }) => {
    const page = await listCrewJobs(c.get('user').id, {
      limit: query.limit ?? 30,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    return c.json({ items: page.items.map(toApiCrewJob), nextCursor: page.nextCursor }, 200);
  }),

  route('getCrewJob', async (c, { params }) => {
    const job = await getCrewJob(c.get('user').id, params.crewJobId);
    if (!job) throw notFound('Crew job not found');
    return c.json(toApiCrewJob(job), 200);
  }),

  route('createCrewJob', async (c, { body }) => {
    const userId = c.get('user').id;
    await enforce({ key: `crew-job:user:${userId}`, max: 20, windowSeconds: 3600 });
    // The same request again: the job it made, and nothing new.
    const seen = await crewJobForRequest(userId, body.clientRequestId);
    if (seen) return c.json(toApiCrewJob(seen), 200);
    try {
      const brief = checkBrief(body);
      const sessionKey = await reportSession(userId, body.reportTo?.channel);
      if (!(await userHasCredits(userId))) throw outOfCredits();
      const { job, created } = await createCrewJob(userId, brief, {
        source: 'app',
        sessionKey,
        clientRequestId: body.clientRequestId,
      });
      return c.json(toApiCrewJob(job), created ? 201 : 200);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw apiError(err);
    }
  }),
];
