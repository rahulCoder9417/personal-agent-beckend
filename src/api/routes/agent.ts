import { listAudit } from '../../modules/admin/audit.ts';
import { PLAN_IDS, PLANS } from '../../modules/billing/plans.ts';
import { crewOfDetails, listCrew } from '../../modules/orchestrator/crew.ts';
import { requestPrewarm } from '../../modules/orchestrator/prewarm.ts';
import { getAgentStatus } from '../../modules/orchestrator/sandbox.ts';
import { iso } from '../presenters.ts';
import { route } from '../router.ts';

export const agentRoutes = [
  route('getAgentStatus', async (c) => {
    const s = await getAgentStatus(c.get('user').id);
    return c.json({ state: s.state, lastActiveAt: iso(s.lastActiveAt) }, 200);
  }),

  // Wake the container before the message (HLD 5.2): checks, then a job; answers at once.
  route('prewarmAgent', async (c) => c.json(await requestPrewarm(c.get('user').id), 200)),

  // The crew for the apps (HLD 0.7). The browser's plan comes from the plans, not from here.
  route('listCrew', (c) => {
    const browserPlan = PLAN_IDS.find((id) => PLANS[id].limits.browser) ?? 'max';
    return c.json(
      {
        items: listCrew(c.get('user').plan).map((m) => ({
          id: m.id,
          name: m.name,
          kind: m.kind,
          role: m.role,
          description: m.description,
          available: m.available,
          browser: m.browser ? { requiresPlan: browserPlan, ...m.browser } : null,
        })),
      },
      200,
    );
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
          crew: crewOfDetails(e.details),
          memoryId: typeof e.details?.memoryId === 'string' ? e.details.memoryId : null,
          creditsCharged: e.creditsCharged,
          createdAt: e.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      },
      200,
    );
  }),
];
