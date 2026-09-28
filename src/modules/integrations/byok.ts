// Bring your own key (HLD 7.1): the user's own provider key, encrypted at rest, test-called before
// it is saved, never returned. With a key set, AI isn't charged in credits (awake time still is).
import { and, eq } from 'drizzle-orm';
import { decryptSecret, encryptSecret } from '../../shared/crypto.ts';
import { db, type Tx } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { byokKeys } from './schema.ts';

export type ByokProvider = (typeof byokKeys.$inferSelect)['provider'];
export const BYOK_PROVIDERS: ByokProvider[] = ['anthropic', 'openai', 'openrouter'];

export interface ByokKeyView {
  provider: ByokProvider;
  set: boolean;
  last4: string | null;
  model: string | null;
  updatedAt: Date | null;
}

/** Returns true if the provider accepts the key. Swappable for tests. */
export type ByokVerifier = (provider: ByokProvider, apiKey: string) => Promise<boolean>;

const PROBES: Record<
  ByokProvider,
  (key: string) => { url: string; headers: Record<string, string> }
> = {
  anthropic: (key) => ({
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  }),
  openai: (key) => ({
    url: 'https://api.openai.com/v1/models',
    headers: { authorization: `Bearer ${key}` },
  }),
  openrouter: (key) => ({
    url: 'https://openrouter.ai/api/v1/key',
    headers: { authorization: `Bearer ${key}` },
  }),
};

const httpVerifier: ByokVerifier = async (provider, apiKey) => {
  const probe = PROBES[provider](apiKey);
  try {
    const res = await fetch(probe.url, {
      headers: probe.headers,
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

let verifier: ByokVerifier = httpVerifier;

/** Tests: swap the provider test-call. `undefined` restores the real one. */
export function setByokVerifier(fake: ByokVerifier | undefined): void {
  verifier = fake ?? httpVerifier;
}

export async function listByokKeys(userId: string): Promise<ByokKeyView[]> {
  const rows = await db().select().from(byokKeys).where(eq(byokKeys.userId, userId));
  return BYOK_PROVIDERS.map((provider) => {
    const row = rows.find((r) => r.provider === provider);
    return {
      provider,
      set: Boolean(row),
      last4: row?.last4 ?? null,
      model: row?.model ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

/** Test-calls the key, then saves it encrypted. Returns null if the provider rejected it. */
export async function setByokKey(
  userId: string,
  provider: ByokProvider,
  apiKey: string,
  model: string | null,
): Promise<ByokKeyView | null> {
  const key = apiKey.trim();
  if (!(await verifier(provider, key))) return null;
  const now = new Date();
  const values = {
    keyEncrypted: encryptSecret(key),
    last4: key.slice(-4),
    model,
    updatedAt: now,
  };
  const [row] = await db()
    .insert(byokKeys)
    .values({ id: newId('byok'), userId, provider, ...values })
    .onConflictDoUpdate({ target: [byokKeys.userId, byokKeys.provider], set: values })
    .returning();
  return { provider, set: true, last4: row!.last4, model: row!.model, updatedAt: row!.updatedAt };
}

export async function deleteByokKey(userId: string, provider: ByokProvider): Promise<void> {
  await db()
    .delete(byokKeys)
    .where(and(eq(byokKeys.userId, userId), eq(byokKeys.provider, provider)));
}

export async function hasByokKey(userId: string, tx: Tx = db()): Promise<boolean> {
  const [row] = await tx
    .select({ id: byokKeys.id })
    .from(byokKeys)
    .where(eq(byokKeys.userId, userId))
    .limit(1);
  return Boolean(row);
}

/** The plaintext key (for wiring into the user's LiteLLM routing); never log or return it. */
export async function getByokKey(
  userId: string,
  provider: ByokProvider,
): Promise<{ apiKey: string; model: string | null } | undefined> {
  const [row] = await db()
    .select()
    .from(byokKeys)
    .where(and(eq(byokKeys.userId, userId), eq(byokKeys.provider, provider)));
  return row ? { apiKey: decryptSecret(row.keyEncrypted), model: row.model } : undefined;
}
