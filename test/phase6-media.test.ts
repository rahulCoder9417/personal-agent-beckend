import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import type { Worker } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setTelegramApi } from '../src/modules/channels/adapters/telegram.ts';
import {
  prepareInboundMedia,
  setTranscriber,
  setUrlDownloader,
} from '../src/modules/channels/media.ts';
import { attachments, messages } from '../src/modules/channels/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import {
  imessageNumber,
  installFakeSendblue,
  installFakeWhatsapp,
  linkImessage,
  linkWhatsapp,
  phone,
  postSendblue,
  postWhatsapp,
  sbInbound,
  useChannelEnv,
  waMessage,
  waWebhook,
} from './fakes-channels.ts';
import { installFakeVm, type Delivery } from './fakes.ts';
import { call, chatUser, expectContract, waitFor } from './helpers.ts';

useChannelEnv({ TELEGRAM_BOT_TOKEN: '123:test-token', MEDIA_MAX_BYTES: '1000000' });

type DeliveredFile = { id: string; name: string; mimeType: string; url: string };
const filesOf = (d: Delivery) => (d as unknown as { attachments: DeliveredFile[] }).attachments;

let workers: Worker[];
let vmFake: ReturnType<typeof installFakeVm>;
let wa: ReturnType<typeof installFakeWhatsapp>;
let sb: ReturnType<typeof installFakeSendblue>;
let transcribed: Array<{ name: string; mimeType: string; bytes: number }>;
let transcript: string | Error;
let downloads: Map<string, { data: Buffer; mimeType?: string }>;
let downloadedUrls: string[];

beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  setTranscriber(undefined);
  setUrlDownloader(undefined);
});
beforeEach(() => {
  vmFake = installFakeVm();
  wa = installFakeWhatsapp();
  sb = installFakeSendblue();
  transcribed = [];
  transcript = 'remind me to call mom at five';
  setTranscriber(async (f) => {
    transcribed.push({ name: f.name, mimeType: f.mimeType, bytes: f.data.length });
    if (transcript instanceof Error) throw transcript;
    return transcript;
  });
  downloads = new Map();
  downloadedUrls = [];
  setUrlDownloader(async (url) => {
    downloadedUrls.push(url);
    const d = downloads.get(url);
    if (!d) throw new Error('404');
    return d;
  });
});

async function whatsappUser() {
  const user = await chatUser();
  const number = phone();
  await linkWhatsapp(user.token, number, wa);
  return { user, number };
}

