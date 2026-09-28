import {
  decideApproval,
  getApproval,
  listApprovals,
  toApiApproval,
} from '../../modules/orchestrator/approvals.ts';
import { notFound } from '../../shared/errors.ts';
import { route } from '../router.ts';

export const approvalRoutes = [
  route('listApprovals', async (c, { query }) => {
    const page = await listApprovals(c.get('user').id, {
      limit: query.limit ?? 30,
      ...(query.status ? { status: query.status } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    return c.json({ items: page.items.map(toApiApproval), nextCursor: page.nextCursor }, 200);
  }),

  route('decideApproval', async (c, { params, body }) => {
    const userId = c.get('user').id;
    if (!(await getApproval(userId, params.approvalId))) throw notFound('Approval not found');
    const a = await decideApproval(userId, params.approvalId, body.decision === 'approve', 'web');
    return c.json(toApiApproval(a), 200);
  }),
];
