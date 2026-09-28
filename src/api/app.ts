import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { wireModules } from '../wiring.ts';
import { AppError } from '../shared/errors.ts';
import { logger } from '../shared/logger.ts';
import { mountAdminBoard } from './admin-board.ts';
import { mountMcp } from './mcp.ts';
import { accessLog, clientIp, ipRateLimit } from './middleware.ts';
import { renderMetrics } from '../modules/admin/metrics.ts';
import { config } from '../shared/config.ts';
import { safeEqual } from '../shared/crypto.ts';
import { errorResponse, mountRoutes, type RouteDef } from './router.ts';
import { agentRoutes } from './routes/agent.ts';
import { appRoutes } from './routes/apps.ts';
import { approvalRoutes } from './routes/approvals.ts';
import { automationRoutes } from './routes/automations.ts';
import { channelRoutes } from './routes/channels.ts';
import { chatRoutes } from './routes/chat.ts';
import { meRoutes } from './routes/me.ts';
import { systemRoutes } from './routes/system.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { channelWebhookRoutes } from './routes/webhooks-channels.ts';
import type { AppEnv } from './types.ts';

export const allRoutes: RouteDef[] = [
  ...systemRoutes,
  ...meRoutes,
  ...channelRoutes,
  ...chatRoutes,
  ...agentRoutes,
  ...approvalRoutes,
  ...appRoutes,
  ...automationRoutes,
  ...webhookRoutes,
  ...channelWebhookRoutes,
];

export function createApp(): Hono<AppEnv> {
  wireModules();
  const app = new Hono<AppEnv>();
  app.use(requestId());
  app.use(accessLog);
  app.use(clientIp);
  app.use(ipRateLimit);

  app.onError((err, c) => {
    if (err instanceof AppError) return errorResponse(c, err);
    logger().error({ err: err.message, stack: err.stack, path: c.req.path }, 'unhandled error');
    return errorResponse(c, new AppError(500, 'internal', 'Internal error'));
  });
  app.notFound((c) => errorResponse(c, new AppError(404, 'not_found', 'Not found')));

  mountRoutes(app, allRoutes);
  mountMcp(app);

  // Prometheus metrics, bearer-protected (disabled when METRICS_TOKEN is unset).
  app.get('/metrics', async (c) => {
    const token = config().METRICS_TOKEN;
    const given = c.req.header('authorization')?.replace(/^Bearer /i, '') ?? '';
    if (!token || !safeEqual(given, token))
      return errorResponse(c, new AppError(404, 'not_found', 'Not found'));
    return c.text(await renderMetrics(), 200, { 'content-type': 'text/plain; version=0.0.4' });
  });
  mountAdminBoard(app);
  return app;
}
