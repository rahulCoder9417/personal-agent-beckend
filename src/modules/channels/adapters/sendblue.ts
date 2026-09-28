// iMessage via Sendblue (HLD 0.3). No buttons: they're rendered as text and the user answers
// "yes" / "no" (see ../text-buttons.ts).
import { config } from '../../../shared/config.ts';
import { safeEqual } from '../../../shared/crypto.ts';
import type { MediaRef } from '../schema.ts';
import type { StatusUpdate } from '../status.ts';
import { withButtonsAsText } from '../text-buttons.ts';
import {
  RecipientBlockedError,
  splitText,
  type ChannelAdapter,
  type InboundMessage,
  type OutboundContent,
} from '../types.ts';

const MAX_TEXT = 4096;

/** Sendblue puts the webhook secret in the `sb-signing-secret` header. */
export function verifySendblueSecret(header: string | undefined): boolean {
  const secret = config().SENDBLUE_SIGNING_SECRET;
  return Boolean(secret && header && safeEqual(header, secret));
}

export type SendbluePayload = {
  content?: string;
  media_url?: string;
  is_outbound?: boolean;
  status?: string;
  error_code?: number | null;
  error_message?: string | null;
  message_handle?: string;
  date_sent?: string;
  from_number?: string;
  number?: string;
  to_number?: string;
  message_type?: string;
  group_id?: string;
  opted_out?: boolean;
};

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  heic: 'image/heic',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  caf: 'audio/x-caf',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  vcf: 'text/vcard',
};

function mediaFromUrl(url: string): MediaRef {
  let name = 'file';
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'file');
  } catch {
    // keep the default name
  }
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return {
    id: url,
    providerId: url,
    name: name.slice(0, 200),
    mimeType: MIME_BY_EXT[ext] ?? 'application/octet-stream',
  };
}

/** A direct (non-group) message from a user, not one of ours. */
export function isSendblueInbound(p: SendbluePayload): boolean {
  return !p.is_outbound && Boolean(p.message_handle && p.from_number) && !p.group_id;
}

export function parseSendblueEvent(p: SendbluePayload): InboundMessage | null {
  if (!isSendblueInbound(p)) return null;
  const from = p.from_number!;
  return {
    channel: 'imessage',
    externalChatId: from,
    externalMessageId: p.message_handle!,
    text: p.content ?? '',
    media: p.media_url ? [mediaFromUrl(p.media_url)] : [],
    displayId: from,
  };
}

const STATUS: Record<string, StatusUpdate['status']> = {
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  ERROR: 'failed',
  DECLINED: 'failed',
};

/** Outbound message events (the "outbound" webhook) → message status. */
export function parseSendblueStatus(p: SendbluePayload): StatusUpdate | null {
  const status = STATUS[(p.status ?? '').toUpperCase()];
  if (!p.is_outbound || !p.message_handle || !status) return null;
  return {
    channel: 'imessage',
    externalId: p.message_handle,
    status,
    ...(status === 'failed' && p.opted_out ? { recipientBlocked: true } : {}),
  };
}

// --- API -----------------------------------------------------------------------------------

export class SendblueApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly optedOut = false,
  ) {
    super(message);
  }
}

export interface SendblueApi {
  /** POST /api/send-message. Returns Sendblue's message object. */
  sendMessage(body: Record<string, unknown>): Promise<SendbluePayload>;
}

const httpApi: SendblueApi = {
  async sendMessage(body) {
    const c = config();
    if (!c.SENDBLUE_API_KEY || !c.SENDBLUE_API_SECRET)
      throw new Error('SENDBLUE_API_KEY / SENDBLUE_API_SECRET are not set');
    const res = await fetch(`${c.SENDBLUE_API_URL}/api/send-message`, {
      method: 'POST',
      headers: {
        'sb-api-key-id': c.SENDBLUE_API_KEY,
        'sb-api-secret-key': c.SENDBLUE_API_SECRET,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as SendbluePayload & { message?: string };
    const errText = json.error_message ?? json.message ?? '';
    if (!res.ok || json.status === 'ERROR') {
      throw new SendblueApiError(
        `sendblue send failed: ${res.status} ${errText}`.trim(),
        res.status,
        Boolean(json.opted_out) || /opted[ -]?out/i.test(errText),
      );
    }
    return json;
  },
};

let api: SendblueApi = httpApi;

/** Tests: replace the Sendblue API. */
export function setSendblueApi(fake: SendblueApi | undefined): void {
  api = fake ?? httpApi;
}

export const sendblueAdapter: ChannelAdapter = {
  channel: 'imessage',
  async send(number: string, content: OutboundContent) {
    const from = config().SENDBLUE_NUMBER;
    const parts = splitText(withButtonsAsText(content.text, content.buttons), MAX_TEXT);
    let lastId: string | undefined;
    for (const part of parts) {
      try {
        const res = await api.sendMessage({
          number,
          content: part,
          ...(from ? { from_number: from } : {}),
        });
        lastId = res.message_handle ?? lastId;
      } catch (err) {
        if (err instanceof SendblueApiError && err.optedOut)
          throw new RecipientBlockedError(err.message);
        throw err;
      }
    }
    return lastId ? { externalId: lastId } : {};
  },
};
