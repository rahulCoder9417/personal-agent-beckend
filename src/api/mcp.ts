import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import { isSuspended } from '../modules/auth/users.ts';
import { getAttachment, verifyFileSignature } from '../modules/channels/files.ts';
import { userIdForMcpToken } from '../modules/orchestrator/sandbox.ts';
import { handleMcpRequest } from '../modules/platform-mcp/server.ts';
import { hit } from '../shared/rate-limit.ts';
import { bearerToken } from './router.ts';
import type { AppEnv } from './types.ts';

/**
 * Platform MCP at /mcp (MCP streamable HTTP, stateless). The caller is identified ONLY by the
 * container token; any user id an agent sends is ignored.
 */
export function mountMcp(app: Hono<AppEnv>): void {
  app.get('/mcp/files/:id', async (c) => {
    const id = c.req.param('id');
    if (!verifyFileSignature(id, c.req.query('exp'), c.req.query('sig')))
      return c.json({ error: { code: 'forbidden', message: 'Bad signature' } }, 403);
    const file = await getAttachment(id);
    if (!file) return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    return new Response(Readable.toWeb(createReadStream(file.path)) as ReadableStream, {
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
