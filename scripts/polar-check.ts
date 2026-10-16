// Checks this server's Polar setup before real money: the token works on POLAR_SERVER, the three
// products match our prices, the waitlist discount is right, and the webhook endpoint points here
// with every event the worker needs. Only reads from Polar; prints no secret.
// Run inside the api container:  node --import tsx scripts/polar-check.ts
// Exit code 0 when every line is OK, 1 otherwise.
import { checkPolarSetup } from '../src/modules/billing/polar-check.ts';

const lines = await checkPolarSetup();
const width = Math.max(...lines.map((l) => l.item.length));
for (const l of lines)
  console.log(`${l.ok ? 'OK  ' : 'FAIL'}  ${l.item.padEnd(width)}  ${l.detail}`);
const failed = lines.filter((l) => !l.ok).length;
console.log(failed ? `\n${failed} to fix before taking payments.` : '\nPolar is ready.');
process.exit(failed ? 1 : 0);
