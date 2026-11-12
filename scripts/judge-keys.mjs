// Reads the judge model's signing keys from NEAR AI Cloud's public attestation report
// (no API key needed) and records them in fixtures/judge-keys.json, which deploy.mjs registers
// in the contract. The full report (Intel TDX quote, NVIDIA evidence, event log) is saved next to
// it so that anyone can check with NEAR AI's verifier that these keys live inside the TEE:
// https://docs.near.ai/cloud/verification/cloud-api/model-attestations
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, readJson } from './lib/testnet.mjs';
import { JUDGE } from './presets.mjs';

const nonce = randomBytes(32).toString('hex');
const keys = [];
for (const algo of ['ed25519', 'ecdsa']) {
  const q = new URLSearchParams({ model: JUDGE.model, provider: 'near', include_tls_fingerprint: 'false', signing_algo: algo, nonce });
  const res = await fetch('https://cloud-api.near.ai/v1/attestation/report?' + q, { headers: { accept: 'application/json', 'x-no-aliasing': 'true' } });
  if (!res.ok) throw new Error(`attestation report for ${algo}: HTTP ${res.status}`);
  const text = await res.text();
  const reports = JSON.parse(text).model_attestations || [];
  if (reports.length !== 1) throw new Error(`expected one model report for ${algo}, got ${reports.length}`);
  const r = reports[0];
  if (r.request_nonce !== nonce) throw new Error('the report does not echo our nonce');
  keys.push({
    algo: algo === 'ed25519' ? 'Ed25519' : 'Ecdsa',
    kind: 'ProviderTee',
    key: r.signing_address.replace(/^0x/, ''),
    label: `NEAR AI Cloud TEE signing key of ${JUDGE.model} (${algo}), from /v1/attestation/report on ${new Date().toISOString().slice(0, 10)}`,
    disabled: false,
  });
  if (algo === 'ed25519') {
    const dir = join(ROOT, 'fixtures/attestation');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, JUDGE.model.replace(/[^a-z0-9.-]+/gi, '_') + '.ed25519.json'), text);
  }
}
const file = join(ROOT, 'fixtures/judge-keys.json');
const all = readJson(file, {});
all[JUDGE.model] = keys;
writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
console.log(JSON.stringify(keys, null, 2));
