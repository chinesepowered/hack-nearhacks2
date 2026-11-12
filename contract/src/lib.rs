//! Arf: one seal pup, raised by everyone.
//!
//! A NEP-141 memecoin whose whole supply sits in a pantry owned by this contract.
//! ARF only leaves the pantry when somebody looks after the pup:
//!
//! * `feed`      - pay a fish (NEAR). The hungrier the pup, the bigger the treat.
//! * `tell_joke` - an AI judge on NEAR AI Cloud scores the joke. This contract rebuilds the
//!   exact request, checks the judge's signature over request and response, and only then pays.
//! * neglect     - if the pup's belly reaches zero he swims away and a slice of the pantry burns.
//!
//! There is no owner and no parameter can change after `new`. See docs/MECHANICS.md.

use near_contract_standards::fungible_token::events::FtBurn;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise,
    PromiseOrValue, PublicKey,
};

mod dao;
mod judge;
#[cfg(test)]
mod tests;

pub use judge::{JudgeAlgo, JudgeKey, JudgeKind};

/// 100% of a belly or of a good mood.
pub const FULL: u64 = 1_000_000_000;
/// ARF has 18 decimals.
pub const ONE_ARF: u128 = 1_000_000_000_000_000_000;
/// The whole supply, minted once into the pantry.
pub const GENESIS_SUPPLY: u128 = 1_000_000_000 * ONE_ARF;
/// How many carers the leaderboard of one generation keeps.
pub const TOP_N: usize = 10;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    Token,
    Jokes,
    History,
    Carers,
    GenPoints,
}

/// Every rule of the game. Set once in `new`, never changed.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Config {
    // ---- time (seconds) ----
    /// One "pup day": the unit of his age, of the theme rotation and of the joke quota.
    pub day_secs: u32,
    /// How long a newborn's full belly lasts.
    pub full_drain_secs: u32,
    /// How long a perfect mood takes to fade to zero.
    pub mood_decay_secs: u32,
    /// How long a lullaby pauses his hunger.
    pub lullaby_secs: u32,
    pub lullaby_cooldown_secs: u32,
    /// After this long without a verdict the author can take the joke fee back.
    pub joke_timeout_secs: u32,

    // ---- prices ----
    pub fish_price: NearToken,
    pub joke_fee: NearToken,
    /// Paid out of the joke fee to whoever delivers the judge's signed verdict.
    pub relayer_tip: NearToken,
    /// ARF burned to sing a lullaby.
    pub lullaby_cost: U128,

    // ---- the pup (belly units: FULL = 100%) ----
    pub start_fullness: u64,
    pub fish_points: u64,
    /// He refuses fish when less hungry than this.
    pub min_hunger: u64,
    /// He gets hungrier as he grows: +bps of drain speed per day of age, up to the cap.
    pub drain_growth_bps: u32,
    pub drain_growth_cap_days: u32,

    // ---- rewards (paid from the pantry) ----
    /// Share of the pantry (parts per million) for a fish given at 100% hunger.
    pub feed_max_ppm: u32,
    /// A bigger pup gives bigger treats: +bps per day of age, up to the cap.
    pub age_bonus_bps: u32,
    pub age_bonus_cap_days: u32,
    /// A happy pup shares more: up to +bps on feeding rewards at 100% mood.
    pub mood_bonus_max_bps: u32,
    /// A joke scoring at least this is a laugh.
    pub laugh_threshold: u8,
    /// Share of the pantry (ppm) paid for a joke, by score 0..=10.
    pub joke_ppm: Vec<u32>,
    /// Mood gained per score point at or above the threshold.
    pub mood_per_point: u64,
    /// Share of the pantry (bps) destroyed when he swims away.
    pub starve_burn_bps: u32,

    // ---- jokes ----
    pub max_joke_len: u32,
    pub jokes_per_day: u32,
    pub themes: Vec<String>,

    // ---- the judge request (NEAR AI Cloud chat completion) ----
    pub model: String,
    pub rubric: String,
    pub max_tokens: u32,
    /// Extra JSON members appended to the request body, without braces. May be empty.
    pub request_extra: String,

    // ---- guests ----
    pub guest_grant: NearToken,
    pub guests_per_hour: u32,
}

