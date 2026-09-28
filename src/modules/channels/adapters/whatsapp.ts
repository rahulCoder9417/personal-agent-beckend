// WhatsApp Cloud API (HLD 0.3): signed webhooks in, Graph API out, 24-hour rule → templates.
import { createHmac } from 'node:crypto';
import { findLink } from '../../auth/links.ts';
import { config } from '../../../shared/config.ts';
import { safeEqual } from '../../../shared/crypto.ts';
import type { MediaRef } from '../schema.ts';
import type { StatusUpdate } from '../status.ts';
import {
  RecipientBlockedError,
  splitText,
  type Button,
  type ChannelAdapter,
  type InboundMessage,
  type OutboundContent,
  type SendResult,
} from '../types.ts';

/** Free-form messages are allowed for 24 hours after the user's last message. */
export const WHATSAPP_WINDOW_MS = 24 * 3600 * 1000;
const MAX_TEXT = 4096;
/** Interactive (button) message body limit. */
const MAX_BUTTON_BODY = 1024;
const MAX_BUTTONS = 3;
const MAX_BUTTON_TITLE = 20;
/** Keep template parameters well under the 1024-char template body limit. */
const MAX_TEMPLATE_PARAM = 700;

/** Graph API error codes. */
export const WA_ERROR = {
  /** More than 24 hours since the user's last message: only templates may be sent. */
  REENGAGEMENT: 131047,
  /** Undeliverable (not on WhatsApp, or can't receive from us). Treated as blocked. */
  UNDELIVERABLE: 131026,
} as const;

// --- webhook verification ------------------------------------------------------------------

/** GET handshake: echo `hub.challenge` only for `subscribe` with our verify token. */
export function whatsappVerifyChallenge(
  mode: string | undefined,
  token: string | undefined,
  challenge: string | undefined,
): string | null {
  const expected = config().WHATSAPP_VERIFY_TOKEN;
  if (mode !== 'subscribe' || !expected || !token || challenge === undefined) return null;
  return safeEqual(token, expected) ? challenge : null;
}

/** POST: `X-Hub-Signature-256: sha256=<hex HMAC of the raw body with the app secret>`. */
export function verifyWhatsappSignature(rawBody: string, header: string | undefined): boolean {
  const secret = config().WHATSAPP_APP_SECRET;
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
  return safeEqual(header.toLowerCase(), expected);
}

// --- inbound -------------------------------------------------------------------------------

type WaMedia = {
  id: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
};
export type WaMessage = {
  from: string;
  id: string;
  timestamp?: string;
  type: string;
  text?: { body?: string };
  interactive?: {
    type?: string;
    button_reply?: { id: string; title?: string };
    list_reply?: { id: string; title?: string };
  };
  /** Quick-reply button on a template. */
  button?: { payload?: string; text?: string };
  image?: WaMedia;
  audio?: WaMedia;
  video?: WaMedia;
  document?: WaMedia;
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
};
export type WaStatus = {
  id: string;
  status: string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string }>;
};
export type WhatsappWebhook = {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string; display_phone_number?: string };
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: WaMessage[];
        statuses?: WaStatus[];
      };
    }>;
  }>;
};

/** What we save as one event per incoming WhatsApp message. */
export type WhatsappEventPayload = { message: WaMessage; profileName?: string };

/** One webhook can carry several messages and statuses (for our phone number only). */
export function extractWhatsapp(body: WhatsappWebhook): {
  messages: WhatsappEventPayload[];
  statuses: WaStatus[];
} {
  const ours = config().WHATSAPP_PHONE_NUMBER_ID;
  const messages: WhatsappEventPayload[] = [];
  const statuses: WaStatus[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (!v) continue;
      if (ours && v.metadata?.phone_number_id && v.metadata.phone_number_id !== ours) continue;
      for (const m of v.messages ?? []) {
        if (!m?.id || !m.from) continue;
        const name = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name;
        messages.push({ message: m, ...(name ? { profileName: name } : {}) });
      }
      for (const s of v.statuses ?? []) if (s?.id && s.status) statuses.push(s);
    }
  }
  return { messages, statuses };
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
};
const baseMime = (m: string | undefined) => (m ?? '').split(';')[0]!.trim();

function mediaRef(media: WaMedia, fallbackName: string, fallbackMime: string): MediaRef {
  const mimeType = baseMime(media.mime_type) || fallbackMime;
  const ext = EXT[mimeType];
  return {
    id: media.id,
    providerId: media.id,
    name: media.filename ?? (ext ? `${fallbackName}.${ext}` : fallbackName),
    mimeType,
  };
}

