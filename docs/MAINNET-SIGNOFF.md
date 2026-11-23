# Mainnet sign-off

The hosted app runs on Mainnet, Testnet, devnets and Local networks. On Mainnet it is **read only** until Pasta signs off on this page. The CLI has supported Mainnet since the first release, behind `--confirm-mainnet` for anything that locks DASH.

## What is on now, and what the flag gates

`web/src/flags.mjs` holds `MAINNET_WRITES = false`. A test fails if it changes, and the bundle hash changes with it, so the deployed value can be checked ([VERIFY.md](VERIFY.md)).

| On Mainnet with the flag off | Allowed |
|---|---|
| Open the page, choose Mainnet, enter a seed phrase | yes |
| Start, join, open, export and import Mainnet groups; compare fingerprints | yes |
| Connect to Mainnet Platform (DAPI through the Mainnet quorum service) and show its height and protocol | yes |
| Look up a member's funding address and balance (Mainnet Insight) | yes |
| Read an identity with a proof | yes |
| Propose or take part in a key ceremony (makes Mainnet key shares) | **no** |
| Propose, sign, reject or broadcast any transition | **no** |
| Build or broadcast an asset lock, create an identity, top up | **no** |

The refusals sit in `NetworkSession` (`web/src/session.mjs`), below the UI, so a crafted click or console call hits them too. `test/web.test.mjs` checks every one. Turning the flag on means editing that file and the test that pins it. That change is the sign-off.

Proven so far: live read-only checks on Mainnet (Platform connect at block 477,616, protocol 14; balance lookup of an `X…` address; zero write controls on the page). Full 2-of-3 runs with funding, identity creation and a signed transition on Testnet and on a Local dashmate network. No public devnet was running, so devnets are tested in code only.

## Security notes

**Key handling.**
- A member's seed phrase is typed into the page, and every secret is derived from it in the tab: the member's message and transport keys, their DKG polynomial, their key shares and their Core funding key. Nothing secret is stored or sent.
- No process ever holds a group key. A share signs only bytes the member's own page rebuilt from the proposal it shows.
- The weak point is the page itself. Code served from a domain can read a phrase as it is typed. On Mainnet, one compromised deploy that every member uses could collect *t* phrases over time, which is enough to take the identity.
- The Core funding key is the most direct risk: it moves DASH by itself, with no threshold. The page derives it from the member's phrase, so any DASH sent to a phrase that is ever typed into the page is exposed to that page, whoever builds the asset lock.

**The relay.**
- The relay is untrusted. It sees every public message, cannot read encrypted shares, and cannot forge or alter messages. At worst it withholds them, which stalls a ceremony or proposal.
- Group ids carry their network, and the page refuses groups from other networks, so Testnet messages cannot be replayed into a Mainnet group.
- The relay is open to anyone. Per-network limits slow abuse but don't stop it, and a group whose join slots fill has to start a new room.
- Retention is currently forever.

**Deploy trust.**
- Today the Worker is deployed from the agent box with an account-wide Cloudflare token, including from branches under review. The `web` GitHub environment isn't set up.
- Whoever holds that token, or can push a deploy, controls the code that reads Mainnet phrases.
- The build is reproducible and `web:verify` checks a live site byte for byte. That detects a changed page; it doesn't prevent one.
- The Mainnet CSP allows `https://*:443`, because evonodes are addressed by IP. A changed page could therefore send data to any HTTPS host.

