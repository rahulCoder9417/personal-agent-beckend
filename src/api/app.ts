import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { AppError } from '../shared/errors.ts';
import { logger } from '../shared/logger.ts';
import { mountAdminBoard } from './admin-board.ts';
import { errorResponse, mountRoutes, type RouteDef } from './router.ts';
import { meRoutes } from './routes/me.ts';
import { systemRoutes } from './routes/system.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import type { AppEnv } from './types.ts';

export const allRoutes: RouteDef[] = [...systemRoutes, ...meRoutes, ...webhookRoutes];

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(requestId());

  app.onError((err, c) => {
    if (err instanceof AppError) return errorResponse(c, err);
    logger().error({ err: err.message, stack: err.stack, path: c.req.path }, 'unhandled error');
    return errorResponse(c, new AppError(500, 'internal', 'Internal error'));
  });
  app.notFound((c) => errorResponse(c, new AppError(404, 'not_found', 'Not found')));

  mountRoutes(app, allRoutes);
  mountAdminBoard(app);
  return app;
}
