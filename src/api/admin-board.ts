import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { HonoAdapter } from '@bull-board/hono';
import type { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { QUEUES, queue } from '../modules/events/queues.ts';
import { requireAdmin, requireUser } from './router.ts';
import type { AppEnv } from './types.ts';

export const ADMIN_BOARD_PATH = '/admin/queues';

/** Bull Board, admins only (HLD 0.2). Browser access uses Clerk's `__session` cookie. */
export function mountAdminBoard(app: Hono<AppEnv>): void {
  const serverAdapter = new HonoAdapter(serveStatic);
  createBullBoard({ queues: QUEUES.map((q) => new BullMQAdapter(queue(q))), serverAdapter });
  serverAdapter.setBasePath(ADMIN_BOARD_PATH);
  app.use(
    `${ADMIN_BOARD_PATH}/*`,
    requireUser({ allowCookie: true, allowQueryToken: true }),
    requireAdmin,
  );
  app.use(
    ADMIN_BOARD_PATH,
    requireUser({ allowCookie: true, allowQueryToken: true }),
    requireAdmin,
  );
  app.route(ADMIN_BOARD_PATH, serverAdapter.registerPlugin() as unknown as Hono<AppEnv>);
}
