// Fake WhatsApp Graph API + Sendblue API, and signed webhook builders (Phase 6 tests).
import { createHmac } from 'node:crypto';
import { setSendblueApi, type SendbluePayload } from '../src/modules/channels/adapters/sendblue.ts';
import { setWhatsappApi, WhatsappApiError } from '../src/modules/channels/adapters/whatsapp.ts';
import { resetConfig } from '../src/shared/config.ts';
import { call, expectContract, waitFor } from './helpers.ts';

export const WA_SECRET = 'wa-app-secret';
export const WA_VERIFY = 'wa-verify-token';
export const WA_PHONE_ID = 'PNID-1';
export const SB_SECRET = 'sb-signing-secret';

/**
 * Channel env for this test file (call at the top level, before the app is used). WhatsApp and
 * iMessage are switched off by default (ENABLED_CHANNELS); these tests switch them on.
 */
export function useChannelEnv(extra: Record<string, string> = {}): void {
  Object.assign(process.env, {
    ENABLED_CHANNELS: 'telegram,web,whatsapp,imessage',
    WHATSAPP_APP_SECRET: WA_SECRET,
    WHATSAPP_VERIFY_TOKEN: WA_VERIFY,
    WHATSAPP_PHONE_NUMBER_ID: WA_PHONE_ID,
    WHATSAPP_DISPLAY_NUMBER: '+1 555 000 1111',
    SENDBLUE_SIGNING_SECRET: SB_SECRET,
    SENDBLUE_NUMBER: '+15550002222',
    ...extra,
  });
  resetConfig();
}

export const phone = () => `1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

// --- WhatsApp ------------------------------------------------------------------------------

export interface SentWhatsapp {
  id: string;
  to: string;
  type: string;
  text?: string;
  buttons?: Array<{ id: string; title: string }>;
  template?: { name: string; lang: string; params: string[]; payloads: string[] };
}

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function installFakeWhatsapp() {
  const sent: SentWhatsapp[] = [];
  const media = new Map<string, { data: Buffer; mimeType: string }>();
  const state = { onSend: undefined as ((body: Body) => void) | undefined };
  let n = 1;
  setWhatsappApi({
    async sendMessage(body: Body) {
      state.onSend?.(body);
      const id = `wamid.out${Date.now()}${n++}`;
      const entry: SentWhatsapp = { id, to: body.to, type: body.type };
      if (body.type === 'text') entry.text = body.text.body;
      if (body.type === 'interactive') {
        entry.text = body.interactive.body.text;
        entry.buttons = body.interactive.action.buttons.map((b: Body) => b.reply);
      }
      if (body.type === 'template') {
        const comps = body.template.components as Body[];
        entry.template = {
          name: body.template.name,
          lang: body.template.language.code,
          params: comps.find((c) => c.type === 'body')!.parameters.map((p: Body) => p.text),
          payloads: comps
            .filter((c) => c.type === 'button')
            .map((c) => c.parameters[0].payload as string),
        };
      }
      sent.push(entry);
      return { messageId: id };
    },
    async getMediaUrl(mediaId) {
      const m = media.get(mediaId);
      if (!m) throw new WhatsappApiError('unknown media', 100, 404);
      return { url: `https://lookaside.test/media/${mediaId}`, mimeType: m.mimeType };
    },
    async download(url) {
      const m = media.get(url.split('/').pop()!);
      if (!m) throw new WhatsappApiError('download failed', undefined, 404);
      return { data: m.data, mimeType: m.mimeType };
    },
  });
  return { sent, media, state };
}

let waSeq = 0;
export const wamid = () => `wamid.in${Date.now()}${waSeq++}${Math.floor(Math.random() * 1e6)}`;

export function waMessage(from: string, fields: Body) {
  return { from, id: wamid(), timestamp: String(Math.floor(Date.now() / 1000)), ...fields };
}

export function waText(from: string, text: string) {
  return waMessage(from, { type: 'text', text: { body: text } });
}

