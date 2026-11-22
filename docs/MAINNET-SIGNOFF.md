# Mainnet sign-off

Nothing in this repository builds or serves a mainnet web app. The CLI has supported mainnet since the first release, behind `--confirm-mainnet` for anything that locks DASH. This page lists what Pasta would decide and check before a **hosted** mainnet build exists. Each item carries a recommendation.

## Decisions

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | How the mainnet app reaches users | (a) live site, like testnet; (b) a signed, versioned download that a small local server (like `dti ui`) serves on `localhost`, since a split ES-module build does not run from `file://`; (c) both | **(c), with (b) the default for funds.** The live site is convenient, but whoever controls the deployment controls the code ([HOSTED.md](HOSTED.md)). A download pinned by hash removes that risk for the members who care. |
| D2 | Host | a subdomain of dashhq.org; a dedicated domain | **A dedicated host with nothing else on it**, e.g. `multisig.dashhq.org`, with a long HSTS max-age. Preload applies to a whole registrable domain (`dashhq.org` with `includeSubDomains`), so it is a zone-wide decision, not one for this host. Never the testnet host: one host, one network. |
| D3 | One build or two | one build with a network switch; one build per network | **One build per network.** The testnet build is locked by code and by its CSP; the mainnet build is a separate bundle whose CSP reaches only mainnet hosts. Neither can be talked into the other network. |
| D4 | Who deploys | the agent box; GitHub Actions from `main`; a person with a hardware key | **GitHub Actions from `main` only**, through the `web-mainnet` environment, with required reviewers (Pasta) and a deployment branch rule. The workflow publishes the bundle hash in the release notes. No deploys from workstations. |
| D5 | Release trust | the page hash in the README; a signed release manifest; a transparency log | **A signed release manifest** covering `index.html` and `build-manifest.txt`: the page hash (SHA-256 of `index.html`, which carries the bundle hash) and the bundle hash, signed with a release key Pasta holds, plus the README's page hash. The hash shown on a page is only a label; [VERIFY.md](VERIFY.md) is the check. |
| D6 | Relay | the same Worker and Durable Object; a separate mainnet relay; members bring their own | **A separate mainnet relay Worker** with its own limits and retention. It holds no secrets; separation keeps testnet abuse and outages away from mainnet groups. Bundles stay available as a fallback. |
| D7 | Relay retention | forever; N days after the last message; until the room is closed | **Keep rooms 180 days after the last message**, and say so in the page. Members need the log to recover their shares; anyone who needs longer keeps an exported bundle. |
| D8 | Funding | seed-derived Core key in the page (as testnet); an external wallet; hardware wallet | **No seed-derived funding in the hosted mainnet page.** The funder builds the asset lock with the CLI, or a later external-signer flow. The page proposes and signs only threshold transitions. |
| D9 | Seed entry | typed into the page (as testnet); imported from a file; hardware-backed | **Typed or from a file, never stored**, as today, but only in the downloadable build (D1b) for groups holding real funds. Reassess after an independent review. |
| D10 | Who may use it | anyone; invited groups; Pasta's own groups first | **Pasta's own groups first**, with small balances, for one release cycle before announcing it. |

## Checklist before the first mainnet deploy

Each item needs an owner and evidence: a link to the PR, the review or the run.

**Code and review**
- [ ] An independent security review of the browser build, the Worker and the relay. It should come from someone who did not write them, and it should include the threshold signing paths ([PROTOCOL.md](PROTOCOL.md)).
- [ ] The mainnet bundle is built from a tagged commit, the build is reproduced on a second machine, and the page hash (covering `index.html` and, through the bundle hash it carries, every other file) is published in signed release notes (D5).
- [ ] A mainnet CSP names every host the page may reach: this origin, the mainnet Insight, `quorums.mainnet.networks.dash.org`, and a fixed set of DAPI endpoints (a pinned evonode list or a DAPI gateway on named hosts). `https:` or `https://*:443` would let a changed page send data anywhere, so they are not acceptable; a test checks that the testnet hosts are absent. The testnet CSP's `https://*:1443` has the same weakness for testnet evonodes, accepted for testnet only.
- [ ] A per-network session lock mirroring `web/src/session.mjs`, with tests that refuse testnet items in the mainnet build.
- [ ] The page asks for an explicit confirmation before any mainnet transition is signed or broadcast, as the CLI does with `--confirm-mainnet`.
- [ ] If the hosted page ever builds asset locks (D8), the asset-lock journal persists and can be exported, so a closed tab can resume a lock.

**Platform**
- [ ] The protocol version is still 14 or later (signatures are checked; see [PLATFORM_REVIEW.md](PLATFORM_REVIEW.md)), and the pinned `@dashevo/evo-sdk` matches the network's release.
- [ ] A mainnet dry run with Pasta's own group and a small balance: identity create, a document, a transfer, a withdrawal and a key rotation, each confirmed by a proved read.

**Operations**
- [ ] The `web-mainnet` environment exists with required reviewers and a branch rule, and the deploy workflow refuses any other ref.
- [ ] On the mainnet host, the zone injects nothing: Web Analytics, Zaraz, Rocket Loader, Email Obfuscation and Apps are off for the host ([HOSTED.md](HOSTED.md)), and `web:verify` passes against the live site.
- [ ] Relay limits are sized for mainnet use, the retention policy is published (D7), and there is a way to see abuse: room counts and 429 rates.
- [ ] A rollback plan: the previous Worker version stays deployable, and a known-good bundle hash is recorded.
- [ ] An incident path: how members learn that a deployed bundle was bad, and which hash to check.

**Users**
- [ ] The page and README say plainly what the site can and cannot see, how to verify the build, and that a phrase used here should hold nothing else.
- [ ] Recovery is documented: losing *n−t+1* phrases loses the key, and MASTER rotation is the only way to change members.

## What stays true regardless

- The relay is untrusted. It cannot forge, alter or read secret messages; at worst it withholds them.
- The identity's keys never exist in one place. A compromised page could leak one member's phrase and share, which is below the threshold. That still means a compromised deployment that every member uses could collect *t* shares over time, which is why D1 and D5 matter.
