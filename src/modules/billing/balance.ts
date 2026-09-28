// What other modules read about a user's credits. The balance is always computed from grants.
import { getBalance, getNextExpiry } from './credits.ts';

export interface BalanceSummary {
  balance: number;
  nextExpiry: Date | null;
}

export async function getBalanceSummary(userId: string): Promise<BalanceSummary> {
  const now = new Date();
  const [balance, nextExpiry] = await Promise.all([
    getBalance(userId, now),
    getNextExpiry(userId, now),
  ]);
  return { balance, nextExpiry };
}

/** HLD 7.5 "before a turn": may this user start a turn? */
export async function hasCredits(userId: string): Promise<boolean> {
  return (await getBalance(userId)) > 0;
}
