// Copies the master spec to the web app's gitignored folder (HLD 1.3). The web app lives in
// ../user-frontend-web (it was ../user-frontend). Its tracked copy, openapi/openapi.yaml, is
// updated by the web app's own `pnpm openapi:sync`.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'openapi/openapi.yaml');
const destDir = resolve(root, '../user-frontend-web/ignore');
mkdirSync(destDir, { recursive: true });
copyFileSync(src, resolve(destDir, 'openapi.yaml'));
console.log(`copied ${src} -> ${destDir}/openapi.yaml`);