/// The pup that is on the ice right now (or the empty floe he left).
#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Pup {
    pub generation: u32,
    pub present: bool,
    pub born_at: u64,
    /// Belly and mood as of `updated_at`. Use `get_state` for live values.
    pub fullness: u64,
    pub mood: u64,
    pub updated_at: u64,
    pub nap_until: u64,
    pub lullaby_ready_at: u64,
    pub feeds: u32,
    pub laughs: u32,
    pub carers: u32,
    /// When the previous pup swam away (0 if never).
    pub left_at: u64,
}

/// What is left of a pup who swam away.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct GenRecord {
    pub generation: u32,
    pub born_at: u64,
    pub left_at: u64,
    pub feeds: u32,
    pub laughs: u32,
    pub carers: u32,
    pub burned: U128,
    pub top: Vec<TopEntry>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TopEntry {
    pub account_id: AccountId,
    pub points: u32,
}

/// All-time record of one account.
#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Carer {
    pub feeds: u32,
    pub jokes: u32,
    pub laughs: u32,
    pub best_score: u8,
    pub points: u32,
    pub earned: U128,
    pub joke_day: u32,
    pub jokes_today: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum JokeStatus {
    Pending,
    Judged,
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Joke {
    pub id: u32,
    pub author: AccountId,
    pub text: String,
    pub theme: u16,
    pub told_at: u64,
    pub status: JokeStatus,
    pub score: u8,
    pub quip: String,
    pub reward: U128,
    pub judged_at: u64,
    pub relayer: Option<AccountId>,
    /// Index of the judge key that signed the verdict.
    pub key_index: u32,
    /// sha256 of the judge's raw response and the judge's signature, kept so that anyone can
    /// re-check the verdict later from chain data alone (the request comes from `judge_request`).
    pub response_hash: String,
    pub signature: Base64VecU8,
}

/// Live numbers for the page.
#[near(serializers = [json])]
pub struct StateView {
    pub now: u64,
    pub generation: u32,
    pub present: bool,
    pub born_at: u64,
    pub age_secs: u64,
    pub age_days: u32,
    /// 0 newborn, 1 weaner, 2 juvenile, 3 grown.
    pub stage: u8,
    /// Belly, mood in basis points of FULL.
    pub fullness_bps: u32,
    pub mood_bps: u32,
    pub napping: bool,
    pub nap_until: u64,
    pub lullaby_ready_at: u64,
    /// When he will swim away if nobody feeds him (0 if absent).
    pub leaves_at: u64,
    pub left_at: u64,
    pub feeds: u32,
    pub laughs: u32,
    pub carers: u32,
    pub pantry: U128,
    pub total_supply: U128,
    pub circulating: U128,
    pub burned: U128,
    /// What a fish would earn right now.
    pub feed_reward: U128,
    /// What a joke scoring 10 would earn right now.
    pub top_joke_reward: U128,
    pub day: u32,
    pub theme: String,
    pub best_age_secs: u64,
    pub best_generation: u32,
    pub jokes: u32,
    pub pending_jokes: u32,
    pub generations_past: u32,
    pub treasury_accrued: U128,
    pub guests: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    cfg: Config,
    genesis: u64,
    /// The colony DAO: receives fees and is the only one who may register judge keys.
    treasury: AccountId,
    treasury_accrued: u128,
    judge_keys: Vec<JudgeKey>,
    pup: Pup,
    top: Vec<TopEntry>,
    history: Vector<GenRecord>,
    jokes: Vector<Joke>,
    pending_jokes: u32,
    /// NEAR held for jokes that are still waiting for a verdict.
    escrow: u128,
    carers: LookupMap<AccountId, Carer>,
    gen_points: LookupMap<(u32, AccountId), u32>,
    burned: u128,
    best_age_secs: u64,
    best_generation: u32,
    guests: u32,
    guest_window_start: u64,
    guest_window_count: u32,
    council_rotated_gen: u32,
}

fn now_secs() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn event(name: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "arf", "version": "1.0.0", "event": name, "data": [data]})
    ));
}

fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    a.checked_mul(b).unwrap_or_else(|| env::panic_str("math overflow")) / c
}

