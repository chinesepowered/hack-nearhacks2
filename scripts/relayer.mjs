// Watches the contract for jokes waiting for a verdict and delivers the judge's signed answers.
// Anyone can run one. It earns the relayer tip for each delivered verdict.
//
//   NEAR_AI_API_KEY=... node scripts/relayer.mjs --name arf-pup
import { join } from 'node:path';
import { ROOT, loadKey, near, readJson } from './lib/testnet.mjs';
import { judgeJoke } from './lib/judge.mjs';

const i = process.argv.indexOf('--name');
const d = readJson(join(ROOT, 'deployments', (i > 0 ? process.argv[i + 1] : 'arf-pup') + '.json'));
if (!d) throw new Error('unknown deployment; pass --name <deployment>');
const relayerKey = loadKey(d.relayer);
if (!relayerKey) throw new Error(`no key for ${d.relayer} in ./keys`);
console.log(`relaying verdicts for ${d.contract} as ${d.relayer}`);
const failed = new Map();
for (;;) {
  try {
    for (const id of await near.view(d.contract, 'get_pending_jokes', { limit: 10 })) {
      if ((failed.get(id) || 0) >= 3) continue;
      try {
        const { joke, txHash } = await judgeJoke(near, d.contract, d.relayer, relayerKey, id);
        console.log(`#${id} scored ${joke.score}/10 "${joke.quip}" -> ${joke.author} (${txHash})`);
      } catch (e) {
        failed.set(id, (failed.get(id) || 0) + 1);
        console.log(`#${id} failed: ${e.message}`);
      }
    }
  } catch (e) {
    console.log('poll failed:', e.message);
  }
  await new Promise((r) => setTimeout(r, Number(process.env.POLL_MS || 800)));
}
