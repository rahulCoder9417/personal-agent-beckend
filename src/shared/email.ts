// One inbox, one name: the waitlist and the sign-up credits compare emails in this form, so the
// spellings of one inbox count as one.

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Lower case, and the +tag dropped from the name on every domain. For Gmail also the dots in the
 * name, and googlemail.com is gmail.com. `A.B+x@GoogleMail.com` → `ab@gmail.com`;
 * `ann+news@example.com` → `ann@example.com`. Text without an `@` is only lower-cased.
 */
export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  local = local.split('+')[0]!;
  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com';
    local = local.replace(/\./g, '');
  }
  return `${local}@${domain}`;
}
