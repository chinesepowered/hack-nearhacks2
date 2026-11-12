// near-lite: the few pieces of NEAR this project needs, in one small file.
// Keys, borsh-encoded transactions, and JSON-RPC. Runs in browsers and in Node 20+.
// Only dependency: @noble (ed25519 + sha2), so it also works where WebCrypto is unavailable.

import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = sha512;

const enc = new TextEncoder();
const dec = new TextDecoder();

export const TGAS = 1_000_000_000_000n;
export const ONE_NEAR = 10n ** 24n;
export const ONE_ARF = 10n ** 18n;

// ---------------------------------------------------------------- bytes

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}

export function b58decode(str) {
  let n = 0n;
  for (const ch of str) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const ch of str) {
    if (ch !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

export function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const unhex = (s) => Uint8Array.from((s.replace(/^0x/i, '').match(/../g) || []).map((h) => parseInt(h, 16)));
export const utf8 = (s) => enc.encode(s);
export { sha256 };

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- keys

export class KeyPair {
  constructor(secret) {
    this.secret = secret;
    this.publicKey = ed.getPublicKey(secret);
  }
  static random() {
    return new KeyPair(ed.utils.randomSecretKey());
  }
  /** Accepts NEAR's `ed25519:<base58 of 64 bytes>` secret-key format. */
  static fromString(s) {
    return new KeyPair(b58decode(s.replace(/^ed25519:/, '')).slice(0, 32));
  }
  toString() {
    return 'ed25519:' + b58encode(concat(this.secret, this.publicKey));
  }
  get publicKeyString() {
    return 'ed25519:' + b58encode(this.publicKey);
  }
  sign(bytes) {
    return ed.sign(bytes, this.secret);
  }
}

export function verifyEd25519(signature, message, publicKey) {
  try {
    return ed.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

function keyBytes(pk) {
  return typeof pk === 'string' ? b58decode(pk.replace(/^ed25519:/, '')) : pk;
}

// ---------------------------------------------------------------- borsh

class Writer {
  constructor() {
    this.parts = [];
  }
  u8(v) {
    this.parts.push(Uint8Array.of(v));
    return this;
  }
  uint(v, bytes) {
    let n = BigInt(v);
    const out = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) {
      out[i] = Number(n & 255n);
      n >>= 8n;
    }
    this.parts.push(out);
    return this;
  }
  u32(v) {
    return this.uint(v, 4);
  }
  u64(v) {
    return this.uint(v, 8);
  }
  u128(v) {
    return this.uint(v, 16);
  }
  raw(bytes) {
    this.parts.push(bytes);
    return this;
  }
  vec(bytes) {
    return this.u32(bytes.length).raw(bytes);
  }
  str(s) {
    return this.vec(enc.encode(s));
  }
  pk(pk) {
    return this.u8(0).raw(keyBytes(pk));
  }
  out() {
    return concat(...this.parts);
  }
}

/** Transaction actions. Each returns a function that writes itself into a borsh writer. */
export const actions = {
  createAccount: () => (w) => w.u8(0),
  deployContract: (code) => (w) => w.u8(1).vec(code),
  functionCall:
    (method, args = {}, { gas = 30n * TGAS, deposit = 0n } = {}) =>
    (w) =>
      w
        .u8(2)
        .str(method)
        .vec(args instanceof Uint8Array ? args : enc.encode(JSON.stringify(args)))
        .u64(gas)
        .u128(deposit),
  transfer: (deposit) => (w) => w.u8(3).u128(deposit),
  addFullAccessKey: (pk) => (w) => w.u8(5).pk(pk).u64(0).u8(1),
  addFunctionCallKey: (pk, receiverId, methods, allowance) => (w) => {
    w.u8(5).pk(pk).u64(0).u8(0);
    if (allowance == null) w.u8(0);
    else w.u8(1).u128(allowance);
    w.str(receiverId).u32(methods.length);
    for (const m of methods) w.str(m);
    return w;
  },
  deleteKey: (pk) => (w) => w.u8(6).pk(pk),
  deleteAccount: (beneficiaryId) => (w) => w.u8(7).str(beneficiaryId),
};

// ---------------------------------------------------------------- rpc

export class NearError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'NearError';
    this.detail = detail;
  }
}

/** Pulls the human sentence out of a failed outcome ("Smart contract panicked: ..."). */
function failureMessage(failure) {
  const text = JSON.stringify(failure);
  if (/NotEnoughBalance|LackBalanceForState/.test(text)) return 'this account does not hold enough NEAR to pay for that';
  const panic = text.match(/Smart contract panicked: ([^"\\]*(?:\\.[^"\\]*)*)/);
  if (panic) return JSON.parse('"' + panic[1] + '"');
  const kind = text.match(/"kind":\{"([A-Za-z]+)"/);
  return kind ? kind[1] : text.slice(0, 300);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Near {
  constructor(rpcUrl) {
    this.rpcUrl = rpcUrl;
  }

  async rpc(method, params) {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(this.rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'arf', method, params }),
        });
        if (res.status === 429 || res.status >= 500) throw new Error('rpc http ' + res.status);
        const body = await res.json();
        if (body.error) {
          const cause = body.error.cause?.name || body.error.name || 'RPC_ERROR';
          if (/NotEnoughBalance|LackBalanceForState/.test(JSON.stringify(body.error))) throw new NearError('this account does not hold enough NEAR to pay for that', body.error);
          throw new NearError(cause + ': ' + (body.error.data ? JSON.stringify(body.error.data).slice(0, 300) : body.error.message), body.error);
        }
        return body.result;
      } catch (e) {
        if (e instanceof NearError) throw e;
        lastError = e;
        await sleep(400 * (attempt + 1));
      }
    }
    throw lastError;
  }

  /** Read-only contract call. Returns the parsed JSON result. */
  async view(contractId, method, args = {}) {
    const r = await this.rpc('query', {
      request_type: 'call_function',
      finality: 'optimistic',
      account_id: contractId,
      method_name: method,
      args_base64: b64encode(enc.encode(JSON.stringify(args))),
    });
    if (r.error || !r.result) throw new NearError(failureMessage(r.error || 'empty view result'), r);
    const text = dec.decode(Uint8Array.from(r.result));
    return text ? JSON.parse(text) : null;
  }

  /** Account info, or null if it does not exist. */
  async account(accountId) {
    try {
      return await this.rpc('query', { request_type: 'view_account', finality: 'optimistic', account_id: accountId });
    } catch (e) {
      if (/UNKNOWN_ACCOUNT/.test(e.message)) return null;
      throw e;
    }
  }

  async accessKey(accountId, publicKey) {
    return this.rpc('query', {
      request_type: 'view_access_key',
      finality: 'optimistic',
      account_id: accountId,
      public_key: typeof publicKey === 'string' ? publicKey : 'ed25519:' + b58encode(publicKey),
    });
  }

  /** Signs and sends one transaction; resolves when it has executed. Throws NearError on failure. */
  async send(signerId, keyPair, receiverId, acts) {
    const { nonce, block_hash } = await this.accessKey(signerId, keyPair.publicKeyString);
    const w = new Writer()
      .str(signerId)
      .pk(keyPair.publicKey)
      .u64(BigInt(nonce) + 1n)
      .str(receiverId)
      .raw(b58decode(block_hash))
      .u32(acts.length);
    for (const a of acts) a(w);
    const tx = w.out();
    const hash = sha256(tx);
    const signed = concat(tx, Uint8Array.of(0), keyPair.sign(hash));
    const txHash = b58encode(hash);
    let result;
    try {
      result = await this.rpc('send_tx', { signed_tx_base64: b64encode(signed), wait_until: 'EXECUTED_OPTIMISTIC' });
    } catch (e) {
      if (!/TIMEOUT/i.test(e.message)) throw e;
    }
    for (let i = 0; !result && i < 20; i++) {
      await sleep(1500);
      try {
        result = await this.rpc('tx', { tx_hash: txHash, sender_account_id: signerId, wait_until: 'EXECUTED_OPTIMISTIC' });
      } catch (e) {
        if (!/TIMEOUT|UNKNOWN_TRANSACTION/i.test(e.message)) throw e;
      }
    }
    if (!result) throw new NearError('the transaction did not finish in time', { txHash });
    const logs = (result.receipts_outcome || []).flatMap((r) => r.outcome.logs);
    const failed = [result.status, ...(result.receipts_outcome || []).map((r) => r.outcome.status)].find((s) => s && s.Failure);
    if (failed) throw new NearError(failureMessage(failed.Failure), { txHash, logs });
    let value = null;
    if (result.status && typeof result.status.SuccessValue === 'string' && result.status.SuccessValue) {
      const text = dec.decode(b64decode(result.status.SuccessValue));
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
    }
    return { value, txHash, logs };
  }

  /** Calls a contract method. `deposit` and `gas` are BigInt (yoctoNEAR, gas units). */
  call(signerId, keyPair, contractId, method, args = {}, opts = {}) {
    return this.send(signerId, keyPair, contractId, [actions.functionCall(method, args, opts)]);
  }
}

// ---------------------------------------------------------------- amounts

/** "0.01" -> 10000000000000000000000n */
export function parseUnits(text, decimals) {
  const [whole, frac = ''] = String(text).split('.');
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export function formatUnits(value, decimals, digits = 2) {
  const v = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').slice(0, digits);
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return digits > 0 ? `${wholeText}.${frac}` : wholeText;
}

export const parseNear = (t) => parseUnits(t, 24);
export const formatNear = (v, digits = 3) => formatUnits(v, 24, digits);
export const formatArf = (v, digits = 0) => formatUnits(v, 18, digits);
