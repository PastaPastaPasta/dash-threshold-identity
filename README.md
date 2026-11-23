# dash-threshold-identity

Run a Dash Platform identity as a **t-of-n multisig** with no one ever holding its keys.

The identity's keys are ordinary BLS12-381 keys as far as Platform is concerned. Behind each one is a group of people. They create the key together in a key ceremony (a distributed key generation, DKG). Afterwards each of them holds a share, and any *t* of them can sign while fewer cannot. The full private key is never assembled anywhere, not even during the ceremony.

Everything is derived from each member's **BIP39 seed phrase**: the member's message-signing and encryption keys, their key-ceremony secrets, their Core funding address and asset-lock keys. Nothing random is generated, and nothing secret is written to disk. A member who loses their laptop recovers their share from their seed phrase plus the room's public message log.

- `dti`: a command-line tool. Each member runs it on their own machine.
- `dti ui`: the same features in a local web UI, served on 127.0.0.1 only.
- `relay/`: a small Cloudflare Worker that acts as a mailbox for the group's signed messages. It is optional and untrusted: rooms also work by passing JSON bundles around (`dti room export` / `import`), and `dti relay serve` runs the same mailbox anywhere with Node.

Proven end to end on testnet; see [docs/TESTNET_E2E.md](docs/TESTNET_E2E.md). The hosted testnet app is described in [docs/HOSTED.md](docs/HOSTED.md). Platform support and mainnet readiness are reviewed in [docs/PLATFORM_REVIEW.md](docs/PLATFORM_REVIEW.md). The protocol is specified in [docs/PROTOCOL.md](docs/PROTOCOL.md).

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
- on Platform, the key is the identity's and is enabled, and the nonce and revision are current (offline review only with `--offline`);
- the ids and withdrawal address the proposal shows are the ones in the bytes.

When a proposal puts keys under a group's control (identity create, adding keys), the review lists that group's members and threshold. Signing then needs `--accept-new-keys` (or the UI's review dialog), so nobody can slip in a key held by a group they control.

The default ceremony makes four keys: MASTER (key 0, identity updates), CRITICAL (1, contracts), HIGH (2, documents) and TRANSFER (3, credit transfers and withdrawals). Pass `--keys FILE` for other layouts, such as a rotation ceremony with new key ids (see `examples/rotation-keys.json`).

### Changing members

Run a new ceremony with the new member set and new key ids. Then, with a MASTER-signed `update-identity`, add the new keys and disable the old ones in one transition. Members removed from the group keep their old shares, but those shares only work for disabled keys.

### The web UI

```sh
dti ui --mnemonic-file seed.txt     # prints http://127.0.0.1:8770/#token=...
```

It covers rooms and bundles, fingerprints, ceremonies, funding, proposals with the decoded transition, signing and broadcasting. It binds to 127.0.0.1, checks the Host header, and requires the per-run token in the printed URL. The seed phrase stays in the `dti` process.

### The hosted app

`web/` builds the same UI into a page that runs entirely in the browser, with the relay on the same origin, deployed at https://multisig.dashhq.org. It works on Testnet, devnets and a Local dashmate network; Mainnet is read only until it has been signed off. The seed phrase stays in the tab's memory. See [docs/HOSTED.md](docs/HOSTED.md) for how it reuses `src/`, the network checks and the risks of serving it from a public domain.

The build is reproducible. Every served file except `index.html` is listed with its SHA-256 in `build-manifest.txt`; `index.html` carries that manifest's hash (the bundle hash, shown on the page), so the hash of `index.html` covers the whole site. Page hash of this commit: `50de8b4da807b8764db17869275f8a7b2a44e219a7cbbafdc4bbfcaa1f28814a`. To check that the live site serves exactly this source, see [docs/VERIFY.md](docs/VERIFY.md). What a mainnet build would need is in [docs/MAINNET-SIGNOFF.md](docs/MAINNET-SIGNOFF.md).

## The relay

```sh
cd relay && npx wrangler deploy     # Cloudflare Worker + one SQLite Durable Object per room
dti relay serve --port 8787 --dir ./relay-data   # or the same API on any machine with Node
```

The relay only stores and returns messages. It refuses messages whose signature does not check out or that name another room. It also refuses anything but a join from keys that are neither the room's creator nor named in one of its ceremonies. It cannot forge, alter or read secret messages; key shares travel encrypted to their recipient. A dishonest relay can only withhold messages, which stalls a ceremony or proposal but cannot break it. A room accepts at most 256 joins. The hosted relay also allows at most 16 joins per room from one network (an IPv4 address or an IPv6 /64), 600 reads and 60 posts a minute, and 10 new rooms a minute; `dti relay serve --limits` turns on the same limits, which are off by default because a relay behind a proxy sees every client as one address. Members who have already joined are unaffected by a full room, but newcomers then need a new room.

## Development

```sh
npm test                              # unit tests: DKG, signing, refusals, builders, review, relay
node scripts/testnet-refusals.mjs DIR CONTRACT   # live refusal checks against testnet
npm run relay:dev                     # the Worker locally under workerd
```
