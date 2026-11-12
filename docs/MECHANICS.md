# Mechanics

Everything here is enforced by [`contract/src`](../contract/src). Numbers are for the live game
(`arf-pup.testnet`); the fast-forward game (`arf-demo.testnet`) uses the same rules with shorter
times. Both parameter sets are in [`scripts/presets.mjs`](../scripts/presets.mjs) and readable
on-chain with `get_config`.

## 1. What exists

- **The pantry.** 1,000,000,000 ARF (18 decimals), minted once into the contract's own balance.
  There is no mint method. ARF leaves the pantry as treats or is burned; nothing else.
- **The pup.** At most one at a time. He has a belly and a mood (0 to 100%), a birth time, and a
  generation number. Belly and mood are stored with a timestamp and recomputed on every call, so
  the chain needs no cron job: `get_state` always returns the values as of now.
- **The colony.** A Sputnik DAO that receives all fees.

## 2. Feeding

`feed()` with 0.01 NEAR attached.

```
hunger  = 100% - belly
treat   = pantry × 0.03% × hunger² × age bonus × mood bonus
age bonus  = 1 + 5% per day he has lived (at most ×2)
mood bonus = 1 + 50% × mood
belly  += 25% (capped at 100%)
```

He refuses fish when his hunger is under 5%, so a full pup cannot be farmed.

**Why hunger squared.** The treat for the next fish is a price that rises the longer nobody
shows up. A colony that is paying attention feeds early and cheaply, so little ARF leaves the
pantry. A colony that is asleep has to be paid more to come back. Emission follows attention
without anyone setting a rate.

It is also a game of chicken. Waiting makes your own fish worth more, until somebody else feeds
first (your treat shrinks) or nobody does (everyone loses 10% of the pantry).

## 3. Neglect

His belly empties in 12 hours when he is newborn, and 5% faster for each day he has lived (at
most twice as fast). When it reaches zero he swims away:

- 10% of the pantry is burned (total supply falls, and it shows in `ft_total_supply`);
- his record goes into the history (how long he lived, fish, laughs, carers, top carers);
- the floe stays empty. **There is exactly one burn per neglected pup**, however long nobody
  comes back.

The next `feed` or `tell_joke` calls a new pup, who arrives half full and in a so-so mood.

Because he gets hungrier as he grows, keeping a streak alive gets harder every day. The longest
life so far is on the page as the record to beat.

## 4. Jokes and the judge

1. `tell_joke(text)` with 0.02 NEAR. At most 280 bytes, 5 per account per day. The fee is held
   by the contract until the joke has an ending.
2. `judge_request(joke_id)` returns the exact bytes of a NEAR AI Cloud chat-completion request,
   built only from contract state:

   ```
   {"model":"z-ai/glm-5.3-flash","messages":[{"role":"system","content":<the rubric>},
    {"role":"user","content":"Theme of the day: <theme>\nJoke: <text>"}],
    "temperature":0,"seed":<joke id>,"max_tokens":200,"stream":false,"reasoning_effort":"low"}
   ```

   The rubric, the model and the theme list are part of the immutable config.
3. Anyone (a "relayer") POSTs those bytes to `https://cloud-api.near.ai/v1/chat/completions`
   and fetches the response signature from `/v1/signature/<id>`. NEAR AI Cloud runs the model in
   a TEE, and the TEE signs the text `<model>:<sha256(request)>:<sha256(response)>`.
4. The relayer calls `judge(joke_id, response, signature, key_index)`. The contract:
   - rebuilds the request itself and hashes it (it never trusts a request from the relayer);
   - hashes the delivered response;
   - verifies the signature over `<model>:<request hash>:<response hash>` against the registered
     judge key (`env::ed25519_verify`, or EIP-191 `ecrecover` for an ECDSA key);
   - reads `{"score": 0..10, "quip": "..."}` out of the response.
5. A score of 7 or more is a laugh. It pays 0.005% / 0.01% / 0.02% / 0.04% of the pantry for a
   7 / 8 / 9 / 10 (times the age bonus), and lifts his mood by 10% per point from 7 up.
   Below 7 nothing is paid.