#[near]
impl Contract {
    /// Mints the whole supply into the pantry. Nobody, including the deployer, gets any ARF.
    #[init]
    pub fn new(config: Config, treasury: AccountId, judge_keys: Vec<JudgeKey>) -> Self {
        Self::check_config(&config);
        for k in &judge_keys {
            k.check();
        }
        let mut token = FungibleToken::new(Key::Token);
        let me = env::current_account_id();
        token.internal_register_account(&me);
        token.internal_deposit(&me, GENESIS_SUPPLY);
        near_contract_standards::fungible_token::events::FtMint {
            owner_id: &me,
            amount: U128(GENESIS_SUPPLY),
            memo: Some("the pantry"),
        }
        .emit();
        Self {
            token,
            cfg: config,
            genesis: now_secs(),
            treasury,
            treasury_accrued: 0,
            judge_keys,
            pup: Pup::default(),
            top: Vec::new(),
            history: Vector::new(Key::History),
            jokes: Vector::new(Key::Jokes),
            pending_jokes: 0,
            escrow: 0,
            carers: LookupMap::new(Key::Carers),
            gen_points: LookupMap::new(Key::GenPoints),
            burned: 0,
            best_age_secs: 0,
            best_generation: 0,
            guests: 0,
            guest_window_start: 0,
            guest_window_count: 0,
            council_rotated_gen: 0,
        }
    }

    fn check_config(c: &Config) {
        require!(c.day_secs > 0 && c.full_drain_secs > 0 && c.mood_decay_secs > 0, "bad times");
        require!(c.start_fullness > 0 && c.start_fullness <= FULL, "bad start_fullness");
        require!(c.fish_points > 0 && c.fish_points <= FULL, "bad fish_points");
        require!(c.min_hunger < FULL, "bad min_hunger");
        require!(c.feed_max_ppm <= 50_000, "feed_max_ppm too high");
        require!(c.joke_ppm.len() == 11, "joke_ppm needs 11 entries");
        require!(c.joke_ppm.iter().all(|p| *p <= 50_000), "joke_ppm too high");
        require!(c.laugh_threshold >= 1 && c.laugh_threshold <= 10, "bad laugh_threshold");
        require!(c.starve_burn_bps <= 5_000, "starve_burn_bps too high");
        require!(!c.themes.is_empty(), "need at least one theme");
        require!(c.max_joke_len >= 10 && c.max_joke_len <= 500, "bad max_joke_len");
        require!(
            c.relayer_tip.as_yoctonear() <= c.joke_fee.as_yoctonear(),
            "tip exceeds joke fee"
        );
        require!(!c.model.is_empty() && !c.rubric.is_empty(), "judge request incomplete");
        let probe = format!("{{\"a\":0{}{}}}", if c.request_extra.is_empty() { "" } else { "," }, c.request_extra);
        require!(serde_json::from_str::<Value>(&probe).is_ok(), "request_extra is not valid JSON members");
    }

    // ------------------------------------------------------------------ the pup

    fn pantry(&self) -> u128 {
        self.token.accounts.get(&env::current_account_id()).unwrap_or(0)
    }

    fn age_days(&self, at: u64) -> u32 {
        (at.saturating_sub(self.pup.born_at) / self.cfg.day_secs as u64) as u32
    }

    /// Belly drain per second at time `at`, in belly units.
    fn drain_per_sec(&self, at: u64) -> u128 {
        let days = self.age_days(at).min(self.cfg.drain_growth_cap_days) as u128;
        let mult_bps = 10_000u128 + days * self.cfg.drain_growth_bps as u128;
        (FULL as u128 * mult_bps / (self.cfg.full_drain_secs as u128 * 10_000)).max(1)
    }

    /// The pup as he is at `now`, plus the moment he swam away if that already happened.
    fn project(&self, now: u64) -> (Pup, Option<u64>) {
        let mut p = self.pup.clone();
        if !p.present || now <= p.updated_at {
            return (p, None);
        }
        let mood_lost = (now - p.updated_at) as u128 * FULL as u128 / self.cfg.mood_decay_secs as u128;
        p.mood = (p.mood as u128).saturating_sub(mood_lost) as u64;
        // Hunger is paused while he naps.
        let drain_start = p.updated_at.max(p.nap_until.min(now));
        let rate = self.drain_per_sec(drain_start);
        let drained = (now - drain_start) as u128 * rate;
        if drained >= p.fullness as u128 {
            let secs_left = (p.fullness as u128).div_ceil(rate) as u64;
            p.fullness = 0;
            p.updated_at = now;
            return (p, Some(drain_start + secs_left));
        }
        p.fullness -= drained as u64;
        p.updated_at = now;
        (p, None)
    }

    /// Brings stored state up to `now`. If he starved in the meantime, he is gone.
    fn sync(&mut self, now: u64) {
        let (p, starved_at) = self.project(now);
        self.pup = p;
        if let Some(left_at) = starved_at {
            self.farewell(left_at);
        }
    }

