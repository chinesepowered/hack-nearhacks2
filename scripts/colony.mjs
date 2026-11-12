// Colony chores that anyone may do: seat the top carers as the DAO council and send the
// collected fees to the DAO treasury. Uses the operator key if present, otherwise a fresh guest.
//
//   node scripts/colony.mjs --name arf-pup
import { join } from 'node:path';
import { KeyPair, TGAS, formatNear } from '../web/near-lite.js';
import { ROOT, loadKey, near, readJson } from './lib/testnet.mjs';

const i = process.argv.indexOf('--name');
const d = readJson(join(ROOT, 'deployments', (i > 0 ? process.argv[i + 1] : 'arf-pup') + '.json'));
if (!d) throw new Error('unknown deployment; pass --name <deployment>');
const C = d.contract;

let id = d.operator;
let key = loadKey(d.operator);
if (!key) {
  key = KeyPair.random();
  ({ value: id } = await near.call(C, KeyPair.fromString(d.doorman_key), C, 'welcome_guest', { public_key: key.publicKeyString }, { gas: 40n * TGAS }));
  for (let n = 0; n < 20 && !(await near.account(id)); n++) await new Promise((r) => setTimeout(r, 500));
}

const councilOf = async () => (await near.view(d.colony_dao, 'get_policy')).roles.find((r) => r.name === 'council').kind.Group;
console.log('council before:', (await councilOf()).join(', '));
try {
  const r = await near.call(id, key, C, 'rotate_council', {}, { gas: 220n * TGAS });
  console.log(r.value ? `council seated (tx ${r.txHash})` : 'the DAO refused the new council');
} catch (e) {
  console.log('not rotated:', e.message);
}
console.log('council now:   ', (await councilOf()).join(', '));
try {
  const f = await near.call(id, key, C, 'flush_treasury', {}, { gas: 30n * TGAS });
  console.log(`fees sent to the treasury (tx ${f.txHash})`);
} catch (e) {
  console.log('no fees sent:', e.message);
}
console.log(`treasury ${d.colony_dao}: ${formatNear((await near.account(d.colony_dao)).amount)} NEAR`);
