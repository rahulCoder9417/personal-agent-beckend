// Payments are on the website only (HLD 7.6). Telegram requires Telegram Stars for digital goods
// sold inside the app, so the Telegram bot never sends a purchase link: a message that would
// carry one names the web app instead. Other channels keep their links.
import { config } from '../../shared/config.ts';
import type { Channel } from './types.ts';

/** How a message names the web app when it may not link to it. */
export const WEB_APP_NAME = 'the Textcrew web app';

/** May a message on this channel link to a page where something is bought? */
export function purchaseLinksAllowed(channel: Channel): boolean {
  return channel !== 'telegram';
}

/** Web app pages where a plan or credits are bought. */
const PURCHASE_PATH = /^\/(billing|pricing|checkout|upgrade|plans?|top-?ups?|subscribe)(\/|$)/i;
const LINK = /https?:\/\/[^\s<>"'`]+/gi;
/** Punctuation that ends a sentence rather than a link. */
const TRAILING = /[.,;:!?)\]}]+$/;

/** A Polar URL (checkout, customer portal), or a buying page of our web app. */
export function isPurchaseLink(link: string): boolean {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host === 'polar.sh' || host.endsWith('.polar.sh')) return true;
  const web = new URL(config().WEB_APP_URL).hostname.toLowerCase();
  return host === web && PURCHASE_PATH.test(url.pathname);
}

/** Replaces every purchase link in a text with the web app's name. Other links are kept. */
export function withoutPurchaseLinks(text: string): string {
  return text.replace(LINK, (match) => {
    const tail = TRAILING.exec(match)?.[0] ?? '';
    const link = tail ? match.slice(0, -tail.length) : match;
    return isPurchaseLink(link) ? `${WEB_APP_NAME}${tail}` : match;
  });
}
