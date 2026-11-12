// End-to-end check against a deployed game on NEAR testnet. Needs no wallet and no funds:
// it becomes a guest through the public doorman key, exactly like a visitor of the page.
//
//   node scripts/e2e.mjs --name arf-pup            feeds the pup as a fresh guest
//   NEAR_AI_API_KEY=... node scripts/e2e.mjs --name arf-pup --joke "..."   also tells and judges a joke
import { join } from 'node:path';
import { KeyPair, TGAS, formatArf, formatNear } from '../web/near-lite.js';
import { ROOT, loadKey, near, readJson, saveKey } from './lib/testnet.mjs';
import { judgeJoke } from './lib/judge.mjs';

const arg = (n, f) => (process.argv.indexOf('--' + n) > 0 ? process.argv[process.argv.indexOf('--' + n) + 1] : f);
const d = readJson(join(ROOT, 'deployments', arg('name', 'arf-pup') + '.json'));
if (!d) throw new Error('unknown deployment; pass --name <deployment>');
const C = d.contract;
const say = (...a) => console.log(...a);
const pct = (bps) => (bps / 100).toFixed(1) + '%';

let s = await near.view(C, 'get_state');
const cfg = await near.view(C, 'get_config');
say(`contract ${C}: pup #${s.generation} ${s.present ? `on the ice, belly ${pct(s.fullness_bps)}, mood ${pct(s.mood_bps)}` : 'not on the ice'}; pantry ${formatArf(s.pantry)} ARF`);

// 1. become a guest
const doorman = KeyPair.fromString(d.doorman_key);
const me = KeyPair.random();
const { value: guestId } = await near.call(C, doorman, C, 'welcome_guest', { public_key: me.publicKeyString }, { gas: 40n * TGAS });
for (let i = 0; i < 20 && !(await near.account(guestId)); i++) await new Promise((r) => setTimeout(r, 500));
saveKey(guestId, me); // kept in ./keys so the guest can come back (it may end up on the council)
say(`guest account ${guestId} with ${formatNear((await near.account(guestId)).amount)} NEAR`);

// 2. feed (if he is too full, say so instead of failing)
if (s.present && 10_000 - s.fullness_bps < cfg.min_hunger / 100_000) say('he is full right now; skipping the fish');
else {
  const fed = await near.call(guestId, me, C, 'feed', {}, { gas: 30n * TGAS, deposit: BigInt(cfg.fish_price) });
  say(`fed a fish: earned ${formatArf(fed.value)} ARF (tx ${fed.txHash})`);
}
say(`ARF balance: ${formatArf(await near.view(C, 'ft_balance_of', { account_id: guestId }))}`);

// 3. optionally tell a joke and deliver the judge's verdict
const joke = arg('joke');
if (joke) {
  const told = await near.call(guestId, me, C, 'tell_joke', { text: joke }, { gas: 30n * TGAS, deposit: BigInt(cfg.joke_fee) });
  say(`told joke #${told.value}`);
  const relayerKey = loadKey(d.relayer);
  const { joke: j, txHash, signature } = await judgeJoke(near, C, relayerKey ? d.relayer : guestId, relayerKey || me, told.value);
  say(`judge: ${j.score}/10 "${j.quip}" reward ${formatArf(j.reward.toString())} ARF (tx ${txHash})`);
  say(`signed by ${signature.signing_address} (${signature.signature_kind})`);
}

s = await near.view(C, 'get_state');
say(`now: pup #${s.generation}, belly ${pct(s.fullness_bps)}, mood ${pct(s.mood_bps)}, ${s.feeds} feeds, ${s.laughs} laughs, ${s.carers} carers; treasury owed ${formatNear(s.treasury_accrued)} NEAR`);
say('top carers:', (await near.view(C, 'get_top')).map((t) => `${t.account_id}=${t.points}`).join(', '));
