import { listAudit } from '../../modules/admin/audit.ts';
import { getAgentStatus } from '../../modules/orchestrator/sandbox.ts';
import { iso } from '../presenters.ts';
import { route } from '../router.ts';

export const agentRoutes = [
  route('getAgentStatus', async (c) => {
    const s = await getAgentStatus(c.get('user').id);
    return c.json({ state: s.state, lastActiveAt: iso(s.lastActiveAt) }, 200);
  }),

  route('listActivity', async (c, { query }) => {
    const page = await listAudit(c.get('user').id, {
      limit: query.limit ?? 30,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    return c.json(
      {
        items: page.items.map((e) => ({
          id: e.id,
          actor: e.actor,
          action: e.action,
          summary: e.summary,
          creditsCharged: e.creditsCharged,
          createdAt: e.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      },
      200,
    );
  }),
];
