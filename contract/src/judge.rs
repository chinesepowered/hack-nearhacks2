//! The joke judge: how the request is built and how a verdict is checked.
//!
//! NEAR AI Cloud runs the model inside secure hardware (a TEE). After each completion it signs
//! `<model>:<sha256(request body)>:<sha256(response body)>` with a key that only exists inside
//! that hardware (docs.near.ai/cloud/verification/cloud-api/response-signatures).
//!
//! This contract never trusts whoever delivers the verdict. It rebuilds the request body from its
//! own state, hashes it, hashes the delivered response, and checks the signature against a
//! registered judge key. A relayer can therefore deliver a verdict or not, but cannot change the
//! model, the rubric, the joke or the score.

use crate::{Config, Joke};
use near_sdk::serde_json::{self, Value};
use near_sdk::{env, near, require};

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum JudgeAlgo {
    Ed25519,
    Ecdsa,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum JudgeKind {
    /// Signed by the model-serving TEE: `<model>:<request hash>:<response hash>`.
    ProviderTee,
    /// Signed by the NEAR AI Cloud gateway TEE: `<request hash>:<response hash>`.
    Gateway,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct JudgeKey {
    pub algo: JudgeAlgo,
    pub kind: JudgeKind,
    /// Hex, with or without 0x. Ed25519: the 32-byte public key. Ecdsa: the 20-byte address.
    pub key: String,
    /// Shown on the page: what this key is and how to check its attestation.
    pub label: String,
    pub disabled: bool,
}

impl JudgeKey {
    pub fn check(&self) {
        let len = unhex(&self.key).len();
        match self.algo {
            JudgeAlgo::Ed25519 => require!(len == 32, "an ed25519 judge key is 32 bytes"),
            JudgeAlgo::Ecdsa => require!(len == 20, "an ecdsa judge key is a 20-byte address"),
        }
    }
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

pub fn unhex(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s);
    require!(s.len() % 2 == 0, "odd-length hex");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap_or_else(|_| env::panic_str("bad hex")))
        .collect()
}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| env::panic_str("unencodable text"))
}

/// The exact request body for a joke. Field order and spacing are part of the protocol: the
/// relayer must send these bytes unchanged, because the judge signs their hash.
pub fn request_body(cfg: &Config, joke: &Joke) -> String {
    let user = format!("Theme of the day: {}\nJoke: {}", cfg.themes[joke.theme as usize], joke.text);
    let mut s = String::with_capacity(cfg.rubric.len() + user.len() + 256);
    s.push_str("{\"model\":");
    s.push_str(&json_string(&cfg.model));
    s.push_str(",\"messages\":[{\"role\":\"system\",\"content\":");
    s.push_str(&json_string(&cfg.rubric));
    s.push_str("},{\"role\":\"user\",\"content\":");
    s.push_str(&json_string(&user));
    s.push_str("}],\"temperature\":0,\"seed\":");
    s.push_str(&joke.id.to_string());
    s.push_str(",\"max_tokens\":");
    s.push_str(&cfg.max_tokens.to_string());
    s.push_str(",\"stream\":false");
    if !cfg.request_extra.is_empty() {
        s.push(',');
        s.push_str(&cfg.request_extra);
    }
    s.push('}');
    s
}

/// True if `signature` is `key`'s signature over the text NEAR AI Cloud signs for this
/// request and response.
pub fn verify(key: &JudgeKey, model: &str, request: &[u8], response: &[u8], signature: &[u8]) -> bool {
    if key.disabled {
        return false;
    }
    let hashes = format!("{}:{}", hex(&env::sha256(request)), hex(&env::sha256(response)));
    let text = match key.kind {
        JudgeKind::ProviderTee => format!("{}:{}", model, hashes),
        JudgeKind::Gateway => hashes,
    };
    let key_bytes = unhex(&key.key);
    match key.algo {
        JudgeAlgo::Ed25519 => {
            let (Ok(sig), Ok(pk)) =
                (<[u8; 64]>::try_from(signature), <[u8; 32]>::try_from(key_bytes.as_slice()))
            else {
                return false;
            };
            env::ed25519_verify(&sig, text.as_bytes(), &pk)
        }
        JudgeAlgo::Ecdsa => {
            if signature.len() != 65 || key_bytes.len() != 20 {
                return false;
            }
            // Ethereum personal-sign (EIP-191) over the text.
            let mut prefixed = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
            prefixed.extend_from_slice(text.as_bytes());
            let digest = env::keccak256(&prefixed);
            let v = match signature[64] {
                27 | 28 => signature[64] - 27,
                0 | 1 => signature[64],
                _ => return false,
            };
            match env::ecrecover(&digest, &signature[..64], v, true) {
                Some(public_key) => env::keccak256(&public_key)[12..] == key_bytes[..],
                None => false,
            }
        }
    }
}

/// Reads `{"score": 0..10, "quip": "..."}` out of a chat-completion response body.
/// Panics (so the joke stays pending and refundable) if there is no usable verdict.
pub fn parse_verdict(response: &[u8]) -> (u8, String) {
    let body: Value =
        serde_json::from_slice(response).unwrap_or_else(|_| env::panic_str("the response is not JSON"));
    let content = body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_else(|| env::panic_str("the response has no message content"));
    let (Some(start), Some(end)) = (content.find('{'), content.rfind('}')) else {
        env::panic_str("the judge did not answer with a verdict");
    };
    require!(end > start, "the judge did not answer with a verdict");
    let verdict: Value = serde_json::from_str(&content[start..=end])
        .unwrap_or_else(|_| env::panic_str("the verdict is not valid JSON"));
    let score = verdict["score"]
        .as_u64()
        .unwrap_or_else(|| env::panic_str("the verdict has no whole-number score"))
        .min(10) as u8;
    let quip: String =
        verdict["quip"].as_str().unwrap_or("").chars().filter(|c| !c.is_control()).take(140).collect();
    (score, quip)
}
