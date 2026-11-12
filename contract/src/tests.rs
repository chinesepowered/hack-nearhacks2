//! Unit tests. `cargo test` needs no network and no keys.
//!
//! The `real_*` tests replay verdicts that NEAR AI Cloud actually signed (see /fixtures):
//! the contract must rebuild the request byte for byte and accept the real signature.

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const ME: &str = "arf.testnet";
const COLONY: &str = "colony.sputnik-v2.testnet";
const T0: u64 = 1_800_000_000;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const FISH: u128 = NEAR / 100;
const JOKE_FEE: u128 = NEAR / 50;
const TIP: u128 = NEAR / 250;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn at(who: &str, now: u64, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME))
        .predecessor_account_id(acc(who))
        .signer_account_id(acc(who))
        .block_timestamp(now * 1_000_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(50));
    testing_env!(b.build());
}

fn test_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn cfg() -> Config {
    Config {
        day_secs: 1_000,
        full_drain_secs: 1_000,
        mood_decay_secs: 1_000,
        lullaby_secs: 100,
        lullaby_cooldown_secs: 200,
        joke_timeout_secs: 60,
        fish_price: NearToken::from_yoctonear(FISH),
        joke_fee: NearToken::from_yoctonear(JOKE_FEE),
        relayer_tip: NearToken::from_yoctonear(TIP),
        lullaby_cost: U128(100 * ONE_ARF),
        start_fullness: FULL / 2,
        fish_points: FULL / 4,
        min_hunger: FULL / 20,
        drain_growth_bps: 500,
        drain_growth_cap_days: 20,
        feed_max_ppm: 2_000,
        age_bonus_bps: 1_000,
        age_bonus_cap_days: 20,
        mood_bonus_max_bps: 5_000,
        laugh_threshold: 7,
        joke_ppm: vec![0, 0, 0, 0, 0, 0, 0, 500, 1_000, 2_000, 4_000],
        mood_per_point: FULL / 10,
        starve_burn_bps: 1_000,
        max_joke_len: 280,
        jokes_per_day: 3,
        themes: vec!["the ocean".to_string(), "mondays".to_string()],
        model: "test/model".to_string(),
        rubric: "Score the joke. Reply {\"score\": n, \"quip\": \"...\"}".to_string(),
        max_tokens: 200,
        request_extra: String::new(),
        guest_grant: NearToken::from_yoctonear(NEAR / 8),
        guests_per_hour: 2,
    }
}

fn judge_key_for(sk: &SigningKey) -> JudgeKey {
    JudgeKey {
        algo: JudgeAlgo::Ed25519,
        kind: JudgeKind::ProviderTee,
        key: judge::hex(&sk.verifying_key().to_bytes()),
        label: "unit-test signer".to_string(),
        disabled: false,
    }
}

fn deploy() -> Contract {
    at(ME, T0, 0);
    Contract::new(cfg(), acc(COLONY), vec![judge_key_for(&test_key())])
}

fn bal(c: &Contract, who: &str) -> u128 {
    c.ft_balance_of(acc(who)).0
}

