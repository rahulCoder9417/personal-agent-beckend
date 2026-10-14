// What the admin tools ask of Clerk, through its Backend API: set the role in a user's public
// metadata, delete a user, end a user's sessions. Tests swap in a stand-in (setClerkAdmin).
import { createClerkClient } from '@clerk/backend';
import { isClerkAPIResponseError } from '@clerk/backend/errors';
import { config } from '../../shared/config.ts';
import { logger } from '../../shared/logger.ts';

/**
 * `not_configured`: `CLERK_SECRET_KEY` is not set. `not_found`: Clerk has no such user.
 * `unavailable`: Clerk could not be reached or refused. Nothing was changed in any of them.
 */
export class ClerkAdminError extends Error {
  constructor(
    readonly kind: 'not_configured' | 'not_found' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

export interface ClerkAdminApi {
  /** Sets `role` in the user's public metadata. Other metadata keys stay as they are. */
  setRole(clerkId: string, role: 'user' | 'admin'): Promise<void>;
  /** Deletes the user in Clerk. Throws `not_found` when Clerk has no such user. */
  deleteUser(clerkId: string): Promise<void>;
  /** Ends every active session of the user. Returns how many were ended. */
  revokeSessions(clerkId: string): Promise<number>;
}

/** A page of Clerk's session list; more than this many pages is not expected for one user. */
const PAGE = 100;
const MAX_PAGES = 10;

type Clerk = ReturnType<typeof createClerkClient>;

async function withClerk<T>(what: string, fn: (clerk: Clerk) => Promise<T>): Promise<T> {
  const secretKey = config().CLERK_SECRET_KEY;
  if (!secretKey) throw new ClerkAdminError('not_configured', 'Clerk is not set up on this server');
  try {
    return await fn(createClerkClient({ secretKey }));
  } catch (err) {
    if (err instanceof ClerkAdminError) throw err;
    if (isClerkAPIResponseError(err) && err.status === 404)
      throw new ClerkAdminError('not_found', 'Clerk has no such user');
    // The status and Clerk's message only: never the request or its headers.
    logger().warn(
      { what, status: isClerkAPIResponseError(err) ? err.status : null, err: String(err) },
      'clerk admin call failed',
    );
    throw new ClerkAdminError('unavailable', 'Clerk could not be reached');
  }
}

const realClerkAdmin: ClerkAdminApi = {
  async setRole(clerkId, role) {
    await withClerk('set role', (clerk) =>
      clerk.users.updateUserMetadata(clerkId, { publicMetadata: { role } }),
    );
  },
  async deleteUser(clerkId) {
    await withClerk('delete user', (clerk) => clerk.users.deleteUser(clerkId));
  },
  async revokeSessions(clerkId) {
    return withClerk('revoke sessions', async (clerk) => {
      // The whole list first: ending sessions while paging would move the pages.
      const ids: string[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data } = await clerk.sessions.getSessionList({
          userId: clerkId,
          status: 'active',
          limit: PAGE,
          offset: page * PAGE,
        });
        ids.push(...data.map((s) => s.id));
        if (data.length < PAGE) break;
      }
      let revoked = 0;
      for (const id of ids) {
        try {
          await clerk.sessions.revokeSession(id);
          revoked++;
        } catch (err) {
          // Ended meanwhile (signed out, expired): nothing left to do for that one.
          if (isClerkAPIResponseError(err) && err.status < 500) continue;
          throw err;
        }
      }
      return revoked;
    });
  },
};

let override: ClerkAdminApi | undefined;

export function clerkAdmin(): ClerkAdminApi {
  return override ?? realClerkAdmin;
}

/** Tests: a stand-in for Clerk's Backend API. Undefined puts the real one back. */
export function setClerkAdmin(fake: ClerkAdminApi | undefined): void {
  override = fake;
}
