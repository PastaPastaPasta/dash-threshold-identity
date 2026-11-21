# Testnet end-to-end run (2026-11-19)

Network: Dash testnet, Platform 5.0.3, protocol 14. Client: `@dashevo/evo-sdk` 5.0.3.

The main run used [`scripts/e2e-testnet.sh`](../scripts/e2e-testnet.sh) at commit `468ab61`, which has every functional fix in this PR. The commits after it change only the local Node relay, how much the UI re-renders, and which broadcast report the identity list trusts. The unit tests cover those changes, plus a browser run of the final UI (row 11).

Six seed phrases were generated for the run: five members plus one extra member who joins later and also funds a top-up. Every key below came from them. Each member ran as a separate process with its own seed file and home directory. They exchanged messages through this repo's Cloudflare Worker relay running under `wrangler dev` (workerd).

## Result: everything passed

- **Identity**: `GSv2XVR4yJguY1trogMTZCDNCvc56qc7KYw7cYwRgEQ6`. It ends at revision 1 with 8 BLS keys; keys 0–3 were disabled by the rotation. A proved read shows every on-chain key equal to its group key.
- **Contract**: `5m2isGBAXhPKdoL7tAMki3s1tM4pDX1jWVYso4oNbBj`. Owner is the identity above; version 3.
- Every executed proposal was confirmed by a proved read of the change it made: the identity's keys, the contract's version, the document, or the nonce. The broadcast reply alone was not taken as proof.

### Key ceremonies

| Ceremony | Members (index) | Keys (key id) |
|---|---|---|
| `f287f03f…` 3-of-5 | alice 1, bob 2, carol 3, dave 4, erin 5 | master 0, critical 1, high 2, transfer 3 |
| `564ebf1e…` rotation, 3-of-5 | alice 1, carol 2, dave 3, erin 4, frank 5 (bob removed) | master 4, critical 5, high 6, transfer 7 |

### Transitions, all signed by threshold keys

Signer numbers are member indices within the ceremony that owns the key.

| # | Transition | Signing key: signers | Proposed by | Broadcast by | Transition hash |
|---|---|---|---|---|---|
| 1 | Identity create from a 1.5 tDASH asset lock (four proofs of possession) | 0, 1, 2, 3: 2,3,5 | alice, the funder | alice | `43b44f31…a1e4` |
| 2 | Contract create (`note` v1) | critical 1: 1,3,4 | bob | erin | `29b12d65…29bf` |
| 3 | Contract update to v2 | critical 1: 2,4,5 | carol | alice | `4b42e4b3…2943` |
| 4 | Document create | high 2: 1,2,3 | dave | erin | `3e6fb711…0d95` |
| 5 | Document replace | high 2: 1,3,4 | erin | bob | `138f773d…2c17` |
| 6 | Document delete | high 2: 1,4,5 | bob | carol | `d24f61d1…d443` |
| 7 | Credit transfer, 1e9 credits | transfer 3: 2,3,4 | alice | erin | `952f1d0a…a3f2` |
| 8 | Credit withdrawal, 5e9 credits to a Core address | transfer 3: 1,2,5 | carol | dave | `cb139c80…c2e8` |
| 9 | **Rotation** in one transition: add keys 4–7, each with a proof of possession from the new group, and disable 0–3 | master 0: 1,3,4, plus 1,2,3 of the new group for each new key | dave | erin | `78f35de7…761b` |
| 10 | Contract update to v3, by the rotated group | critical 5: 1,4,5 (alice, erin, frank) | frank | carol | `ef2ab2d2…de32` |
| 11 | Document create, **entirely in the web UI** at the final commit (propose, sign, broadcast) | high 6: 1,2,4 | carol (UI) | carol (UI) | `ee7a06c2…15df` |

The approvals for rows 1 and 9 add keys, so they needed `--accept-new-keys`. Before that, the review listed each new key's ceremony, members and threshold.