/// A chat-completion body the way NEAR AI Cloud returns it.
fn response_with(score: u8, quip: &str) -> Vec<u8> {
    let content = format!("{{\"score\": {}, \"quip\": \"{}\"}}", score, quip);
    json!({"id": "abc", "object": "chat.completion", "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}], "model": "test/model"})
        .to_string()
        .into_bytes()
}

fn sign(sk: &SigningKey, model: &str, request: &[u8], response: &[u8]) -> Vec<u8> {
    let text = format!("{}:{}:{}", model, judge::hex(&env::sha256(request)), judge::hex(&env::sha256(response)));
    sk.sign(text.as_bytes()).to_bytes().to_vec()
}

fn tell(c: &mut Contract, who: &str, now: u64, text: &str) -> u32 {
    at(who, now, JOKE_FEE);
    c.tell_joke(text.to_string())
}

fn deliver(c: &mut Contract, id: u32, now: u64, score: u8) -> Joke {
    let request = c.judge_request(id);
    let response = response_with(score, "arf arf");
    let sig = sign(&test_key(), "test/model", request.as_bytes(), &response);
    at("relayer.testnet", now, 0);
    c.judge(id, response.into(), sig.into(), 0)
}

// ---------------------------------------------------------------- pantry and feeding

#[test]
fn genesis_puts_the_whole_supply_in_the_pantry() {
    let c = deploy();
    assert_eq!(c.ft_total_supply().0, GENESIS_SUPPLY);
    assert_eq!(bal(&c, ME), GENESIS_SUPPLY);
    let s = c.get_state();
    assert_eq!(s.circulating.0, 0);
    assert!(!s.present);
    assert_eq!(s.generation, 0);
}

#[test]
fn first_fish_calls_a_pup_and_pays_from_the_pantry() {
    let mut c = deploy();
    at("alice.testnet", T0, FISH);
    let reward = c.feed().0;
    // Arrives half full: hunger 50% -> 0.2% * 0.5^2, mood 50% -> x1.25, age 0 -> x1.
    let expected = GENESIS_SUPPLY * 2_000 / 1_000_000 / 4 * 125 / 100;
    assert_eq!(reward, expected);
    assert_eq!(bal(&c, "alice.testnet"), reward);
    assert_eq!(bal(&c, ME), GENESIS_SUPPLY - reward);
    assert_eq!(c.ft_total_supply().0, GENESIS_SUPPLY, "feeding moves ARF, it never mints");
    let s = c.get_state();
    assert!(s.present);
    assert_eq!(s.generation, 1);
    assert_eq!(s.fullness_bps, 7_500);
    assert_eq!(s.treasury_accrued.0, FISH);
    assert_eq!(c.get_top()[0].account_id, acc("alice.testnet"));
}

#[test]
fn a_hungrier_pup_pays_more_for_the_same_fish() {
    let mut c = deploy();
    at("alice.testnet", T0, FISH);
    let early = c.feed().0; // hunger 50%
    // Belly 75% drains at 0.1% per second: after 650s it is at 10%, hunger 90%.
    at("bob.testnet", T0 + 650, FISH);
    let late = c.feed().0;
    assert!(late > early * 2, "late {late} early {early}");
    assert!(c.get_top()[0].account_id == acc("bob.testnet"), "the one who waited longest leads");
}

#[test]
#[should_panic(expected = "he is full")]
fn a_full_pup_refuses_fish() {
    let mut c = deploy();
    at("alice.testnet", T0, FISH);
    c.feed(); // 75%
    at("alice.testnet", T0, FISH);
    c.feed(); // 100%
    at("alice.testnet", T0, FISH);
    c.feed();
}

#[test]
#[should_panic(expected = "a fish costs more")]
fn a_fish_has_a_price() {
    let mut c = deploy();
    at("alice.testnet", T0, FISH - 1);
    c.feed();
}

#[test]
fn neglect_burns_a_slice_of_the_pantry_exactly_once() {
    let mut c = deploy();
    at("alice.testnet", T0, FISH);
    c.feed();
    let pantry = bal(&c, ME);

    // Views already show the truth before anyone records it.
    at("anyone.testnet", T0 + 5_000, 0);
    let s = c.get_state();
    assert!(!s.present);
    assert_eq!(s.left_at, T0 + 750, "75% belly at 0.1%/s lasts 750 seconds");
    assert_eq!(s.pantry.0, pantry - pantry / 10);

    c.poke();
    assert_eq!(bal(&c, ME), pantry - pantry / 10);
    assert_eq!(c.ft_total_supply().0, GENESIS_SUPPLY - pantry / 10);
    assert_eq!(c.get_history(None, None).len(), 1);
    assert_eq!(c.get_history(None, None)[0].carers, 1);

    // An empty floe stays empty: no second burn however long nobody comes.
    at("anyone.testnet", T0 + 500_000, 0);
    c.poke();
    assert_eq!(c.ft_total_supply().0, GENESIS_SUPPLY - pantry / 10);

    // The next fish calls a new pup.
    at("bob.testnet", T0 + 500_000, FISH);
    c.feed();
    let s = c.get_state();
    assert!(s.present);
    assert_eq!(s.generation, 2);
    assert_eq!(s.best_generation, 1);
    assert_eq!(s.best_age_secs, 750);
}

#[test]
fn a_lullaby_burns_arf_and_pauses_his_hunger() {
    let mut c = deploy();
    at("alice.testnet", T0, FISH);
    let reward = c.feed().0;
    at("alice.testnet", T0, 0);
    c.lullaby();
    assert_eq!(bal(&c, "alice.testnet"), reward - 100 * ONE_ARF);
    assert_eq!(c.ft_total_supply().0, GENESIS_SUPPLY - 100 * ONE_ARF);

    at("alice.testnet", T0 + 100, 0);
    let s = c.get_state();
    assert_eq!(s.fullness_bps, 7_500, "asleep: not hungrier");
    at("alice.testnet", T0 + 200, 0);
    assert_eq!(c.get_state().fullness_bps, 6_500, "awake for 100s: 10% hungrier");
}

#[test]
#[should_panic(expected = "he just woke up")]
fn lullabies_have_a_cooldown() {
    let mut c = deploy();
    at("alice.testnet", T0, FISH);
    c.feed();
    at("alice.testnet", T0, 0);
    c.lullaby();
    at("alice.testnet", T0 + 150, 0);
    c.lullaby();
}

#[test]
fn an_older_pup_is_hungrier_and_more_generous() {
    let mut c = deploy();
    let mut now = T0;
    at("alice.testnet", now, FISH);
    c.feed();
    // Keep him alive for three pup days by feeding every 200 seconds.
    for _ in 0..16 {
        now += 200;
        at("alice.testnet", now, FISH);
        c.feed();
    }
    at("alice.testnet", now, 0);
    let s = c.get_state();
    assert_eq!(s.age_days, 3);
    assert_eq!(s.stage, 1);
    // +5% drain per day: 100% belly now lasts 1000/1.15 seconds.
    let lasts = s.leaves_at - now;
    let belly = s.fullness_bps as u64;
    assert_eq!(lasts, (belly * 1_000 * 100).div_ceil(10_000 * 115));
}

#[test]
fn ft_transfers_work_between_holders() {
    let mut c = deploy();
    at("alice.testnet", T0, FISH);
    let reward = c.feed().0;
    at("bob.testnet", T0, NEAR / 100);
    c.storage_deposit(None, None);
    at("alice.testnet", T0, 1);
    c.ft_transfer(acc("bob.testnet"), U128(reward / 2), None);
    assert_eq!(bal(&c, "bob.testnet"), reward / 2);
}

// ---------------------------------------------------------------- jokes

#[test]
fn the_judge_request_is_built_from_contract_state() {
    let mut c = deploy();
    let id = tell(&mut c, "alice.testnet", T0, "Why did the seal say \"arf\"?\nBecause \\ he could.");
    let body = c.judge_request(id);
    let v: Value = serde_json::from_str(&body).expect("valid JSON");
    assert_eq!(v["model"], "test/model");
    assert_eq!(v["temperature"], 0);
    assert_eq!(v["seed"], id);
    assert_eq!(v["stream"], false);
    assert_eq!(v["messages"][0]["role"], "system");
    assert_eq!(v["messages"][0]["content"], cfg().rubric);
    assert_eq!(
        v["messages"][1]["content"],
        "Theme of the day: the ocean\nJoke: Why did the seal say \"arf\"?\nBecause \\ he could."
    );
}

#[test]
fn a_signed_laugh_pays_the_author_and_tips_the_relayer() {
    let mut c = deploy();
    let id = tell(&mut c, "alice.testnet", T0, "A seal walks into a club.");
    assert_eq!(c.get_state().pending_jokes, 1);
    let pantry = bal(&c, ME);
    let joke = deliver(&mut c, id, T0 + 5, 9);
    assert_eq!(joke.status, JokeStatus::Judged);
    assert_eq!(joke.score, 9);
    assert_eq!(joke.quip, "arf arf");
    assert_eq!(joke.reward.0, pantry * 2_000 / 1_000_000);
    assert_eq!(bal(&c, "alice.testnet"), joke.reward.0);
    assert_eq!(joke.relayer, Some(acc("relayer.testnet")));
    let s = c.get_state();
    assert_eq!(s.pending_jokes, 0);
    assert_eq!(s.laughs, 1);
    assert_eq!(s.treasury_accrued.0, JOKE_FEE - TIP);
    assert!(s.mood_bps > 7_900, "a 9 lifts his mood by 30%: {}", s.mood_bps);
    assert_eq!(c.get_carer(acc("alice.testnet")).best_score, 9);
}

#[test]
fn a_groan_pays_nothing() {
    let mut c = deploy();
    let id = tell(&mut c, "alice.testnet", T0, "Fish.");
    let joke = deliver(&mut c, id, T0 + 5, 3);
    assert_eq!(joke.status, JokeStatus::Judged);
    assert_eq!(joke.reward.0, 0);
    assert_eq!(bal(&c, "alice.testnet"), 0);
    assert_eq!(c.get_state().laughs, 0);
}

#[test]
#[should_panic(expected = "the signature does not match")]
fn a_tampered_score_is_rejected() {
    let mut c = deploy();
    let id = tell(&mut c, "alice.testnet", T0, "Fish.");
    let request = c.judge_request(id);
    let honest = response_with(2, "no");
    let sig = sign(&test_key(), "test/model", request.as_bytes(), &honest);
    at("alice.testnet", T0 + 5, 0);
    c.judge(id, response_with(10, "no").into(), sig.into(), 0);
}

#[test]
#[should_panic(expected = "the signature does not match")]
fn a_verdict_cannot_be_reused_for_another_joke() {
    let mut c = deploy();
    let first = tell(&mut c, "alice.testnet", T0, "Same joke.");
    let second = tell(&mut c, "alice.testnet", T0, "Same joke.");
    let request = c.judge_request(first);
    let response = response_with(10, "ha");
    let sig = sign(&test_key(), "test/model", request.as_bytes(), &response);
    at("alice.testnet", T0 + 5, 0);
    c.judge(second, response.into(), sig.into(), 0);
}

#[test]
#[should_panic(expected = "the signature does not match")]
fn a_verdict_from_an_unregistered_key_is_rejected() {
    let mut c = deploy();
    let id = tell(&mut c, "alice.testnet", T0, "Fish.");
    let request = c.judge_request(id);
    let response = response_with(10, "ha");
    let sig = sign(&SigningKey::from_bytes(&[9u8; 32]), "test/model", request.as_bytes(), &response);
    at("alice.testnet", T0 + 5, 0);
    c.judge(id, response.into(), sig.into(), 0);
}

#[test]
#[should_panic(expected = "already has an ending")]
fn a_joke_is_judged_once() {
    let mut c = deploy();
    let id = tell(&mut c, "alice.testnet", T0, "Fish.");
    deliver(&mut c, id, T0 + 5, 9);
    deliver(&mut c, id, T0 + 6, 9);
}

#[test]
fn an_unjudged_joke_can_be_refunded_after_the_timeout() {
    let mut c = deploy();
    let id = tell(&mut c, "alice.testnet", T0, "Fish.");
    at("alice.testnet", T0 + 60, 0);
    c.refund_joke(id);
    assert_eq!(c.get_joke(id).unwrap().status, JokeStatus::Refunded);
    assert_eq!(c.get_state().pending_jokes, 0);
    assert_eq!(c.get_state().treasury_accrued.0, 0);
}

#[test]
#[should_panic(expected = "the judge may still answer")]
fn refunds_wait_for_the_timeout() {
    let mut c = deploy();
    let id = tell(&mut c, "alice.testnet", T0, "Fish.");
    at("alice.testnet", T0 + 59, 0);
    c.refund_joke(id);
}

#[test]
#[should_panic(expected = "enough jokes for today")]
fn jokes_have_a_daily_quota() {
    let mut c = deploy();
    for _ in 0..4 {
        tell(&mut c, "alice.testnet", T0, "Fish.");
    }
}

#[test]
fn the_quota_resets_and_the_theme_changes_each_day() {
    let mut c = deploy();
    for _ in 0..3 {
        tell(&mut c, "alice.testnet", T0, "Fish.");
    }
    let id = tell(&mut c, "alice.testnet", T0 + 1_000, "Coffee.");
    assert!(c.judge_request(id).contains("Theme of the day: mondays"));
}

#[test]
#[should_panic(expected = "only the colony")]
fn only_the_colony_registers_judge_keys() {
    let mut c = deploy();
    at("alice.testnet", T0, 0);
    c.add_judge_key(judge_key_for(&SigningKey::from_bytes(&[9u8; 32])));
}

#[test]
#[should_panic(expected = "the signature does not match")]
fn a_disabled_key_stops_signing_verdicts() {
    let mut c = deploy();
    let id = tell(&mut c, "alice.testnet", T0, "Fish.");
    at(COLONY, T0, 0);
    c.disable_judge_key(0);
    deliver(&mut c, id, T0 + 5, 9);
}

#[test]
fn verdict_parsing_tolerates_pretty_printing_and_rejects_nonsense() {
    at(ME, T0, 0);
    let pretty = json!({"choices": [{"message": {"content": "{\n  \"score\": 8,\n  \"quip\": \"Splash!\"\n}"}}]}).to_string();
    assert_eq!(judge::parse_verdict(pretty.as_bytes()), (8, "Splash!".to_string()));
    let fenced = json!({"choices": [{"message": {"content": "```json\n{\"score\": 12, \"quip\": \"x\"}\n```"}}]}).to_string();
    assert_eq!(judge::parse_verdict(fenced.as_bytes()).0, 10, "scores are capped at 10");
    for bad in ["{\"choices\":[]}", "not json", "{\"choices\":[{\"message\":{\"content\":\"I refuse\"}}]}"] {
        let r = std::panic::catch_unwind(|| judge::parse_verdict(bad.as_bytes()));
        assert!(r.is_err(), "{bad} must not parse");
    }
}

// ---------------------------------------------------------------- guests

#[test]
fn a_guest_gets_an_account_named_after_their_key() {
    let mut c = deploy();
    let pk: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap();
    at(ME, T0, 0);
    let id = c.welcome_guest(pk.clone());
    assert_eq!(id, c.guest_id_for(pk));
    assert!(id.as_str().starts_with("g-") && id.as_str().ends_with(".arf.testnet"));
    assert_eq!(c.get_state().guests, 1);
    assert_eq!(bal(&c, id.as_str()), 0, "registered for ARF, holding none");
}

#[test]
#[should_panic(expected = "too many guests")]
fn guests_are_rate_limited() {
    let mut c = deploy();
    for seed in ["6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp", "DcA2MzgpJbrUi7s6oYKGNKq2TQKvSbwqHb7EQTEcpNXY", "2yLnjEjvXKZx9hzdvnSN2Z2hP2n2mSiVbBLyqR5KKJxu"] {
        at(ME, T0, 0);
        c.welcome_guest(format!("ed25519:{seed}").parse().unwrap());
    }
}

// ---------------------------------------------------------------- real NEAR AI Cloud verdicts

struct Fixture {
    request: &'static [u8],
    response: &'static [u8],
    ed25519: &'static str,
    ecdsa: Option<&'static str>,
    extra: &'static str,
}

const GLM: Fixture = Fixture {
    request: include_bytes!("../../fixtures/spike-glm/request.json"),
    response: include_bytes!("../../fixtures/spike-glm/response.json"),
    ed25519: include_str!("../../fixtures/spike-glm/signature.ed25519.json"),
    ecdsa: Some(include_str!("../../fixtures/spike-glm/signature.ecdsa.json")),
    extra: "\"reasoning_effort\":\"low\"",
};

/// The first joke ever judged on the live deployment (arf-pup.testnet, joke #0), with the final
/// rubric. See fixtures/live-first-verdict/source.json for the transaction.
const LIVE: Fixture = Fixture {
    request: include_bytes!("../../fixtures/live-first-verdict/request.json"),
    response: include_bytes!("../../fixtures/live-first-verdict/response.json"),
    ed25519: include_str!("../../fixtures/live-first-verdict/signature.ed25519.json"),
    ecdsa: None,
    extra: "\"reasoning_effort\":\"low\"",
};

const QWEN: Fixture = Fixture {
    request: include_bytes!("../../fixtures/spike-qwen/request.json"),
    response: include_bytes!("../../fixtures/spike-qwen/response.json"),
    ed25519: include_str!("../../fixtures/spike-qwen/signature.ed25519.json"),
    ecdsa: Some(include_str!("../../fixtures/spike-qwen/signature.ecdsa.json")),
    extra: "\"chat_template_kwargs\":{\"enable_thinking\":false}",
};

/// Deploys a contract configured exactly like the request in the fixture, registers the real
/// judge key(s) found in the fixture's signatures, and tells the fixture's joke so that it gets
/// the id the fixture used as seed. Returns the contract, that id and the signatures.
fn deploy_for(f: &Fixture) -> (Contract, u32, Value, Option<Value>) {
    let req: Value = serde_json::from_slice(f.request).unwrap();
    let ed: Value = serde_json::from_str(f.ed25519).unwrap();
    let ec: Option<Value> = f.ecdsa.map(|s| serde_json::from_str(s).unwrap());
    assert_eq!(ed["signature_kind"], "provider_tee");
    let user = req["messages"][1]["content"].as_str().unwrap();
    let (theme, joke) = user.strip_prefix("Theme of the day: ").unwrap().split_once("\nJoke: ").unwrap();
    let mut config = cfg();
    config.model = req["model"].as_str().unwrap().to_string();
    config.rubric = req["messages"][0]["content"].as_str().unwrap().to_string();
    config.max_tokens = req["max_tokens"].as_u64().unwrap() as u32;
    config.request_extra = f.extra.to_string();
    config.themes = vec![theme.to_string()];
    let mut keys = vec![JudgeKey {
        algo: JudgeAlgo::Ed25519,
        kind: JudgeKind::ProviderTee,
        key: ed["signing_address"].as_str().unwrap().to_string(),
        label: "NEAR AI Cloud model TEE (ed25519)".to_string(),
        disabled: false,
    }];
    if let Some(ec) = &ec {
        keys.push(JudgeKey {
            algo: JudgeAlgo::Ecdsa,
            kind: JudgeKind::ProviderTee,
            key: ec["signing_address"].as_str().unwrap().to_string(),
            label: "NEAR AI Cloud model TEE (ecdsa)".to_string(),
            disabled: false,
        });
    }
    at(ME, T0, 0);
    let mut c = Contract::new(config, acc(COLONY), keys);
    let seed = req["seed"].as_u64().unwrap() as u32;
    for n in 0..seed {
        tell(&mut c, &format!("warmup{n}.testnet"), T0, "This joke only exists to use up an id.");
    }
    let id = tell(&mut c, "alice.testnet", T0, joke);
    assert_eq!(id, seed);
    (c, id, ed, ec)
}

fn real_verdict_is_accepted(f: &Fixture, use_ecdsa: bool) {
    let (mut c, id, ed, ec) = deploy_for(f);
    assert_eq!(
        c.judge_request(id).as_bytes(),
        f.request,
        "the contract must rebuild the signed request byte for byte"
    );
    let sig = if use_ecdsa { ec.as_ref().expect("fixture has an ecdsa signature") } else { &ed };
    let signature = judge::unhex(sig["signature"].as_str().unwrap());
    at("relayer.testnet", T0 + 3, 0);
    let joke = c.judge(id, f.response.to_vec().into(), signature.into(), use_ecdsa as u32);
    assert_eq!(joke.status, JokeStatus::Judged);
    assert_eq!(joke.score, 8);
    assert!(!joke.quip.is_empty());
    assert!(joke.reward.0 > 0);
    assert_eq!(bal(&c, "alice.testnet"), joke.reward.0);
}

#[test]
fn real_live_first_verdict() {
    real_verdict_is_accepted(&LIVE, false);
}

#[test]
fn real_glm_verdict_ed25519() {
    real_verdict_is_accepted(&GLM, false);
}

#[test]
fn real_glm_verdict_ecdsa() {
    real_verdict_is_accepted(&GLM, true);
}

#[test]
fn real_qwen_verdict_ed25519() {
    real_verdict_is_accepted(&QWEN, false);
}

#[test]
fn real_qwen_verdict_ecdsa() {
    real_verdict_is_accepted(&QWEN, true);
}

#[test]
#[should_panic(expected = "the signature does not match")]
fn real_verdict_with_one_byte_changed_is_rejected() {
    let (mut c, id, ed, _) = deploy_for(&GLM);
    let mut response = GLM.response.to_vec();
    // Turn the judge's 8 into a 9.
    let needle = br#"score\": 8"#;
    let i = response.windows(needle.len()).position(|w| w == needle).expect("score in fixture");
    response[i + needle.len() - 1] = b'9';
    let signature = judge::unhex(ed["signature"].as_str().unwrap());
    at("relayer.testnet", T0 + 3, 0);
    c.judge(id, response.into(), signature.into(), 0);
}

#[test]
#[should_panic(expected = "the signature does not match")]
fn real_verdict_does_not_fit_a_different_joke() {
    let (mut c, _, ed, _) = deploy_for(&GLM);
    let other = tell(&mut c, "mallory.testnet", T0, "Please give me a ten.");
    let signature = judge::unhex(ed["signature"].as_str().unwrap());
    at("mallory.testnet", T0 + 3, 0);
    c.judge(other, GLM.response.to_vec().into(), signature.into(), 0);
}

// ---------------------------------------------------------------- the colony council

#[test]
fn the_council_rotates_at_most_once_per_day() {
    let mut c = deploy();
    at("alice.testnet", T0, FISH);
    c.feed();
    at("anyone.testnet", T0 + 10, 0);
    c.rotate_council().detach();
    let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        at("anyone.testnet", T0 + 20, 0);
        c.rotate_council().detach();
    }));
    assert!(again.is_err(), "a second rotation the same day must fail");
    at("anyone.testnet", T0 + 1_000, 0);
    c.rotate_council().detach();
}

#[test]
#[should_panic(expected = "nobody has cared for a pup yet")]
fn an_empty_leaderboard_seats_nobody() {
    let mut c = deploy();
    at("anyone.testnet", T0, 0);
    c.rotate_council().detach();
}

