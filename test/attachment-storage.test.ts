import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { signedFileUrl } from '../src/modules/channels/files.ts';
import { deleteUserChannelData } from '../src/modules/channels/messages.ts';
import { attachments } from '../src/modules/channels/schema.ts';
import { db } from '../src/shared/db/client.ts';
import { resetConfig } from '../src/shared/config.ts';
import { chatUser, expectContract, testApp } from './helpers.ts';

async function upload(token: string, text: string) {
  const form = new FormData();
  form.append('file', new File([text], 'note.txt', { type: 'text/plain' }));
  const res = await testApp().request('/v1/attachments', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return (await expectContract<{ id: string }>('uploadAttachment', res, 201)).id;
}

const fileUrl = (id: string) => signedFileUrl(id).replace(/^.*?\/mcp\//, '/mcp/');

describe('attachment storage', () => {
  it('keeps an upload under ATTACHMENTS_DIR/<user>/ and still reads it after a restart', async () => {
    const user = await chatUser();
    const id = await upload(user.token, 'hello volume');
    const [row] = await db().select().from(attachments).where(eq(attachments.id, id));
    expect(row!.path).toBe(resolve(process.env.ATTACHMENTS_DIR!, user.id, id));

    // A restart: the process forgets everything it held in memory; only the folder is left.
    vi.resetModules();
    resetConfig();
    const store = await import('../src/modules/channels/attachment-store.ts');
    const path = await store.readableAttachmentPath(row!);
    expect(path).toBe(row!.path);
    expect(await readFile(path!, 'utf8')).toBe('hello volume');

    // The container's signed link still serves it.
    const res = await testApp().request(fileUrl(id));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello volume');
  });

  it('refuses ids that could climb out of the folder', async () => {
    const store = await import('../src/modules/channels/attachment-store.ts');
    expect(() => store.attachmentPath('usr_1', '../x')).toThrow();
    expect(() => store.attachmentPath('..', 'att_1')).toThrow();
    expect(() => store.attachmentPath('usr_1', 'a/b')).toThrow();
    await expect(
      store.saveAttachmentFile('usr_1', '../../evil', Buffer.from('x')),
    ).rejects.toThrow();
    const owner = await chatUser();
    const evil = {
      userId: owner.id,
      path: `${process.env.ATTACHMENTS_DIR}/${owner.id}/../other/x`,
    };
    expect(await store.readableAttachmentPath(evil)).toBeUndefined();
    expect(
      await store.readableAttachmentPath({ userId: owner.id, path: '/etc/passwd' }),
    ).toBeUndefined();
  });

  it("does not hand one user's file out under another user", async () => {
    const a = await chatUser();
    const b = await chatUser();
    const id = await upload(a.token, 'private');
    const [row] = await db().select().from(attachments).where(eq(attachments.id, id));
    const store = await import('../src/modules/channels/attachment-store.ts');
    expect(await store.readableAttachmentPath({ userId: b.id, path: row!.path })).toBeUndefined();
    // A row whose path points into another user's folder is not served.
    await db().update(attachments).set({ userId: b.id }).where(eq(attachments.id, id));
    expect((await testApp().request(fileUrl(id))).status).toBe(404);
  });

  it('removes the files when the user is deleted', async () => {
    const user = await chatUser();
    const id = await upload(user.token, 'bye');
    const [row] = await db().select().from(attachments).where(eq(attachments.id, id));
    await deleteUserChannelData(user.id);
    await expect(stat(row!.path)).rejects.toThrow();
  });
});
