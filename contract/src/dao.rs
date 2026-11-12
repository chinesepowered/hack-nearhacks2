//! The colony: a Sputnik DAO that receives every fish and joke fee.
//!
//! Nobody votes on who sits on its council. Seats are earned: once per pup day anyone can call
//! `rotate_council`, and this contract proposes and approves (through its own narrowly scoped
//! `pup` role in the DAO) a new `council` role holding the top carers. The council can spend the
//! treasury and register judge keys; it cannot change the DAO's policy, so it cannot unseat the
//! rule that seated it.

use crate::{event, now_secs, Contract, ContractExt};
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseError, PromiseOrValue};

/// How many carers get a seat.
pub const COUNCIL_SIZE: usize = 5;

/// What a council member may do in the DAO: spend, call other contracts, hold signalling votes.
const COUNCIL_PERMISSIONS: [&str; 5] = ["transfer:*", "call:*", "vote:*", "add_bounty:*", "bounty_done:*"];

fn council_role(members: &[AccountId]) -> Value {
    json!({
        "ChangePolicyAddOrUpdateRole": {
            "role": {
                "name": "council",
                "kind": {"Group": members},
                "permissions": COUNCIL_PERMISSIONS,
                "vote_policy": {}
            }
        }
    })
}

#[near]
impl Contract {
    /// Seat the best carers as the colony's council. Anyone can call, once per pup day.
    /// Takes the leaderboard of the pup on the ice, or of the last pup if the floe is empty.
    pub fn rotate_council(&mut self) -> Promise {
        let now = now_secs();
        self.sync(now);
        let day = self.day(now);
        require!(day >= self.council_next_day, "the council was already seated today");
        let board = if self.pup.present || self.history.is_empty() {
            self.top.clone()
        } else {
            self.history.get(self.history.len() - 1).map(|g| g.top.clone()).unwrap_or_default()
        };
        let members: Vec<AccountId> = board.iter().take(COUNCIL_SIZE).map(|e| e.account_id.clone()).collect();
        require!(!members.is_empty(), "nobody has cared for a pup yet");
        self.council_next_day = day + 1;

        let kind = council_role(&members);
        let args = json!({
            "proposal": {
                "description": format!("Seat the top carers of pup #{} as the council", self.pup.generation),
                "kind": kind
            }
        });
        Promise::new(self.treasury.clone())
            .function_call(
                "add_proposal".to_string(),
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(30),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(80))
                    .on_council_proposed(kind.to_string(), members, day),
            )
    }

    #[private]
    pub fn on_council_proposed(
        &mut self,
        #[callback_result] proposal_id: Result<u64, PromiseError>,
        kind: String,
        members: Vec<AccountId>,
        day: u32,
    ) -> PromiseOrValue<bool> {
        let Ok(id) = proposal_id else {
            // The DAO refused (for example: this contract has no `pup` role there). Allow a retry.
            self.council_next_day = day;
            event("council_failed", json!({"step": "add_proposal"}));
            return PromiseOrValue::Value(false);
        };
        let args = format!("{{\"id\":{},\"action\":\"VoteApprove\",\"proposal\":{},\"memo\":null}}", id, kind);
        PromiseOrValue::Promise(
            Promise::new(self.treasury.clone())
                .function_call("act_proposal".to_string(), args.into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(40))
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(Gas::from_tgas(10))
                        .on_council_seated(id, members, day),
                ),
        )
    }

    #[private]
    pub fn on_council_seated(
        &mut self,
        #[callback_result] voted: Result<(), PromiseError>,
        proposal_id: u64,
        members: Vec<AccountId>,
        day: u32,
    ) -> bool {
        if voted.is_err() {
            self.council_next_day = day;
            event("council_failed", json!({"step": "act_proposal", "proposal_id": proposal_id}));
            return false;
        }
        event("council_seated", json!({"proposal_id": proposal_id, "members": members}));
        self.council = members;
        true
    }

    /// The council as last seated by this contract.
    pub fn get_council(&self) -> Vec<AccountId> {
        self.council.clone()
    }
}