    fn farewell(&mut self, left_at: u64) {
        let me = env::current_account_id();
        let burn = mul_div(self.pantry(), self.cfg.starve_burn_bps as u128, 10_000);
        if burn > 0 {
            self.token.internal_withdraw(&me, burn);
            self.burned += burn;
            FtBurn { owner_id: &me, amount: U128(burn), memo: Some("the pup swam away") }.emit();
        }
        let age = left_at.saturating_sub(self.pup.born_at);
        if age > self.best_age_secs {
            self.best_age_secs = age;
            self.best_generation = self.pup.generation;
        }
        let record = GenRecord {
            generation: self.pup.generation,
            born_at: self.pup.born_at,
            left_at,
            feeds: self.pup.feeds,
            laughs: self.pup.laughs,
            carers: self.pup.carers,
            burned: U128(burn),
            top: self.top.clone(),
        };
        event("swam_away", json!({"generation": record.generation, "age_secs": age, "burned": U128(burn)}));
        self.history.push(record);
        self.pup.present = false;
        self.pup.left_at = left_at;
    }

    fn arrive(&mut self, now: u64) {
        self.pup = Pup {
            generation: self.pup.generation + 1,
            present: true,
            born_at: now,
            fullness: self.cfg.start_fullness,
            mood: FULL / 2,
            updated_at: now,
            nap_until: 0,
            lullaby_ready_at: 0,
            feeds: 0,
            laughs: 0,
            carers: 0,
            left_at: self.pup.left_at,
        };
        self.top.clear();
        event("arrived", json!({"generation": self.pup.generation}));
    }

    fn ensure_pup(&mut self, now: u64) {
        self.sync(now);
        if !self.pup.present {
            self.arrive(now);
        }
    }

    fn age_bonus(&self, now: u64, amount: u128) -> u128 {
        let days = self.age_days(now).min(self.cfg.age_bonus_cap_days) as u128;
        mul_div(amount, 10_000 + days * self.cfg.age_bonus_bps as u128, 10_000)
    }

    /// Treat for one fish, given a pup state. Rises with the square of his hunger.
    fn feed_reward_for(&self, p: &Pup, now: u64) -> u128 {
        let hunger = (FULL - p.fullness) as u128;
        let base = mul_div(self.pantry(), self.cfg.feed_max_ppm as u128, 1_000_000);
        let by_hunger = mul_div(mul_div(base, hunger, FULL as u128), hunger, FULL as u128);
        let by_age = self.age_bonus(now, by_hunger);
        let mood_bps = 10_000 + mul_div(self.cfg.mood_bonus_max_bps as u128, p.mood as u128, FULL as u128);
        mul_div(by_age, mood_bps, 10_000)
    }

    fn pay_from_pantry(&mut self, to: &AccountId, amount: u128, memo: &str) {
        if amount == 0 {
            return;
        }
        if self.token.accounts.get(to).is_none() {
            self.token.internal_register_account(to);
        }
        let me = env::current_account_id();
        self.token.internal_transfer(&me, to, amount, Some(memo.to_string()));
    }

    fn carer_mut(&mut self, who: &AccountId) -> Carer {
        self.carers.get(who).cloned().unwrap_or_default()
    }

    fn add_points(&mut self, who: &AccountId, points: u32) {
        let key = (self.pup.generation, who.clone());
        let before = self.gen_points.get(&key).copied();
        if before.is_none() {
            self.pup.carers += 1;
        }
        let total = before.unwrap_or(0) + points;
        self.gen_points.insert(key, total);
        if let Some(e) = self.top.iter_mut().find(|e| &e.account_id == who) {
            e.points = total;
        } else {
            self.top.push(TopEntry { account_id: who.clone(), points: total });
        }
        self.top.sort_by(|a, b| b.points.cmp(&a.points));
        self.top.truncate(TOP_N);
    }