**Funding.** Frank's seed-derived Core address funded a 0.1 tDASH top-up. A proved read showed the balance rise from 107,493,869,704 to 117,485,858,284 credits.

### Refusals (`scripts/testnet-refusals.mjs`, broadcast to testnet on purpose)

| Attempt | Platform's answer |
|---|---|
| Contract v4 signed with two CRITICAL shares interpolated | **20002** Invalid State Transition signature |
| Contract v4 signed with one share alone | **20002** |
| Contract v4 signed with three shares under a wrong index | **20002** |
| Contract v4 signed by the **disabled** pre-rotation CRITICAL key, with a *valid* 3-of-5 signature from bob (removed) and two others | **20006** Identity key 1 is disabled |
| A proposal whose bytes differ from its stated intent | refused at review: the bytes do not match the intent when rebuilt independently |

The contract stayed at version 3 after all of them. Each forged signature also failed the local verifier before the script broadcast it anyway.

### Across machines

On commit `f73f965`, three members on separate machines ran a 2-of-3 ceremony through the relay: a macOS laptop, a second macOS machine and a Linux VM. They then added that key to an identity with the group's MASTER and signed a document 2-of-3 with it. Both transitions were confirmed on chain. The two remote machines started with only their seed phrase and rebuilt their shares from the relay's message log.

The later commits change the completion message and the relay's membership rules, and the main run above covers both. They don't change how machines connect.

### Costs (measured as balance changes)

- Identity create: about 0.12e9 credits.
- Contract create or update for a one-type contract: about 12.0e9 credits each, since every update pays the registration fee again.
- Documents, transfers, withdrawals and identity updates: 0.01–0.1e9 credits each.

## Hosted testnet app (2026-11-21)

[`scripts/web-e2e.mjs`](../scripts/web-e2e.mjs) drove https://new-multisig.dashhq.org (the build in [HOSTED.md](HOSTED.md)) with three separate Chromium profiles, one per member, each holding only its own seed phrase in page memory. Alice and Bob used 1440×900 windows; Carol used a 390×844 phone viewport. All messages went through the relay on the same origin.

| Step | Who | Result |
|---|---|---|
| Room `030e24c1…`, joins | alice creates; bob, carol join | 3 members, fingerprints shown |
| Key ceremony `08b19842…`, 2-of-3, four keys | alice proposes; all accept and run the DKG | complete in about 10 s |
| Asset lock, 0.5 tDASH from alice's seed-derived address | alice's page builds, signs and broadcasts it through Insight | tx `5e872c36…099a`, chain-locked at 1595997 |
| Identity create, four proofs of possession | bob and carol review and sign; alice combines, signs the asset-lock proof and broadcasts | identity `9EFgF9HEz73m3TA57MRXwtBDBM5htfTKBj1tRbWFwrVm` |
| Credit transfer, 1e8 credits to `GSv2XVR4…EQ6` | bob proposes; carol and alice sign with the TRANSFER key; carol broadcasts | executed, nonce 1 |

The page's proved read shows the four on-chain keys equal to the group keys. A separate Node process confirmed the identity's four BLS keys, nonce 1 and a balance 103,516,000 credits lower after the transfer (1e8 plus the fee). No page errors and no CSP violations from the app occurred; the one blocked script was Cloudflare's zone-injected analytics beacon, which the Worker now prevents with `Cache-Control: no-transform`.

## Earlier runs

The same steps ran three earlier times that day on earlier commits of this branch. Each run turned up fixes, which are now in this PR:

- **Document id:** the SDK reports a different id before the create transition is built; the tool now reads it from the built batch.
- **Snapshot replies:** some transitions return an affected-state snapshot instead of an execution proof; they are now confirmed by proved reads.
- **Stale local state:** some commands acted on a stale local log; proposal and identity commands now sync first.
- **Hardening from code review:**
  - strict intent schemas;
  - completions that name their reveals;
  - complaints judged on evidence;
  - membership-pinned relay rooms;
  - safer asset-lock handling.