export function waWebhook(messages: Body[], statuses: Body[] = []) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: WA_PHONE_ID },
              ...(messages.length
                ? {
                    contacts: messages.map((m) => ({ wa_id: m.from, profile: { name: 'Tester' } })),
                    messages,
                  }
                : {}),
              ...(statuses.length ? { statuses } : {}),
            },
          },
        ],
      },
    ],
  };
}

export function waStatus(id: string, status: string, errors?: Array<{ code: number }>) {
  return {
    id,
    status,
    timestamp: String(Math.floor(Date.now() / 1000)),
    recipient_id: '15550000000',
    ...(errors ? { errors } : {}),
  };
}

export function signWhatsapp(raw: string, secret = WA_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

export async function postWhatsapp(body: unknown, secret = WA_SECRET): Promise<Response> {
  const raw = JSON.stringify(body);
  return call('/webhooks/whatsapp', {
    method: 'POST',
    body: raw,
    headers: { 'x-hub-signature-256': signWhatsapp(raw, secret) },
  });
}

export async function linkWhatsapp(
  token: string,
  number: string,
  wa: { sent: SentWhatsapp[] },
): Promise<{ code: string; deepLink: string | null }> {
  const lc = await expectContract<{ code: string; deepLink: string | null }>(
    'createLinkCode',
    await call('/v1/channels/link-codes', { method: 'POST', token, body: { channel: 'whatsapp' } }),
    201,
  );
  await expectContract(
    'webhookWhatsapp',
    await postWhatsapp(waWebhook([waText(number, lc.code)])),
    200,
  );
  await waitFor(async () =>
    wa.sent.find((m) => m.to === number && m.text?.startsWith('✅ Linked')),
  );
  return lc;
}

// --- Sendblue ------------------------------------------------------------------------------

export interface SentSendblue {
  number: string;
  content: string;
  fromNumber?: string;
  handle: string;
}

export function installFakeSendblue() {
  const sent: SentSendblue[] = [];
  const state = { onSend: undefined as ((body: Body) => void) | undefined };
  let n = 1;
  setSendblueApi({
    async sendMessage(body: Body): Promise<SendbluePayload> {
      state.onSend?.(body);
      const handle = `sb-out-${Date.now()}-${n++}`;
      sent.push({
        number: body.number,
        content: body.content,
        fromNumber: body.from_number,
        handle,
      });
      return { status: 'QUEUED', is_outbound: true, message_handle: handle, number: body.number };
    },
  });
  return { sent, state };
}

let sbSeq = 0;
export function sbInbound(from: string, content: string, extra: Partial<SendbluePayload> = {}) {
  return {
    accountEmail: 'ops@example.com',
    content,
    is_outbound: false,
    status: 'RECEIVED',
    error_code: null,
    error_message: null,
    message_handle: `sb-in-${Date.now()}-${sbSeq++}-${Math.floor(Math.random() * 1e6)}`,
    date_sent: new Date().toISOString(),
    date_updated: new Date().toISOString(),
    from_number: from,
    number: from,
    to_number: '+15550002222',
    was_downgraded: false,
    plan: 'blue',
    media_url: '',
    message_type: 'message',
    group_id: '',
    ...extra,
  };
}

export async function postSendblue(body: unknown, secret = SB_SECRET): Promise<Response> {
  return call('/webhooks/sendblue', {
    method: 'POST',
    body,
    headers: { 'sb-signing-secret': secret },
  });
}

export const imessageNumber = () =>
  `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

export async function linkImessage(
  token: string,
  number: string,
  sb: { sent: SentSendblue[] },
): Promise<{ code: string; deepLink: string | null }> {
  const lc = await expectContract<{ code: string; deepLink: string | null }>(
    'createLinkCode',
    await call('/v1/channels/link-codes', { method: 'POST', token, body: { channel: 'imessage' } }),
    201,
  );
  await expectContract('webhookSendblue', await postSendblue(sbInbound(number, lc.code)), 200);
  await waitFor(async () =>
    sb.sent.find((m) => m.number === number && m.content.startsWith('✅ Linked')),
  );
  return lc;
}
