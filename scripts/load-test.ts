// Load test at the awake cap (HLD Phase 8). Run against a full stack (docker compose --profile app
// --profile vm) with N linked Telegram chats. It fires one message per chat at once, then watches
// the vm-manager: awake containers must never exceed the cap and every message must get a reply.
//
//   LOAD_USERS=40 AWAKE_CAP=15 API_URL=http://localhost:8080 pnpm tsx scripts/load-test.ts
//
// Seeding: creates users + telegram links directly in Postgres (chat ids 900000000+i), so the
// Telegram bot token should point at a stub (TELEGRAM_API_URL) that accepts sendMessage.
import { randomUUID } from 'node:crypto';
import { channelLinks } from '../src/modules/auth/schema.ts';
import { upsertUserFromClerk } from '../src/modules/auth/users.ts';
import { vm } from '../src/modules/orchestrator/vm.ts';
import { SandboxState } from '../proto-gen/vm/v1/vm_pb.ts';
import { config } from '../src/shared/config.ts';
import { closeDb, db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';

const N = Number(process.env.LOAD_USERS ?? 40);
const CAP = Number(process.env.AWAKE_CAP ?? 15);
const API = process.env.API_URL ?? 'http://localhost:8080';
const secret = config().TELEGRAM_WEBHOOK_SECRET!;

const chats: number[] = [];
for (let i = 0; i < N; i++) {
  const { user } = await upsertUserFromClerk({
    clerkId: `load_${randomUUID()}`,
    email: `load${i}@example.com`,
    emailVerified: true,
    name: `Load ${i}`,
    role: 'user',
  });
  const chatId = 900_000_000 + i;
  await db()
    .insert(channelLinks)
    .values({
      id: newId('chl'),
      userId: user.id,
      channel: 'telegram',
      externalId: String(chatId),
      displayId: `load${i}`,
    })
    .onConflictDoNothing();
  chats.push(chatId);
}

const started = Date.now();
const responses = await Promise.all(
  chats.map((chatId, i) =>
    fetch(`${API}/webhooks/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
      body: JSON.stringify({
        update_id: Date.now() * 1000 + i,
        message: {
          message_id: i,
          chat: { id: chatId },
          from: { id: chatId },
          text: 'load test: say hi',
        },
      }),
    }).then((r) => r.status),
  ),
);
console.log(
  `webhooks: ${responses.filter((s) => s === 200).length}/${N} accepted in ${Date.now() - started} ms`,
);

let maxAwake = 0;
const deadline = Date.now() + 10 * 60_000;
while (Date.now() < deadline) {
  const { sandboxes } = await vm().listSandboxes({ states: [] });
  const awake = sandboxes.filter((s) =>
    [SandboxState.AWAKE, SandboxState.BUSY, SandboxState.WAKING].includes(s.state),
  ).length;
  maxAwake = Math.max(maxAwake, awake);
  const busy = sandboxes.filter((s) => s.state === SandboxState.BUSY).length;
  console.log(`awake=${awake} busy=${busy} max=${maxAwake}`);
  if (awake > CAP) {
    console.error(`FAIL: ${awake} awake > cap ${CAP}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 2000));
  if (busy === 0 && Date.now() - started > 30_000) break;
}
console.log(`done: max awake ${maxAwake} (cap ${CAP}). Check Bull Board: no failed inbound jobs.`);
await closeDb();
