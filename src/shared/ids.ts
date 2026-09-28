import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * Time-sortable string id: `<prefix>_<10 chars time><16 chars random>`.
 * Newest-first cursor pagination orders by id.
 */
export function newId(prefix: string, now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (const b of bytes) rand += CROCKFORD[b % 32];
  return `${prefix}_${time}${rand}`;
}
