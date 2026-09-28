// Fake vm-manager + fake Telegram Bot API for end-to-end tests without Docker.
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../src/shared/crypto.ts';
import { setTelegramApi } from '../src/modules/channels/adapters/telegram.ts';
import { setVmClient, type VmClient } from '../src/modules/orchestrator/vm.ts';
import { DeliverEventType, SandboxState } from '../proto-gen/vm/v1/vm_pb.ts';
import { testApp } from './helpers.ts';

export interface Delivery {
  userId: string;
  deliveryId: string;
  sessionKey: string;
  text: string;
  kind: number;
  approvalId: string;
  approved: boolean;
}

/** What the fake "agent" does with a delivered message. Default: echo it back via send_message. */
export type AgentBehaviour = (
  d: Delivery,
  mcp: (tool: string, args: Record<string, unknown>) => Promise<McpResult>,
) => Promise<void>;

export interface McpResult {
  isError?: boolean;
  text: string;
}

export async function mcpCall(
  token: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<McpResult> {
  const res = await testApp().request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const body = (await res.json()) as {
    result?: { isError?: boolean; content?: Array<{ text: string }> };
    error?: { message: string };
  };
  if (body.error) return { isError: true, text: body.error.message };
  return { isError: body.result?.isError ?? false, text: body.result?.content?.[0]?.text ?? '' };
}

export function installFakeVm(behaviour?: AgentBehaviour) {
  const tokens = new Map<string, string>();
  const deliveries: Delivery[] = [];
  const created: string[] = [];
  const touches: string[] = [];
  const agent: AgentBehaviour =
    behaviour ??
    (async (d, mcp) =>
      void (await mcp('send_message', { text: `echo: ${d.text}`, session_key: d.sessionKey })));
  const state = { agent, wakeError: null as Error | null };

  const fake = {
    async createSandbox(req: { userId: string }) {
      let token = tokens.get(req.userId);
      if (!token) {
        token = randomBytes(24).toString('hex');
        tokens.set(req.userId, token);
        created.push(req.userId);
      }
      return {
        sandbox: { userId: req.userId, state: SandboxState.STOPPED },
        mcpTokenHash: sha256Hex(token),
      };
    },
    async wakeSandbox(req: { userId: string }) {
      if (state.wakeError) throw state.wakeError;
      return { sandbox: { userId: req.userId, state: SandboxState.AWAKE }, wasStopped: true };
    },
    async *deliver(req: Delivery) {
      deliveries.push({ ...req });
      yield { type: DeliverEventType.ACCEPTED, message: '', platformFault: false };
      const token = tokens.get(req.userId)!;
      await state.agent(req, (tool, args) => mcpCall(token, tool, args));
      yield { type: DeliverEventType.TURN_DONE, message: '', platformFault: false };
    },
    async touch(req: { userId: string }) {
      touches.push(req.userId);
      return {};
    },
    async getSandbox(req: { userId: string }) {
      return {
        userId: req.userId,
        state: tokens.has(req.userId) ? SandboxState.AWAKE : SandboxState.STOPPED,
        lastActiveAtUnixMs: BigInt(Date.now()),
      };
    },
    async deleteSandbox(req: { userId: string }) {
      tokens.delete(req.userId);
      return {};
    },
    async setEgressAllowlist() {
      return {};
    },
    async getUsage() {
      return { usage: [] };
    },
  };
  setVmClient(fake as unknown as VmClient);
  return { tokens, deliveries, created, touches, state };
}

export interface SentTelegram {
  chatId: string;
  text: string;
  buttons?: Array<{ text: string; callback_data: string }>;
}

export function installFakeTelegram() {
  const sent: SentTelegram[] = [];
  let nextId = 1000;
  setTelegramApi(async (method, body) => {
    if (method === 'sendMessage') {
      const kb = (
        body.reply_markup as
          { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } | undefined
      )?.inline_keyboard?.[0];
      sent.push({
        chatId: String(body.chat_id),
        text: String(body.text),
        ...(kb ? { buttons: kb } : {}),
      });
      return { message_id: nextId++ };
    }
    return {};
  });
  return { sent };
}

let updateId = 1;
export function telegramUpdate(chatId: number, text: string, username = 'someone') {
  return {
    update_id: updateId++ + Math.floor(Math.random() * 1e9),
    message: { message_id: updateId, from: { id: chatId, username }, chat: { id: chatId }, text },
  };
}

export function telegramButton(chatId: number, data: string) {
  return {
    update_id: updateId++ + Math.floor(Math.random() * 1e9),
    callback_query: {
      id: `cb${updateId}`,
      from: { id: chatId },
      data,
      message: { message_id: 1, chat: { id: chatId } },
    },
  };
}
