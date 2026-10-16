import {
  cancelSubscription,
  resumeSubscription,
  startCheckout,
} from '../../modules/billing/polar.ts';
import { getAutoTopUp, setAutoTopUp } from '../../modules/billing/auto-topup.ts';
import { PLAN_IDS, PLANS, TOP_UPS } from '../../modules/billing/plans.ts';
import { getCurrentSubscription } from '../../modules/billing/subscriptions.ts';
import { toPlan, toSubscription } from '../billing-presenters.ts';
import { route } from '../router.ts';

export const billingRoutes = [
  route('listPlans', (c) =>
    c.json(
      { plans: PLAN_IDS.map((id) => toPlan(PLANS[id])), topUps: TOP_UPS.map((t) => ({ ...t })) },
      200,
    ),
  ),

  route('getSubscription', async (c) => {
    const user = c.get('user');
    return c.json(toSubscription(user.plan, await getCurrentSubscription(user.id)), 200);
  }),

  // Returns a hosted checkout URL; plan/credits change only when Polar's webhook arrives.
  route('createCheckout', async (c, { body }) => {
    const { checkoutUrl, discountApplied } = await startCheckout(
      c.get('user'),
      body.kind === 'plan'
        ? { kind: 'plan', planId: body.planId }
        : { kind: 'topup', topUpId: body.topUpId },
    );
    return c.json({ checkoutUrl, discountApplied }, 200);
  }),

  route('cancelSubscription', async (c) => {
    const user = c.get('user');
    return c.json(toSubscription(user.plan, await cancelSubscription(user.id)), 200);
  }),

  // Undo a cancel before the period ends; credits and the plan still follow Polar's events.
  route('resumeSubscription', async (c) => {
    const user = c.get('user');
    return c.json(toSubscription(user.plan, await resumeSubscription(user.id)), 200);
  }),

  // Auto top-up (behind AUTO_TOPUP_ENABLED): the settings, this month's top-ups, the last try.
  route('getAutoTopUp', async (c) => c.json(await getAutoTopUp(c.get('user').id), 200)),

  route('setAutoTopUp', async (c, { body }) =>
    c.json(
      await setAutoTopUp(c.get('user'), {
        enabled: body.enabled,
        ...(body.thresholdCredits !== undefined ? { thresholdCredits: body.thresholdCredits } : {}),
        ...(body.topUpId !== undefined ? { topUpId: body.topUpId } : {}),
        ...(body.monthlyCap !== undefined ? { monthlyCap: body.monthlyCap } : {}),
        ...(body.consent !== undefined ? { consent: body.consent } : {}),
      }),
      200,
    ),
  ),
];