/** Normalizes a saved WhatsApp event. Reactions, stickers and system messages are ignored. */
export function parseWhatsappEvent(payload: WhatsappEventPayload): InboundMessage | null {
  const m = payload.message;
  if (!m?.from || !m.id) return null;
  const base = {
    channel: 'whatsapp' as const,
    externalChatId: m.from,
    externalMessageId: m.id,
    displayId: `+${m.from.replace(/^\+/, '')}`,
  };
  switch (m.type) {
    case 'text':
      return { ...base, text: m.text?.body ?? '', media: [] };
    case 'interactive': {
      const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
      if (!reply) return null;
      return { ...base, text: '', media: [], buttonReply: { data: reply.id } };
    }
    case 'button':
      if (!m.button?.payload) return null;
      return { ...base, text: '', media: [], buttonReply: { data: m.button.payload } };
    case 'image':
    case 'video':
    case 'document':
    case 'audio': {
      const media = m[m.type];
      if (!media?.id) return null;
      const fallback: Record<string, [string, string]> = {
        image: ['image', 'image/jpeg'],
        video: ['video', 'video/mp4'],
        document: ['file', 'application/octet-stream'],
        audio: [media.voice ? 'voice' : 'audio', 'audio/ogg'],
      };
      const [name, mime] = fallback[m.type]!;
      return { ...base, text: media.caption ?? '', media: [mediaRef(media, name, mime)] };
    }
    case 'location': {
      const l = m.location;
      if (!l) return null;
      const where = [l.name, l.address].filter(Boolean).join(', ');
      return {
        ...base,
        text: `[Location] ${l.latitude},${l.longitude}${where ? ` (${where})` : ''}`,
        media: [],
      };
    }
    default:
      return null;
  }
}

const STATUS: Record<string, StatusUpdate['status']> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

/** A saved WhatsApp status event → message status update. */
export function parseWhatsappStatus(s: WaStatus): StatusUpdate | null {
  const status = STATUS[s.status];
  if (!status || !s.id) return null;
  const blocked = status === 'failed' && s.errors?.some((e) => e.code === WA_ERROR.UNDELIVERABLE);
  return {
    channel: 'whatsapp',
    externalId: s.id,
    status,
    ...(blocked ? { recipientBlocked: true } : {}),
  };
}

// --- Graph API -----------------------------------------------------------------------------

export class WhatsappApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface WhatsappApi {
  /** POST /{phone-number-id}/messages. Returns the WhatsApp message id (wamid). */
  sendMessage(body: Record<string, unknown>): Promise<{ messageId?: string }>;
  /** GET /{media-id}: a short-lived download URL. */
  getMediaUrl(mediaId: string): Promise<{ url: string; mimeType?: string }>;
  /** Downloads a media URL (needs the bearer token). */
  download(url: string): Promise<{ data: Buffer; mimeType?: string }>;
}

function authHeader(): Record<string, string> {
  const token = config().WHATSAPP_ACCESS_TOKEN;
  if (!token) throw new Error('WHATSAPP_ACCESS_TOKEN is not set');
  return { authorization: `Bearer ${token}` };
}

async function graphError(res: Response, what: string): Promise<WhatsappApiError> {
  const json = (await res.json().catch(() => ({}))) as {
    error?: { code?: number; message?: string };
  };
  return new WhatsappApiError(
    `whatsapp ${what} failed: ${res.status} ${json.error?.code ?? ''} ${json.error?.message ?? ''}`.trim(),
    json.error?.code,
    res.status,
  );
}

