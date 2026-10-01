import type { Context, Hono } from 'hono';
import { audit } from '../modules/admin/audit.ts';
import {
  GitGatewayError,
  gitInfoRefs,
  gitRpc,
  parseGitService,
  parseRepo,
  type GitRepo,
  type GitService,
} from '../modules/integrations/git-gateway.ts';
import { touch, userIdForMcpToken } from '../modules/orchestrator/sandbox.ts';
import { logger } from '../shared/logger.ts';
import { hit } from '../shared/rate-limit.ts';
import { bearerToken } from './router.ts';
import type { AppEnv } from './types.ts';

/** The container token: `Authorization: Bearer <token>`, or Basic auth with it as the password. */
function containerToken(c: Context): string | undefined {
  const bearer = bearerToken(c);
  if (bearer) return bearer;
  const h = c.req.header('authorization');
  if (!h?.toLowerCase().startsWith('basic ')) return undefined;
  const decoded = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
  const at = decoded.indexOf(':');
  return at >= 0 ? decoded.slice(at + 1) || undefined : undefined;
}

const text = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(`${message}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  });

/**
 * Git gateway at /git/<owner>/<repo> (git smart HTTP, HLD section 5.1). Like /mcp, the caller is
 * identified ONLY by the container token. Errors are text/plain: git prints them as `remote: …`.
 */
export function mountGit(app: Hono<AppEnv>): void {
  const handle =
    (run: (userId: string, repo: GitRepo, c: Context) => Promise<Response>) =>
    async (c: Context) => {
      const token = containerToken(c);
      const userId = token ? await userIdForMcpToken(token) : null;
      if (!userId) return text(401, 'Unauthorized');
      const rl = await hit({ key: `git:user:${userId}`, max: 300, windowSeconds: 60 });
      if (!rl.allowed) return text(429, 'Rate limited', { 'Retry-After': String(rl.retryAfter) });
      touch(userId);
      try {
        return await run(userId, parseRepo(c.req.param('owner')!, c.req.param('repo')!), c);
      } catch (err) {
        if (err instanceof GitGatewayError) return text(err.status, err.message);
        logger().error({ userId, err: String(err) }, 'git gateway failed');
        return text(502, 'The git gateway could not reach GitHub');
      }
    };

  const rpc = (service: GitService) =>
    handle(async (userId, repo, c) => {
      const { response, pushed } = await gitRpc({
        userId,
        repo,
        service,
        headers: c.req.raw.headers,
        body: c.req.raw.body,
      });
      if (pushed.length) {
        const name = `${repo.owner}/${repo.repo}`;
        const refs = pushed.map((p) => p.ref);
        await audit({
          userId,
          actor: 'agent',
          action: 'git_push',
          summary: `Pushed ${refs.map((r) => r.replace('refs/heads/', '')).join(', ')} to ${name}`,
          details: { repo: name, refs },
        });
      }
      return response;
    });

  app.get(
    '/git/:owner/:repo/info/refs',
    handle(async (userId, repo, c) => {
      const service = parseGitService(c.req.query('service'));
      if (!service) return text(400, 'Only git smart HTTP is supported');
      const res = await gitInfoRefs({ userId, repo, service, headers: c.req.raw.headers });
      if (service === 'git-upload-pack') {
        const name = `${repo.owner}/${repo.repo}`;
        await audit({
          userId,
          actor: 'agent',
          action: 'git_fetch',
          summary: `Fetched ${name}`,
          details: { repo: name },
        });
      }
      return res;
    }),
  );
  app.post('/git/:owner/:repo/git-upload-pack', rpc('git-upload-pack'));
  app.post('/git/:owner/:repo/git-receive-pack', rpc('git-receive-pack'));
}
