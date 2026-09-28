// The real HTTP clients (Graph API, Sendblue, Jev SDK, LiteLLM chat + transcription) against a
// local stand-in server: checks paths, auth headers and request/response mapping.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendblueAdapter } from '../src/modules/channels/adapters/sendblue.ts';
import {
  downloadWhatsappMedia,
  whatsappAdapter,
} from '../src/modules/channels/adapters/whatsapp.ts';
import { prepareInboundMedia } from '../src/modules/channels/media.ts';
import { RecipientBlockedError } from '../src/modules/channels/types.ts';
import { routeTurn } from '../src/modules/orchestrator/routing.ts';
import { createUser } from './helpers.ts';
import { useChannelEnv } from './fakes-channels.ts';

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

let server: Server;
let base: string;
const seen: Seen[] = [];
const json = (b: Buffer) => JSON.parse(b.toString('utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function reply(
  path: string,
  body: Buffer,
): { status: number; type: string; body: string | Buffer } {
  const ok = (v: unknown) => ({ status: 200, type: 'application/json', body: JSON.stringify(v) });
  if (path === '/graph/PNID-1/messages') {
    if (json(body).to === '15550009999')
      return {
        status: 400,
        type: 'application/json',
        body: JSON.stringify({ error: { code: 131026, message: 'Message undeliverable' } }),
      };
    return ok({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.HTTP1' }] });
  }
  if (path === '/graph/MEDIA-1')
    return ok({ url: `${base}/wa-bin/MEDIA-1`, mime_type: 'audio/ogg' });
  if (path === '/wa-bin/MEDIA-1')
    return { status: 200, type: 'audio/ogg', body: Buffer.from('ogg!') };
  if (path === '/api/send-message')
    return ok({ status: 'QUEUED', is_outbound: true, message_handle: 'sb-handle-1' });
  if (path === '/jev/v1/systemone')
    return ok({
      model: 'jev-1.13.0',
      answers: {
        route: {
          type: 'choice',
          choice: 'simple',
          confidence: 0.9,
          probabilities: { simple: 0.91, task: 0.07, spam: 0.02 },
        },
      },
      usage: { input_tokens: 10, output_tokens: 1 },
    });
  if (path === '/v1/chat/completions')
    return ok({ choices: [{ message: { role: 'assistant', content: ' Hello there! ' } }] });
  if (path === '/v1/audio/transcriptions') return ok({ text: ' call the dentist ' });
  if (path === '/files/memo.m4a')
    return { status: 200, type: 'audio/mp4', body: Buffer.from('m4a!') };
  return { status: 404, type: 'text/plain', body: 'not found' };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      seen.push({ method: req.method ?? '', path, headers: req.headers, body });
      const r = reply(path, body);
      res.writeHead(r.status, { 'content-type': r.type });
      res.end(r.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  useChannelEnv({
    WHATSAPP_API_URL: `${base}/graph`,
    WHATSAPP_ACCESS_TOKEN: 'wa-token',
    SENDBLUE_API_URL: base,
    SENDBLUE_API_KEY: 'sb-key',
    SENDBLUE_API_SECRET: 'sb-secret',
    JEV_URL: `${base}/jev`,
    JEV_API_KEY: 'jev-key',
    LITELLM_URL: base,
    LITELLM_MASTER_KEY: 'sk-master',
    STT_MODEL: 'whisper-test',
  });
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const last = (path: string) => seen.filter((s) => s.path === path).at(-1)!;

describe('Phase 6: real HTTP clients', () => {
  it('WhatsApp: sends with the bearer token to /{phone-number-id}/messages', async () => {
    const res = await whatsappAdapter.send('15550001234', { text: 'hello' });
    expect(res).toEqual({ externalId: 'wamid.HTTP1' });
    const req = last('/graph/PNID-1/messages');
    expect(req.method).toBe('POST');
    expect(req.headers.authorization).toBe('Bearer wa-token');
    expect(json(req.body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15550001234',
      type: 'text',
      text: { body: 'hello', preview_url: false },
    });
  });

  it('WhatsApp: 131026 becomes RecipientBlockedError; media id → URL → bytes', async () => {
    await expect(whatsappAdapter.send('15550009999', { text: 'x' })).rejects.toBeInstanceOf(
      RecipientBlockedError,
    );
    const media = await downloadWhatsappMedia('MEDIA-1');
    expect(media.data.toString()).toBe('ogg!');
    expect(media.mimeType).toBe('audio/ogg');
    expect(last('/wa-bin/MEDIA-1').headers.authorization).toBe('Bearer wa-token');
  });

  it('Sendblue: sends with the API key headers and our number', async () => {
    const res = await sendblueAdapter.send('+15550001234', { text: 'hi there' });
    expect(res).toEqual({ externalId: 'sb-handle-1' });
    const req = last('/api/send-message');
    expect(req.headers['sb-api-key-id']).toBe('sb-key');
    expect(req.headers['sb-api-secret-key']).toBe('sb-secret');
    expect(json(req.body)).toEqual({
      number: '+15550001234',
      content: 'hi there',
      from_number: '+15550002222',
    });
  });

  it('Jev (TypeSafe SDK) + LiteLLM cheap model: a simple question gets a quick reply', async () => {
    const user = await createUser();
    const decision = await routeTurn({
      userId: user.id,
      deliveryId: 'evt_http_1',
      kind: 'message',
      sessionKey: 'web',
      channel: 'web',
      text: 'good morning!',
    });
    expect(decision).toEqual({ kind: 'simple', reply: 'Hello there!' });

    const jev = last('/jev/v1/systemone');
    expect(jev.headers.authorization).toBe('Bearer jev-key');
    const body = json(jev.body);
    expect(body.model).toBe('jev-latest');
    expect(body.state).toEqual({ conversation: [], message: 'good morning!' });
    expect(body.questions.route.type).toBe('choice');
    expect(Object.keys(body.questions.route.criteria)).toEqual(['simple', 'task', 'spam']);

    const chat = last('/v1/chat/completions');
    expect(chat.headers.authorization).toBe('Bearer sk-master');
    const chatBody = json(chat.body);
    expect(chatBody).toMatchObject({ model: 'cheap', user: user.id });
    expect(chatBody.messages.at(-1)).toEqual({ role: 'user', content: 'good morning!' });
  });

  it('LiteLLM transcription: multipart upload with STT_MODEL', async () => {
    const user = await createUser();
    const url = `${base}/files/memo.m4a`;
    const out = await prepareInboundMedia(
      user.id,
      {
        channel: 'imessage',
        externalChatId: '+15550001234',
        externalMessageId: 'h-http',
        text: '',
        media: [{ id: url, providerId: url, name: 'memo.m4a', mimeType: 'audio/mp4' }],
        displayId: '+15550001234',
      },
      'evt_http_stt',
    );
    expect(out.text).toBe('[Voice message] call the dentist');
    const stt = last('/v1/audio/transcriptions');
    expect(stt.headers.authorization).toBe('Bearer sk-master');
    expect(stt.headers['content-type']).toContain('multipart/form-data');
    const form = stt.body.toString('latin1');
    expect(form).toContain('name="model"');
    expect(form).toContain('whisper-test');
    expect(form).toContain('filename="memo.m4a"');
    expect(form).toContain('m4a!');
  });
});
