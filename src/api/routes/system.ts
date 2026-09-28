import { route } from '../router.ts';

export const systemRoutes = [route('getHealth', (c) => c.json({ status: 'ok' as const }, 200))];
