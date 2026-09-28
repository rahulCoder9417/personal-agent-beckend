import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { AppError } from '../shared/errors.ts';
import { logger } from '../shared/logger.ts';
import { mountAdminBoard } from './admin-board.ts';
import { errorResponse, mountRoutes, type RouteDef } from './router.ts';
import { adminRoutes } from './routes/admin.ts';
import { billingRoutes } from './routes/billing.ts';
import { byokRoutes } from './routes/byok.ts';
import { couponRoutes } from './routes/coupons.ts';
import { creditRoutes } from './routes/credits.ts';
import { meRoutes } from './routes/me.ts';
import { systemRoutes } from './routes/system.ts';
import { dodoWebhookRoutes } from './routes/webhooks-dodo.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import type { AppEnv } from './types.ts';

export const allRoutes: RouteDef[] = [
  ...systemRoutes,
  ...meRoutes,
  ...webhookRoutes,
  // Phase 5: billing, credits, coupons, bring-your-own key, admin, Dodo webhook
  ...billingRoutes,
  ...creditRoutes,
  ...couponRoutes,
  ...byokRoutes,
  ...adminRoutes,
  ...dodoWebhookRoutes,
];

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
