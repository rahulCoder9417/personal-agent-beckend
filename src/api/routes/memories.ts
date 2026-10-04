import { audit } from '../../modules/admin/audit.ts';
import {
  deleteAllMemories,
  deleteMemory,
  listMemories,
  MEMORY_MAX_COUNT,
  toApiMemory,
} from '../../modules/orchestrator/memory.ts';
import { notFound } from '../../shared/errors.ts';
import { route } from '../router.ts';

// The user's side of the shared memory (HLD 0.9): see it and delete it. Memories are made by the
// agent; there is no endpoint to add or edit one. The activity log never gets a memory's text.
export const memoryRoutes = [
  route('listMemories', async (c) => {
    const rows = await listMemories(c.get('user').id);
    return c.json({ items: rows.map(toApiMemory), max: MEMORY_MAX_COUNT }, 200);
  }),

  route('deleteMemory', async (c, { params }) => {
    const userId = c.get('user').id;
    const removed = await deleteMemory(userId, params.memoryId);
    if (!removed) throw notFound('Memory not found');
    await audit({
      userId,
      actor: 'user',
      action: 'memory_deleted',
      summary: 'Deleted a memory',
      details: { memoryId: removed.id },
    });
    return c.body(null, 204);
  }),

  route('deleteAllMemories', async (c) => {
    const userId = c.get('user').id;
    const deleted = await deleteAllMemories(userId);
    if (deleted > 0)
      await audit({
        userId,
        actor: 'user',
        action: 'memories_cleared',
        summary: `Deleted all memories (${deleted})`,
      });
    return c.json({ deleted }, 200);
  }),
];
