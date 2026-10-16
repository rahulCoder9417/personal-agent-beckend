// A read-only check of this server's Polar setup against our plans, run before taking real money
// (and after switching POLAR_SERVER). It only reads from Polar and never prints a secret.
import { config } from '../../shared/config.ts';
import { PLANS, TOP_UPS } from './plans.ts';
import { POLAR_API_VERSION, PolarHttpError, polarRequest } from './polar.ts';
import { POLAR_EVENT_ACTIONS } from './polar-events.ts';

export interface CheckLine {
  item: string;
  ok: boolean;
  detail: string;
}

type Get = (path: string) => Promise<unknown>;
type Obj = Record<string, unknown>;

/** The events our webhook endpoint must send: exactly the ones the worker acts on. */
export const REQUIRED_EVENTS = Object.keys(POLAR_EVENT_ACTIONS).sort();

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * The product's one live fixed price in US dollars. A product may also carry prices in other
 * currencies (Polar shows the buyer's own); our plans are in dollars, so the dollar one is checked.
 */
function fixedPrice(p: Obj): { amount: number; currency: string } | null {
  const prices = Array.isArray(p.prices) ? (p.prices as Obj[]) : [];
  const live = prices.filter((x) => isObj(x) && x.is_archived !== true);
  const usd = live.filter((x) => String(x.price_currency ?? '').toLowerCase() === 'usd');
  const pick = usd.length ? usd : live;
  if (pick.length !== 1) return null;
  const price = pick[0]!;
  if (price.amount_type !== 'fixed' || typeof price.price_amount !== 'number') return null;
  return { amount: price.price_amount, currency: String(price.price_currency ?? '').toLowerCase() };
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;

async function checkProduct(
  get: Get,
  item: string,
  id: string | undefined,
  want: { cents: number; monthly: boolean },
): Promise<CheckLine> {
  if (!id) return { item, ok: false, detail: 'product id not set' };
  let p: unknown;
  try {
    p = await get(`/v1/products/${encodeURIComponent(id)}`);
  } catch (err) {
    return { item, ok: false, detail: failure(err, 'product') };
  }
  if (!isObj(p)) return { item, ok: false, detail: 'unexpected answer' };
  const problems: string[] = [];
  if (p.is_archived === true) problems.push('archived');
  if (want.monthly && !(p.is_recurring === true && p.recurring_interval === 'month')) {
    problems.push('not a monthly subscription');
  }
  if (want.monthly && (p.recurring_interval_count ?? 1) !== 1) problems.push('not every 1 month');
  if (!want.monthly && p.is_recurring === true) problems.push('should be a one-time purchase');
  if (p.trial_interval) problems.push('has a free trial (checkouts switch it off, but remove it)');
  const price = fixedPrice(p);
  if (!price) problems.push('needs exactly one fixed price');
  else {
    if (price.amount !== want.cents) {
      problems.push(`price is ${dollars(price.amount)}, our plans say ${dollars(want.cents)}`);
    }
    if (price.currency !== 'usd') problems.push(`currency is ${price.currency}, expected usd`);
  }
  const name = typeof p.name === 'string' ? p.name : id;
  return problems.length
    ? { item, ok: false, detail: `${name}: ${problems.join('; ')}` }
    : {
        item,
        ok: true,
        detail: `${name}, ${dollars(want.cents)}${want.monthly ? ' a month' : ''}`,
      };
}

async function checkDiscount(get: Get, id: string | undefined): Promise<CheckLine> {
  const item = 'Waitlist discount';
  if (!id) return { item, ok: true, detail: 'not set (the waitlist offer is off)' };
  let d: unknown;
  try {
    d = await get(`/v1/discounts/${encodeURIComponent(id)}`);
  } catch (err) {
    return { item, ok: false, detail: failure(err, 'discount') };
  }
  if (!isObj(d)) return { item, ok: false, detail: 'unexpected answer' };
  const problems: string[] = [];
  if (d.type !== 'percentage' || d.basis_points !== 5000) problems.push('should be 50% off');
  if (d.duration !== 'once') problems.push('should apply once (the first month only)');
  if (d.code) problems.push('has a code anyone could type; leave the code empty');
  const products = Array.isArray(d.products) ? (d.products as Obj[]).map((x) => x.id) : [];
  const c = config();
  const plans = [c.POLAR_PRODUCT_PRO, c.POLAR_PRODUCT_MAX].filter(Boolean);
  if (products.length && plans.some((p) => !products.includes(p))) {
    problems.push('should cover the Pro and Max products');
  }
  if (products.includes(c.POLAR_PRODUCT_TOPUP_10)) problems.push('should not cover the top-up');
  return problems.length
    ? { item, ok: false, detail: problems.join('; ') }
    : { item, ok: true, detail: '50% off the first month of Pro or Max' };
}

async function checkWebhook(get: Get): Promise<CheckLine> {
  const item = 'Webhook endpoint';
  const url = `${config().PUBLIC_API_URL.replace(/\/$/, '')}/webhooks/polar`;
  if (!config().POLAR_WEBHOOK_SECRET) {
    return { item, ok: false, detail: 'POLAR_WEBHOOK_SECRET not set: every webhook is refused' };
  }
  let out: unknown;
  try {
    out = await get('/v1/webhooks/endpoints?limit=100');
  } catch (err) {
    return { item, ok: false, detail: failure(err, 'webhook list') };
  }
  const items = isObj(out) && Array.isArray(out.items) ? (out.items as Obj[]) : [];
  const ours = items.filter((e) => e.url === url);
  if (!ours.length) return { item, ok: false, detail: `no endpoint for ${url}` };
  const e = ours[0]!;
  const problems: string[] = [];
  if (ours.length > 1) problems.push(`${ours.length} endpoints for the same address`);
  if (e.enabled === false) problems.push('switched off');
  if (e.format !== 'raw') problems.push(`format is ${String(e.format)}, should be raw`);
  if (e.api_version && e.api_version !== POLAR_API_VERSION) {
    problems.push(`API version ${String(e.api_version)}, should be ${POLAR_API_VERSION}`);
  }
  const events = Array.isArray(e.events) ? (e.events as string[]) : [];
  const missing = REQUIRED_EVENTS.filter((x) => !events.includes(x));
  if (missing.length) problems.push(`missing events: ${missing.join(', ')}`);
  return problems.length
    ? { item, ok: false, detail: problems.join('; ') }
    : { item, ok: true, detail: `${url}, ${REQUIRED_EVENTS.length} events` };
}

function failure(err: unknown, what: string): string {
  if (err instanceof PolarHttpError) {
    if (err.status === 401) return 'the token is refused (wrong server, or revoked)';
    if (err.status === 403) return `the token may not read the ${what} (add the scope)`;
    if (err.status === 404) return `${what} not found on this Polar server`;
    return `Polar answered ${err.status}`;
  }
  return `Polar could not be reached (${(err as Error).message.slice(0, 80)})`;
}

/** Every line of the check. `get` is Polar's API (a fake in tests). */
export async function checkPolarSetup(
  get: Get = (path) => polarRequest('GET', path),
): Promise<CheckLine[]> {
  const c = config();
  const lines: CheckLine[] = [
    { item: 'Server', ok: true, detail: `${c.POLAR_SERVER}, API version ${POLAR_API_VERSION}` },
  ];
  if (!c.POLAR_ACCESS_TOKEN) {
    lines.push({ item: 'Access token', ok: false, detail: 'POLAR_ACCESS_TOKEN not set' });
    return lines;
  }
  const topUp = TOP_UPS.find((t) => t.id === 'topup_10')!;
  lines.push(
    await checkProduct(get, 'Pro product', c.POLAR_PRODUCT_PRO, {
      cents: PLANS.pro.priceCents,
      monthly: true,
    }),
    await checkProduct(get, 'Max product', c.POLAR_PRODUCT_MAX, {
      cents: PLANS.max.priceCents,
      monthly: true,
    }),
    await checkProduct(get, 'Top-up product', c.POLAR_PRODUCT_TOPUP_10, {
      cents: topUp.priceCents,
      monthly: false,
    }),
    await checkDiscount(get, c.POLAR_WAITLIST_DISCOUNT_ID),
    await checkWebhook(get),
  );
  return lines;
}
