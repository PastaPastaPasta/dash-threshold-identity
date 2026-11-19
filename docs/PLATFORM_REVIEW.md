# Platform support and mainnet readiness

Reviewed against `dashpay/platform` **v5.0.3**, the release mainnet and testnet both run (checked 2026-11-19: drive 5.0.3, protocol 14 on both, chain ids `evo1` and `dash-testnet-51`). The client uses `@dashevo/evo-sdk` 5.0.3. Line references are to the v5.0.3 tag.

## Verdict

Everything this tool does is supported on mainnet as it runs today:

- identity create;
- top-up;
- identity update (add and disable keys, including MASTER rotation);
- data contract create and update;
- document create, replace and delete;
- credit transfer;
- credit withdrawal.

Every transition was exercised on testnet on the same software; see [TESTNET_E2E.md](TESTNET_E2E.md). Platform needs no change: a threshold key is an ordinary BLS12-381 identity key.

There is one hard condition: **protocol version 14 or later**. Before protocol 14, Platform accepted any well-formed BLS signature without checking it (details below). Mainnet and testnet are both at 14, and protocol versions only go up.

## What the source says

**BLS keys are allowed for every identity-signed transition.** The signature check accepts `ECDSA_SECP256K1`, `BLS12_381` and `ECDSA_HASH160` (`rs-drive-abci/.../validate_state_transition_identity_signed/v0/mod.rs:36`), then checks purpose, security level and disabled status, and verifies.

**Each transition has a required key purpose and security level:**

| Transition | Purpose | Security level | Key in the default layout |
|---|---|---|---|
| Identity update | AUTHENTICATION | MASTER | 0 |
| Data contract create | AUTHENTICATION | CRITICAL or HIGH | 1 |
| Data contract update | AUTHENTICATION | CRITICAL | 1 |
| Document batch | AUTHENTICATION | CRITICAL, HIGH or MEDIUM (and the document type's own requirement) | 2 |
| Credit transfer | TRANSFER | CRITICAL | 3 |
| Credit withdrawal | TRANSFER (or OWNER) | CRITICAL | 3 |

**Key structure.** AUTHENTICATION keys may be MASTER, CRITICAL, HIGH or MEDIUM, and TRANSFER keys must be CRITICAL, with no restriction on key type (`validate_identity_public_keys_structure/v0/mod.rs:22-36`). Identity create needs exactly one MASTER key. BLS keys are 48 bytes.

**Signature scheme.** Platform uses `dashcore::blsful`, pinned to `dashpay/agora-blsful@0c34a7a` in `Cargo.lock`, the same revision as 5.0.0-beta.6 and rc.4:

- curve `Bls12381G2Impl`, with public keys in G1 and signatures in G2;
- verified as `Signature::Basic` (IETF basic, NUL ciphersuite) over the raw signable bytes (`rs-dpp/src/bls/native_bls.rs:36`; key proofs at `rs-dpp/src/signing.rs:82`);
- identity points are refused.

This is not Dash Core's legacy BLS scheme. The tool's noble-based signer matches it byte for byte (`test/core.test.mjs`: a threshold signature equals a plain basic signature under the rebuilt throwaway key), and testnet accepted the signatures.

**A BLS signature must verify, from protocol 14 on.** `verify_identity_signed_signature` generation 1 refuses a BLS signature that does not verify. Generation 0 (protocols 1–13) discarded the verdict and accepted any well-formed one. Protocol 14 selects generation 1 (`rs-platform-version/src/version/v14.rs:2796`). Testnet confirmed this: forged two-share, one-share and wrongly indexed signatures all came back with **20002 Invalid State Transition signature**.

**Proofs of possession.** Every key added by identity create or identity update signs the transition's signable bytes as proof that the key's holder can sign (`rs-dpp/src/signing.rs`). For a threshold key, that is a threshold signature by the new key's group, which the tool collects alongside the MASTER signature in the same proposal.

**Uniqueness.** BLS12_381 is a unique key type (`key_type.rs:93`): a group key can be on only one identity. Each identity needs its own ceremony; a group key cannot be reused.

## Behaviours to plan for on mainnet

- **Contract updates cost the full registration fee again.** Drive charges an update for the whole contract (`rs-drive-abci/src/execution/types/execution_event/mod.rs:378`), and the balance pre-check wants that amount up front. Testnet measured about 12.0e9 credits per create or update for a one-type contract (0.1 DASH base + 0.02 DASH per document type). Keep the identity's balance above the next update's cost. A top-up needs no signatures from the group.
- **BLS is deterministic.** Rebroadcasting the same signed bytes is a duplicate transaction. A retry needs new bytes (`--fee-increase`), and so a new signing round.
- **Nonces.** Identity nonce (identity update, contract create, transfer, withdrawal) and identity-contract nonce (contract update, documents) are part of the signed bytes. One proposal per nonce stream can be in flight. The reviewer checks they are current, and a refused transition does not use up its nonce.
- **Some results come back as an affected-state snapshot.** Contract updates, transfers, withdrawals and top-ups return one instead of an execution proof. The tool treats such a reply as success only after a proved read shows the nonce (or balance) advanced.
- **Withdrawals** go to a Core P2PKH address and are paid by Platform's withdrawal process. On testnet the 5e9-credit withdrawal reached the Core address within minutes.
- **Rotation.** One identity update can add a new MASTER and disable the old one; this ran on testnet. Disabling is what revokes a removed member's old share.

## SDK and tooling notes

- The JS SDK has no BLS signer of its own; its BLS module is a stub. The tool builds unsigned transitions with the SDK, signs outside it, and sets the signature bytes. Proofs of possession are attached through `IdentityPublicKeyInCreation.signature`.
- Document ids: the id a `Document` object reports before it goes into a create transition is not the final one. The tool reads the id from the built batch.
- Builders must be byte-identical across members. The SDK version is pinned (`@dashevo/evo-sdk` 5.0.3), and the proposal records the protocol version it was built for. A member on a different SDK build gets a clear refusal instead of a silent mismatch.

## Mainnet checklist

1. Each member creates a **fresh** seed phrase for this group, writes it down twice and stores the copies apart.
2. Run the ceremony on `--network mainnet`. Read every fingerprint over a call before accepting.
3. Rehearse first: a testnet ceremony with the same members and the full flow (create, contract, update, rotation).
4. The funder locks enough for the identity and the first contract plus one update (about 0.12 DASH each for a one-type contract, more per extra type), using `dti identity create --confirm-mainnet`.
5. Keep the room's message log (relay or exported bundle) somewhere durable. Together with a seed phrase it is what rebuilds a share.
6. Use a threshold that survives losing members: 3-of-5 tolerates two losses. MASTER is the recovery key.
