// What other modules read about a user's credits. The balance is always computed from grants.
import { getBalance, getBalanceAndNextExpiry } from './credits.ts';

export interface BalanceSummary {
  balance: number;
  nextExpiry: Date | null;
}

/** The balance and when the next credits run out: one read of the user's grants. */
export async function getBalanceSummary(userId: string): Promise<BalanceSummary> {
  return getBalanceAndNextExpiry(userId);
}

/** HLD 7.5 "before a turn": may this user start a turn? */
export async function hasCredits(userId: string): Promise<boolean> {
  return (await getBalance(userId)) > 0;
}
