// Re-checks a judged joke from chain data alone. No keys, no NEAR AI Cloud account.
//
//   node scripts/verify-verdict.mjs --name arf-pup --joke 0
//
// It asks the contract for the request it built for that joke, hashes it, and checks the stored
// signature over `<model>:<sha256(request)>:<sha256(response)>` against the registered judge key.
import { join } from 'node:path';
import { b64decode, hex, sha256, unhex, utf8, verifyEd25519 } from '../web/near-lite.js';
import { ROOT, near, readJson } from './lib/testnet.mjs';

const arg = (n, f) => (process.argv.indexOf('--' + n) > 0 ? process.argv[process.argv.indexOf('--' + n) + 1] : f);
const d = readJson(join(ROOT, 'deployments', arg('name', 'arf-pup') + '.json'));
if (!d) throw new Error('unknown deployment; pass --name <deployment>');
const id = Number(arg('joke', '0'));

const [cfg, keys, joke] = await Promise.all([near.view(d.contract, 'get_config'), near.view(d.contract, 'get_judge_keys'), near.view(d.contract, 'get_joke', { joke_id: id })]);
if (!joke) throw new Error(`joke #${id} does not exist on ${d.contract}`);
if (joke.status !== 'Judged') throw new Error(`joke #${id} is ${joke.status}, there is no verdict to check`);
const request = await near.view(d.contract, 'judge_request', { joke_id: id });
const body = JSON.parse(request);
const key = keys[joke.key_index];
const text = `${cfg.model}:${hex(sha256(utf8(request)))}:${joke.response_hash}`;

const checks = [
  ['request uses the configured model', body.model === cfg.model],
  ['request carries the configured rubric', body.messages[0].content === cfg.rubric],
  ['request contains exactly this joke', body.messages[1].content.endsWith('Joke: ' + joke.text)],
  ['judge key is registered and enabled', !!key && !key.disabled],
  [`signature is valid (${key?.algo})`, key?.algo === 'Ed25519' ? verifyEd25519(b64decode(joke.signature), utf8(text), unhex(key.key)) : null],
];
console.log(`joke #${id} on ${d.contract} by ${joke.author}: "${joke.text}"`);
console.log(`verdict: ${joke.score}/10 "${joke.quip}", reward ${BigInt(joke.reward) / 10n ** 18n} ARF, delivered by ${joke.relayer}`);
console.log(`signed text: ${text}`);
console.log(`judge key:   ${key?.key} (${key?.label})`);
let ok = true;
for (const [what, pass] of checks) {
  console.log(`  ${pass === null ? 'SKIP' : pass ? 'PASS' : 'FAIL'}  ${what}${pass === null ? ' (this script only checks ed25519; the contract checked it on-chain)' : ''}`);
  if (pass === false) ok = false;
}
process.exit(ok ? 0 : 1);
