import { eq } from 'drizzle-orm';
import type { Worker } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import {
  routeTurn,
  setChatCompleter,
  setJevClient,
  setRoutingAppsProvider,
  type ChatMessage,
  type JevDecision,
  type JevRequest,
} from '../src/modules/orchestrator/routing.ts';
import { setVmClient, vm, type VmClient } from '../src/modules/orchestrator/vm.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import {
  installFakeWhatsapp,
  linkWhatsapp,
  phone,
  postWhatsapp,
  useChannelEnv,
  waText,
  waWebhook,
} from './fakes-channels.ts';
import { installFakeVm } from './fakes.ts';
import { chatUser, waitFor } from './helpers.ts';

useChannelEnv();

let workers: Worker[];
let vmFake: ReturnType<typeof installFakeVm>;
let wa: ReturnType<typeof installFakeWhatsapp>;
let wakes: string[];
let jevCalls: JevRequest[];
let jevAnswer: JevDecision | Error;
let chatCalls: ChatMessage[][];
let chatAnswer: string | Error;

beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  setJevClient(undefined);
  setChatCompleter(undefined);
});
beforeEach(() => {
  vmFake = installFakeVm();
  // Count wake-ups on top of the fake vm-manager.
  wakes = [];
  const fake = vm();
  setVmClient({
    ...fake,
    wakeSandbox: (req: Parameters<VmClient['wakeSandbox']>[0]) => {
      wakes.push(String(req.userId));
      return fake.wakeSandbox(req);
    },
  } as VmClient);
  wa = installFakeWhatsapp();
  jevCalls = [];
  jevAnswer = { route: 'task', confidence: 0.9, apps: [] };
  setJevClient({
    async decide(req) {
      jevCalls.push(req);
      if (jevAnswer instanceof Error) throw jevAnswer;
      return jevAnswer;
    },
  });
  chatCalls = [];
  chatAnswer = "I'm great, thanks for asking!";
  setChatCompleter(async ({ messages: m }) => {
    chatCalls.push(m);
    if (chatAnswer instanceof Error) throw chatAnswer;
    return chatAnswer;
  });
  setRoutingAppsProvider(async () => []);
});

async function linkedUser() {
  const user = await chatUser();
  const number = phone();
  await linkWhatsapp(user.token, number, wa);
  return { user, number };
}

async function inboundStatus(userId: string, text: string) {
  const rows = await db().select().from(messages).where(eq(messages.userId, userId));
  return rows.find((r) => r.direction === 'in' && r.text === text)?.status;
}