    /// Give the pup a fish. Costs `fish_price` NEAR, which goes to the colony treasury.
    /// Pays ARF from the pantry: the hungrier he was, the more.
    /// If the floe is empty, a new pup arrives first.
    #[payable]
    pub fn feed(&mut self) -> U128 {
        let now = now_secs();
        let who = env::predecessor_account_id();
        let paid = env::attached_deposit().as_yoctonear();
        let price = self.cfg.fish_price.as_yoctonear();
        require!(paid >= price, "a fish costs more than that");
        self.ensure_pup(now);
        let hunger = FULL - self.pup.fullness;
        require!(hunger >= self.cfg.min_hunger, "he is full, come back when he is hungry");

        let reward = self.feed_reward_for(&self.pup, now);
        self.pup.fullness = (self.pup.fullness + self.cfg.fish_points).min(FULL);
        self.pup.feeds += 1;
        self.pay_from_pantry(&who, reward, "a treat for a fish");

        let points = (hunger * 100 / FULL) as u32;
        self.add_points(&who, points.max(1));
        let mut c = self.carer_mut(&who);
        c.feeds += 1;
        c.points += points.max(1);
        c.earned = U128(c.earned.0 + reward);
        self.carers.insert(who.clone(), c);

        self.treasury_accrued += price;
        if paid > price {
            Promise::new(who.clone()).transfer(NearToken::from_yoctonear(paid - price)).detach();
        }
        event(
            "fed",
            json!({"by": who, "generation": self.pup.generation, "hunger_bps": hunger * 10_000 / FULL, "reward": U128(reward)}),
        );
        U128(reward)
    }

    /// Burn `lullaby_cost` ARF to sing him to sleep: his hunger pauses for `lullaby_secs`.
    pub fn lullaby(&mut self) {
        let now = now_secs();
        let who = env::predecessor_account_id();
        self.sync(now);
        require!(self.pup.present, "there is no pup to sing to");
        require!(now >= self.pup.lullaby_ready_at, "he just woke up, let him play");
        let cost = self.cfg.lullaby_cost.0;
        self.token.internal_withdraw(&who, cost);
        self.burned += cost;
        FtBurn { owner_id: &who, amount: U128(cost), memo: Some("a lullaby") }.emit();
        self.pup.nap_until = now + self.cfg.lullaby_secs as u64;
        self.pup.lullaby_ready_at = self.pup.nap_until + self.cfg.lullaby_cooldown_secs as u64;
        event("lullaby", json!({"by": who, "nap_until": self.pup.nap_until}));
    }

    /// Anyone may call this to record that the pup has swum away (it also happens by itself on
    /// the next `feed` or `tell_joke`).
    pub fn poke(&mut self) {
        self.sync(now_secs());
    }

    // ------------------------------------------------------------------ jokes

    fn day(&self, now: u64) -> u32 {
        (now.saturating_sub(self.genesis) / self.cfg.day_secs as u64) as u32
    }

    /// Tell the pup a joke. Costs `joke_fee` NEAR. The verdict arrives through `judge`.
    #[payable]
    pub fn tell_joke(&mut self, text: String) -> u32 {
        let now = now_secs();
        let who = env::predecessor_account_id();
        let fee = self.cfg.joke_fee.as_yoctonear();
        require!(env::attached_deposit().as_yoctonear() == fee, "attach exactly the joke fee");
        let text = text.trim().to_string();
        require!(!text.is_empty(), "that is not a joke, that is silence");
        require!(text.len() <= self.cfg.max_joke_len as usize, "too long, seals have short attention spans");
        require!(!text.chars().any(|c| c.is_control() && c != '\n'), "no control characters");
        self.ensure_pup(now);

        let day = self.day(now);
        let mut c = self.carer_mut(&who);
        if c.joke_day != day {
            c.joke_day = day;
            c.jokes_today = 0;
        }
        require!(c.jokes_today < self.cfg.jokes_per_day, "that is enough jokes for today");
        c.jokes_today += 1;
        c.jokes += 1;
        self.carers.insert(who.clone(), c);

        let id = self.jokes.len();
        let theme = (day as usize % self.cfg.themes.len()) as u16;
        self.jokes.push(Joke {
            id,
            author: who.clone(),
            text,
            theme,
            told_at: now,
            status: JokeStatus::Pending,
            score: 0,
            quip: String::new(),
            reward: U128(0),
            judged_at: 0,
            relayer: None,
            key_index: 0,
            response_hash: String::new(),
            signature: Base64VecU8(Vec::new()),
        });
        self.pending_jokes += 1;
        self.escrow += fee;
        event("joke_told", json!({"id": id, "by": who}));
        id
    }

    /// The exact bytes that must be POSTed to NEAR AI Cloud `/v1/chat/completions` for this joke.
    /// Built from contract state only, so nobody can change the model, the rubric or the joke.
    pub fn judge_request(&self, joke_id: u32) -> String {
        let joke = self.jokes.get(joke_id).unwrap_or_else(|| env::panic_str("no such joke"));
        judge::request_body(&self.cfg, joke)
    }

