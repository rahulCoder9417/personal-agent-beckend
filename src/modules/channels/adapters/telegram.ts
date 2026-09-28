import { config } from '../../../shared/config.ts';
import { safeEqual } from '../../../shared/crypto.ts';
import type { MediaRef } from '../schema.ts';
import {
  RecipientBlockedError,
  splitText,
  type ChannelAdapter,
  type InboundMessage,
  type OutboundContent,
} from '../types.ts';

export function verifyTelegramSecret(header: string | undefined): boolean {
  const secret = config().TELEGRAM_WEBHOOK_SECRET;
  return Boolean(secret && header && safeEqual(header, secret));
}

type TgUser = { id: number; username?: string; first_name?: string };
type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: { id: number; username?: string; first_name?: string };
  text?: string;
  caption?: string;
  voice?: { file_id: string; mime_type?: string };
  audio?: { file_id: string; mime_type?: string; file_name?: string };
  photo?: Array<{ file_id: string }>;
  document?: { file_id: string; file_name?: string; mime_type?: string };
};
export type TelegramUpdate = {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage };
};

/** Chat id of an update (for linking lookups at intake), or null for updates we ignore. */
export function telegramChatId(u: TelegramUpdate): string | null {
  const chat = u.message?.chat ?? u.callback_query?.message?.chat;
  return chat ? String(chat.id) : u.callback_query ? String(u.callback_query.from.id) : null;
}

export function parseTelegramUpdate(u: TelegramUpdate): InboundMessage | null {
  if (u.callback_query) {
    const cq = u.callback_query;
    const chatId = telegramChatId(u)!;
    return {
      channel: 'telegram',
      externalChatId: chatId,
      externalMessageId: `cb:${cq.id}`,
      text: '',
      media: [],
      displayId: cq.from.username ? `@${cq.from.username}` : (cq.from.first_name ?? chatId),
      buttonReply: { data: cq.data ?? '', callbackId: cq.id },
    };
  }
  const m = u.message;
  if (!m) return null;
  const media: MediaRef[] = [];
  if (m.voice)
    media.push({
      id: m.voice.file_id,
      providerId: m.voice.file_id,
      name: 'voice.ogg',
      mimeType: m.voice.mime_type ?? 'audio/ogg',
    });
  if (m.audio)
    media.push({
      id: m.audio.file_id,
      providerId: m.audio.file_id,
      name: m.audio.file_name ?? 'audio',
      mimeType: m.audio.mime_type ?? 'audio/mpeg',
    });
  const photo = m.photo?.[m.photo.length - 1];
  if (photo)
    media.push({
      id: photo.file_id,
      providerId: photo.file_id,
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
    });
  if (m.document) {
    media.push({
      id: m.document.file_id,
      providerId: m.document.file_id,
      name: m.document.file_name ?? 'file',
      mimeType: m.document.mime_type ?? 'application/octet-stream',
    });
  }
  const from = m.from ?? m.chat;
  return {
    channel: 'telegram',
    externalChatId: String(m.chat.id),
    externalMessageId: String(m.message_id),
    text: m.text ?? m.caption ?? '',
    media,
    displayId: from.username ? `@${from.username}` : (from.first_name ?? String(m.chat.id)),
  };
}

export type TelegramApi = (
  method: string,
  body: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const httpApi: TelegramApi = async (method, body) => {
  const c = config();
  if (!c.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const res = await fetch(`${c.TELEGRAM_API_URL}/bot${c.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: Record<string, unknown>;
    description?: string;
  };
  if (res.status === 403) throw new RecipientBlockedError(json.description ?? 'blocked');
  if (!res.ok || !json.ok)
    throw new Error(`telegram ${method} failed: ${res.status} ${json.description ?? ''}`);
  return json.result ?? {};
};

let api: TelegramApi = httpApi;

/** Tests: replace the Bot API. */
export function setTelegramApi(fake: TelegramApi | undefined): void {
  api = fake ?? httpApi;
}

export function telegramApi(): TelegramApi {
  return api;
}

export const telegramAdapter: ChannelAdapter = {
  channel: 'telegram',
  async send(chatId: string, content: OutboundContent) {
    const parts = splitText(content.text);
    let lastId: string | undefined;
    for (const [i, part] of parts.entries()) {
      const isLast = i === parts.length - 1;
      const result = await api('sendMessage', {
        chat_id: chatId,
        text: part,
        ...(isLast && content.buttons?.length
          ? {
              reply_markup: {
                inline_keyboard: [
                  content.buttons.map((b) => ({ text: b.title, callback_data: b.id })),
                ],
              },
            }
          : {}),
      });
      lastId = result.message_id !== undefined ? String(result.message_id) : lastId;
    }
    return { externalId: lastId };
  },
};

/** Stops the button spinner after a tap. Best effort. */
export async function answerCallback(callbackId: string, text?: string): Promise<void> {
  await api('answerCallbackQuery', {
    callback_query_id: callbackId,
    ...(text ? { text } : {}),
  }).catch(() => {});
}
