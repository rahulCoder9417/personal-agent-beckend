// Real git objects and packs for the gateway's tests: commits made by hand, packed the way git
// sends them in a push (version 2, zlib-compressed objects, deltas against an earlier object).
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface GitObject {
  type: 1 | 2 | 3 | 4;
  data: Buffer;
  id: string;
}

const NAMES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' } as const;

export function gitObject(type: GitObject['type'], data: Buffer | string): GitObject {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const id = createHash('sha1').update(`${NAMES[type]} ${buf.length}\0`).update(buf).digest('hex');
  return { type, data: buf, id };
}

let n = 0;
/** A commit with these parents (a unique message, so every commit has its own id). */
export function commit(parents: string[], message = `change ${++n}`): GitObject {
  return gitObject(
    1,
    `tree ${EMPTY_TREE}\n${parents.map((p) => `parent ${p}\n`).join('')}` +
      `author Agent <agent@example.com> 1700000000 +0000\n` +
      `committer Agent <agent@example.com> 1700000000 +0000\n\n${message}\n`,
  );
}

function header(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

function sizeVarint(size: number): Buffer {
  const out: number[] = [];
  do {
    let b = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) b |= 0x80;
    out.push(b);
  } while (size > 0);
  return Buffer.from(out);
}

/** A delta that copies the base's first `copy` bytes and inserts the rest of `target`. */
export function delta(base: Buffer, target: Buffer, copy: number): Buffer {
  const parts: Buffer[] = [sizeVarint(base.length), sizeVarint(target.length)];
  if (copy > 0) parts.push(Buffer.from([0x80 | 0x10, copy & 0xff])); // offset 0, one size byte
  for (let at = copy; at < target.length; at += 127) {
    const chunk = target.subarray(at, Math.min(at + 127, target.length));
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  return Buffer.concat(parts);
}

export type PackEntry =
  GitObject | { ofsDeltaOf: number; delta: Buffer } | { refDeltaOf: string; delta: Buffer };

/** A version 2 pack of these entries (an ofs delta names its base by its index in the list). */
export function pack(entries: PackEntry[]): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  const parts: Buffer[] = [head];
  const offsets: number[] = [];
  let at = 12;
  for (const e of entries) {
    offsets.push(at);
    let chunk: Buffer;
    if ('ofsDeltaOf' in e) {
      let off = at - offsets[e.ofsDeltaOf]!;
      const bytes = [off & 0x7f];
      off = Math.floor(off / 128);
      while (off > 0) {
        off -= 1;
        bytes.unshift(0x80 | (off & 0x7f));
        off = Math.floor(off / 128);
      }
      chunk = Buffer.concat([header(6, e.delta.length), Buffer.from(bytes), deflateSync(e.delta)]);
    } else if ('refDeltaOf' in e) {
      chunk = Buffer.concat([
        header(7, e.delta.length),
        Buffer.from(e.refDeltaOf, 'hex'),
        deflateSync(e.delta),
      ]);
    } else {
      chunk = Buffer.concat([header(e.type, e.data.length), deflateSync(e.data)]);
    }
    parts.push(chunk);
    at += chunk.length;
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, '0') + line;

/** A git-receive-pack request: the command list, a flush, then the pack. */
export function receivePack(commands: Array<[string, string, string]>, body: Buffer): Buffer {
  const head =
    commands
      .map(([o, nw, ref], i) => pkt(`${o} ${nw} ${ref}${i === 0 ? '\0report-status' : ''}\n`))
      .join('') + '0000';
  return Buffer.concat([Buffer.from(head, 'latin1'), body]);
}
