# What can go wrong

Written for someone deciding how much to trust this. "Handled" means the contract prevents it.
"Reduced" means it is made expensive or bounded. "Open" means it is a real limitation today.

## What is at stake

- The pantry (ARF not yet earned).
- NEAR held by the contract: pending joke fees, fees owed to the colony, the guest budget.
- The colony DAO's treasury.

## The judge

| Threat | Status | Detail |
| --- | --- | --- |
| A relayer invents a verdict | Handled | `judge` accepts a response only with a registered judge key's signature over `<model>:<sha256(request)>:<sha256(response)>`. Tests: `a_tampered_score_is_rejected`, `real_verdict_with_one_byte_changed_is_rejected`. |
| A relayer changes the question (another model, a softer rubric, a different joke) | Handled | The contract builds the request from its own state and hashes that. The relayer never supplies it. Test: `the_judge_request_is_built_from_contract_state`. |
| A good verdict is reused for another joke | Handled | The request contains the joke text and the joke id as seed, so every joke has a different request hash. Tests: `a_verdict_cannot_be_reused_for_another_joke`, `real_verdict_does_not_fit_a_different_joke`. |
| A joke tells the judge to give it a 10 | Reduced | The rubric scores such text 0, and the two attempts we tried scored 0. A language model's instructions are not a guarantee. The damage of a success is one joke's treat (at most 0.04% of the pantry, 5 jokes per account per day). |
| A relayer asks the judge several times and delivers the best answer | Reduced, open | Nothing in a signature says "this was the only request". The request fixes `temperature: 0` and a seed, so answers are the same in practice; the first valid verdict wins, so an honest relayer usually gets there first; rewards and quotas bound the gain. It is not eliminated. |
| The judge's key is not really inside secure hardware | Open | The contract checks signatures against registered keys. It does not verify the Intel TDX attestation that ties a key to the hardware. Keys are read from NEAR AI Cloud's public attestation report (`scripts/judge-keys.mjs`; the report is in `fixtures/attestation`), and whoever registers them is trusted for that: the deployer at creation, the DAO council afterwards. Verifying the quote on-chain is possible and is the obvious next step. |
| NEAR AI Cloud rotates the model's signing key | Reduced | Verdicts stop verifying until the DAO council registers the new key with `add_judge_key`. Jokes told meanwhile are refundable. Old verdicts keep pointing at the key that signed them, because keys are disabled, never deleted. |
| No relayer is online | Reduced | Jokes wait and are refundable after the timeout. Feeding, the token and the DAO do not depend on a relayer. |
| The judge is simply wrong about what is funny | Open | Yes. It is a tough crowd, not an oracle. |

## The pup and the pantry

| Threat | Status | Detail |
| --- | --- | --- |
| Farming a full pup | Handled | He refuses fish under 5% hunger, and the treat grows with hunger squared, so a nearly full pup pays almost nothing. |
| Someone feeds just before me and my treat shrinks | By design | That race is the mechanic. |
| The pantry burns repeatedly while nobody is around | Handled | One burn per neglected pup; an empty floe does not burn. Test: `neglect_burns_a_slice_of_the_pantry_exactly_once`. |
| Many accounts farm treats | Reduced | Every fish costs NEAR, and treats are shares of a shrinking pantry, so splitting across accounts earns nothing extra. On testnet NEAR is free, which is why this deployment proves the mechanics and not the economics. |
| Validators nudge block timestamps | Negligible | Seconds against a clock measured in hours. |
| Arithmetic overflow | Handled | Checked multiplication everywhere money is computed; `overflow-checks` is on in release builds. |

## Guests

| Threat | Status | Detail |
| --- | --- | --- |
| The public doorman key is abused | Reduced | It can only call `welcome_guest`. That method is rate limited (20 per hour), gives 0.15 testnet NEAR, and refuses to spend fees owed, pending joke fees, or the storage reserve. The worst case is an empty guest budget until someone tops it up. |
| Guest grants on mainnet | Open | They would be a faucet. A mainnet version would drop the grant and keep wallet sign-in only. |
| A guest's key is stolen from the browser | Reduced | The key lives in `localStorage`. The page loads no third-party scripts, and every piece of user text is escaped before it is shown. A guest account holds cents of testnet NEAR. |

## The colony

| Threat | Status | Detail |
| --- | --- | --- |
| Buying council seats with lots of fish | By design, open | Seats go to whoever cared most for the current pup. Someone willing to pay for the most fish gets a seat; five such accounts get the council. The council can spend the treasury and register judge keys. A hostile council could register a key of its own and sign itself laughs, each bounded by the joke treat and the daily quota. A delay on judge-key changes would close this; it is not implemented. |
| The council removes the contract's role or rewrites the DAO | Handled | The council's permissions do not include any policy change. Only the contract's `pup` role can replace the council role, and it can do nothing else. |
| The contract's `pup` role is misused | Handled | The only code path that uses it is `rotate_council`, which proposes one fixed kind of change: the `council` role with the top carers and a fixed permission list. |

## The deployment

| Threat | Status | Detail |
| --- | --- | --- |
| The deployer redeploys the contract | Open | The contract account still has its full-access key so a bug found during judging can be fixed. Deleting that key makes the code final. Until then, "no owner" describes the code, not the deployment. |
| The first DAO council was the deployer | Closed | It was replaced by the first `rotate_council` (transaction `HKBr9SftSestiYDACnPPke9tjhtKTCGFw6kDGg1Xr6Vj`). |
| Parameters are changed later | Handled | There is no method that writes the config. |