describe('Phase 6: Jev routing', () => {
  it("a simple question is answered by the cheap model and doesn't wake a container", async () => {
    const { user, number } = await linkedUser();
    jevAnswer = { route: 'simple', confidence: 0.93, apps: [] };
    await postWhatsapp(waWebhook([waText(number, 'hi, how are you?')]));
    const reply = await waitFor(async () =>
      wa.sent.find((m) => m.to === number && m.text === "I'm great, thanks for asking!"),
    );
    expect(reply.type).toBe('text');
    await waitFor(async () => (await inboundStatus(user.id, 'hi, how are you?')) === 'delivered');
    expect(wakes).toHaveLength(0);
    expect(vmFake.deliveries).toHaveLength(0);

    expect(jevCalls).toHaveLength(1);
    expect(jevCalls[0]!.state.message).toBe('hi, how are you?');
    const chat = chatCalls[0]!;
    expect(chat[0]!.role).toBe('system');
    expect(chat[0]!.content).toContain('ESCALATE');
    expect(chat.at(-1)).toEqual({ role: 'user', content: 'hi, how are you?' });

    const rows = await db().select().from(messages).where(eq(messages.userId, user.id));
    expect(rows.find((r) => r.direction === 'out' && r.text === reply.text)).toBeTruthy();
  });

  it('a task wakes the container and carries the apps Jev picked', async () => {
    const { user, number } = await linkedUser();
    setRoutingAppsProvider(async () => [
      { slug: 'gmail', name: 'Gmail' },
      { slug: 'googlecalendar', name: 'Google Calendar' },
    ]);
    jevAnswer = { route: 'task', confidence: 0.88, apps: ['gmail'] };
    await postWhatsapp(waWebhook([waText(number, 'email Bob the invoice')]));
    await waitFor(async () => wa.sent.find((m) => m.text === 'echo: email Bob the invoice'));
    expect(wakes).toEqual([user.id]);
    expect(vmFake.deliveries).toHaveLength(1);
    const meta = JSON.parse(
      (vmFake.deliveries[0] as unknown as { metadataJson: string }).metadataJson,
    );
    // Every delivery also carries the chat's epoch (0: no new chat started yet).
    expect(meta).toEqual({ apps: ['gmail'], chat_epoch: 0 });
    expect(jevCalls[0]!.apps.map((a) => a.slug)).toEqual(['gmail', 'googlecalendar']);
  });

  it('Jev down → every message is a task', async () => {
    const { number } = await linkedUser();
    jevAnswer = new Error('connect ECONNREFUSED');
    await postWhatsapp(waWebhook([waText(number, 'what is 2+2?')]));
    await waitFor(async () => wa.sent.find((m) => m.text === 'echo: what is 2+2?'));
    expect(vmFake.deliveries).toHaveLength(1);
    expect(chatCalls).toHaveLength(0);
  });

  it('Jev not configured → every message is a task (no Jev call at all)', async () => {
    setJevClient(undefined); // JEV_API_KEY is unset in tests
    const { number } = await linkedUser();
    await postWhatsapp(waWebhook([waText(number, 'hello')]));
    await waitFor(async () => wa.sent.find((m) => m.text === 'echo: hello'));
    expect(vmFake.deliveries).toHaveLength(1);
  });

  it('spam is ignored only when Jev is very sure', async () => {
    const { user, number } = await linkedUser();
    jevAnswer = { route: 'spam', confidence: 0.97, apps: [] };
    await postWhatsapp(waWebhook([waText(number, 'W1N FREE CRYPTO click here')]));
    await waitFor(
      async () => (await inboundStatus(user.id, 'W1N FREE CRYPTO click here')) === 'delivered',
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(vmFake.deliveries).toHaveLength(0);
    expect(wa.sent.filter((m) => m.to === number && !m.text?.startsWith('✅'))).toHaveLength(0);

    jevAnswer = { route: 'spam', confidence: 0.6, apps: [] };
    await postWhatsapp(waWebhook([waText(number, 'hmm is this spam')]));
    // No engine has run in this chat yet, so the turn starts with a recap of the chat as stored
    // (HLD 0.9), which holds the ignored message too. The turn's own text comes last.
    await waitFor(async () => wa.sent.find((m) => m.text?.endsWith('\nhmm is this spam')));
    expect(vmFake.deliveries).toHaveLength(1);
    expect(vmFake.deliveries[0]!.text.split('\n').at(-1)).toBe('hmm is this spam');
  });

  it('an unsure "simple", an ESCALATE answer or a cheap-model error all fall back to the agent', async () => {
    const { number } = await linkedUser();
    jevAnswer = { route: 'simple', confidence: 0.5, apps: [] };
    await postWhatsapp(waWebhook([waText(number, 'one')]));
    await waitFor(async () => wa.sent.find((m) => m.text === 'echo: one'));
    expect(chatCalls).toHaveLength(0);

    jevAnswer = { route: 'simple', confidence: 0.95, apps: [] };
    chatAnswer = 'ESCALATE';
    await postWhatsapp(waWebhook([waText(number, 'two')]));
    await waitFor(async () => wa.sent.find((m) => m.text === 'echo: two'));

    chatAnswer = new Error('litellm 503');
    await postWhatsapp(waWebhook([waText(number, 'three')]));
    await waitFor(async () => wa.sent.find((m) => m.text === 'echo: three'));
    expect(vmFake.deliveries.map((d) => d.text)).toEqual(['one', 'two', 'three']);
    expect(wa.sent.find((m) => m.text === 'ESCALATE')).toBeUndefined();
  });

  it('Jev sees the recent conversation, so follow-ups go to the agent', async () => {
    const { number } = await linkedUser();
    await postWhatsapp(waWebhook([waText(number, 'draft a note to Sam')]));
    await waitFor(async () => wa.sent.find((m) => m.text === 'echo: draft a note to Sam'));
    await new Promise((r) => setTimeout(r, 100));
    await postWhatsapp(waWebhook([waText(number, 'yes do it')]));
    await waitFor(async () => wa.sent.find((m) => m.text === 'echo: yes do it'));
    const last = jevCalls.at(-1)!;
    expect(last.state.message).toBe('yes do it');
    expect(last.state.conversation).toEqual(
      expect.arrayContaining([
        { role: 'user', text: 'draft a note to Sam' },
        { role: 'assistant', text: 'echo: draft a note to Sam' },
      ]),
    );
    expect(last.state.conversation.find((m) => m.text === 'yes do it')).toBeUndefined();
  });

  it('only fresh text messages are routed', async () => {
    jevAnswer = { route: 'simple', confidence: 0.99, apps: [] };
    const base = {
      userId: 'usr_x',
      deliveryId: 'evt_x',
      sessionKey: 'web',
      channel: 'web' as const,
      text: 'hi',
    };
    expect(await routeTurn({ ...base, kind: 'automation' })).toEqual({ kind: 'task' });
    expect(await routeTurn({ ...base, kind: 'approval_answer' })).toEqual({ kind: 'task' });
    expect(
      await routeTurn({
        ...base,
        kind: 'message',
        attachments: [{ id: 'att_1', name: 'a.png', mimeType: 'image/png', path: '/tmp/a' }],
      }),
    ).toEqual({ kind: 'task' });
    expect(await routeTurn({ ...base, kind: 'message', text: 'x'.repeat(1001) })).toEqual({
      kind: 'task',
    });
    expect(jevCalls).toHaveLength(0);
    expect(await routeTurn({ ...base, kind: 'message' })).toEqual({
      kind: 'simple',
      reply: "I'm great, thanks for asking!",
    });
  });
});
