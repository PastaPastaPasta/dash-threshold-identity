# Protocol (`dti/1`)

## Keys from the seed phrase

Each member has a BIP39 mnemonic and an optional passphrase. `seed = BIP39-seed(mnemonic, passphrase)` (64 bytes).
Everything else is derived from it, with no randomness:

```
kdf(label, parts…, L) = HKDF-SHA256(ikm = seed, salt = "dash-threshold-identity/v1",
                                    info = lp(label) ‖ lp(part₁) ‖ …, L)
lp(x) = u32be(len(x)) ‖ x                 (numbers are encoded as u32be first)
scalar(label, parts…) = first nonzero  OS2IP(kdf(label, parts…, counter, 64)) mod r,  counter = 0, 1, …
```

| Secret | Derivation |
|---|---|
| Message-signing key (Ed25519) | `kdf("auth/ed25519")` |
| Transport key (X25519) | `kdf("transport/x25519")` |
| DKG polynomial coefficient *k* for ceremony *cid*, slot *s* | `scalar("dkg/coefficient", cid, s, k)` |
| Schnorr nonce for the proof of knowledge | `scalar("nonce/pok", cid, s, index, a₀)` |
| Document-create entropy | `kdf("document/entropy", contractId, nonce, type, properties)` |
| Core funding address | BIP32 `m/44'/coin'/0'/0/0` (coin 5 mainnet, 1 testnet) |
| Asset-lock credit key, identity registration *i* | DIP-9 `m/9'/coin'/5'/1'/i'` |
| Asset-lock credit key, top-up *i* | DIP-9 `m/9'/coin'/5'/2'/i'` |

A member's fingerprint is `SHA-256("dti-fingerprint|authPub|transportPub")`, taking the first 10 bytes in 5 groups. Members compare fingerprints over a channel they trust before accepting a ceremony; this pins every member's keys.

Because the DKG polynomial depends on the ceremony id, and the ceremony id hashes the whole roster with its indices, a member never reuses a polynomial across different rosters. Re-running the same ceremony gives the same bytes, which is harmless. So a share never has to be stored: it is recomputed from the seed and the ceremony's public messages.

## Messages

Every message is a signed envelope:

```
{ v: 1, room, type, from: authPub, at, body, sig }
sig = Ed25519(authSecret, "dti/1|envelope|" ‖ canonical-json({v, room, type, from, at, body}))
id  = SHA-256(canonical-json(envelope))
```

Canonical JSON sorts keys, has no whitespace, and allows only safe integers. A room is an append-only set of envelopes. The state is a deterministic function of that set: messages are processed by type and then by time, so the order they arrive in does not matter. Invalid signatures and wrong-room messages are ignored.

| Type | Body | Notes |
|---|---|---|
| `hello` | `name, transportPub` | joins the room |
| `config` | the ceremony config | only from the config's organizer. `cid = SHA-256(canonical({ceremony: config}))` |
| `accept` | `cid` | every participant must accept before key generation starts |
| `dkg-commit` | `cid, digest` | `digest = SHA-256(canonical({reveal}))`. A second, different commit fails the ceremony |
| `dkg-reveal` | `cid, reveal` | must match the commit. Honest clients reveal only after all *n* commits are visible |
| `dkg-complete` | `cid, transcript, keys{slot: groupPublicKey, publicSharesDigest}` | |
| `dkg-complaint` | `cid, against, slot, reason` | any complaint fails the ceremony |
| `proposal` | `network, intent, unsigned, signable, requirements[{cid, slot}], derived, note` | |
| `approve` | `proposalId, shares{"cid/slot": {index, share}}` | |
| `reject` | `proposalId, reason` | |
| `broadcast` | `proposalId, result` | the executor's report, checked against Platform |

## Key ceremony (joint-Feldman DKG with commit-then-reveal)

The ceremony config fixes the network, the threshold *t*, the members with indices 1..n and their keys, and the key slots (`slot, keyId, purpose, securityLevel`). For each slot, member *i*:

