// When the agent asks for the user's OK, Tex says plainly what it wants to do (made from the
// approval's own summary: no model call) and that it waits for Approve or Deny. The agent is told
// the user already sees that, so it ends its turn without saying it again.
import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { messages } from '../src/modules/channels/schema.ts';
import { subscribe, type StreamEvent } from '../src/modules/channels/stream.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { events } from '../src/modules/events/schema.ts';
import { approvalAskText, channelOfSession } from '../src/modules/orchestrator/approval-text.ts';
import { decideApproval, handleProcessApproval } from '../src/modules/orchestrator/approvals.ts';
import { handleWebMessage, sendWebMessage } from '../src/modules/orchestrator/process-message.ts';
import { DeliverKind } from '../proto-gen/vm/v1/vm_pb.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeComposio, installFakeVm, type McpResult } from './fakes.ts';
import { chatUser, waitFor } from './helpers.ts';

describe('the question Tex asks', () => {
  it('says what Tex wants to do, from the summary, and how to answer', () => {
    expect(approvalAskText('Send an email to x@acme.com with subject "Test"', 'web')).toBe(
      'I\'d like to send an email to x@acme.com with subject "Test". Approve or Deny below.',
    );
    for (const channel of ['telegram', 'whatsapp'] as const)
      expect(approvalAskText('Delete 3 emails from Bob.', channel)).toBe(
        "I'd like to delete 3 emails from Bob. Approve or Deny below.",
      );
    // iMessage has no buttons: its sender adds "Reply YES to approve or NO to deny." itself.
    expect(approvalAskText('Pay the invoice', 'imessage')).toBe("I'd like to pay the invoice.");
  });

  it('keeps a summary that does not start with a verb as written', () => {
    expect(approvalAskText('Gmail: send the notes to Priya', 'web')).toBe(
      "I'd like your OK for this: Gmail: send the notes to Priya. Approve or Deny below.",
    );
    expect(approvalAskText('Priya gets the notes', 'telegram')).toBe(
      "I'd like your OK for this: Priya gets the notes. Approve or Deny below.",
    );
    // A verb with a colon after it is a label, not the start of a sentence.
    expect(approvalAskText('Email: the launch notes to Priya', 'web')).toBe(
      "I'd like your OK for this: Email: the launch notes to Priya. Approve or Deny below.",
    );
  });

  it('writes the verb in small letters, and ends the sentence once', () => {
    expect(approvalAskText('  SEND the report...  ', 'web')).toBe(
      "I'd like to send the report. Approve or Deny below.",
    );
    expect(approvalAskText('Start a crew job for Patch?', 'web')).toBe(
      "I'd like to start a crew job for Patch? Approve or Deny below.",
    );
  });

  it('knows the chat of a session key', () => {
    expect(channelOfSession('web')).toBe('web');
    expect(channelOfSession('telegram:12345')).toBe('telegram');
    expect(channelOfSession('imessage:+15550001111')).toBe('imessage');
  });
});

let vm: ReturnType<typeof installFakeVm>;
beforeAll(() => wireModules());
afterAll(async () => {
  await closeQueues();
});
beforeEach(async () => {
  vm = installFakeVm();
  vm.state.live = true;
  // request_approval checks an app action's inputs against Composio's description of it.
  await installFakeComposio();
});

const SUMMARY = 'Send an email to priya@acme.com with subject "Test"';
const ARGS = { to: 'priya@acme.com', subject: 'Test', body: 'Hello' };

/** The user writes in web chat and the worker runs the turn. */
async function sayInWeb(userId: string, text: string) {
  const { message, eventId } = await sendWebMessage(userId, {
    text,
    clientMessageId: randomUUID(),
  });
  await handleWebMessage({ data: { messageId: message.id, eventId, userId } } as Job);
  return message;
}

/** The worker's job for the user's answer, run here (no worker in this file). */
async function runAnswer(userId: string, approvalId: string) {
  const [event] = await db()
    .select()
    .from(events)
    .where(and(eq(events.source, 'approval'), eq(events.externalId, approvalId)));
  await handleProcessApproval({ data: { approvalId, userId, eventId: event!.id } } as Job);
}

describe('asking in web chat', () => {
  it("the question is Tex's message with the card, and the agent is told to end its turn", async () => {
    const user = await chatUser();
    const results: McpResult[] = [];
    vm.state.agent = async (d, mcp) => {
      if (d.kind !== DeliverKind.MESSAGE) return;
      results.push(
        await mcp('request_approval', {
          summary: SUMMARY,
          action: 'GMAIL_SEND_EMAIL',
          arguments: ARGS,
          session_key: d.sessionKey,
        }),
      );
    };
    const seen: StreamEvent[] = [];
    const stop = await subscribe(user.id, (e) => void seen.push(e));
    const asked = await sayInWeb(user.id, 'email priya a test');
    await waitFor(async () => seen.some((e) => e.type === 'approval.created')).finally(stop);

    // Tex's sentence, then what will really run, written by the server from the inputs.
    const expected =
      'I\'d like to send an email to priya@acme.com with subject "Test".\n' +
      'What will run: Gmail – send email · To: priya@acme.com · Subject: Test · Text: Hello\n' +
      'Approve or Deny below.';
    // Saved as Tex's message in the conversation, carrying the approval (the web app draws the card).
    const [question] = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, user.id), isNotNull(messages.approvalId)));
    expect(question).toMatchObject({
      direction: 'out',
      channel: 'web',
      text: expected,
      conversationId: asked.conversationId,
    });
    const created = seen.find(
      (e) => e.type === 'message.created' && (e.data as { approvalId?: string }).approvalId,
    );
    expect(created?.data).toMatchObject({ text: expected, approvalId: question!.approvalId });

    // The tool says what the user sees and that the turn ends here.
    const result = JSON.parse(results[0]!.text) as Record<string, string>;
    expect(results[0]!.isError).toBeFalsy();
    expect(result).toMatchObject({ status: 'pending', shown_to_user: expected });
    expect(result.next).toMatch(/^End your turn now/);
  });

  it('after Deny, the agent is told not to do it and to say so in one sentence', async () => {
    const user = await chatUser();
    vm.state.agent = async (d, mcp) => {
      if (d.kind === DeliverKind.MESSAGE)
        await mcp('request_approval', {
          summary: SUMMARY,
          action: 'GMAIL_SEND_EMAIL',
          arguments: ARGS,
          session_key: d.sessionKey,
        });
      else await mcp('send_message', { text: "OK, I won't send it.", session_key: d.sessionKey });
    };
    await sayInWeb(user.id, 'email priya a test');
    const [question] = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, user.id), isNotNull(messages.approvalId)));
    await decideApproval(user.id, question!.approvalId!, false, 'web');
    await runAnswer(user.id, question!.approvalId!);

    const answer = vm.deliveries.find((d) => d.kind === DeliverKind.APPROVAL_ANSWER);
    expect(answer).toMatchObject({ approvalId: question!.approvalId, approved: false });
    expect(answer!.text).toContain(`The user REJECTED: ${SUMMARY}. Don't do it.`);
    expect(answer!.text).toContain("Tell them in one short sentence that you won't.");
  });
});
