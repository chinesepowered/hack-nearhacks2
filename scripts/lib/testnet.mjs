// Testnet plumbing shared by the scripts: RPC client, local key files, faucet-funded accounts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyPair, Near } from '../../web/near-lite.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RPC_URL = process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com';
export const HELPER_URL = process.env.NEAR_HELPER_URL || 'https://helper.testnet.near.org';
export const KEYS_DIR = process.env.ARF_KEYS_DIR || join(ROOT, 'keys');
export const near = new Near(RPC_URL);

/** Keys live in ./keys (git-ignored). They are testnet-only and worthless, but still never committed. */
export function loadKey(accountId) {
  const file = join(KEYS_DIR, accountId + '.json');
  if (!existsSync(file)) return null;
  return KeyPair.fromString(JSON.parse(readFileSync(file, 'utf8')).secret_key);
}

export function saveKey(accountId, keyPair) {
  mkdirSync(KEYS_DIR, { recursive: true });
  writeFileSync(join(KEYS_DIR, accountId + '.json'), JSON.stringify({ account_id: accountId, public_key: keyPair.publicKeyString, secret_key: keyPair.toString() }, null, 2), { mode: 0o600 });
}

/** Creates `<name>.testnet` through the public testnet faucet and returns its key. Reuses a saved key. */
export async function ensureFaucetAccount(accountId) {
  let key = loadKey(accountId);
  if (key && (await near.account(accountId))) return key;
  key = key || KeyPair.random();
  saveKey(accountId, key);
  const res = await fetch(HELPER_URL + '/account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: key.publicKeyString }),
  });
  if (!res.ok) throw new Error(`faucet refused ${accountId}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  for (let i = 0; i < 20; i++) {
    if (await near.account(accountId)) return key;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${accountId} did not appear on chain`);
}

export function readJson(path, fallback = null) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}
