# Testnet end-to-end run (2026-11-19)

Network: Dash testnet, Platform 5.0.3, protocol 14. Tool: this repository (`dti` CLI and web UI), `@dashevo/evo-sdk` 5.0.3.

Six seed phrases were generated for the run: five members plus one extra member who joins later and also funds a top-up. Every key below came from them. The relay was this repo's Cloudflare Worker running under `wrangler dev` (workerd). Later steps ran on three machines:

- the laptop, which reached the relay locally;
- a Mac Studio, which reached it over the tailnet;
- a Linux VM, "agentbox", which reached it through an SSH tunnel.

The two remote machines started from empty state. Each had only its own seed phrase, and rebuilt its shares from the relay's message log.

## Result: everything passed

- **Identity**: `7nVXwBc8CH98WmLBHWbE3QooBhEdw5j6Eqie3MN39fKY`. Revision 2 at the end, with 9 BLS keys; keys 0–3 are disabled after the rotation.
- **Contract**: `5iHLV5fYCpb4QJKqKJCvTLhme2WzJu97sWgiVsYUo2r`. Owner is the identity above; version 3.

### Key ceremonies

| Ceremony | Members | Keys (key id) |
|---|---|---|
| `4ed57ee4…` initial, 3-of-5 | alice, carol, dave, erin, bob | master 0, critical 1, high 2, transfer 3 |
| `59b88165…` rotation, 3-of-5 | alice, carol, dave, erin, frank (bob removed) | master 4, critical 5, high 6, transfer 7 |
| `bf58bf27…` ops, 2-of-3, across three machines | alice (laptop), dave (Mac Studio), erin (agentbox) | ops 8 (HIGH) |

Each ceremony took 7–10 seconds. Every member ended with the same group keys. The proved identity read shows every on-chain key equal to its group key.

### Transitions, all signed by threshold keys

Signer numbers are member indices within the ceremony that owns the key. Proposer, signers and executor are all different people in most rows.

| # | Transition | Key | Proposed by | Signed by | Broadcast by | Transition hash |
|---|---|---|---|---|---|---|
| 1 | Identity create (four proofs of possession) from a 1.5 tDASH asset lock | 0, 1, 2, 3 | alice (funder) | bob, carol, erin | alice | `1166bcce…857d` |
| 2 | Contract create (`note` v1) | critical 1 | bob | alice, carol, dave | erin | `450f00dc…5624` |
| 3 | Contract update to v2 (adds `mood`) | critical 1 | carol | bob, dave, erin | alice | `cb9cb2d2…9c1b` |
| 4 | Document create | high 2 | dave | alice, bob, carol | erin | `fb2684c2…37f1` |
| 5 | Document replace (revision 2) | high 2 | erin | carol, dave, alice | bob | `2f892d26…8005` |
| 6 | Document delete | high 2 | bob | erin, alice, dave | carol | `aaa68fdd…0b6e` |
| 7 | Credit transfer, 1e9 credits | transfer 3 | alice | bob, carol, dave | erin | `077a3158…91fe` |
| 8 | Credit withdrawal, 5e9 credits to a Core address | transfer 3 | carol | alice, erin, bob | dave | `6f9fcce5…bc26` |
| 9 | **Rotation**: add keys 4–7 (each with a threshold proof), disable 0–3, one transition | master 0 + new 4–7 | dave | alice, carol, dave | erin | `6ee0629b…dc52` |
| 10 | Contract update to v3, by the rotated group | critical 5 | frank | frank, erin, alice | carol | `de1ddf37…5cdc` |
| 11 | Document create, by the rotated group | high 6 | carol | frank, dave, erin | alice | `dc220c0b…f8bb` |
| 12 | Document create, **entirely through the web UI** (propose, sign, broadcast) | high 6 | carol (UI) | carol (UI), alice, erin | carol (UI) | `996703e5…e1ce` |
| 13 | Add the ops key, signed from three machines | master 4 + ops 8 | dave (Mac Studio) | dave, erin (agentbox), alice (laptop) | erin (agentbox) | `d1fd0c19…cd9c` |
| 14 | Document create signed 2-of-3 by ops | ops 8 | erin (agentbox) | dave (Mac Studio), alice (laptop) | alice | `79e58380…33d8` |

There were also two top-ups, 0.2 and 0.1 tDASH, from frank's seed-derived Core address. A top-up needs no group signature, and both were confirmed by proved balance.

The withdrawal (row 8) was paid on Core: frank's address went from 1.00000000 to 1.04999810 tDASH before the top-ups spent from it.

### Refusals (`scripts/testnet-refusals.mjs`, broadcast to testnet on purpose)

| Attempt | Platform's answer |
|---|---|
| Contract v4 signed with two CRITICAL shares interpolated | **20002** Invalid State Transition signature |
| Contract v4 signed with one share alone | **20002** |
| Contract v4 signed with three shares under a wrong index | **20002** |
| Contract v4 signed by the **disabled** pre-rotation CRITICAL key, with a *valid* 3-of-5 signature from bob (removed) and two others | **20006** Identity key 1 is disabled |
| A proposal whose bytes differ from its stated intent | refused at review: the bytes do not match the intent when rebuilt independently |

The contract stayed at version 3 after all of them.

Every forged signature failed the local verifier before it was broadcast; the script broadcast it anyway to see Platform's answer.

### Costs (measured as balance changes)

- Identity create from a 1.5 tDASH lock: about 0.12e9 credits.
- Contract create or update for a one-type contract: about 12.0e9 credits each (the registration fee, charged again on every update).
- Documents, transfer, withdrawal and identity updates: 0.01–0.1e9 credits each.

## Things this run found and fixed

- The SDK reports a document id from `Document` that differs from the id in the built create transition. The tool now reads it from the batch. Row 4's journal still shows the old id (`9PD2…`); the document's real id is `6yEdCSmv…`.
- Contract updates, transfers, withdrawals and top-ups return an affected-state snapshot, not an execution proof. `execute` and `identity topup` now confirm the change with a proved read (the nonce or balance) before reporting success.
- Members who joined with a stale local log could not find the identity. Identity commands now sync first.
