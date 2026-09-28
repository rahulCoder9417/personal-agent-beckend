// Phase 6 channels: plugs WhatsApp and Sendblue (iMessage) into the channel registries and the
// media download (+ voice to text) into the inbound path. Called once from src/wiring.ts.
import { setInboundHooks } from '../orchestrator/process-message.ts';
import { registerAdapter } from './adapters/index.ts';
import {
  parseSendblueEvent,
  parseSendblueStatus,
  sendblueAdapter,
  type SendbluePayload,
} from './adapters/sendblue.ts';
import {
  parseWhatsappEvent,
  parseWhatsappStatus,
  whatsappAdapter,
  type WaStatus,
  type WhatsappEventPayload,
} from './adapters/whatsapp.ts';
import { registerInboundParser } from './inbound.ts';
import { prepareInboundMedia } from './media.ts';
import { registerStatusParser } from './status.ts';

export function wireChannels(): void {
  registerAdapter(whatsappAdapter);
  registerAdapter(sendblueAdapter);

  registerInboundParser('whatsapp', (p) =>
    parseWhatsappEvent(p as unknown as WhatsappEventPayload),
  );
  registerInboundParser('sendblue', (p) => parseSendblueEvent(p as SendbluePayload));

  registerStatusParser('whatsapp', (p) => parseWhatsappStatus(p as unknown as WaStatus));
  registerStatusParser('sendblue', (p) => parseSendblueStatus(p as SendbluePayload));

  // The worker downloads media and transcribes voice before the message is saved.
  setInboundHooks({ prepareInbound: prepareInboundMedia });
}
