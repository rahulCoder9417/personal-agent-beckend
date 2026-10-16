import { appEvents } from '../../modules/integrations/app-events.ts';
import { appCatalogFor, disconnect, startConnect } from '../../modules/integrations/apps.ts';
import { appForToolkit, findApp } from '../../modules/integrations/catalog.ts';
import { composioCallbackUrl } from '../../modules/integrations/composio.ts';
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  toApiMcpServer,
  updateMcpServer,
} from '../../modules/integrations/mcp-servers.ts';
import { logger } from '../../shared/logger.ts';
import { notFound, unavailable } from '../../shared/errors.ts';
import { route } from '../router.ts';

export const appRoutes = [
  route('listApps', async (c) => {
    const user = c.get('user');
    return c.json({ items: await appCatalogFor(user.id, user.plan) }, 200);
  }),

  route('connectApp', async (c, { params, body }) => {
    const user = c.get('user');
    const { redirectUrl } = await startConnect(user.id, user.plan, params.appSlug, body?.returnUrl);
    return c.json({ redirectUrl }, 200);
  }),

  // The provider's way back, through our own address, on to Composio. It only redirects: the
  // query holds a one-time code, so it is not read, saved or logged (the access log has the route
  // only).
  route('oauthCallback', (c) => {
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    return c.redirect(composioCallbackUrl(new URL(c.req.url).search), 302);
  }),

  // The events an app can start an automation on, for the canvas's picker (kept 10 minutes).
  route('listAppEvents', async (c, { params }) => {
    const app = findApp(params.appSlug) ?? appForToolkit(params.appSlug);
    if (!app) throw notFound('Unknown app');
    try {
      return c.json({ items: await appEvents(app.toolkit) }, 200);
    } catch (err) {
      logger().warn({ app: app.slug, err: String(err) }, 'app events not listed');
      throw unavailable(`Couldn't get ${app.name}'s events just now. Try again in a moment.`);
    }
  }),

  route('disconnectApp', async (c, { params }) => {
    if (!(await disconnect(c.get('user').id, params.connectionId)))
      throw notFound('Connection not found');
    return c.body(null, 204);
  }),

  route('listMcpServers', async (c) => {
    const rows = await listMcpServers(c.get('user').id);
    return c.json({ items: rows.map(toApiMcpServer) }, 200);
  }),

  route('createMcpServer', async (c, { body }) => {
    const user = c.get('user');
    const row = await createMcpServer(user.id, user.plan, body);
    return c.json(toApiMcpServer(row), 201);
  }),

  route('updateMcpServer', async (c, { params, body }) => {
    const row = await updateMcpServer(c.get('user').id, params.mcpServerId, body);
    if (!row) throw notFound('MCP server not found');
    return c.json(toApiMcpServer(row), 200);
  }),

  route('deleteMcpServer', async (c, { params }) => {
    if (!(await deleteMcpServer(c.get('user').id, params.mcpServerId)))
      throw notFound('MCP server not found');
    return c.body(null, 204);
  }),
];
