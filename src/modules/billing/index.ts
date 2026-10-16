// The billing module's public surface: other modules import from here only.
export { chargeAppAction } from './app-actions.ts';
export { chargePaidTool } from './paid-tools.ts';
export { getBalanceSummary, hasCredits, type BalanceSummary } from './balance.ts';
export {
  onBalanceDepleted,
  onCreditsAdded,
  onPlanChanged,
  onTurnBilled,
  onAutoTopUpTurnedOff,
  type AutoTopUpNotice,
  type BalanceListener,
} from './hooks.ts';
export { getLiteLLMKey, ownKeyInUse } from './litellm.ts';
export { onboardBilling, offboardBilling } from './onboard.ts';
export { planHasWebSearch, planLimits, type PlanLimits, type PlanId } from './plans.ts';
export { redeemCoupon, type RedeemResult } from './coupons.ts';
export {
  reverseTurn,
  switchAiRouting,
  switchAiRoutingQuietly,
  syncUsageForUser,
  type SyncResult,
} from './usage.ts';
export { queueTurnRefund, type FailedTurn } from './jobs.ts';
export { queueTurnBilling, settleUnbilledTurns, type TurnToBill } from './turn-billing.ts';
export { canUseModel } from './models.ts';
export {
  balancesFor,
  creditsSince,
  getBalance,
  getBalanceAndGrants,
  listBalanceGrants,
  listLedger,
} from './credits.ts';
export { adjustCredits, setPlanByHand } from './admin.ts';
export { getCurrentSubscription, type Subscription } from './subscriptions.ts';
export { monthStart } from './free-credits.ts';
export { CHAT_COUPON_PATTERN, redeemFromChat } from './chat.ts';
