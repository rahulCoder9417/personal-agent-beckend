import { verifyToken } from '@clerk/backend';
import { config } from '../../shared/config.ts';
import { unauthorized } from '../../shared/errors.ts';

/** Verifies a Clerk session JWT and returns the Clerk user id (`sub`). */
export async function verifySessionToken(token: string): Promise<string> {
  const c = config();
  try {
    const result = (await verifyToken(token, {
      ...(c.CLERK_JWT_KEY ? { jwtKey: c.CLERK_JWT_KEY } : {}),
      ...(c.CLERK_SECRET_KEY ? { secretKey: c.CLERK_SECRET_KEY } : {}),
      ...(c.CLERK_AUTHORIZED_PARTIES
        ? { authorizedParties: c.CLERK_AUTHORIZED_PARTIES.split(',').map((s) => s.trim()) }
        : {}),
    })) as unknown as { sub?: string; data?: { sub?: string }; errors?: unknown[] };
    if (result.errors?.length) throw unauthorized();
    const sub = result.sub ?? result.data?.sub;
    if (!sub) throw unauthorized();
    return sub;
  } catch {
    throw unauthorized();
  }
}