    /// Deliver the judge's answer. Anyone can call this: the contract accepts it only if
    /// `signature` is a registered judge key's signature over
    /// `<model>:<sha256(request)>:<sha256(response)>`, where the request is `judge_request`.
    /// `response` is the raw, unmodified HTTP response body.
    pub fn judge(&mut self, joke_id: u32, response: Base64VecU8, signature: Base64VecU8, key_index: u32) -> Joke {
        let now = now_secs();
        let relayer = env::predecessor_account_id();
        let mut joke = self.jokes.get(joke_id).unwrap_or_else(|| env::panic_str("no such joke")).clone();
        require!(joke.status == JokeStatus::Pending, "this joke already has an ending");
        let key = self
            .judge_keys
            .get(key_index as usize)
            .unwrap_or_else(|| env::panic_str("no such judge key"));
        let request = judge::request_body(&self.cfg, &joke);
        require!(
            judge::verify(key, &self.cfg.model, request.as_bytes(), &response.0, &signature.0),
            "the signature does not match this joke's request and response"
        );
        let (score, quip) = judge::parse_verdict(&response.0);

        self.ensure_pup(now);
        let mut reward = 0u128;
        let laughed = score >= self.cfg.laugh_threshold;
        if laughed {
            let base = mul_div(self.pantry(), self.cfg.joke_ppm[score as usize] as u128, 1_000_000);
            reward = self.age_bonus(now, base);
            let gain = (score - self.cfg.laugh_threshold + 1) as u64 * self.cfg.mood_per_point;
            self.pup.mood = (self.pup.mood + gain).min(FULL);
            self.pup.laughs += 1;
            self.pay_from_pantry(&joke.author, reward, "a treat for a laugh");
            self.add_points(&joke.author, score as u32 * 10);
        }
        let mut c = self.carer_mut(&joke.author);
        if laughed {
            c.laughs += 1;
            c.points += score as u32 * 10;
            c.earned = U128(c.earned.0 + reward);
        }
        c.best_score = c.best_score.max(score);
        self.carers.insert(joke.author.clone(), c);

        joke.status = JokeStatus::Judged;
        joke.score = score;
        joke.quip = quip;
        joke.reward = U128(reward);
        joke.judged_at = now;
        joke.relayer = Some(relayer.clone());
        joke.key_index = key_index;
        joke.response_hash = judge::hex(&env::sha256(&response.0));
        joke.signature = signature;
        self.jokes.replace(joke_id, joke.clone());
        self.pending_jokes -= 1;

        let fee = self.cfg.joke_fee.as_yoctonear();
        let tip = self.cfg.relayer_tip.as_yoctonear();
        self.escrow -= fee;
        self.treasury_accrued += fee - tip;
        if tip > 0 {
            Promise::new(relayer).transfer(NearToken::from_yoctonear(tip)).detach();
        }
        event(
            "judged",
            json!({"id": joke_id, "by": joke.author, "score": score, "laughed": laughed, "reward": U128(reward)}),
        );
        joke
    }

    /// If no verdict came within `joke_timeout_secs`, the author gets the fee back.
    pub fn refund_joke(&mut self, joke_id: u32) {
        let now = now_secs();
        let mut joke = self.jokes.get(joke_id).unwrap_or_else(|| env::panic_str("no such joke")).clone();
        require!(joke.status == JokeStatus::Pending, "this joke already has an ending");
        require!(now >= joke.told_at + self.cfg.joke_timeout_secs as u64, "the judge may still answer");
        joke.status = JokeStatus::Refunded;
        let fee = self.cfg.joke_fee.as_yoctonear();
        self.escrow -= fee;
        self.pending_jokes -= 1;
        Promise::new(joke.author.clone()).transfer(NearToken::from_yoctonear(fee)).detach();
        self.jokes.replace(joke_id, joke);
        event("joke_refunded", json!({"id": joke_id}));
    }

    // ------------------------------------------------------------------ judge keys and treasury

    /// Only the colony treasury (a DAO) can register the public keys of the judge.
    pub fn add_judge_key(&mut self, key: JudgeKey) -> u32 {
        require!(env::predecessor_account_id() == self.treasury, "only the colony can change judge keys");
        key.check();
        self.judge_keys.push(key);
        event("judge_key_added", json!({"index": self.judge_keys.len() - 1}));
        (self.judge_keys.len() - 1) as u32
    }

