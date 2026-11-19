# dash-threshold-identity

Run a Dash Platform identity as a **t-of-n multisig** with no one ever holding its keys.

The identity's keys are ordinary BLS12-381 keys as far as Platform is concerned. Behind each one is a group of people. They create the key together in a key ceremony (a distributed key generation, DKG). Afterwards each of them holds a share, and any *t* of them can sign while fewer cannot. The full private key is never assembled anywhere, not even during the ceremony.

Everything is derived from each member's **BIP39 seed phrase**: the member's message-signing and encryption keys, their key-ceremony secrets, their Core funding address and asset-lock keys. Nothing random is generated, and nothing secret is written to disk. A member who loses their laptop recovers their share from their seed phrase plus the room's public message log.

- `dti`: a command-line tool. Each member runs it on their own machine.
- `dti ui`: the same features in a local web UI, served on 127.0.0.1 only.
- `relay/`: a small Cloudflare Worker that acts as a mailbox for the group's signed messages. It is optional and untrusted: rooms also work by passing JSON bundles around (`dti room export` / `import`), and `dti relay serve` runs the same mailbox anywhere with Node.

Proven end to end on testnet; see [docs/TESTNET_E2E.md](docs/TESTNET_E2E.md). Platform support and mainnet readiness are reviewed in [docs/PLATFORM_REVIEW.md](docs/PLATFORM_REVIEW.md). The protocol is specified in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Install

Node 22 or newer.

```sh
git clone https://github.com/PastaPastaPasta/dash-threshold-identity
cd dash-threshold-identity && npm ci
alias dti="$PWD/bin/dti.mjs"
```

Each member uses **their own** seed phrase, ideally a fresh one used for nothing else. `dti` reads it from `--mnemonic-file FILE` (recommended), from `DTI_MNEMONIC`, or from a hidden prompt. An optional BIP39 passphrase comes from `--passphrase-file` or `DTI_PASSPHRASE`.

## A group from start to finish

```sh
# One member creates the room and shares the room id and relay URL with the others.
dti room create --label "Example foundation" --name alice --relay https://relay.example.org
dti room join ROOM --name bob --relay https://relay.example.org        # every other member

dti status    # everyone reads their fingerprint to the others over a call; check them all

# The organizer proposes the ceremony: who, how many signatures, which keys.
dti ceremony propose --network testnet --threshold 3 --label "Example foundation keys"
dti ceremony run      # every member: shows the roster, asks to accept, then runs the DKG

# A funder (any member) locks DASH from their seed-derived Core address and proposes the identity.
dti fund address --network testnet
dti identity create --duffs 150000000
dti approve PROPOSAL  # any three members: rebuilds, decodes and checks it, then signs a share
dti execute PROPOSAL  # the funder: combines the shares, signs the asset-lock proof, broadcasts

# From then on, anything the identity does is a proposal that t members sign.
dti propose contract-create --schema examples/notes-v1.json
dti propose contract-update --contract ID --schema examples/notes-v2.json
dti propose document --contract ID --type note --action create --data '{"message":"hi"}'
dti propose transfer --to IDENTITY --amount 1000000000
dti propose withdraw --to-address yAddress --amount 5000000000
dti propose update-identity --add CEREMONY/master,CEREMONY/critical --disable 0,1
dti approve PROPOSAL; dti execute PROPOSAL
```

Before signing, `dti approve` (and the UI's **Review and sign**) refuses unless **all** of these hold:

- the transition rebuilt independently from the proposal's stated intent is byte-for-byte the one proposed;
- the decoded transition is shown to the signer;
- every key involved is the group key the ceremony produced;
- the signing key has the purpose and security level Platform requires for that transition;
- on Platform, the key is the identity's and is enabled, and the nonce and revision are current.

The default ceremony makes four keys: MASTER (key 0, identity updates), CRITICAL (1, contracts), HIGH (2, documents) and TRANSFER (3, credit transfers and withdrawals). Pass `--keys FILE` for other layouts, such as a rotation ceremony with new key ids (see `examples/rotation-keys.json`).

### Changing members

Run a new ceremony with the new member set and new key ids. Then, with a MASTER-signed `update-identity`, add the new keys and disable the old ones in one transition. Members removed from the group keep their old shares, but those shares only work for disabled keys.

### The web UI

```sh
dti ui --mnemonic-file seed.txt     # prints http://127.0.0.1:8770/#token=...
```

It covers rooms and bundles, fingerprints, ceremonies, funding, proposals with the decoded transition, signing and broadcasting. It binds to 127.0.0.1, checks the Host header, and requires the per-run token in the printed URL. The seed phrase stays in the `dti` process.

## The relay

```sh
cd relay && npx wrangler deploy     # Cloudflare Worker + one SQLite Durable Object per room
dti relay serve --port 8787 --dir ./relay-data   # or the same API on any machine with Node
```

The relay only stores and returns messages. It refuses messages whose signature does not check out or that name another room. It cannot forge, alter or read secret messages; key shares travel encrypted to their recipient. A dishonest relay can only withhold messages, which stalls a ceremony or proposal but cannot break it.

## Development

```sh
npm test                              # unit tests: DKG, signing, refusals, builders, review, relay
node scripts/testnet-refusals.mjs DIR CONTRACT   # live refusal checks against testnet
npm run relay:dev                     # the Worker locally under workerd
```
