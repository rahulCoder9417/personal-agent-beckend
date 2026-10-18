// Chat media (HLD 0.3): the worker downloads photos, files and voice notes into
// ATTACHMENTS_DIR/<userId>/<id>, saves an `attachments` row (so the container can fetch it via a
// signed URL) and turns voice into text with LiteLLM's /v1/audio/transcriptions.
import { config } from '../../shared/config.ts';
import { sha256Hex } from '../../shared/crypto.ts';
import { db } from '../../shared/db/client.ts';
import { logger } from '../../shared/logger.ts';
import { saveAttachmentFile } from './attachment-store.ts';
import { downloadWhatsappMedia } from './adapters/whatsapp.ts';
import { telegramApi } from './adapters/telegram.ts';
import { getInboundByEvent } from './messages.ts';
import { attachments, type MediaRef } from './schema.ts';
import type { ChatChannel, InboundMessage } from './types.ts';

export type Downloaded = { data: Buffer; mimeType?: string };
export type UrlDownloader = (url: string) => Promise<Downloaded>;
export type Transcriber = (file: {
  data: Buffer;
  name: string;
  mimeType: string;
}) => Promise<string>;

export class MediaTooLargeError extends Error {}

const httpDownload: UrlDownloader = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  // Never log the URL: Telegram file URLs contain the bot token.
  if (!res.ok) throw new Error(`media download failed: ${res.status}`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > config().MEDIA_MAX_BYTES) throw new MediaTooLargeError('media too large');
  const mimeType = res.headers.get('content-type') ?? undefined;
  return { data: Buffer.from(await res.arrayBuffer()), ...(mimeType ? { mimeType } : {}) };
};

let downloadUrl: UrlDownloader = httpDownload;

/** Tests: replace plain URL downloads (Telegram file URLs, Sendblue media URLs). */
export function setUrlDownloader(fn: UrlDownloader | undefined): void {
  downloadUrl = fn ?? httpDownload;
}

/** How each channel turns a MediaRef's provider id into bytes. */
const downloaders: Record<ChatChannel, (m: MediaRef) => Promise<Downloaded>> = {
  async telegram(m) {
    const c = config();
    if (!c.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');
    const file = await telegramApi()('getFile', { file_id: m.providerId });
    if (typeof file.file_path !== 'string') throw new Error('telegram getFile returned no path');
    return downloadUrl(`${c.TELEGRAM_API_URL}/file/bot${c.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
  },
  whatsapp: (m) => downloadWhatsappMedia(m.providerId!),
  imessage: (m) => downloadUrl(m.providerId!),
};

const litellmTranscribe: Transcriber = async (file) => {
  const c = config();
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.name);
  form.append('model', c.STT_MODEL);
  const res = await fetch(`${c.LITELLM_URL}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: c.LITELLM_MASTER_KEY ? { authorization: `Bearer ${c.LITELLM_MASTER_KEY}` } : {},
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`transcription failed: ${res.status}`);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? '').trim();
};

let transcribe: Transcriber = litellmTranscribe;

/** Tests: replace speech-to-text. */
export function setTranscriber(fn: Transcriber | undefined): void {
  transcribe = fn ?? litellmTranscribe;
}

const baseMime = (m: string | undefined) => (m ?? '').split(';')[0]!.trim().toLowerCase();
const isAudio = (mimeType: string) => mimeType.startsWith('audio/');

/**
 * Downloads one media item and saves it as an attachment. The id is derived from the event, so a
 * re-run overwrites the same file and row instead of adding new ones.
 */
async function storeMedia(
  userId: string,
  channel: ChatChannel,
  media: MediaRef,
  key: string,
): Promise<{ ref: MediaRef; data: Buffer }> {
  if (!media.providerId) throw new Error('media has no provider id');
  const file = await downloaders[channel](media);
  if (file.data.length > config().MEDIA_MAX_BYTES) throw new MediaTooLargeError('media too large');
  const declared = baseMime(media.mimeType);
  const generic = !declared || declared === 'application/octet-stream';
  const mimeType =
    (generic ? baseMime(file.mimeType) : declared) || declared || 'application/octet-stream';
  const id = `att_${sha256Hex(key).slice(0, 26)}`;
  const path = await saveAttachmentFile(userId, id, file.data);
  await db()
    .insert(attachments)
    .values({ id, userId, name: media.name, mimeType, sizeBytes: file.data.length, path })
    .onConflictDoNothing({ target: attachments.id });
  return {
    ref: { id, name: media.name, mimeType, providerId: media.providerId, path },
    data: file.data,
  };
}

/**
 * The `prepareInbound` hook (runs in the worker before the message is saved): downloads the
 * message's media, returns it with local paths, and appends voice transcripts to the text.
 * A failed download or transcription doesn't lose the message; a note is added instead.
 */
export async function prepareInboundMedia(
  userId: string,
  msg: InboundMessage,
  eventId: string,
): Promise<InboundMessage> {
  if (msg.media.length === 0) return msg;
  // Saved by an earlier attempt of this job: the saved message already has paths + transcript.
  if (await getInboundByEvent(eventId)) return msg;
  const log = logger().child({ userId, channel: msg.channel, eventId });
  const media: MediaRef[] = [];
  const notes: string[] = [];
  for (const [i, m] of msg.media.entries()) {
    let stored: { ref: MediaRef; data: Buffer };
    try {
      stored = await storeMedia(userId, msg.channel, m, `${eventId}:${i}`);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'media download failed');
      notes.push(
        err instanceof MediaTooLargeError
          ? `[Attachment "${m.name}" was too large to receive]`
          : `[Attachment "${m.name}" couldn't be downloaded]`,
      );
      continue;
    }
    media.push(stored.ref);
    if (!isAudio(stored.ref.mimeType)) continue;
    try {
      const text = await transcribe({
        data: stored.data,
        name: stored.ref.name,
        mimeType: stored.ref.mimeType,
      });
      notes.push(text ? `[Voice message] ${text}` : '[Voice message with no speech]');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'transcription failed');
      notes.push("[Voice message: couldn't transcribe it; the audio file is attached]");
    }
  }
  return { ...msg, text: [msg.text, ...notes].filter(Boolean).join('\n\n'), media };
}
