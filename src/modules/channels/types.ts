import type { MediaRef } from './schema.ts';

export type ChatChannel = 'whatsapp' | 'telegram' | 'imessage';
export type Channel = ChatChannel | 'web';

/** A chat message normalized from any provider. */
export interface InboundMessage {
  channel: ChatChannel;
  /** Chat id / phone number. */
  externalChatId: string;
  externalMessageId: string;
  text: string;
  media: MediaRef[];
  /** Masked phone number or @username, shown in the web app. */
  displayId: string;
  /** A tapped button (Telegram callback / WhatsApp reply button). */
  buttonReply?: { data: string; callbackId?: string };
}

export interface Button {
  /** Opaque payload returned when tapped, e.g. `apr:<approvalId>:yes`. */
  id: string;
  title: string;
}

export interface OutboundContent {
  text: string;
  buttons?: Button[];
  /** WhatsApp only: template to use outside the 24-hour window. */
  template?: 'reminder' | 'approval' | 'task_done';
}

export interface SendResult {
  externalId?: string;
}

export interface ChannelAdapter {
  channel: Channel;
  send(externalChatId: string, content: OutboundContent): Promise<SendResult>;
}

/** Thrown by an adapter when the user blocked us (the link is marked blocked, no retry). */
export class RecipientBlockedError extends Error {}

export const sessionKeyFor = (channel: Channel, externalChatId?: string) =>
  channel === 'web' ? 'web' : `${channel}:${externalChatId}`;

export function parseSessionKey(key: string): { channel: Channel; externalChatId?: string } | null {
  if (key === 'web') return { channel: 'web' };
  const i = key.indexOf(':');
  if (i < 0) return null;
  const channel = key.slice(0, i);
  if (channel !== 'telegram' && channel !== 'whatsapp' && channel !== 'imessage') return null;
  return { channel, externalChatId: key.slice(i + 1) };
}

/** Split long text on paragraph/line/space boundaries (Telegram/WhatsApp ~4096 chars). */
export function splitText(text: string, max = 4096): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length || parts.length === 0) parts.push(rest);
  return parts;
}
