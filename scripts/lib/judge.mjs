// The relayer's whole job: carry bytes between the contract and NEAR AI Cloud without touching them.
// It cannot change a verdict: the contract rebuilds the request itself and checks the signature.
import { existsSync, readFileSync } from 'node:fs';
import { TGAS, b64encode, unhex, utf8 } from '../../web/near-lite.js';

const API = 'https://cloud-api.near.ai/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function apiKey() {
  if (process.env.NEAR_AI_API_KEY) return process.env.NEAR_AI_API_KEY.trim();
  const file = process.env.NEAR_AI_API_KEY_FILE;
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim();
  throw new Error('set NEAR_AI_API_KEY (or NEAR_AI_API_KEY_FILE) to a NEAR AI Cloud key: https://cloud.near.ai');
}

/** Asks the judge about one request body. Returns the raw response bytes and the TEE signature. */
export async function askJudge(requestBody, key = apiKey()) {
  const headers = { authorization: 'Bearer ' + key, 'content-type': 'application/json', 'x-no-aliasing': 'true', 'accept-encoding': 'identity' };
  const res = await fetch(API + '/chat/completions', { method: 'POST', headers, body: utf8(requestBody), signal: AbortSignal.timeout(90_000) });
  const response = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${new TextDecoder().decode(response).slice(0, 200)}`);
  const id = JSON.parse(new TextDecoder().decode(response)).id;
  for (let attempt = 0; attempt < 15; attempt++) {
    const r = await fetch(`${API}/signature/${encodeURIComponent(id)}?signing_algo=ed25519`, { headers: { authorization: 'Bearer ' + key, accept: 'application/json' } });
    if (r.ok) {
      const sig = await r.json();
      if (sig.text && sig.signature) return { response, signature: sig };
    }
    await sleep(1000);
  }
  throw new Error('the judge answered but no signature became available for ' + id);
}

/** Fetches the canonical request for a joke, asks the judge, and delivers the signed verdict. */
export async function judgeJoke(near, contractId, relayerId, relayerKey, jokeId, key = apiKey()) {
  const request = await near.view(contractId, 'judge_request', { joke_id: jokeId });
  const { response, signature } = await askJudge(request, key);
  const keys = await near.view(contractId, 'get_judge_keys');
  const signer = signature.signing_address.replace(/^0x/, '').toLowerCase();
  const keyIndex = keys.findIndex((k) => !k.disabled && k.algo === 'Ed25519' && k.key.replace(/^0x/, '').toLowerCase() === signer);
  if (keyIndex < 0) throw new Error(`the judge signed with ${signer}, which is not a registered judge key (did the model's TEE key rotate?)`);
  const out = await near.call(relayerId, relayerKey, contractId, 'judge', { joke_id: jokeId, response: b64encode(response), signature: b64encode(unhex(signature.signature)), key_index: keyIndex }, { gas: 60n * TGAS });
  return { joke: out.value, txHash: out.txHash, signature };
}
