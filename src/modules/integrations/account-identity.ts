// Who each connection is signed in as: the user's GitHub username, their Gmail address. It is kept
// as the connection's account label, and Tex sees it in get_profile and list_app_actions, so Tex
// never asks the user for it. On 17 October 2026 the founder asked about his repositories and Tex
// asked for his GitHub username, then asked again in the next chat, though GitHub was connected.
//
// Composio's record of a connected account does not say who it is: the label read from it (its
// `data.email`) was empty for every connection on the server. So the app is asked once, with its
// own read-only "who am I" action (the catalog's `identity`), and the answer is kept. Apps without
// one keep no label: Tex is told to ask the user once and save the answer to memory.
// docs/backend-report.md, "Apps through Composio".
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { logger } from '../../shared/logger.ts';
import type { Connection } from './apps.ts';
import { findApp } from './catalog.ts';
import { composio } from './composio.ts';
import { connections } from './tables.ts';

/**
 * The longest a lookup holds up a tool's answer. A slower lookup still finishes and keeps the
 * label, so the next call has it.
 */
export const IDENTITY_WAIT_MS = 3_000;
/** A connection whose lookup failed, or whose app did not say, is asked again after this. */
export const IDENTITY_RETRY_MS = 10 * 60_000;
/** A longer answer is not an account name, and is not kept. */
const MAX_LABEL_CHARS = 200;

/** When each connection's lookup last failed, by our connection id. */
const failedAt = new Map<string, number>();
/** Lookups under way, by connection id, so two tool calls at once ask the app once. */
const inFlight = new Map<string, Promise<string | null>>();

/** For tests: forget the failed and running lookups. */
export function resetIdentityLookups(): void {
  failedAt.clear();
  inFlight.clear();
}

/**
 * The value of `field` in an action's result: at its top, or inside a wrapper Composio may put
 * around it (`data`, `response_data`…), at most three levels down, the nearest first. Only a
 * non-empty string counts. A result sent as JSON text is read as JSON.
 */
export function identityFrom(data: unknown, field: string): string | null {
  let level: unknown[] = [data];
  for (let depth = 0; depth < 4 && level.length > 0; depth++) {
    const next: unknown[] = [];
    for (let v of level) {
      if (typeof v === 'string' && v.trimStart().startsWith('{')) {
        try {
          v = JSON.parse(v);
        } catch {
          continue;
        }
      }
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const o = v as Record<string, unknown>;
      const hit = o[field];
      if (typeof hit === 'string' && hit.trim()) return hit.trim();
      next.push(...Object.values(o));
    }
    level = next;
  }
  return null;
}

/** Asks the app who the connection is, and keeps the answer on it. Null: the app did not say. */
async function lookUp(row: Connection): Promise<string | null> {
  const identity = findApp(row.app)?.identity;
  if (!identity) return null;
  // The Composio user id is always the connection's own user.
  const res = await composio().whoAmI(identity.action, {
    userId: row.userId,
    connectedAccountId: row.composioAccountId,
    arguments: identity.arguments ?? {},
  });
  const label = res.successful ? identityFrom(res.data, identity.field) : null;
  if (!label || label.length > MAX_LABEL_CHARS) return null;
  await db()
    .update(connections)
    .set({ accountLabel: label })
    .where(
      and(
        eq(connections.userId, row.userId),
        eq(connections.id, row.id),
        isNull(connections.accountLabel),
      ),
    );
  return label;
}

/** One lookup per connection at a time. Never throws; a failure is noted, with its time. */
function lookUpOnce(row: Connection, now: number): Promise<string | null> {
  const running = inFlight.get(row.id);
  if (running) return running;
  const p = lookUp(row)
    .catch((err: unknown) => {
      logger().warn(
        { userId: row.userId, app: row.app, connectionId: row.id, err: String(err) },
        'account identity lookup failed',
      );
      return null;
    })
    .then((label) => {
      if (label) failedAt.delete(row.id);
      else failedAt.set(row.id, now);
      return label;
    })
    .finally(() => inFlight.delete(row.id));
  inFlight.set(row.id, p);
  return p;
}

/** The lookup's answer, or null when it takes longer than `ms` (it goes on in the background). */
async function within(p: Promise<string | null>, ms: number): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref();
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One user's connections, with the account label filled in on each active one whose app can say
 * who it is and that has none yet. The apps are asked at the same time, at most once per
 * connection while a label is missing (again after IDENTITY_RETRY_MS when one did not say), and
 * the answer is kept, so this asks nothing once the labels are known. Never throws: a connection
 * whose app can't be asked keeps no label.
 */
export async function withAccountLabels(
  rows: Connection[],
  now = Date.now(),
  waitMs = IDENTITY_WAIT_MS,
): Promise<Connection[]> {
  const todo = rows.filter((r) => {
    if (r.status !== 'active' || r.accountLabel || !findApp(r.app)?.identity) return false;
    const failed = failedAt.get(r.id);
    return failed === undefined || now - failed >= IDENTITY_RETRY_MS;
  });
  if (todo.length === 0) return rows;
  const found = new Map<string, string>();
  await Promise.all(
    todo.map(async (r) => {
      const label = await within(lookUpOnce(r, now), waitMs);
      if (label) found.set(r.id, label);
    }),
  );
  if (found.size === 0) return rows;
  return rows.map((r) => (found.has(r.id) ? { ...r, accountLabel: found.get(r.id)! } : r));
}
