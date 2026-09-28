import { AppError } from '../../shared/errors.ts';
import { redeemCoupon } from './coupons.ts';

/** A coupon code sent as a chat message, e.g. "AGT-7KQ2-M9XP-4RWD-ABCD". */
export const CHAT_COUPON_PATTERN = /^\s*(AGT(?:-?[A-Z0-9]{4}){3,4})\s*$/i;

/**
 * Redeems a code sent in chat (HLD 7.7: "by sending the code in chat"). Same rules as the web
 * endpoint, same generic failure. Returns the reply text, or null if the text isn't a code.
 */
export async function redeemFromChat(userId: string, text: string): Promise<string | null> {
  const m = CHAT_COUPON_PATTERN.exec(text);
  if (!m) return null;
  try {
    const r = await redeemCoupon({ userId, code: m[1]!, ip: null });
    const expiry = r.expiresAt ? `, they expire on ${r.expiresAt.toISOString().slice(0, 10)}` : '';
    return `🎉 +${r.creditsAdded} credits added${expiry}. Balance: ${r.balance}.`;
  } catch (err) {
    if (err instanceof AppError && err.status === 429)
      return 'Too many attempts. Please try again later.';
    if (err instanceof AppError) return 'That code is invalid or expired.';
    throw err;
  }
}
