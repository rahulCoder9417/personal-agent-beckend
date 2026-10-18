// Where attachment files live on disk: ATTACHMENTS_DIR/<userId>/<attachmentId>. In the containers
// that folder is a Docker volume, so the files survive restarts and deploys. Every path is built
// here from validated ids and checked to stay inside the user's own folder.
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { config } from '../../shared/config.ts';

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

function safeId(value: string, what: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`invalid ${what}`);
  return value;
}

const userDir = (userId: string) => resolve(config().ATTACHMENTS_DIR, safeId(userId, 'user id'));

/** The file's path, or an error when the user id or the attachment id is not a plain id. */
export function attachmentPath(userId: string, id: string): string {
  return join(userDir(userId), safeId(id, 'attachment id'));
}

/** Writes the file (creating the user's folder) and returns its path. */
export async function saveAttachmentFile(
  userId: string,
  id: string,
  data: Buffer,
): Promise<string> {
  const path = attachmentPath(userId, id);
  await mkdir(userDir(userId), { recursive: true });
  await writeFile(path, data);
  return path;
}

/**
 * The stored path when it is a file inside this user's own folder, otherwise undefined. A row
 * whose path points elsewhere (an old row from before the volume, or a bad one) is never read.
 */
export async function readableAttachmentPath(row: {
  userId: string;
  path: string;
}): Promise<string | undefined> {
  let dir: string;
  try {
    dir = userDir(row.userId);
  } catch {
    return undefined;
  }
  const path = resolve(row.path);
  if (!path.startsWith(dir + sep)) return undefined;
  const info = await stat(path).catch(() => undefined);
  return info?.isFile() ? path : undefined;
}

/** Removes a file, but only one inside this user's folder. A missing file is fine. */
export async function removeAttachmentFile(row: { userId: string; path: string }): Promise<void> {
  let dir: string;
  try {
    dir = userDir(row.userId);
  } catch {
    return;
  }
  const path = resolve(row.path);
  if (path.startsWith(dir + sep)) await rm(path, { force: true });
}
