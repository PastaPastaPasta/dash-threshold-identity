# Mainnet sign-off

The hosted app runs on Mainnet, Testnet, devnets and Local networks. On Mainnet, writes are **on** since 2026-11-23, by Pasta's decision recorded below. The CLI has supported Mainnet since the first release, behind `--confirm-mainnet` for anything that locks DASH.

## What the flag gates

`web/src/flags.mjs` holds `MAINNET_WRITES = true` since 2026-11-23 (see the sign-off record below). A test pins the value, and the bundle hash changes with it, so the deployed value can be checked ([VERIFY.md](VERIFY.md)). The table shows what a build with the flag off allows.

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

## Sign-off record

**2026-11-23 01:10 CT.** Pasta, relayed by the dashhq PM: "I want mainnet etc on". `MAINNET_WRITES` stayed `false`. The PM's instruction was to run every check first and to stop before enabling if any check found a real fund-loss risk. Two checks did.

| Check | Result |
|---|---|
| Stuck asset lock recovery | **Fixed** in PR #6 (merged `09c0795`). With no journal record, the page reads the funding address's history and resumes an unused lock instead of building another. It never reuses a credit key, and re-sends a lock that dropped out of the mempool. Regtest crash runs (locks `eb2a60fc…`, `902e0688…`) resumed the same lock and broadcast no second one. Remaining gap: a top-up lock lost to a closed tab can only be recovered with the CLI. |
| D9: funding key in the page | **Open (Pasta).** The member's phrase derives a Core key that moves DASH with no threshold. Together with deploy trust, this is a theft path for every balance typed into the page. |
| Deploy trust and `web-mainnet` environment | **Open (Pasta).** The repository side is ready: a signed-release deploy workflow, release signing and CODEOWNERS ([MAINNET-GUARDRAILS.md](MAINNET-GUARDRAILS.md)). Pasta's account steps take about 15 minutes. |
| D6: Mainnet CSP | **Open.** `connect-src` allows `https://*:443`, because there is no named DAPI gateway on Mainnet. |
| D10: typed confirmation | **Done** in this change, for the hosted page and the local `dti ui`. Before locking funds, signing or broadcasting on Mainnet, the page shows a "Mainnet, real DASH" warning with the amount and recipient, and asks the member to type the amount (or `mainnet` when there is none). The check depends on the network of the proposal or ceremony and fails closed. `Session.approve` and `execute` refuse Mainnet without `confirmMainnet`, and so does `assetLock`; in the CLI that is `--confirm-mainnet`. This guards against a member's own mistake. It is not a security control, because a changed page could set the flag itself. Only the amount is typed; the recipient is shown in groups of four with its payment history. |
| Change and fee handling | Checked, and two bugs fixed in PR #6. Change returns to the funding address and the fee is capped at 0.001 DASH. Locks with 7 or more inputs had paid below the relay minimum, and a 100,000-duff registration lock would have been stranded; the minimum is now 200,000. |
| Platform version | Mainnet at protocol 14 (DAPI read on 2026-11-22). |
| Signed release (D5), second-machine build | **Open (Pasta).** Needs a release key that Pasta holds. |
| Zone injection rules for the host | **Open (Pasta).** The token cannot write zone rules (see [HOSTED.md](HOSTED.md)). Until then, the Worker blocks the injection with `no-transform` and the CSP. |
| Independent security review | Partly done: agent reviews only, so not a human review. |
| Live Mainnet dry run | **Read only.** DAPI connect and balance lookups pass. There is no Mainnet test wallet with DASH, so nothing was spent. |

Turning writes on later is one change, made after Pasta's guardrail steps and after D9 is settled. As built, the flag would also enable asset locks built in the page from a member's phrase, which D9 recommends against; either D9 is accepted as is, or that path is turned off for Mainnet first: `MAINNET_WRITES = true` in `web/src/flags.mjs` and its pinning test, then a deploy. To turn them off again, run `npm run web:mainnet-off` (it sets the flag false, tests, deploys and checks the live site), or roll back the Worker with `npx wrangler rollback <previous version>` from `web/`.

**2026-11-23 11:44 CT.** Pasta, relayed by the dashhq PM: the deploy-trust risk (the account-wide Cloudflare token on the agent box, and the permissive Mainnet CSP) is "not a concern for this"; turn Mainnet on at multisig.dashhq.org and skip the GitHub-environment, scoped-token and signing-key guardrails. `MAINNET_WRITES` was set to `true` in that change. The in-app protections stay: the typed "Mainnet, real DASH" confirmation (D10) and the asset-lock recovery (#6). D9 is accepted as built: Mainnet asset locks are built in the page from the funder's phrase, so a phrase used there must hold only what it is about to lock. To turn writes off again: `npm run web:mainnet-off`, or `npx wrangler rollback <previous version>` from `web/`.

## What stays true regardless

- The relay can't forge, alter or read secret messages; at worst it withholds them.
- The identity's keys never exist in one place. Fewer than *t* compromised members learn nothing about them.
- Every signer signs only what its own page rebuilt from the proposal it shows.