1. Derives `fᵢ(x) = aᵢ₀ + aᵢ₁x + … + aᵢ,ₜ₋₁xᵗ⁻¹` from its seed.
2. Builds its reveal:
   - the Feldman commitments `Cᵢₖ = aᵢₖ·G1`;
   - a Schnorr proof of knowledge of `aᵢ₀`, bound to (cid, slot, i);
   - for every *j ≠ i*, `fᵢ(j)` encrypted to *j* with ChaCha20-Poly1305. The key and nonce come from `HKDF(X25519(i, j), "dti/1/box", lp("dkg-share", cid, slot, i, j, pubᵢ, pubⱼ))`, so each key encrypts exactly one message. The receiver computes the context itself.
3. Commits to the hash of the reveal. Once all *n* commits are visible, it publishes the reveal. Committing first stops a member from choosing their polynomial after seeing everyone else's; the most a late member can do is abort.
4. Checks every other member's reveal: the proof of knowledge, the commitment count, and a nonzero top coefficient. It decrypts its own share from each and checks `fᵢ(j)·G1 = Σₖ Cᵢₖ·jᵏ`. Any failure produces a complaint.
5. Computes:
   - its share `sⱼ = Σᵢ fᵢ(j)`;
   - the group key `Y = Σᵢ Cᵢ₀`;
   - every member's public share `Yⱼ = Σᵢ Σₖ Cᵢₖ·jᵏ`.

   It checks that the joint polynomial has degree exactly *t−1*, then publishes `dkg-complete` with a transcript digest over all reveal digests.

The ceremony is complete only when all *n* completions agree with the transcript and keys a member computes locally. A relay that shows different members different messages causes a mismatch (the ceremony fails) or a stall. It cannot produce an agreed key.

No code path adds up secrets at x = 0, except a test that rebuilds a throwaway key to show the scheme equals plain BLS.

## Signing

Platform verifies BLS12-381 signatures in the IETF "basic" scheme: public keys in G1, signatures in G2, ciphersuite `BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_`, over the raw signable bytes of the transition.

A share's signature is `σⱼ = sⱼ·H(m)`. Each share is checked against its public share with `e(σⱼ, g1) = e(H(m), Yⱼ)`. Any *t* valid shares interpolate to `σ = Σ λⱼ·σⱼ`, which is checked against `Y` before broadcast. BLS signing is deterministic, so a retry with the same bytes is a duplicate transaction. A retry needs new bytes, for example `userFeeIncrease`.

### Proposals

A proposal carries the **intent** (a small JSON description), the unsigned transition, and the bytes to sign. Each signer's client:

1. Rebuilds the transition from the intent with the pinned SDK and requires byte equality with `unsigned` and `signable`.
2. Decodes `unsigned` with the SDK and shows it.
3. Checks:
   - the group keys and slots;
   - the network;
   - the purpose and security level the transition needs;
   - on Platform, that the signing key is the identity's, enabled and equal to the group key, and that nonces and revisions are current.
4. Only then publishes its share.

Requirements are per ceremony and slot, so one proposal can need shares from several ceremonies. For example, a rotation needs the old MASTER plus proofs of possession for each new key. Anyone can combine and broadcast; for identity creation that is the funder, who also signs the asset-lock proof. Executors confirm the outcome with proved reads, not only the broadcast reply.

## Trust and failure model

- **Custody.** No process ever holds a group secret. Fewer than *t* members learn nothing about it.
- **Authorization.** A signer signs only bytes it rebuilt from an intent it read. A malicious proposer can propose, but cannot get signatures for bytes other than the ones it describes.
- **Relay.** Untrusted. It sees all public messages, but key shares are encrypted end to end. It can withhold messages (a liveness problem), not forge or alter them.
- **Robustness.** None. A bad share aborts the ceremony with a complaint that names the sender; the group then reruns it without that member. This suits small groups of known members.
- **Removed members** keep old shares. Rotation disables the old keys on chain, which is what revokes them.
- **Loss.** With *t* of *n*, losing *n−t+1* seed phrases loses the key. MASTER is what changes keys, so losing it freezes the identity's key set.
