// Is a push a fast-forward (docs/backend-report.md, "The git gateway")? Told from the commits in
// the push's pack, and for commits GitHub already has, from GitHub's compare API.
import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  isFastForward,
  packCommits,
  PackError,
} from '../src/modules/integrations/git-pack.ts';
import { commit, delta, gitObject, pack } from './git-packs.ts';

const OLD = commit([]);
const never = async () => {
  throw new Error('GitHub should not be asked');
};

describe('packCommits', () => {
  it('finds each commit and its parents, and nothing in an empty push', () => {
    const c1 = commit([OLD.id]);
    const c2 = commit([c1.id, OLD.id], 'a merge');
    const blob = gitObject(3, 'hello\n');
    const commits = packCommits(pack([c1, blob, c2]));
    expect([...commits.entries()]).toEqual([
      [c1.id, [OLD.id]],
      [c2.id, [c1.id, OLD.id]],
    ]);
    expect(packCommits(Buffer.alloc(0)).size).toBe(0);
  });

  it('resolves deltas against an earlier object in the pack, by offset or by id', () => {
    const c1 = commit([OLD.id]);
    const c2 = commit([c1.id]);
    const c3 = commit([c2.id]);
    const commits = packCommits(
      pack([
        c1,
        { ofsDeltaOf: 0, delta: delta(c1.data, c2.data, 10) },
        { refDeltaOf: c1.id, delta: delta(c1.data, c3.data, 4) },
      ]),
    );
    expect(commits.get(c2.id)).toEqual([c1.id]);
    expect(commits.get(c3.id)).toEqual([c2.id]);
  });

  it('leaves out a delta whose base is not in the pack (a thin pack)', () => {
    const c1 = commit([OLD.id]);
    const commits = packCommits(pack([{ refDeltaOf: OLD.id, delta: delta(OLD.data, c1.data, 5) }]));
    expect(commits.has(c1.id)).toBe(false);
  });

  it('refuses what is not a pack', () => {
    expect(() => packCommits(Buffer.from('not a pack at all'))).toThrow(PackError);
    const broken = pack([commit([OLD.id])]);
    expect(() => packCommits(broken.subarray(0, 20))).toThrow(PackError);
    expect(() => applyDelta(Buffer.from('abc'), Buffer.from([9, 3, 3, 0x61, 0x62, 0x63]))).toThrow(
      PackError,
    );
  });
});

describe('isFastForward', () => {
  it('is one when the new commits lead back to the branch’s commit', async () => {
    const c1 = commit([OLD.id]);
    const c2 = commit([c1.id]);
    expect(await isFastForward(OLD.id, c2.id, packCommits(pack([c1, c2])), never)).toBe(true);
    expect(await isFastForward(OLD.id, OLD.id, new Map(), never)).toBe(true);
  });

  it('asks GitHub about the commits the walk leaves the pack at', async () => {
    const base = commit([]); // on GitHub, not sent
    const c1 = commit([base.id]);
    const asked: Array<[string, string]> = [];
    const github = (answer: boolean) => async (a: string, b: string) => {
      asked.push([a, b]);
      return answer;
    };
    const commits = packCommits(pack([c1]));
    expect(await isFastForward(OLD.id, c1.id, commits, github(true))).toBe(true);
    expect(asked).toEqual([[OLD.id, base.id]]);
    // A rebase on top of something else: the branch's commit is not under the new one.
    expect(await isFastForward(OLD.id, c1.id, commits, github(false))).toBe(false);
  });

  it('asks GitHub directly when the new commit was not sent (it has it already)', async () => {
    const elsewhere = commit([]);
    const asked: string[] = [];
    await isFastForward(OLD.id, elsewhere.id, new Map(), async (_a, b) => {
      asked.push(b);
      return false;
    });
    expect(asked).toEqual([elsewhere.id]);
  });

  it('a new history with no parent is never a fast-forward; SHA-256 ids can’t be checked', async () => {
    const root = commit([]);
    expect(await isFastForward(OLD.id, root.id, packCommits(pack([root])), never)).toBe(false);
    await expect(isFastForward('a'.repeat(64), 'b'.repeat(64), new Map(), never)).rejects.toThrow(
      PackError,
    );
  });
});
