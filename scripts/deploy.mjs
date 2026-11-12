// Deploys a complete Arf game to NEAR testnet from nothing:
//   1. an operator account (faucet funded)        <name>-ops.testnet
//   2. the colony DAO (Sputnik DAO v3 factory)    <name>-colony.sputnikv2.testnet
//   3. the contract, initialised in the same tx    <name>.testnet
//   4. a public "doorman" key that can only call welcome_guest (lets visitors play without a wallet)
//   5. a relayer account for delivering verdicts   <name>-relayer.testnet
//
// Usage: node scripts/deploy.mjs --name arf-pup --preset live
// Keys are written to ./keys (git-ignored). Public details go to ./deployments/<name>.json.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KeyPair, TGAS, actions, b64encode, formatNear, parseNear, utf8 } from '../web/near-lite.js';
import { ROOT, RPC_URL, ensureFaucetAccount, loadKey, near, saveKey } from './lib/testnet.mjs';
import { JUDGE, PRESETS } from './presets.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const name = arg('name');
const preset = arg('preset', 'live');
const extraFaucets = Number(arg('fund', '2'));
if (!name || !PRESETS[preset]) {
  console.error('usage: node scripts/deploy.mjs --name <account prefix> --preset live|demo [--fund <faucet accounts>]');
  process.exit(1);
}

const FACTORY = 'sputnikv2.testnet';
const ops = `${name}-ops.testnet`;
const contractId = `${name}.testnet`;
const relayerId = `${name}-relayer.testnet`;
const daoName = `${name}-colony`;
const daoId = `${daoName}.${FACTORY}`;
const log = (...a) => console.log('·', ...a);

// 1. operator, topped up from a few throwaway faucet accounts
const opsKey = await ensureFaucetAccount(ops);
for (let i = 1; i <= extraFaucets; i++) {
  const donor = `${name}-fund${i}.testnet`;
  if (loadKey(donor) && !(await near.account(donor))) continue; // spent and deleted
  const donorKey = await ensureFaucetAccount(donor);
  const spare = BigInt((await near.account(donor)).amount) - parseNear('0.05');
  if (spare > 0n) {
    await near.send(donor, donorKey, ops, [actions.transfer(spare)]);
    log(`funded ${ops} from ${donor}`);
  }
}
log(`${ops} has ${formatNear((await near.account(ops)).amount)} NEAR`);

// 2. the colony DAO. Its council starts as the operator and is replaced by `rotate_council`.
//    The contract gets a `pup` role that can do exactly one thing: replace the council role.
if (!(await near.account(daoId))) {
  const councilPermissions = ['transfer:*', 'call:*', 'vote:*', 'add_bounty:*', 'bounty_done:*'];
  const daoArgs = {
    config: {
      name: daoName,
      purpose: 'Treasury of the Arf seal colony. Holds the fish and joke fees. Its council is the pup\'s best carers, seated by the Arf contract.',
      metadata: '',
    },
    policy: {
      roles: [
        { name: 'council', kind: { Group: [ops] }, permissions: councilPermissions, vote_policy: {} },
        {
          name: 'pup',
          kind: { Group: [contractId] },
          permissions: ['policy_add_or_update_role:AddProposal', 'policy_add_or_update_role:VoteApprove'],
          vote_policy: {},
        },
      ],
      default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] },
      proposal_bond: '0',
      proposal_period: '604800000000000',
      bounty_bond: '100000000000000000000000',
      bounty_forgiveness_period: '86400000000000',
    },
  };
  await near.call(ops, opsKey, FACTORY, 'create', { name: daoName, args: b64encode(utf8(JSON.stringify(daoArgs))) }, { gas: 280n * TGAS, deposit: parseNear(arg('dao-deposit', '6')) });
  if (!(await near.account(daoId))) throw new Error('the DAO factory did not create ' + daoId);
  log(`created DAO ${daoId}`);
} else log(`DAO ${daoId} already exists`);

// 3. the contract: faucet account, extra NEAR for storage and the guest budget, deploy + init
const contractKey = await ensureFaucetAccount(contractId);
const wasm = readFileSync(join(ROOT, 'contract/target/wasm32-unknown-unknown/release/arf.wasm'));
let deployed = false;
try {
  await near.view(contractId, 'get_treasury');
  deployed = true;
} catch {}
if (!deployed) {
  const spare = BigInt((await near.account(ops)).amount) - parseNear('1.5');
  if (spare > 0n) await near.send(ops, opsKey, contractId, [actions.transfer(spare)]);
  const judgeKeys = JSON.parse(readFileSync(join(ROOT, 'fixtures/judge-keys.json'), 'utf8'))[JUDGE.model];
  if (!judgeKeys) throw new Error('no judge keys recorded for ' + JUDGE.model + ' in fixtures/judge-keys.json');
  await near.send(contractId, contractKey, contractId, [
    actions.deployContract(wasm),
    actions.functionCall('new', { config: PRESETS[preset], treasury: daoId, judge_keys: judgeKeys }, { gas: 100n * TGAS }),
  ]);
  log(`deployed ${wasm.length} bytes to ${contractId} (${preset} preset)`);
} else log(`${contractId} is already deployed`);

// 4. the doorman: a function-call key on the contract's own account, limited to welcome_guest
let doorman = loadKey(contractId + '.doorman');
if (!doorman) {
  doorman = KeyPair.random();
  await near.send(contractId, contractKey, contractId, [
    actions.addFunctionCallKey(doorman.publicKeyString, contractId, ['welcome_guest'], parseNear('5')),
  ]);
  saveKey(contractId + '.doorman', doorman);
  log('added the doorman key (welcome_guest only)');
}

// 5. relayer
await ensureFaucetAccount(relayerId);

const deployment = {
  network: 'testnet',
  preset,
  contract: contractId,
  colony_dao: daoId,
  relayer: relayerId,
  operator: ops,
  rpc: RPC_URL,
  explorer: 'https://testnet.nearblocks.io',
  judge_model: JUDGE.model,
  // Public by design: this key can only call `welcome_guest` on the contract.
  doorman_key: doorman.toString(),
  deployed_at: new Date().toISOString(),
};
mkdirSync(join(ROOT, 'deployments'), { recursive: true });
writeFileSync(join(ROOT, 'deployments', name + '.json'), JSON.stringify(deployment, null, 2) + '\n');
log(`${contractId} holds ${formatNear((await near.account(contractId)).amount)} NEAR`);
console.log(JSON.stringify({ ...deployment, doorman_key: '(see deployments file)' }, null, 2));
