// Replaces the code of a deployed game with the current build. State is kept as it is, so this
// is only for changes that do not alter the stored layout. It needs the contract account's key,
// which the deployer still holds during the hackathon (see README, "What is not finished").
//
//   npm run build:contract && node scripts/upgrade.mjs --name arf-pup
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { actions } from '../web/near-lite.js';
import { ROOT, loadKey, near, readJson } from './lib/testnet.mjs';

const i = process.argv.indexOf('--name');
const d = readJson(join(ROOT, 'deployments', (i > 0 ? process.argv[i + 1] : '') + '.json'));
if (!d) throw new Error('usage: node scripts/upgrade.mjs --name <deployment>');
const key = loadKey(d.contract);
if (!key) throw new Error(`no key for ${d.contract} in ./keys`);
const wasm = readFileSync(join(ROOT, 'contract/target/wasm32-unknown-unknown/release/arf.wasm'));
const r = await near.send(d.contract, key, d.contract, [actions.deployContract(wasm)]);
const s = await near.view(d.contract, 'get_state');
console.log(`${d.contract}: deployed ${wasm.length} bytes (tx ${r.txHash}); state intact: pup #${s.generation}, ${s.jokes} jokes`);
