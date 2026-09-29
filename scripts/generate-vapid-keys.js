// Generates a VAPID key pair and writes it to .dev.vars for `wrangler dev`.
// For production, copy the same values into secrets:
//   npx wrangler secret put VAPID_PUBLIC_KEY
//   npx wrangler secret put VAPID_PRIVATE_JWK
import { existsSync, writeFileSync } from 'node:fs';

const file = new URL('../.dev.vars', import.meta.url);
if (existsSync(file) && !process.argv.includes('--force')) {
  console.error('.dev.vars already exists; pass --force to overwrite (this invalidates existing subscriptions).');
  process.exit(1);
}

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
const jwk = await crypto.subtle.exportKey('jwk', privateKey);

writeFileSync(file, [
  `VAPID_PUBLIC_KEY=${Buffer.from(raw).toString('base64url')}`,
  `VAPID_PRIVATE_JWK='${JSON.stringify(jwk)}'`,
  '',
].join('\n'));
console.log('Wrote .dev.vars');
