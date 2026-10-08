// Bring your own key (HLD 7.1): the user's own provider key, encrypted at rest, test-called before
// it is saved, never returned. Billing puts the key that pays into LiteLLM, on the server, as a
// model only this user's LiteLLM key may call (billing/litellm.ts); it never enters a container.
import { and, desc, eq } from 'drizzle-orm';
import { decryptSecret, encryptSecret, sha256Hex } from '../../shared/crypto.ts';
import { db, type Tx } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { byokKeys } from './schema.ts';

export type ByokProvider = (typeof byokKeys.$inferSelect)['provider'];
export const BYOK_PROVIDERS: ByokProvider[] = ['anthropic', 'openai', 'openrouter'];

/**
 * The model used when the user didn't pick one: each provider's current mid-priced model with
 * tool use (checked 2026-10-08 against the providers' model lists). OpenRouter's default is the
 * same Claude model as Anthropic's, under OpenRouter's name for it.
 */
export const DEFAULT_MODELS: Record<ByokProvider, string> = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-6.1-sol',
  openrouter: 'anthropic/claude-sonnet-5.5',
};

export interface ByokKeyView {
  provider: ByokProvider;
  set: boolean;
  last4: string | null;
  model: string | null;
  /** The model that runs with this key: the user's choice or the provider's default. */
  effectiveModel: string;
  updatedAt: Date | null;
}

/** The saved key that pays for the user's AI when their own key pays. Never log `apiKey`. */
export interface OwnKey {
  provider: ByokProvider;
  model: string;
  apiKey: string;
  /** Identifies the saved key row and its content, without revealing the key. */
  fingerprint: string;
}

type ByokRow = typeof byokKeys.$inferSelect;

const effectiveModel = (provider: ByokProvider, model: string | null) =>
  model || DEFAULT_MODELS[provider];

// A hash of the row's id, model and ciphertext: changes whenever the key or the model changes.
const fingerprintOf = (row: ByokRow) =>
  sha256Hex(
    [row.id, row.provider, effectiveModel(row.provider, row.model), row.keyEncrypted].join('\n'),
  ).slice(0, 32);

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
      effectiveModel: effectiveModel(provider, row?.model ?? null),
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
  return {
    provider,
    set: true,
    last4: row!.last4,
    model: row!.model,
    effectiveModel: effectiveModel(provider, row!.model),
    updatedAt: row!.updatedAt,
  };
}

export async function deleteByokKey(userId: string, provider: ByokProvider): Promise<void> {
  await db()
    .delete(byokKeys)
    .where(and(eq(byokKeys.userId, userId), eq(byokKeys.provider, provider)));
}

/** Account deletion: every saved key of the user. */
export async function deleteUserByokKeys(userId: string): Promise<void> {
  await db().delete(byokKeys).where(eq(byokKeys.userId, userId));
}

/** The saved row as it is (encrypted), to put it back if a change can't be applied. */
export type ByokSnapshot = ByokRow | undefined;

export async function snapshotByokKey(
  userId: string,
  provider: ByokProvider,
): Promise<ByokSnapshot> {
  const [row] = await db()
    .select()
    .from(byokKeys)
    .where(and(eq(byokKeys.userId, userId), eq(byokKeys.provider, provider)));
  return row;
}

/** Puts the provider's row back to the snapshot (none in the snapshot: no row). */
export async function restoreByokKey(
  userId: string,
  provider: ByokProvider,
  snapshot: ByokSnapshot,
): Promise<void> {
  await db().transaction(async (tx) => {
    await tx
      .delete(byokKeys)
      .where(and(eq(byokKeys.userId, userId), eq(byokKeys.provider, provider)));
    if (snapshot) await tx.insert(byokKeys).values(snapshot);
  });
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

/** With several keys saved, the one saved last pays. Undefined: no key saved. */
export async function ownKeyForAi(userId: string): Promise<OwnKey | undefined> {
  const [row] = await db()
    .select()
    .from(byokKeys)
    .where(eq(byokKeys.userId, userId))
    .orderBy(desc(byokKeys.updatedAt), desc(byokKeys.id))
    .limit(1);
  if (!row) return undefined;
  return {
    provider: row.provider,
    model: effectiveModel(row.provider, row.model),
    apiKey: decryptSecret(row.keyEncrypted),
    fingerprint: fingerprintOf(row),
  };
}

/** Each saved key's fingerprint (to tell which one LiteLLM holds). */
export async function byokFingerprints(
  userId: string,
): Promise<Array<{ provider: ByokProvider; fingerprint: string }>> {
  const rows = await db().select().from(byokKeys).where(eq(byokKeys.userId, userId));
  return rows.map((r) => ({ provider: r.provider, fingerprint: fingerprintOf(r) }));
}
