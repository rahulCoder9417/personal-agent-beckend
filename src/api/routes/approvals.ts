import {
  decideApproval,
  getApproval,
  listApprovals,
  toApiApproval,
} from '../../modules/orchestrator/approvals.ts';
import {
  createSkipRule,
  deleteSkipRule,
  listSkipRules,
  toApiSkipRule,
} from '../../modules/orchestrator/skip-rules.ts';
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

  // Skip rules: only the user, with their session, makes or removes one (never the agent).
  route('listSkipRules', async (c) => {
    const rules = await listSkipRules(c.get('user').id);
    return c.json({ items: rules.map(toApiSkipRule) }, 200);
  }),

  route('createSkipRule', async (c, { body }) => {
    const rule = await createSkipRule(c.get('user').id, {
      approvalId: body.approvalId,
      scope: body.scope,
      ...(body.recipients ? { recipients: body.recipients } : {}),
    });
    return c.json(toApiSkipRule(rule), 201);
  }),

  route('deleteSkipRule', async (c, { params }) => {
    if (!(await deleteSkipRule(c.get('user').id, params.ruleId)))
      throw notFound('Skip rule not found');
    return c.body(null, 204);
  }),
];
