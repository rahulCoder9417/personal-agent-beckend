// Placeholder until Phase 5 (credits ledger). Other modules only use these exported functions.
export interface BalanceSummary {
  balance: number;
  nextExpiry: Date | null;
}

export async function getBalanceSummary(_userId: string): Promise<BalanceSummary> {
  return { balance: 0, nextExpiry: null };
}
