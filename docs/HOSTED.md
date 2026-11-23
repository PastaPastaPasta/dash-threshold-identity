# Hosted web app

`web/` builds the UI (`src/ui/static`) into a static page that runs every member's side of the protocol in the browser, and a Cloudflare Worker that serves the page and the relay from one origin. It works on Mainnet (read only for now), Testnet, any `devnet-<name>`, and a Local dashmate network.

```sh
npm run web:build     # web/dist: index.html, the bundle, the vendored dashhq shell
npm run web:dev       # build, then the Worker locally under workerd
npm run web:deploy    # build, then wrangler deploy --config web/wrangler.toml
```

## What is shared with the CLI

The page imports `src/` directly: derivation, envelopes, the DKG, the room state, proposals, review, transition building and the Core asset lock are the same modules the CLI runs. The browser build changes three things and forks no logic:

- **Storage.** `src/store.mjs` reads and writes through `#storage`. Node resolves it to `src/storage/node.mjs` (files under `~/.dti`); a browser bundle resolves it to `src/storage/memory.mjs`, a `Map` that lives as long as the tab.
- **Transport.** `src/ui/static/app.js` gets `api()` from `./transport.js`. Locally that is a token-carrying `fetch` to `dti ui`; in the bundle it is `web/src/transport.mjs`, which calls the same route table (`src/ui/routes.mjs`) in process.
- **Session.** `web/src/session.mjs` subclasses `Session` to pin the network and the relay (below).

Node built-ins that `@dashevo/dashcore-lib` needs come from `buffer`, `events`, `util`, `assert` and `url`, plus a small `crypto` shim over `@noble/hashes` (`web/src/shims`).

## Networks

Each page load is on exactly one network, chosen by `?network=` (`mainnet`, `testnet`, `devnet-<name>` or `local`; default `testnet`). Switching networks reloads the page, so nothing from one network stays in memory on another.

- **Network parameters** come from `src/networks.mjs`: Core address versions (Mainnet `X…`, the test networks `y…`), the BIP44 coin type in key paths (5 on Mainnet, 1 elsewhere), the Insight explorer, and the quorum service. Platform nodes are discovered through each network's quorum service by the SDK (`quorums.mainnet…`, `quorums.testnet…`, `quorums.<name>.networks.dash.org`, or the local dashmate service on port 22444); no DAPI address is built in.
- **Groups belong to a network.** A group id starts with its network (`m_`, `t_`, `d<name>_`, `r_` for Local). The relay stores each id in its own room, and every signed message names its group, so a message from one network's group cannot be replayed into another. `web/src/session.mjs` refuses to open, join or import a group, or to act on a key ceremony, identity or proposal, that belongs to another network. Group ids from before this change, and groups the CLI or `dti ui` create, have no prefix and open on Testnet only in the hosted page. Devnet names that would read as another network (`devnet-mainnet`, `devnet-testnet`, `devnet-local`, `devnet-regtest`) are refused.
- **Each network has its own CSP.** The Worker reads `?network=` and sends a `connect-src` for that network: Testnet Insight, the Testnet quorum service and any host on port 1443; Mainnet Insight, the Mainnet quorum service and any host on port 443; a devnet's own Insight and quorum hosts and port 1443; or only this computer for Local. A Testnet page cannot reach Mainnet Insight, the Mainnet quorum service or Mainnet evonodes (port 443). The reverse does not hold: because evonodes are reached by IP, the Mainnet wildcard on port 443 matches any HTTPS host, and Testnet and devnet pages share port 1443. The session checks above, not the CSP, are what keep a page on its network; D6 in [MAINNET-SIGNOFF.md](MAINNET-SIGNOFF.md) tracks narrowing it.
- **Mainnet is read only in this build.** `web/src/flags.mjs` sets `MAINNET_WRITES = false`. With it off, a Mainnet page can open and join groups, compare fingerprints, check the network and look up balances and identities. It refuses key ceremonies, proposals, signing, rejecting, broadcasting, asset locks, identity creation and top-ups, both in the page and in the session (`test/web.test.mjs`). The flag is part of the bundle, so the bundle hash shows its value; turning it on needs Pasta's sign-off ([MAINNET-SIGNOFF.md](MAINNET-SIGNOFF.md)).
- **Mainnet looks different.** The network strip is dark with an amber rule and says real DASH, the shell's network pill is solid, and the group title carries a Mainnet badge. Testnet keeps the dashed amber strip; devnets and Local use a grey dotted one.
- **Local networks** need an Insight-compatible API for funding (the page asks for its URL) and a browser that trusts the dashmate gateway's certificate, which is self-signed by default.

