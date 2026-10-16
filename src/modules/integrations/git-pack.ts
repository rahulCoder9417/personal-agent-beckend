// Is a push a fast-forward? The git gateway asks before a push to a branch that already exists
// (docs/backend-report.md, "The git gateway"). GitHub takes a force push from anyone who may
// push, so the gateway tells the two apart itself, from what the push sends: the commits in its
// pack. A push only adds commits when the branch's current commit (`oldId`) is an ancestor of the
// new one (`newId`). The new commits are in the pack; the walk back through their parents either
// meets `oldId`, or leaves the pack at commits GitHub already has, which GitHub is then asked
// about (its compare API). Whatever can't be read counts as a force push: the user is asked.
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const OBJ_COMMIT = 1;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;
const TYPE_NAMES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
/** Commits looked at in one push, at most; a longer history is asked about as unknown. */
const MAX_WALK = 20_000;
/** Commits that GitHub is asked about in one check, at most. */
const MAX_BOUNDARY = 8;

/** Thrown for a pack that can't be read: the push then counts as a force push. */
export class PackError extends Error {}

interface Entry {
  type: number;
  data: Buffer;
  /** OFS_DELTA: the base's offset in the pack. REF_DELTA: the base's id. */
  base?: number | string;
}

function inflateAt(buf: Buffer, at: number): { data: Buffer; next: number } {
  try {
    const { buffer, engine } = inflateSync(buf.subarray(at), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    return { data: buffer, next: at + engine.bytesWritten };
  } catch {
    throw new PackError('a pack object could not be read');
  }
}

/** git's delta format: the base's size, the result's size, then copy and insert instructions. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const size = () => {
    let n = 0;
    let shift = 0;
    for (;;) {
      const b = delta[at++];
      if (b === undefined) throw new PackError('bad delta');
      n += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) return n;
    }
  };
  if (size() !== base.length) throw new PackError('delta does not fit its base');
  const out = Buffer.alloc(size());
  let o = 0;
  while (at < delta.length) {
    const op = delta[at++]!;
    if (op & 0x80) {
      let off = 0;
      let len = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) off |= delta[at++]! << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (1 << (4 + i))) len |= delta[at++]! << (8 * i);
      if (len === 0) len = 0x10000;
      off >>>= 0;
      if (off + len > base.length || o + len > out.length) throw new PackError('bad delta copy');
      base.copy(out, o, off, off + len);
      o += len;
    } else if (op > 0) {
      if (at + op > delta.length || o + op > out.length) throw new PackError('bad delta insert');
      delta.copy(out, o, at, at + op);
      at += op;
      o += op;
    } else {
      throw new PackError('bad delta instruction');
    }
  }
  if (o !== out.length) throw new PackError('delta result too short');
  return out;
}

/**
 * The commits in a pack, by id, with their parents. Deltas whose base is in the pack are resolved;
 * one whose base is not (a thin pack's base on GitHub) is left out, so a commit sent that way is
 * not found and the push counts as unknown. An empty body (nothing new to send) has no commits.
 */
export function packCommits(pack: Buffer): Map<string, string[]> {
  const commits = new Map<string, string[]>();
  if (pack.length === 0) return commits;
  if (pack.length < 12 || pack.subarray(0, 4).toString('latin1') !== 'PACK')
    throw new PackError('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError('unknown pack version');
  const count = pack.readUInt32BE(8);
  const entries = new Map<number, Entry>();
  let at = 12;
  for (let i = 0; i < count; i++) {
    const start = at;
    let byte = pack[at++];
    if (byte === undefined) throw new PackError('pack ends early');
    const type = (byte >> 4) & 7;
    while (byte & 0x80) {
      byte = pack[at++];
      if (byte === undefined) throw new PackError('pack ends early');
    }
    let base: number | string | undefined;
    if (type === OBJ_OFS_DELTA) {
      let b = pack[at++]!;
      let off = b & 0x7f;
      while (b & 0x80) {
        b = pack[at++]!;
        off = (off + 1) * 128 + (b & 0x7f);
      }
      base = start - off;
    } else if (type === OBJ_REF_DELTA) {
      base = pack.subarray(at, at + 20).toString('hex');
      at += 20;
    } else if (!TYPE_NAMES[type]) {
      throw new PackError('unknown object type');
    }
    const { data, next } = inflateAt(pack, at);
    at = next;
    entries.set(start, { type, data, ...(base !== undefined ? { base } : {}) });
  }

  // Resolve every object to its type, content and id.
  const resolved = new Map<number, { type: number; data: Buffer; id: string }>();
  const byId = new Map<string, number>();
  const idOf = (type: number, data: Buffer) =>
    createHash('sha1').update(`${TYPE_NAMES[type]} ${data.length}\0`).update(data).digest('hex');
  const resolve = (
    offset: number,
    depth = 0,
  ): { type: number; data: Buffer; id: string } | null => {
    const hit = resolved.get(offset);
    if (hit) return hit;
    const e = entries.get(offset);
    if (!e || depth > 50) return null;
    let type = e.type;
    let data = e.data;
    if (type === OBJ_OFS_DELTA || type === OBJ_REF_DELTA) {
      const baseAt = typeof e.base === 'number' ? e.base : byId.get(String(e.base));
      if (baseAt === undefined) return null;
      const base = resolve(baseAt, depth + 1);
      if (!base) return null;
      type = base.type;
      data = applyDelta(base.data, e.data);
    }
    const r = { type, data, id: idOf(type, data) };
    resolved.set(offset, r);
    byId.set(r.id, offset);
    return r;
  };
  // Whole objects first, so a REF_DELTA can find its base by id; then the deltas, until no more resolve.
  for (const [offset, e] of entries) if (e.type < OBJ_OFS_DELTA) resolve(offset);
  for (let progress = true; progress;) {
    progress = false;
    for (const offset of entries.keys())
      if (!resolved.has(offset) && resolve(offset)) progress = true;
  }
  for (const r of resolved.values()) {
    if (r.type !== OBJ_COMMIT) continue;
    const head = r.data.toString('utf8').split('\n\n', 1)[0] ?? '';
    const parents = head
      .split('\n')
      .filter((l) => l.startsWith('parent '))
      .map((l) => l.slice(7).trim());
    commits.set(r.id, parents);
  }
  return commits;
}

/**
 * True when `newId` only adds commits on top of `oldId`. `isAncestor(oldId, commit)` asks GitHub
 * about a commit it already has. Throws PackError when it can't be told.
 */
export async function isFastForward(
  oldId: string,
  newId: string,
  commits: Map<string, string[]>,
  isAncestor: (ancestor: string, commit: string) => Promise<boolean>,
): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/.test(oldId) || !/^[0-9a-f]{40}$/.test(newId))
    throw new PackError('only SHA-1 repositories can be checked');
  if (oldId === newId) return true;
  // The new commit was not sent: GitHub has it already (a branch moved to an existing commit).
  if (!commits.has(newId)) return isAncestor(oldId, newId);
  const boundary = new Set<string>();
  const seen = new Set<string>([newId]);
  const queue = [newId];
  while (queue.length) {
    if (seen.size > MAX_WALK) throw new PackError('history too long to check');
    const id = queue.pop()!;
    for (const parent of commits.get(id) ?? []) {
      if (parent === oldId) return true;
      if (seen.has(parent)) continue;
      seen.add(parent);
      if (commits.has(parent)) queue.push(parent);
      else boundary.add(parent);
    }
  }
  // The walk left the pack at commits GitHub has: `oldId` must be an ancestor of one of them.
  if (boundary.size === 0) return false; // a new root: unrelated history
  if (boundary.size > MAX_BOUNDARY) throw new PackError('too many commits to ask GitHub about');
  for (const commit of boundary) if (await isAncestor(oldId, commit)) return true;
  return false;
}