## Decisions

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | How the Mainnet app reaches users | (a) the live site; (b) a signed, versioned download served on `localhost` by a small local server (like `dti ui`), since a split ES-module build doesn't run from `file://`; (c) both | **(c), with (b) the default for groups holding real funds.** The live site is convenient, but whoever controls the deploy controls the code. A download pinned by hash removes that risk for members who care. |
| D2 | Host | the shared multi-network page; a dedicated Mainnet host | **A dedicated Mainnet host** (e.g. `mainnet.multisig.dashhq.org`; `multisig.dashhq.org` is now the shared page) serving the same bundle with only Mainnet enabled. This gives it its own origin, its own deploy approvals and its own CSP, and keeps the shared page for the test networks. HSTS preload is a zone-wide decision for `dashhq.org`. |
| D3 | Network separation | one page with a switcher (now); one host per network | **Keep the switcher for the test networks.** Each page load is on one network, with its own CSP, group ids and session checks, which already stops cross-network mistakes. Put Mainnet on its own host once writes are on (D2). |
| D4 | Who deploys | the agent box (now); GitHub Actions from `main`; a person with a hardware key | **GitHub Actions from `main` only**, through a `web-mainnet` environment with Pasta as required reviewer and a branch rule. Use a Cloudflare token scoped to this Worker only. No more deploys from workstations. |
| D5 | Release trust | the page hash in the README (now); a signed release manifest; a transparency log | **A signed release manifest:** the page hash and bundle hash, signed with a release key Pasta holds, and published with each release. The hash shown on a page is only a label; `web:verify` is the check. |
| D6 | DAPI reachability and CSP | discovered evonodes on any HTTPS host (now); a DAPI gateway on named hosts | **A DAPI gateway on named hosts** for Mainnet (for example `dapi.mainnet.networks.dash.org`), so the Mainnet `connect-src` can drop `https://*:443`. Until then, D1(b) is the safer way to use Mainnet. |
| D7 | Relay | the shared Worker (now); a separate Mainnet relay; members bring their own | **A separate Mainnet relay Worker** with its own limits and retention. Bundles stay available as a fallback. |
| D8 | Relay retention | forever (now); N days after the last message | **180 days after the last message**, stated in the page. Members need the log to rebuild shares; anyone who needs longer keeps an exported bundle. |
| D9 | Funding on Mainnet | seed-derived Core key in the page; the CLI; an external wallet or hardware signer | **Not in the hosted page, and not from a phrase that ever enters it.** The funder builds the asset lock with the CLI from a separate funding phrase, or later with an external signer whose keys never enter the browser. Member phrases typed into the page must hold no funds. The page signs only threshold transitions. |
| D10 | Mainnet confirmation | none; a typed confirmation per transition | **A typed confirmation before every Mainnet signature and broadcast**, naming the amount and recipient, like the CLI's `--confirm-mainnet`. |
| D11 | Who may use it first | anyone; invited groups; Pasta's own groups | **Pasta's own groups**, with small balances, for one release cycle. |

## Checklist before turning `MAINNET_WRITES` on

Each item needs an owner and evidence: a PR, a review or a run.

**Code and review**
- [ ] An independent security review of the browser build, `NetworkSession`, the Worker and the relay, by someone who didn't write them, including the threshold signing paths ([PROTOCOL.md](PROTOCOL.md)).
- [ ] D9 and D10 implemented: no Mainnet asset locks from the page; Mainnet funding uses a phrase or signer that never enters the browser, and the page says member phrases must hold no funds; a typed confirmation before each Mainnet signature and broadcast.
- [ ] D6 decided. If a gateway exists, the Mainnet CSP names only it, Insight and the quorum service, and a test checks the CSP has no wildcard host.
- [ ] The release is built from a tagged commit, reproduced on a second machine, and its page hash published in signed release notes (D5).

**Platform**
- [ ] Protocol 14 or later on Mainnet (signatures are checked; see [PLATFORM_REVIEW.md](PLATFORM_REVIEW.md)), and the pinned `@dashevo/evo-sdk` matches the network's release.
- [ ] Asset-lock recovery reviewed ([HOSTED.md](HOSTED.md)): a closed tab resumes an unused registration lock from the chain; a top-up lock lost the same way can only be retried from the CLI (`dti fund locks`, `dti identity topup --index N`), and the scan trusts Insight to list every transaction.
- [ ] A Mainnet dry run with Pasta's own group and a small balance: identity creation from a CLI-built asset lock, a document, a transfer, a withdrawal and a key rotation, each confirmed by a proved read.

**Operations**
- [ ] Pasta's setup in [MAINNET-GUARDRAILS.md](MAINNET-GUARDRAILS.md): the deploy token kept in the `web-mainnet` environment, the environment itself, code-owner review on `main`, the release key and the zone rules.
- [ ] The `web-mainnet` environment exists with required reviewers, a branch rule and a deploy token kept only in it (Cloudflare cannot scope it to this Worker while it manages custom domains; signed releases make up for that). The deploy workflow refuses any other ref.
- [ ] The Mainnet host injects nothing: Web Analytics, Zaraz, Rocket Loader, Email Obfuscation and Apps are off for it ([HOSTED.md](HOSTED.md)), and `web:verify` passes against it.
- [ ] Relay limits sized for Mainnet, retention published (D8), and a way to see abuse (room counts, 429 rates).
- [ ] Rollback: the previous Worker version stays deployable, and the last known-good page hash is recorded.
- [ ] An incident path: how members learn a deployed page was bad, and which hash to check.

**Users**
- [ ] The page says plainly what the site can and cannot see, how to verify the build, and that a phrase used here should hold nothing else.
- [ ] Recovery is documented: losing *n−t+1* phrases loses the key, and MASTER rotation is the only way to change members.

## What stays true regardless

- The relay can't forge, alter or read secret messages; at worst it withholds them.
- The identity's keys never exist in one place. Fewer than *t* compromised members learn nothing about them.
- Every signer signs only what its own page rebuilt from the proposal it shows.