## Secrets

- The seed phrase is typed or pasted into the unlock form, turned into the BIP39 seed, and the form is reset. The seed lives in the `Session` object in this tab only. Everything secret (member keys, DKG polynomials, shares, Core keys) is derived from it on demand, as in the CLI.
- Nothing secret is stored. The page itself writes nothing to `localStorage`, `sessionStorage`, IndexedDB, cookies or a service worker. The only stored value is the family shell's theme choice, `light`, `dark` or `system`, which it keeps in a `dh_theme` cookie for `.dashhq.org` (shared with the other dashhq sites) and in `localStorage` under `dh-theme`. Reload or **Lock** and the tab forgets everything; unlocking with the same phrase and joining the same room rebuilds the shares from the relay's log.
- The relay receives only signed envelopes. Key shares inside DKG reveals are encrypted to their recipient.
- No analytics, no third-party scripts or styles, no external fonts. The dashhq.org zone injects Cloudflare's Web Analytics beacon into proxied HTML; the Worker sends HTML with `Cache-Control: no-transform` to stop that, and the CSP would block the script anyway. The zone's Web Analytics, Zaraz, Rocket Loader and Email Obfuscation settings should be off for this host. CSP: `default-src 'none'`, scripts and styles from this origin only, `wasm-unsafe-eval` for the SDK's WebAssembly, blob workers only (the SDK compiles WebAssembly in one; a blob worker inherits the page's CSP), no frames, no form posts, no `<base>`.
- The asset-lock journal is also in memory, so a closed tab forgets a lock it was waiting on. Before it builds a new lock, the page (and the CLI, when its journal has no usable record) reads the funding address's history from Insight, mempool included, and finds the asset locks whose credit outputs pay one of the seed's registration or top-up keys. For each registration lock it checks with a proved read whether the identity that lock would create already exists. It resumes the first unused registration lock of at least 200000 duffs (Platform's minimum for an identity) at whatever amount it holds, and reuses an open identity-create proposal of the same member that already uses that lock instead of posting another. Any new lock gets a key index above every one found on chain, so a credit key is never paid twice. The form's "Lock new funds" box (the CLI's `--new-lock`) skips resuming, for a lock Platform keeps refusing. Top-up locks are not resumed: Platform offers no query for whether an asset-lock outpoint was already consumed. The page has no way to retry one; the funder recovers it with the CLI and the same seed (`dti fund locks`, then `dti identity topup --index N`; Platform rejects a used one). The scan trusts Insight to list every transaction: a dishonest or lagging Insight can hide a lock, and then the page builds a new one (the hidden lock's funds stay recoverable from the seed) and could pay a credit key a second time.

## Risks of serving key-handling code from a public domain

- **Whoever controls the deployment controls the code.** A changed bundle could read the seed phrase as it is typed. CSP limits where it could send it, but the same deployment sets the CSP. This is the main difference from the CLI, where a member runs code they installed. The build is reproducible, so anyone can check what was served ([VERIFY.md](VERIFY.md)); that detects a changed bundle but does not prevent one. The hash shown on the page is only a label: a changed page could show the right hash and still load other code.
- **Deployment.** Until the `web` environment and its secrets exist, preview deploys of this host are made from the agent box (`npm run web:deploy`), including from branches under review. Once set up, `deploy-web.yml` deploys only from `main`, installs without running dependency install scripts, and needs the `web` environment's Cloudflare secrets. The page is served only on `multisig.dashhq.org` (`workers_dev = false`). The earlier preview host `new-multisig.dashhq.org` is still attached to the same Worker, but page requests there get a 301 to `multisig.dashhq.org` with the same path and query. Relay calls under `/v1/` are not redirected, so tabs already open on the old host keep working. Plain HTTP gets a 301 to HTTPS, from the zone's Always Use HTTPS setting and again in the Worker. Entry and chunk files have content hashes, so a deploy never mixes old and new code.
- **The domain is shared.** Any script on `multisig.dashhq.org` runs with the page's access. Nothing else is served from that host, and the Worker answers only `GET`/`HEAD` for files and the relay API under `/v1/`.
- **Supply chain.** The bundle includes `@dashevo/evo-sdk`, `@dashevo/dashcore-lib` and their dependencies, pinned by `package-lock.json`.
- **Browser exposure.** Extensions, a compromised browser profile, clipboard managers and screen sharing can see the phrase.
- **Relay abuse.** The relay is public. Per network (an IPv4 address or an IPv6 /64) it allows 600 reads and 60 posts a minute, 10 new rooms a minute, and 16 joins in any one room, so one network cannot use up a room's 256 join slots. A refused join gets a 403 that says why; the member's page keeps re-sending it with each sync, which costs one post every 8 seconds. The Worker keeps the rate counters in memory in a `Limits` Durable Object named after the network, so they reset when that object is evicted or redeployed. Rooms store the join count under a hash of the room id and the network; that hides the address from a casual reader of the room's storage but not from someone who tries every IPv4 address. Sixteen or more networks can still fill a room, and one IPv6 user with a /48 counts as many networks; a room that fills needs to be replaced, which is the trade-off for letting a group behind one NAT join, and the relay cannot forge, alter or read secret messages.
- **Mainnet.** With the flag off, nothing on this page can make keys, sign, or move Mainnet DASH or credits. A Mainnet page still takes a seed phrase to show a member's fingerprint and balance, so the risks above apply to a phrase typed there.
- **Mainnet CSP is broad.** Mainnet evonodes answer on port 443 at addresses that change, so the Mainnet `connect-src` includes `https://*:443`, which is any HTTPS host. A changed page on Mainnet could send data anywhere; the Testnet CSP has the same weakness on port 1443. A fixed DAPI gateway on named hosts would close this ([MAINNET-SIGNOFF.md](MAINNET-SIGNOFF.md)).

## Cloudflare zone settings for this host

The dashhq.org zone has Web Analytics automatic setup on for every host, and Email Obfuscation on. The Worker already stops both on this host: it sends HTML with `Cache-Control: no-transform`, which Cloudflare honours for these features, and the CSP would block an injected script anyway. Rocket Loader is off for the zone. The agent tokens cannot write zone configuration rules or Web Analytics rules, so these two host-scoped rules are for someone with zone access:

1. **Configuration Rule** (Rules → Configuration Rules → Create): name `multisig: no injected scripts`, expression `(http.host in {"multisig.dashhq.org" "new-multisig.dashhq.org"})`. Settings: Rocket Loader **Off**, Email Obfuscation **Off**, **Disable Zaraz**, **Disable Real User Monitoring (RUM)**, **Disable Apps**. Rollback: delete that rule.
2. **Web Analytics rule** (Analytics → Web Analytics → dashhq.org → Manage site → Advanced options → Add rule): hosts `multisig.dashhq.org` and `new-multisig.dashhq.org`, path `*`, **Exclude**. Rollback: delete those rules.

`npm run web:verify -- https://multisig.dashhq.org` fails if anything is injected into `index.html`, because it compares the served page byte for byte.

## Before a mainnet build

[MAINNET-SIGNOFF.md](MAINNET-SIGNOFF.md) has the decisions and checklist, each with a recommendation. In short, a mainnet build needs Pasta's sign-off, and at least:

- an independent security review of the browser build and the Worker, and a decision on code-delivery trust (reproducible builds with published hashes, subresource integrity for a pinned release, or a downloadable signed build instead of a live site);
- review of the asset-lock recovery from the chain described above, and a way to retry a top-up lock from the page (today only the CLI can); an explicit mainnet confirmation step in the page like the CLI's `--confirm-mainnet`;
- a narrower Mainnet CSP than today's (a DAPI gateway on named hosts instead of any host on port 443);
- a policy for the relay (who runs it, rate limits, retention) and for the domain (a dedicated host, HSTS preload);
- hardware wallet or external signer support for the funder, so mainnet asset locks need not be built from a seed typed into a page.