    /// Keys are disabled, never deleted, so old verdicts keep pointing at the key that signed them.
    pub fn disable_judge_key(&mut self, index: u32) {
        require!(env::predecessor_account_id() == self.treasury, "only the colony can change judge keys");
        let key = self.judge_keys.get_mut(index as usize).unwrap_or_else(|| env::panic_str("no such judge key"));
        key.disabled = true;
        event("judge_key_disabled", json!({"index": index}));
    }

    /// Send the collected fish and joke fees to the colony treasury. Anyone can call.
    pub fn flush_treasury(&mut self) -> Promise {
        let amount = self.treasury_accrued;
        require!(amount > 0, "nothing to send");
        self.treasury_accrued = 0;
        event("treasury_flushed", json!({"amount": U128(amount), "to": self.treasury}));
        Promise::new(self.treasury.clone()).transfer(NearToken::from_yoctonear(amount))
    }

    // ------------------------------------------------------------------ guests

    /// Creates `g-<hash of key>.<this contract>` controlled by `public_key` and gives it a little
    /// NEAR for fish, so a visitor can play without a wallet. Rate limited.
    pub fn welcome_guest(&mut self, public_key: PublicKey) -> AccountId {
        let now = now_secs();
        if now >= self.guest_window_start + 3600 {
            self.guest_window_start = now;
            self.guest_window_count = 0;
        }
        require!(self.guest_window_count < self.cfg.guests_per_hour, "too many guests this hour, try later");
        let grant = self.cfg.guest_grant.as_yoctonear();
        // Never spend what is owed (pending joke fees, the treasury's share) or what pays for storage.
        let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        let committed = self.escrow + self.treasury_accrued + storage + NearToken::from_millinear(500).as_yoctonear();
        require!(
            env::account_balance().as_yoctonear() >= committed + grant,
            "the guest budget is empty"
        );
        let id = self.guest_account_id(&public_key);
        self.guest_window_count += 1;
        self.guests += 1;
        if self.token.accounts.get(&id).is_none() {
            self.token.internal_register_account(&id);
        }
        Promise::new(id.clone())
            .create_account()
            .add_full_access_key(public_key)
            .transfer(NearToken::from_yoctonear(grant))
            .detach();
        event("guest", json!({"account_id": id}));
        id
    }

    fn guest_account_id(&self, public_key: &PublicKey) -> AccountId {
        let digest = env::sha256(public_key.as_bytes());
        format!("g-{}.{}", judge::hex(&digest[..6]), env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("guest name too long for this contract account"))
    }

    pub fn guest_id_for(&self, public_key: PublicKey) -> AccountId {
        self.guest_account_id(&public_key)
    }

    // ------------------------------------------------------------------ views

    pub fn get_config(&self) -> Config {
        self.cfg.clone()
    }

    pub fn get_treasury(&self) -> AccountId {
        self.treasury.clone()
    }

    pub fn get_judge_keys(&self) -> Vec<JudgeKey> {
        self.judge_keys.clone()
    }

