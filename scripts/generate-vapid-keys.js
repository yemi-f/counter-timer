// Generates a VAPID key pair and writes it to .dev.vars for `wrangler dev`,
// keeping any other lines (e.g. VAPID_SUBJECT). For production, copy the same
// values into secrets:
//   npx wrangler secret put VAPID_PUBLIC_KEY
//   npx wrangler secret put VAPID_PRIVATE_JWK
//   npx wrangler secret put VAPID_SUBJECT
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../.dev.vars', import.meta.url);
if (existsSync(file) && !process.argv.includes('--force')) {
  console.error('.dev.vars already exists; pass --force to overwrite (this invalidates existing subscriptions).');
  process.exit(1);
}

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
const jwk = await crypto.subtle.exportKey('jwk', privateKey);

const kept = existsSync(file)
  ? readFileSync(file, 'utf8').split('\n')
      .filter((line) => line && !/^VAPID_(PUBLIC_KEY|PRIVATE_JWK)=/.test(line))
  : [];
if (!kept.some((line) => line.startsWith('VAPID_SUBJECT='))) {
  kept.push('VAPID_SUBJECT=mailto:you@example.com');
  console.log('Set VAPID_SUBJECT in .dev.vars to your own mailto: address.');
}

writeFileSync(file, [
  `VAPID_PUBLIC_KEY=${Buffer.from(raw).toString('base64url')}`,
  `VAPID_PRIVATE_JWK='${JSON.stringify(jwk)}'`,
  ...kept,
  '',
].join('\n'));
console.log('Wrote .dev.vars');
