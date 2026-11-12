# Arf: one seal pup, raised by everyone

Arf is a memecoin on NEAR testnet that nobody can buy from the contract and nobody was given.
The whole supply sits in a pantry owned by the contract, and it only comes out when somebody
looks after one shared, on-chain seal pup:

- **Feed him.** A fish costs 0.01 NEAR. The hungrier he is, the more ARF the fish earns.
- **Make him laugh.** Tell him a joke. An AI judge running on NEAR AI Cloud scores it, and the
  contract pays only after checking the judge's cryptographic signature itself.
- **Neglect him** and he swims away: 10% of the pantry is destroyed and the colony starts over
  with a new pup.

Every fee goes to a Sputnik DAO whose council is not elected. It is whoever cared for the pup most.

Built at NEAR HACKATHON, November 2026. Everything runs on **testnet**; ARF has no value.

| | |
| --- | --- |
| Play | https://chinesepowered.github.io/hack-nearhacks2/ (the same file is [`docs/index.html`](docs/index.html); or run it locally, see below) |
| Contract (real time) | [`arf-pup.testnet`](https://testnet.nearblocks.io/address/arf-pup.testnet) |
| Colony treasury | [`arf-pup-colony.sputnikv2.testnet`](https://testnet.nearblocks.io/address/arf-pup-colony.sputnikv2.testnet) (Sputnik DAO v3) |
| Contract (fast-forward, for demos) | [`arf-demo.testnet`](https://testnet.nearblocks.io/address/arf-demo.testnet): a belly lasts 4 minutes instead of 12 hours |
| First verdict checked on-chain | [`HTkt6q99…NvBR`](https://testnet.nearblocks.io/txns/HTkt6q99BferFEay37gFGHv6AkfN6d2sMUCWgNfYNvBR) |
| Mechanics, in full | [docs/MECHANICS.md](docs/MECHANICS.md) |
| 60-day simulation | [docs/SIMULATION.md](docs/SIMULATION.md) |
| What can go wrong | [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) |

## The problem

Most memecoins have no mechanic: supply is fixed or admin-controlled, and nothing a holder does
changes it. The ones that add an AI usually ask you to trust a server: someone's backend calls a
model and tells the contract what the model said.

Arf does two things about that.

1. **The supply follows what the community actually does.** Care moves ARF out of the pantry,
   neglect destroys it, and the rate adjusts by itself: the longer nobody feeds the pup, the more
   the next fish pays, until somebody shows up.
2. **The AI's answer is checked by the contract, not by us.** The contract writes the judge's
   request, anyone may carry it to the model and back, and the contract accepts the answer only
   if it bears the signature of the model's secure hardware over that exact request and response.

## How NEAR is used

| Piece | Where | What it does here |
| --- | --- | --- |
| NEAR AI Cloud (private inference in a TEE) | [`contract/src/judge.rs`](contract/src/judge.rs) | The judge model runs inside secure hardware and signs `<model>:<sha256(request)>:<sha256(response)>`. The contract rebuilds the request from its own state and verifies that signature with `env::ed25519_verify` (or `ecrecover` for ECDSA keys). |
| Function-call access keys | [`welcome_guest`](contract/src/lib.rs), [`scripts/deploy.mjs`](scripts/deploy.mjs) | A public "doorman" key can call exactly one method, which creates a guest account. Visitors play in seconds with no wallet, no seed phrase and no backend. |
| Named sub-accounts | `welcome_guest` | Each guest is `g-<hash of their key>.arf-pup.testnet`, created by the contract. |
| NEP-141, NEP-145, NEP-148 | [`contract/src/lib.rs`](contract/src/lib.rs) | ARF is a standard fungible token (`near-contract-standards`). |
| Sputnik DAO v3 | [`contract/src/dao.rs`](contract/src/dao.rs) | Fees go to the DAO. The contract holds a role there that can do one thing: replace the council with the pup's top carers. |

No oracle, indexer or server of ours sits between the page and the chain. The page is one static
HTML file that talks to NEAR RPC.

```
 browser (guest key) ──────────────▶ arf-pup.testnet ───── fees ────▶ arf-pup-colony.sputnikv2.testnet
        ▲   feed · tell_joke · lullaby      │   ▲                          (council = top carers)
        └────── get_dashboard (RPC) ────────┘   │ judge(joke, response, signature)
                                                │
                 anyone's relayer ──────────────┘◀──── NEAR AI Cloud (model in a TEE, signs the answer)
                 (carries bytes, cannot change them)
```

## Try it

### In the browser

1. Open the page. **See** the pup, how full his belly is, and how long until he swims away.
2. Click **Give a fish** (or **Call a pup with a fish** if the floe is empty). **See** a guest
   account appear in the top right within a few seconds, the pup eat, and your ARF balance rise.
   No wallet is involved.
3. Type a joke about the day's theme and click **Tell joke**. If a relayer is online, **see** the
   pup clap once per point, the score, his reply and your reward within about ten seconds.
   If no relayer is online the joke stays "waiting for the judge" and the fee is refundable after
   30 minutes; feeding is unaffected.
4. In **The verdict** card click **Check it yourself**. **See** the page rebuild the request,
   hash it and verify the judge's signature in your browser, using only data from the chain.
5. Scroll to **The colony**. **See** the DAO treasury balance and the seated council; **Seat the
   top carers** asks the contract to replace the council (once per pup day).

To watch a whole life cycle in minutes, build the page against the fast-forward game:
`node scripts/build-web.mjs --name arf-demo && npm run dev`.

### From a terminal (no keys, no funds)

Requires Rust 1.95+ with the `wasm32-unknown-unknown` target and Node 20+.

```sh
npm install

# 1. Unit tests: 35 pass. Five of them replay verdicts that NEAR AI Cloud really signed
#    (fixtures/), one of them the first joke judged on arf-pup.testnet, and two more show that a
#    tampered or misplaced verdict is rejected.
cd contract && cargo test && cd ..

# 2. Re-check a live verdict from chain data alone. Prints PASS for each step.
node scripts/verify-verdict.mjs --name arf-pup --joke 0

# 3. Play as a fresh guest against the live contract: creates a guest account through the
#    doorman key and feeds the pup (or reports that he is full).
node scripts/e2e.mjs --name arf-pup

# 4. Sixty simulated days of four colonies. Deterministic; rewrites docs/sim.csv and the chart.
node scripts/sim.mjs

# 5. Read the live state directly.
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"optimistic","account_id":"arf-pup.testnet","method_name":"get_state","args_base64":"e30="}}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Buffer.from(JSON.parse(s).result.result).toString()))'
```

### With a NEAR AI Cloud key (optional)

```sh
export NEAR_AI_API_KEY=...          # https://cloud.near.ai

# Tell a joke as a guest and deliver the judge's signed verdict yourself.
node scripts/e2e.mjs --name arf-pup --joke "I asked the tide for some space. It said it would get back to me. Twice a day."

# Or keep judging everybody's jokes. Each delivered verdict earns the relayer tip (0.005 NEAR).
# The relayer needs its own testnet account key in ./keys or in ARF_RELAYER_KEY.
node scripts/relayer.mjs --name arf-pup
```

### Run the page locally, or deploy your own game

```sh
npm run build:contract                              # contract/target/wasm32-unknown-unknown/release/arf.wasm
node scripts/deploy.mjs --name my-arf --preset demo   # faucet accounts, DAO, contract, doorman key, relayer account
node scripts/build-web.mjs --name my-arf && npm run dev   # http://localhost:4173
```

`deploy.mjs` needs nothing but network access: it funds itself from the public testnet faucet.

## The rules

All of these are fixed when the contract is created ([`scripts/presets.mjs`](scripts/presets.mjs));
there is no method that changes them. Values below are for `arf-pup.testnet`.

| Rule | Value |
| --- | --- |
| Supply | 1,000,000,000 ARF, all minted into the pantry. No allocation to anyone. |
| Belly | Empties in 12 hours for a newborn, 5% faster per day of age (up to twice as fast). |
| Fish | 0.01 NEAR, refills 25% of his belly. He refuses fish when more than 95% full. |
| Treat for a fish | `pantry × 0.03% × hunger² × (1 + 5% per day of age, max ×2) × (1 + up to 50% for mood)` |
| Neglect | Belly at zero: he swims away, 10% of the pantry burns, once. The next fish calls a new pup. |
| Joke | 0.02 NEAR, at most 280 bytes, 5 per account per day. |
| Treat for a joke | Score 7: 0.005% of the pantry, 8: 0.01%, 9: 0.02%, 10: 0.04%, times the age bonus. Below 7: nothing. |
| Mood | Each laugh lifts it; it fades over 12 hours. |
| Lullaby | Burn 50,000 ARF: he naps 30 minutes and does not get hungrier. |
| Fees | Fish and joke fees (minus a 0.005 NEAR tip to whoever delivers a verdict) go to the colony DAO. |
| Council | The top 5 carers of the pup on the ice, re-seated by anyone once per day. |

Why these shapes, and what a colony's behaviour does to supply over 60 days, is in
[docs/MECHANICS.md](docs/MECHANICS.md) and [docs/SIMULATION.md](docs/SIMULATION.md).

## What is not finished, stated plainly

- **The judge is online only while a relayer runs.** There is no always-on server. Feeding, the
  token, the DAO and the proofs work regardless; jokes wait, and are refundable.
  [`.github/workflows/relayer.yml`](.github/workflows/relayer.yml) can run one every five minutes
  if two repository secrets are set.
- **The judge's keys are registered, not proven on-chain.** They come from NEAR AI Cloud's public
  attestation report ([`scripts/judge-keys.mjs`](scripts/judge-keys.mjs), report saved in
  [`fixtures/attestation`](fixtures/attestation)). The contract verifies signatures against those
  keys; it does not verify the hardware attestation itself. Whoever registers keys (the deployer
  at creation, the DAO council afterwards) is trusted for that step.
- **A relayer could ask the judge more than once and deliver the answer it likes best.** The
  request fixes temperature 0 and a seed, rewards are small shares of the pantry and there is a
  daily quota, but this is reduced, not eliminated.
- **The deployer still holds the contract account's key** so that a bug found during judging can
  be fixed. Until it is deleted, "no owner" is a property of the code, not yet of the deployment.
- **Guest accounts are a testnet convenience.** The contract gives each guest 0.15 testnet NEAR.
  On mainnet that would be a faucet to farm; it would be removed.

More in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Repository layout

```
contract/        Rust contract (near-sdk 5.30): lib.rs (pup, pantry, token), judge.rs, dao.rs, tests.rs
web/             The page: app.js, seal.js (the pup), near-lite.js (keys, borsh transactions, RPC), style.css
scripts/         deploy.mjs, relayer.mjs, e2e.mjs, verify-verdict.mjs, colony.mjs, sim.mjs, judge-keys.mjs, presets.mjs
fixtures/        Verdicts really signed by NEAR AI Cloud, the judge's attestation report and keys
deployments/     Public details of the deployed games
docs/            index.html (the built page), MECHANICS.md, SIMULATION.md, THREAT_MODEL.md
```

## Where each track's theme shows up

| Track | In this project |
| --- | --- |
| Memecoins With Mechanics | The token is the mechanic: supply leaves the pantry only through care and jokes, burns on neglect, parameters immutable, simulated for 60 days. |
| Privacy & Private AI | A TEE-hosted model on NEAR AI Cloud is the judge, and its response signature is verified inside a NEAR contract and again in the browser. |
| Social Money | A Sputnik DAO holds the fees; seats are earned by care and assigned by the contract through a narrowly scoped role. |
| Games With Real Economies | One shared pet with its own wallet that pays the players; guests play without a wallet or gas prompts. |
| Open Innovation | A contract that treats an AI's answer as untrusted input and checks it. |

## Built with

- Rust, [near-sdk](https://github.com/near/near-sdk-rs) and near-contract-standards 5.30.
- [@noble/ed25519](https://github.com/paulmillr/noble-ed25519) and @noble/hashes for signing in the page; esbuild to bundle it.
- Fonts: Fredoka and Nunito (SIL Open Font License), embedded from @fontsource.
- NEAR AI Cloud model `z-ai/glm-5.3-flash` as the judge.
- Written during the hackathon window (12 to 14 November 2026) with an AI coding agent
  (Claude Code); no code predates the hackathon.

## Other submission by the same author

**Capybazaar** is a separate, independent project submitted to the same hackathon by the same
person. The two share no code.

## License

MIT, see [LICENSE](LICENSE).
