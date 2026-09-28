// Dodo fakes for Phase 5 tests: a fake API client and Standard Webhooks signing.
import { randomUUID } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { setDodoClient, type DodoClient } from '../src/modules/billing/dodo.ts';
import { DODO_SECRET } from './billing-fakes.ts';

// --- Dodo -------------------------------------------------------------------------------------

export class FakeDodo implements DodoClient {
  checkouts: Array<Parameters<DodoClient['createCheckoutSession']>[0]> = [];
  cancelled: string[] = [];
  async createCheckoutSession(input: Parameters<DodoClient['createCheckoutSession']>[0]) {
    this.checkouts.push(input);
    const sessionId = `cks_${this.checkouts.length}`;
    return {
      sessionId,
      checkoutUrl: `https://test.checkout.dodopayments.com/session/${sessionId}`,
    };
  }
  async cancelAtPeriodEnd(subscriptionId: string) {
    this.cancelled.push(subscriptionId);
  }
}

export function signDodo(payload: unknown, msgId = `msg_${randomUUID()}`) {
  const body = JSON.stringify(payload);
  const ts = new Date();
  return {
    body,
    headers: {
      'webhook-id': msgId,
      'webhook-timestamp': String(Math.floor(ts.getTime() / 1000)),
      'webhook-signature': new Webhook(DODO_SECRET).sign(msgId, ts, body),
      'content-type': 'application/json',
    },
  };
}

export function installDodo(): FakeDodo {
  const fake = new FakeDodo();
  setDodoClient(fake);
  return fake;
}