describe('Phase 6: media and voice', () => {
  it('a WhatsApp voice note is downloaded, transcribed, and the transcript reaches the agent', async () => {
    const { user, number } = await whatsappUser();
    const audio = Buffer.from('OggS fake opus bytes');
    wa.media.set('MEDIA-VOICE-1', { data: audio, mimeType: 'audio/ogg; codecs=opus' });
    await postWhatsapp(
      waWebhook([
        waMessage(number, {
          type: 'audio',
          audio: { id: 'MEDIA-VOICE-1', mime_type: 'audio/ogg; codecs=opus', voice: true },
        }),
      ]),
    );
    const reply = await waitFor(async () =>
      wa.sent.find((m) => m.to === number && m.text?.startsWith('echo:')),
    );
    expect(reply.text).toBe('echo: [Voice message] remind me to call mom at five');
    expect(transcribed).toEqual([
      { name: 'voice.ogg', mimeType: 'audio/ogg', bytes: audio.length },
    ]);

    const d = vmFake.deliveries[0]!;
    expect(d.text).toBe('[Voice message] remind me to call mom at five');
    const [file] = filesOf(d);
    expect(file).toMatchObject({ name: 'voice.ogg', mimeType: 'audio/ogg' });
    expect(file!.url).toContain(`/mcp/files/${file!.id}?exp=`);

    const [row] = await db().select().from(attachments).where(eq(attachments.id, file!.id));
    expect(row).toMatchObject({ userId: user.id, sizeBytes: audio.length });
    expect(row!.path).toContain(user.id);
    expect(await readFile(row!.path)).toEqual(audio);

    // The container can fetch it through the signed URL.
    const url = new URL(file!.url);
    const res = await call(`${url.pathname}${url.search}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(audio);

    // Chat history shows the transcript and the attachment.
    const history = await expectContract<{
      items: Array<{ direction: string; text: string; attachments: Array<{ id: string }> }>;
    }>('listMessages', await call('/v1/messages', { token: user.token }), 200);
    const inbound = history.items.find((m) => m.direction === 'in' && m.attachments.length)!;
    expect(inbound.text).toContain('call mom');
    expect(inbound.attachments[0]!.id).toBe(file!.id);
  });

  it('an image with a caption is attached and not transcribed', async () => {
    const { number } = await whatsappUser();
    wa.media.set('MEDIA-IMG-1', { data: Buffer.from('jpeg'), mimeType: 'image/jpeg' });
    await postWhatsapp(
      waWebhook([
        waMessage(number, {
          type: 'image',
          image: { id: 'MEDIA-IMG-1', mime_type: 'image/jpeg', caption: 'what is this plant?' },
        }),
      ]),
    );
    await waitFor(async () => vmFake.deliveries[0]);
    const d = vmFake.deliveries[0]!;
    expect(d.text).toBe('what is this plant?');
    expect(filesOf(d)).toHaveLength(1);
    expect(filesOf(d)[0]).toMatchObject({ name: 'image.jpg', mimeType: 'image/jpeg' });
    expect(transcribed).toHaveLength(0);
  });

  it('a Telegram photo is fetched with getFile + the file URL', async () => {
    const tgSent: string[] = [];
    setTelegramApi(async (method, body) => {
      if (method === 'getFile') return { file_id: body.file_id, file_path: 'photos/file_7.jpg' };
      if (method === 'sendMessage') tgSent.push(String(body.text));
      return { message_id: 1 };
    });
    const user = await chatUser();
    const chatId = Math.floor(Math.random() * 1e9);
    const lc = await expectContract<{ code: string }>(
      'createLinkCode',
      await call('/v1/channels/link-codes', {
        method: 'POST',
        token: user.token,
        body: { channel: 'telegram' },
      }),
      201,
    );
    const tg = (update: Record<string, unknown>) =>
      call('/webhooks/telegram', {
        method: 'POST',
        body: { update_id: Math.floor(Math.random() * 1e9), ...update },
        headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
      });
    await tg({ message: { message_id: 1, chat: { id: chatId }, text: lc.code } });
    await waitFor(async () => tgSent.find((t) => t.startsWith('✅ Linked')));

    const fileUrl = 'https://api.telegram.org/file/bot123:test-token/photos/file_7.jpg';
    downloads.set(fileUrl, { data: Buffer.from('tg-jpeg'), mimeType: 'image/jpeg' });
    await tg({
      message: {
        message_id: 2,
        chat: { id: chatId },
        caption: 'look',
        photo: [{ file_id: 'small' }, { file_id: 'BIG-PHOTO' }],
      },
    });
    await waitFor(async () => vmFake.deliveries[0]);
    expect(downloadedUrls).toEqual([fileUrl]);
    expect(vmFake.deliveries[0]!.text).toBe('look');
    expect(filesOf(vmFake.deliveries[0]!)[0]).toMatchObject({
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
    });
  });

  it('an iMessage attachment is downloaded from its media_url', async () => {
    const user = await chatUser();
    const number = imessageNumber();
    await linkImessage(user.token, number, sb);
    const mediaUrl = 'https://storage.sendblue.test/files/Audio%20Message.m4a';
    downloads.set(mediaUrl, { data: Buffer.from('m4a'), mimeType: 'audio/mp4' });
    await postSendblue(sbInbound(number, '', { media_url: mediaUrl }));
    await waitFor(async () => vmFake.deliveries[0]);
    const d = vmFake.deliveries[0]!;
    expect(d.text).toBe('[Voice message] remind me to call mom at five');
    expect(filesOf(d)[0]).toMatchObject({ name: 'Audio Message.m4a', mimeType: 'audio/mp4' });
  });

  it("a failed transcription or download doesn't lose the message", async () => {
    const { number } = await whatsappUser();
    transcript = new Error('stt down');
    wa.media.set('MEDIA-VOICE-2', { data: Buffer.from('ogg'), mimeType: 'audio/ogg' });
    await postWhatsapp(
      waWebhook([
        waMessage(number, { type: 'audio', audio: { id: 'MEDIA-VOICE-2', voice: true } }),
      ]),
    );
    await waitFor(async () => vmFake.deliveries[0]);
    expect(vmFake.deliveries[0]!.text).toContain("couldn't transcribe");
    expect(filesOf(vmFake.deliveries[0]!)).toHaveLength(1);

    await postWhatsapp(
      waWebhook([
        waMessage(number, {
          type: 'document',
          document: { id: 'MISSING', filename: 'report.pdf', mime_type: 'application/pdf' },
        }),
      ]),
    );
    await waitFor(async () => vmFake.deliveries[1]);
    expect(vmFake.deliveries[1]!.text).toBe('[Attachment "report.pdf" couldn\'t be downloaded]');
    expect(filesOf(vmFake.deliveries[1]!)).toHaveLength(0);
  });

  it('files over MEDIA_MAX_BYTES are refused with a note', async () => {
    const { number } = await whatsappUser();
    wa.media.set('MEDIA-BIG', { data: Buffer.alloc(1_000_001), mimeType: 'video/mp4' });
    await postWhatsapp(
      waWebhook([
        waMessage(number, { type: 'video', video: { id: 'MEDIA-BIG', caption: 'clip' } }),
      ]),
    );
    await waitFor(async () => vmFake.deliveries[0]);
    expect(vmFake.deliveries[0]!.text).toBe(
      'clip\n\n[Attachment "video.mp4" was too large to receive]',
    );
  });

  it('re-running the preparation for the same event reuses the same attachment', async () => {
    const user = await chatUser();
    const url = 'https://storage.sendblue.test/files/pic.png';
    downloads.set(url, { data: Buffer.from('png'), mimeType: 'image/png' });
    const msg = {
      channel: 'imessage' as const,
      externalChatId: '+15551234567',
      externalMessageId: 'h1',
      text: 'hi',
      media: [{ id: url, providerId: url, name: 'pic.png', mimeType: 'image/png' }],
      displayId: '+15551234567',
    };
    const a = await prepareInboundMedia(user.id, msg, 'evt_rerun_1');
    const b = await prepareInboundMedia(user.id, msg, 'evt_rerun_1');
    expect(a.media[0]!.id).toBe(b.media[0]!.id);
    expect(
      await db().select().from(attachments).where(eq(attachments.userId, user.id)),
    ).toHaveLength(1);
    expect(await db().select().from(messages).where(eq(messages.userId, user.id))).toHaveLength(0);
  });
});