    pub fn get_state(&self) -> StateView {
        let now = now_secs();
        let (p, starved_at) = self.project(now);
        let present = p.present && starved_at.is_none();
        let age_secs = if present { now.saturating_sub(p.born_at) } else { 0 };
        let age_days = (age_secs / self.cfg.day_secs as u64) as u32;
        let leaves_at = if present {
            let start = now.max(p.nap_until);
            start + (p.fullness as u128).div_ceil(self.drain_per_sec(start)) as u64
        } else {
            0
        };
        let pantry = self.pantry();
        // What the pantry will hold once the pending farewell is recorded.
        let pantry_after = if starved_at.is_some() {
            pantry - mul_div(pantry, self.cfg.starve_burn_bps as u128, 10_000)
        } else {
            pantry
        };
        let feed_reward = if present {
            self.feed_reward_for(&p, now)
        } else {
            // A fresh pup arrives at `start_fullness`.
            let hunger = (FULL - self.cfg.start_fullness) as u128;
            let base = mul_div(pantry_after, self.cfg.feed_max_ppm as u128, 1_000_000);
            let by_hunger = mul_div(mul_div(base, hunger, FULL as u128), hunger, FULL as u128);
            mul_div(by_hunger, 10_000 + self.cfg.mood_bonus_max_bps as u128 / 2, 10_000)
        };
        let top_joke = mul_div(pantry_after, self.cfg.joke_ppm[10] as u128, 1_000_000);
        let day = self.day(now);
        let supply = self.token.total_supply;
        let pending_burn = pantry - pantry_after;
        StateView {
            now,
            generation: p.generation,
            present,
            born_at: p.born_at,
            age_secs,
            age_days,
            stage: match age_days {
                0..=1 => 0,
                2..=4 => 1,
                5..=9 => 2,
                _ => 3,
            },
            fullness_bps: if present { (p.fullness * 10_000 / FULL) as u32 } else { 0 },
            mood_bps: if present { (p.mood * 10_000 / FULL) as u32 } else { 0 },
            napping: present && now < p.nap_until,
            nap_until: p.nap_until,
            lullaby_ready_at: p.lullaby_ready_at,
            leaves_at,
            left_at: starved_at.unwrap_or(p.left_at),
            feeds: p.feeds,
            laughs: p.laughs,
            carers: p.carers,
            pantry: U128(pantry_after),
            total_supply: U128(supply - pending_burn),
            circulating: U128(supply - pantry),
            burned: U128(self.burned + pending_burn),
            feed_reward: U128(feed_reward),
            top_joke_reward: U128(if present { self.age_bonus(now, top_joke) } else { top_joke }),
            day,
            theme: self.cfg.themes[day as usize % self.cfg.themes.len()].clone(),
            best_age_secs: self.best_age_secs.max(if present { age_secs } else { 0 }),
            best_generation: self.best_generation,
            jokes: self.jokes.len(),
            pending_jokes: self.pending_jokes,
            generations_past: self.history.len(),
            treasury_accrued: U128(self.treasury_accrued),
            guests: self.guests,
        }
    }

    /// Leaderboard of the pup on the ice now.
    pub fn get_top(&self) -> Vec<TopEntry> {
        self.top.clone()
    }

    pub fn get_carer(&self, account_id: AccountId) -> Carer {
        self.carers.get(&account_id).cloned().unwrap_or_default()
    }

    pub fn get_joke(&self, joke_id: u32) -> Option<Joke> {
        self.jokes.get(joke_id).cloned()
    }

    /// Newest first.
    pub fn get_jokes(&self, skip: Option<u32>, limit: Option<u32>) -> Vec<Joke> {
        let total = self.jokes.len();
        let skip = skip.unwrap_or(0).min(total);
        let limit = limit.unwrap_or(20).min(50);
        (0..total - skip).rev().take(limit as usize).filter_map(|i| self.jokes.get(i).cloned()).collect()
    }

    /// Ids of jokes still waiting for a verdict, oldest first (for relayers).
    pub fn get_pending_jokes(&self, limit: Option<u32>) -> Vec<u32> {
        let limit = limit.unwrap_or(20).min(50) as usize;
        let total = self.jokes.len();
        // Pending jokes are recent: scan the newest 200 only.
        let mut ids: Vec<u32> = (total.saturating_sub(200)..total)
            .filter(|i| self.jokes.get(*i).map(|j| j.status == JokeStatus::Pending).unwrap_or(false))
            .collect();
        ids.truncate(limit);
        ids
    }

    /// Past pups, newest first.
    pub fn get_history(&self, skip: Option<u32>, limit: Option<u32>) -> Vec<GenRecord> {
        let total = self.history.len();
        let skip = skip.unwrap_or(0).min(total);
        let limit = limit.unwrap_or(10).min(50);
        (0..total - skip).rev().take(limit as usize).filter_map(|i| self.history.get(i).cloned()).collect()
    }
}

// ---------------------------------------------------------------------- NEP-141 / NEP-145 / NEP-148

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            self.burned += burned;
        }
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        require!(
            env::predecessor_account_id() != env::current_account_id(),
            "the pantry cannot be unregistered"
        );
        if let Some((_, balance)) = self.token.internal_storage_unregister(force) {
            self.burned += balance;
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Arf".to_string(),
            symbol: "ARF".to_string(),
            icon: Some(ICON.to_string()),
            reference: None,
            reference_hash: None,
            decimals: 18,
        }
    }
}

const ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%23bfe6ff'/%3E%3Cellipse cx='32' cy='38' rx='20' ry='17' fill='%23fff'/%3E%3Ccircle cx='25' cy='33' r='3.4' fill='%231d2b3a'/%3E%3Ccircle cx='39' cy='33' r='3.4' fill='%231d2b3a'/%3E%3Cellipse cx='32' cy='40' rx='3' ry='2' fill='%231d2b3a'/%3E%3C/svg%3E";
