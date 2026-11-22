# Hosted testnet web app

`web/` builds the local UI (`src/ui/static`) into a static page that runs every member's side of the protocol in the browser, and a Cloudflare Worker that serves the page and the relay from one origin. It is testnet only.

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

## Testnet lock

Each layer is enough on its own to stop a mainnet action:

1. **The page.** The build removes every `mainnet` option and fails if one is left. No URL parameter or stored setting selects a network.
2. **The route table.** `transport.mjs` overwrites `network` with `testnet` on ceremony proposals and funding reads, and `confirmMainnet` with `false` on asset locks.
3. **The session.** `TestnetSession` refuses a ceremony, identity, proposal, Platform connection, funding address or asset lock on any other network. A mainnet ceremony or proposal posted into a room by another member is shown, but this page will not accept, sign or execute it. `test/web.test.mjs` covers each refusal.
4. **CSP.** `connect-src` allows only this origin, `insight.testnet.networks.dash.org`, `quorums.testnet.networks.dash.org` and HTTPS on port 1443 (testnet evonodes). Mainnet Insight, the mainnet quorum service and mainnet evonodes (port 443) are unreachable from the page even if the code above were bypassed.

## Secrets

- The seed phrase is typed or pasted into the unlock form, turned into the BIP39 seed, and the form is reset. The seed lives in the `Session` object in this tab only. Everything secret (member keys, DKG polynomials, shares, Core keys) is derived from it on demand, as in the CLI.
- Nothing secret is stored. The page itself writes nothing to `localStorage`, `sessionStorage`, IndexedDB, cookies or a service worker. The only stored value is the family shell's theme choice, `light`, `dark` or `system`, which it keeps in a `dh_theme` cookie for `.dashhq.org` (shared with the other dashhq sites) and in `localStorage` under `dh-theme`. Reload or **Lock** and the tab forgets everything; unlocking with the same phrase and joining the same room rebuilds the shares from the relay's log.
- The relay receives only signed envelopes. Key shares inside DKG reveals are encrypted to their recipient.
- No analytics, no third-party scripts or styles, no external fonts. The dashhq.org zone injects Cloudflare's Web Analytics beacon into proxied HTML; the Worker sends HTML with `Cache-Control: no-transform` to stop that, and the CSP would block the script anyway. The zone's Web Analytics, Zaraz, Rocket Loader and Email Obfuscation settings should be off for this host. CSP: `default-src 'none'`, scripts and styles from this origin only, `wasm-unsafe-eval` for the SDK's WebAssembly, blob workers only (the SDK compiles WebAssembly in one; a blob worker inherits the page's CSP), no frames, no form posts, no `<base>`.
- The asset-lock journal is also in memory. If the tab closes between broadcasting an asset lock and proposing the identity, that lock's funds sit at the seed-derived credit address and nothing resumes it: the CLI resumes a lock only from its own local journal, and without that record it builds a new lock. Recovering those funds means building the asset-lock proof by hand from the same seed.

## Risks of serving key-handling code from a public domain

- **Whoever controls the deployment controls the code.** A changed bundle could read the seed phrase as it is typed. CSP limits where it could send it, but the same deployment sets the CSP. This is the main difference from the CLI, where a member runs code they installed. The build is reproducible, so anyone can check what was served ([VERIFY.md](VERIFY.md)); that detects a changed bundle but does not prevent one. The hash shown on the page is only a label: a changed page could show the right hash and still load other code.
- **Deployment.** Until the `web` environment and its secrets exist, preview deploys of this host are made from the agent box (`npm run web:deploy`), including from branches under review. Once set up, `deploy-web.yml` deploys only from `main`, installs without running dependency install scripts, and needs the `web` environment's Cloudflare secrets. The page is served only on `new-multisig.dashhq.org` (`workers_dev = false`). Entry and chunk files have content hashes, so a deploy never mixes old and new code.
- **The domain is shared.** Any script on `new-multisig.dashhq.org` runs with the page's access. Nothing else is served from that host, and the Worker answers only `GET`/`HEAD` for files and the relay API under `/v1/`.
- **Supply chain.** The bundle includes `@dashevo/evo-sdk`, `@dashevo/dashcore-lib` and their dependencies, pinned by `package-lock.json`.
- **Browser exposure.** Extensions, a compromised browser profile, clipboard managers and screen sharing can see the phrase.
- **Relay abuse.** The relay is public. Per network (an IPv4 address or an IPv6 /64) it allows 600 reads and 60 posts a minute, 10 new rooms a minute, and 16 joins in any one room, so one network cannot use up a room's 256 join slots. A refused join gets a 403 that says why; the member's page keeps re-sending it with each sync, which costs one post every 8 seconds. The Worker keeps the rate counters in memory in a `Limits` Durable Object named after the network, so they reset when that object is evicted or redeployed. Rooms store the join count under a hash of the room id and the network; that hides the address from a casual reader of the room's storage but not from someone who tries every IPv4 address. Sixteen or more networks can still fill a room, and one IPv6 user with a /48 counts as many networks; a room that fills needs to be replaced, which is the trade-off for letting a group behind one NAT join, and the relay cannot forge, alter or read secret messages.
- **Testnet only.** Losing a testnet phrase loses practice funds. Nothing on this page can move mainnet DASH or credits.

## Cloudflare zone settings for this host

The dashhq.org zone has Web Analytics automatic setup on for every host, and Email Obfuscation on. The Worker already stops both on this host: it sends HTML with `Cache-Control: no-transform`, which Cloudflare honours for these features, and the CSP would block an injected script anyway. Rocket Loader is off for the zone. The agent tokens cannot write zone configuration rules or Web Analytics rules, so these two host-scoped rules are for someone with zone access:

1. **Configuration Rule** (Rules → Configuration Rules → Create): name `new-multisig: no injected scripts`, expression `(http.host eq "new-multisig.dashhq.org")`. Settings: Rocket Loader **Off**, Email Obfuscation **Off**, **Disable Zaraz**, **Disable Real User Monitoring (RUM)**, **Disable Apps**. Rollback: delete that rule.
2. **Web Analytics rule** (Analytics → Web Analytics → dashhq.org → Manage site → Advanced options → Add rule): host `new-multisig.dashhq.org`, path `*`, **Exclude**. Rollback: delete that rule.

`npm run web:verify -- https://new-multisig.dashhq.org` fails if anything is injected into `index.html`, because it compares the served page byte for byte.

## Before a mainnet build

[MAINNET-SIGNOFF.md](MAINNET-SIGNOFF.md) has the decisions and checklist, each with a recommendation. In short, a mainnet build needs Pasta's sign-off, and at least:

- an independent security review of the browser build and the Worker, and a decision on code-delivery trust (reproducible builds with published hashes, subresource integrity for a pinned release, or a downloadable signed build instead of a live site);
- a persisted, exportable asset-lock journal so a closed tab can resume or recover a lock, and an explicit mainnet confirmation step in the page like the CLI's `--confirm-mainnet`;
- the mainnet CSP hosts (mainnet Insight, `quorums.mainnet.networks.dash.org`, evonodes on 443), chosen per build so one build never reaches both networks;
- a policy for the relay (who runs it, rate limits, retention) and for the domain (a dedicated host, HSTS preload);
- hardware wallet or external signer support for the funder, so mainnet asset locks need not be built from a seed typed into a page.