6. The relayer gets a 0.005 NEAR tip out of the fee; the rest goes to the colony.
7. If no verdict arrives within 30 minutes, `refund_joke` returns the fee to the author.

The contract stores the response hash and the signature with each joke, so anyone can re-check a
verdict later from chain data alone: `node scripts/verify-verdict.mjs --name arf-pup --joke 0`,
or the "Check it yourself" button on the page.

What a relayer can and cannot do: it can deliver a verdict or not. It cannot change the model,
the rubric, the joke, the score or who gets paid. See [THREAT_MODEL.md](THREAT_MODEL.md) for the
one thing it can try (asking twice).

## 5. Mood, age and lullabies

- **Mood** fades from 100% to zero over 12 hours. Laughs lift it. A happy pup pays up to 50% more
  for fish, so jokes are a public good: your laugh raises everybody's next treat.
- **Age** raises both his appetite and his generosity. A long-lived pup is worth more to the
  colony and harder to keep.
- **Lullaby.** Burn 50,000 ARF to pause his hunger for 30 minutes (two-hour cooldown). It is the
  token's sink, and the colony's tool for a night when nobody is around.

## 6. The colony

- Fish and joke fees accumulate in the contract; `flush_treasury` (anyone) sends them to the DAO.
- `rotate_council` (anyone, once per pup day) takes the top 5 carers of the pup on the ice (or of
  the last pup if the floe is empty) and has the contract propose and approve, in one
  transaction, a new `council` role in the DAO holding exactly those accounts.
- The contract's own role in the DAO (`pup`) has two permissions:
  `policy_add_or_update_role:AddProposal` and `:VoteApprove`. It cannot move money.
- The council can spend the treasury (`transfer`), call contracts (`call`), hold signalling votes
  and run bounties. It cannot change the DAO's policy, so it cannot undo the rule that seated it.
- The DAO is also the only account allowed to register or disable judge keys in the Arf contract
  (`add_judge_key`, `disable_judge_key`), which is how a rotated TEE key would be handled.

Points: a fish scores the pup's hunger at that moment (1 to 100); a laugh scores ten times the
joke's score. Feeding a starving pup counts for more than topping up a full one.

## 7. Guests

`welcome_guest(public_key)` creates `g-<hash>.arf-pup.testnet` with that key and 0.15 testnet
NEAR. The page calls it with a public function-call key that can call nothing else. It is rate
limited (20 per hour) and never spends fees owed to the colony, pending joke fees, or the NEAR
that pays for the contract's storage.

A transaction has to prepay all the gas attached to it, and a guest holds a fraction of a NEAR.
So the page attaches small limits (10 to 15 Tgas; 60 for `rotate_council`), and the contract
reserves only about 60 Tgas for its two DAO calls and callbacks. Measured use is 3 to 5 Tgas per
call, about 11 Tgas for a council rotation.

## 8. Who gains from what

- **Carers** earn ARF and want the pup alive: a burn takes 10% of their future treats.
- **Holders** see supply shrink when a pup is lost and grow when he is cared for. They cannot
  cause a loss: the only way to lose a pup is for nobody to feed him, and anyone can.
- **Relayers** earn the tip per delivered verdict, which pays for the inference.
- **Emission slows by itself.** Every treat is a share of what is left, so the pantry never
  empties and there is no halving schedule. In the 60-day simulation a devoted colony releases
  about 24% of the supply; a colony that lets pups die releases about 8% and burns 39 to 54%.
  See [SIMULATION.md](SIMULATION.md).

## 9. Parameters

| | Live (`arf-pup`) | Fast-forward (`arf-demo`) |
| --- | --- | --- |
| A pup day | 24 hours | 10 minutes |
| Newborn's belly lasts | 12 hours | 4 minutes |
| Mood fades in | 12 hours | 8 minutes |
| Lullaby / cooldown | 30 min / 2 hours | 40 s / 60 s |
| Joke refund after | 30 minutes | 90 seconds |
| Jokes per account per day | 5 | 20 |
| Guests per hour | 20 | 60 |
| Everything else | identical | identical |