const httpApi: WhatsappApi = {
  async sendMessage(body) {
    const c = config();
    if (!c.WHATSAPP_PHONE_NUMBER_ID) throw new Error('WHATSAPP_PHONE_NUMBER_ID is not set');
    const res = await fetch(`${c.WHATSAPP_API_URL}/${c.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await graphError(res, 'send');
    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    return { messageId: json.messages?.[0]?.id };
  },
  async getMediaUrl(mediaId) {
    const res = await fetch(`${config().WHATSAPP_API_URL}/${encodeURIComponent(mediaId)}`, {
      headers: authHeader(),
    });
    if (!res.ok) throw await graphError(res, 'media lookup');
    const json = (await res.json()) as { url?: string; mime_type?: string };
    if (!json.url) throw new WhatsappApiError('whatsapp media lookup returned no url');
    return { url: json.url, ...(json.mime_type ? { mimeType: json.mime_type } : {}) };
  },
  async download(url) {
    const res = await fetch(url, { headers: authHeader() });
    if (!res.ok) throw new WhatsappApiError(`whatsapp media download failed: ${res.status}`);
    const mimeType = res.headers.get('content-type') ?? undefined;
    return { data: Buffer.from(await res.arrayBuffer()), ...(mimeType ? { mimeType } : {}) };
  },
};

let api: WhatsappApi = httpApi;

/** Tests: replace the Graph API. */
export function setWhatsappApi(fake: WhatsappApi | undefined): void {
  api = fake ?? httpApi;
}

export function whatsappApi(): WhatsappApi {
  return api;
}

/** Media id → bytes (used by the worker's media download). */
export async function downloadWhatsappMedia(
  mediaId: string,
): Promise<{ data: Buffer; mimeType?: string }> {
  const { url, mimeType } = await api.getMediaUrl(mediaId);
  const file = await api.download(url);
  const mt = file.mimeType ?? mimeType;
  return { data: file.data, ...(mt ? { mimeType: mt } : {}) };
}

// --- outbound ------------------------------------------------------------------------------

export function isWithinWindow(lastInboundAt: Date | null | undefined, now = Date.now()): boolean {
  return Boolean(lastInboundAt && now - lastInboundAt.getTime() < WHATSAPP_WINDOW_MS);
}

const envelope = (to: string) => ({
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to,
});

function interactiveBody(to: string, text: string, buttons: Button[]) {
  return {
    ...envelope(to),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text },
      action: {
        buttons: buttons.slice(0, MAX_BUTTONS).map((b) => ({
          type: 'reply',
          reply: { id: b.id.slice(0, 256), title: b.title.slice(0, MAX_BUTTON_TITLE) },
        })),
      },
    },
  };
}

/** Template parameters can't hold newlines, tabs or 4+ spaces in a row. */
export function templateParam(text: string): string {
  const flat =
    text
      .replace(/\s*\n\s*/g, ' · ')
      .replace(/\s+/g, ' ')
      .trim() || '-';
  return flat.length > MAX_TEMPLATE_PARAM ? `${flat.slice(0, MAX_TEMPLATE_PARAM - 1)}…` : flat;
}

/**
 * Outside the 24-hour window only an approved template may be sent. The message text goes into
 * the template's single body variable ({{1}}). Without an explicit template, messages with
 * buttons use the approval template (its quick-reply buttons carry our button payloads, in
 * order) and anything else uses "task done".
 */
export function templateBody(to: string, content: OutboundContent) {
  const c = config();
  const kind = content.template ?? (content.buttons?.length ? 'approval' : 'task_done');
  const name = {
    reminder: c.WHATSAPP_TEMPLATE_REMINDER,
    approval: c.WHATSAPP_TEMPLATE_APPROVAL,
    task_done: c.WHATSAPP_TEMPLATE_TASK_DONE,
  }[kind];
  const components: Array<Record<string, unknown>> = [
    { type: 'body', parameters: [{ type: 'text', text: templateParam(content.text) }] },
  ];
  if (kind === 'approval') {
    (content.buttons ?? []).slice(0, MAX_BUTTONS).forEach((b, i) =>
      components.push({
        type: 'button',
        sub_type: 'quick_reply',
        index: String(i),
        parameters: [{ type: 'payload', payload: b.id }],
      }),
    );
  }
  return {
    ...envelope(to),
    type: 'template',
    template: { name, language: { code: c.WHATSAPP_TEMPLATE_LANG }, components },
  };
}

async function sendOne(body: Record<string, unknown>): Promise<string | undefined> {
  try {
    return (await api.sendMessage(body)).messageId;
  } catch (err) {
    if (err instanceof WhatsappApiError && err.code === WA_ERROR.UNDELIVERABLE)
      throw new RecipientBlockedError(err.message);
    throw err;
  }
}

async function sendFreeForm(to: string, content: OutboundContent): Promise<SendResult> {
  const buttons = content.buttons ?? [];
  let parts = splitText(content.text, MAX_TEXT);
  if (buttons.length) {
    const last = parts.pop()!;
    parts = [...parts, ...splitText(last, MAX_BUTTON_BODY)];
  }
  let lastId: string | undefined;
  for (const [i, part] of parts.entries()) {
    const withButtons = buttons.length > 0 && i === parts.length - 1;
    const body = withButtons
      ? interactiveBody(to, part, buttons)
      : { ...envelope(to), type: 'text', text: { body: part, preview_url: false } };
    lastId = (await sendOne(body)) ?? lastId;
  }
  return lastId ? { externalId: lastId } : {};
}

async function sendTemplate(to: string, content: OutboundContent): Promise<SendResult> {
  const id = await sendOne(templateBody(to, content));
  return id ? { externalId: id } : {};
}

export const whatsappAdapter: ChannelAdapter = {
  channel: 'whatsapp',
  async send(to: string, content: OutboundContent) {
    // Unlinked chats only ever get a reply to the message they just sent (window open).
    const link = await findLink('whatsapp', to);
    if (link && !isWithinWindow(link.lastInboundAt)) return sendTemplate(to, content);
    try {
      return await sendFreeForm(to, content);
    } catch (err) {
      // Our clock said "inside the window" but WhatsApp disagrees: fall back to a template.
      if (link && err instanceof WhatsappApiError && err.code === WA_ERROR.REENGAGEMENT)
        return sendTemplate(to, content);
      throw err;
    }
  },
};
