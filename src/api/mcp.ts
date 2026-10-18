import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import { z } from 'zod';
import { isSuspended } from '../modules/auth/users.ts';
import { readableAttachmentPath } from '../modules/channels/attachment-store.ts';
import { getAttachment, verifyFileSignature } from '../modules/channels/files.ts';
import { checkGate, GATED_TOOLS } from '../modules/orchestrator/gate.ts';
import { touch, userIdForMcpToken } from '../modules/orchestrator/sandbox.ts';
import { handleMcpRequest } from '../modules/platform-mcp/server.ts';
import { hit } from '../shared/rate-limit.ts';
import { bearerToken } from './router.ts';
import type { AppEnv } from './types.ts';

/**
 * Platform MCP at /mcp (MCP streamable HTTP, stateless). The caller is identified ONLY by the
 * container token; any user id an agent sends is ignored.
 */
const GateCallBody = z.object({
  tool: z.enum(GATED_TOOLS),
  target: z.string().min(1).max(20_000),
  why: z.string().max(500).default(''),
  cwd: z.string().max(1000).nullish(),
});

export function mountMcp(app: Hono<AppEnv>): void {
  // Claude Code's gate hook (docs/backend-report.md, "Approvals for the agent's own actions"):
  // before a command or file change that needs the user's OK. Like /mcp, the caller is known by
  // the container token only. Under /mcp, so it is closed to the internet with it.
  app.post('/mcp/gate', async (c) => {
    const token = bearerToken(c);
    const userId = token ? await userIdForMcpToken(token) : null;
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Unauthorized' } }, 401);
    c.set('containerUserId', userId);
    if (await isSuspended(userId))
      return c.json({ error: { code: 'forbidden', message: 'This account is suspended' } }, 403);
    const rl = await hit({ key: `gate:user:${userId}`, max: 60, windowSeconds: 60 });
    if (!rl.allowed)
      return c.json({ error: { code: 'rate_limited', message: 'Rate limited' } }, 429, {
        'Retry-After': String(rl.retryAfter),
      });
    const parsed = GateCallBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: { code: 'bad_request', message: 'Not a gate call' } }, 400);
    touch(userId);
    return c.json(await checkGate(userId, parsed.data));
  });

  app.get('/mcp/files/:id', async (c) => {
    const id = c.req.param('id');
    if (!verifyFileSignature(id, c.req.query('exp'), c.req.query('sig')))
      return c.json({ error: { code: 'forbidden', message: 'Bad signature' } }, 403);
    const file = await getAttachment(id);
    if (!file) return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    const path = await readableAttachmentPath(file);
    if (!path) return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: {
        'content-type': file.mimeType,
        'content-disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
      },
    });
  });

  app.all('/mcp', async (c) => {
    const token = bearerToken(c);
    const userId = token ? await userIdForMcpToken(token) : null;
    if (!userId) {
      return c.json(
        { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
        401,
      );
    }
    c.set('containerUserId', userId);
    // Suspended by an admin: a turn that was running keeps no tools; the container is stopped.
    if (await isSuspended(userId)) {
      return c.json(
        { jsonrpc: '2.0', error: { code: -32003, message: 'This account is suspended' }, id: null },
        403,
      );
    }
    const rl = await hit({ key: `mcp:user:${userId}`, max: 240, windowSeconds: 60 });
    if (!rl.allowed) {
      return c.json(
        { jsonrpc: '2.0', error: { code: -32029, message: 'Rate limited' }, id: null },
        429,
        { 'Retry-After': String(rl.retryAfter) },
      );
    }
    return handleMcpRequest({ userId }, c.req.raw);
  });
}
