# Testnet end-to-end run (2026-11-19)

Network: Dash testnet, Platform 5.0.3, protocol 14. Tool: this repository at the code in this PR, `@dashevo/evo-sdk` 5.0.3. Most steps are scripted in [`scripts/e2e-testnet.sh`](../scripts/e2e-testnet.sh). The cross-machine and web-UI steps were run by hand on top of it.

Six seed phrases were generated for the run: five members plus one extra member who joins later and also funds a top-up. Every key below came from them. The relay was this repo's Cloudflare Worker running under `wrangler dev` (workerd).

Most members ran as separate processes, each with its own seed file and home directory. The last steps used three separate machines: a macOS laptop, a second macOS machine, and a Linux VM. The two remote machines started from empty state, holding only their own seed phrase. They rebuilt their key shares from the relay's message log.

## Result: everything passed

- **Identity**: `8n9cYCaBfrCfu9pqMeELVSuVDa5JQhMmkmoHBpsYmQCN`. At the end it has 9 BLS keys; keys 0–3 were disabled by the rotation. A proved read shows every on-chain key equal to its group key.
- **Contract**: `Bm2gJyijuRxE3hg8Ab4YW6efJidX3jVMaV4vcVdoiWA5`. Owner is the identity above; version 3.
- Every executed proposal was confirmed by a proved read of the change it made: the identity's keys, the contract's version, the document, or the nonce. The broadcast reply alone was not taken as proof.

### Key ceremonies

| Ceremony | Members (index) | Keys (key id) |
|---|---|---|
| `e218d495…` 3-of-5 | alice 1, bob 2, carol 3, dave 4, erin 5 | master 0, critical 1, high 2, transfer 3 |
| `6f686f24…` rotation, 3-of-5 | alice 1, carol 2, dave 3, erin 4, frank 5 (bob removed) | master 4, critical 5, high 6, transfer 7 |
| `6caa4694…` 2-of-3, one member per machine | alice 1 (laptop), dave 2 (second Mac), erin 3 (Linux VM) | ops 8 (HIGH) |

### Transitions, all signed by threshold keys

Signer numbers are member indices within the ceremony that owns the key.

| # | Transition | Signing key: signers | Proposed by | Broadcast by | Transition hash |
|---|---|---|---|---|---|
| 1 | Identity create from a 1.5 tDASH asset lock (four proofs of possession) | 0, 1, 2, 3: 2,3,5 (bob, carol, erin) | alice, the funder | alice | `c3ed77a4…6122` |
| 2 | Contract create (`note` v1) | critical 1: 1,3,4 | bob | erin | `34e0467b…7909` |
| 3 | Contract update to v2 | critical 1: 2,4,5 | carol | alice | `5bfa64ea…5ab2` |
| 4 | Document create | high 2: 1,2,3 | dave | erin | `6b94f042…afb5` |
| 5 | Document replace | high 2: 1,3,4 | erin | bob | `8a387520…ab36` |
| 6 | Document delete | high 2: 1,4,5 | bob | carol | `294329fd…7734` |
| 7 | Credit transfer, 1e9 credits | transfer 3: 2,3,4 | alice | erin | `72adacc5…0a40` |
| 8 | Credit withdrawal, 5e9 credits to a Core address | transfer 3: 1,2,5 | carol | dave | `63aca9d8…aa42` |
| 9 | **Rotation** in one transition: add keys 4–7, each with a proof of possession from the new group, and disable keys 0–3 | master 0: 1,3,4, plus 1,2,3 of the new group for each new key | dave | erin | `089c3c1e…5d70` |
| 10 | Contract update to v3, by the rotated group | critical 5: 1,4,5 (alice, erin, frank) | frank | carol | `5be7d0b1…f062` |
| 11 | Add the ops key, signed from three machines | master 4: 1,3,4, plus ops 8: 1,2 | dave (second Mac) | erin (Linux VM) | `1358f164…54fe` |
| 12 | Document create signed 2-of-3 by ops | ops 8: 1,2 (laptop, second Mac) | erin (Linux VM) | alice (laptop) | `16fb69b9…4f5b` |
| 13 | Document create, **entirely in the web UI** (propose, sign, broadcast) | high 6: 1,2,4 | carol (UI) | carol (UI) | `e29d0cc7…7636` |

Every signing approval that added keys (rows 1, 9 and 11) needed `--accept-new-keys`. Before that, the review listed each new key's ceremony, members and threshold.

**Funding.**
- Frank, from his seed-derived Core address, made a 0.1 tDASH top-up. A top-up needs no group signature, and a proved read showed the balance rise from 107,494,284,264 to 117,486,288,304 credits.
- The withdrawal in row 8 was paid on Core to frank's address. Its balance ended at 1 − 0.1 (top-up lock and fee) + 0.04999810 tDASH.

### Refusals (`scripts/testnet-refusals.mjs`, broadcast to testnet on purpose)

| Attempt | Platform's answer |
|---|---|
| Contract v4 signed with two CRITICAL shares interpolated | **20002** Invalid State Transition signature |
| Contract v4 signed with one share alone | **20002** |
| Contract v4 signed with three shares under a wrong index | **20002** |
| Contract v4 signed by the **disabled** pre-rotation CRITICAL key, with a *valid* 3-of-5 signature from bob (removed) and two others | **20006** Identity key 1 is disabled |
| A proposal whose bytes differ from its stated intent | refused at review: the bytes do not match the intent when rebuilt independently |

The contract stayed at version 3 after all of them. Each forged signature also failed the local verifier before the script broadcast it anyway.

### Costs (measured as balance changes)

- Identity create: about 0.12e9 credits.
- Contract create or update for a one-type contract: about 12.0e9 credits each, since every update pays the registration fee again.
- Documents, transfers, withdrawals and identity updates: 0.01–0.1e9 credits each.

## Earlier run

An earlier run the same day, on a pre-review version of this branch, covered the same ground plus the same three-machine segment. It found and fixed three problems:

- The SDK reports a different document id before a create transition is built; the tool now reads the id from the built batch.
- Some transitions return an affected-state snapshot instead of an execution proof; the tool now confirms them with proved reads.
- Commands sometimes acted on a stale local log; identity and proposal commands now sync first.
