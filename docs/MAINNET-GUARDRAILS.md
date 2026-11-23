# Mainnet guardrails: what Pasta sets up

This is the deploy-trust part of [MAINNET-SIGNOFF.md](MAINNET-SIGNOFF.md). It takes one sitting of about 17 minutes, and only covers what needs Pasta's GitHub and Cloudflare accounts. Mainnet writes stay off (`MAINNET_WRITES = false`) until Pasta decides otherwise; nothing here turns them on.

## Already done in the repository

- `.github/workflows/deploy-web-mainnet.yml` is now the only CI deploy of the hosted page; the older unsigned `deploy-web.yml` is removed, because the same Worker serves Mainnet.
  - It runs from `main` only.
  - Tests run in a first job with no secrets.
  - A second job, in the `web-mainnet` environment, does a fresh checkout, installs without install scripts and rebuilds. It **refuses to deploy unless Pasta signed this exact build**, then deploys and checks the live site byte for byte.
- `web/release.mjs` signs and checks releases. A release is `releases/<page sha256>.json` plus an SSH signature (namespace `dti-release`).
  - It covers the page hash, the bundle hash of every served file, the hash of the Worker script wrangler uploads (which includes the CSP and the relay) and the hash of `web/wrangler.toml`.
  - Keys allowed to sign are listed in `releases/allowed_signers`, which stays empty until step 4.
  - Tested with throwaway keys. It refuses all of these:
    - a release with no signature;
    - a key not in the list;
    - a release file edited after signing;
    - the wrong namespace;
    - a changed Worker script.
- `.github/CODEOWNERS` makes Pasta the owner of everything by default, so any new file (a `.env`, an `npm-shrinkwrap.json`, a new workflow) needs his review. It leaves out only code whose output the signed release covers (`web/src/`, `web/static/`, `web/vendor/`, `web/worker.mjs`, `relay/`, `src/`), plus tests, docs and scripts. Inside those it re-owns the Mainnet flag, `src/networks.mjs` and `src/util.mjs` (the deploy job imports them before the check), the off switch and this doc. The deploy job also refuses tracked `.env`, `.npmrc`, `npm-shrinkwrap.json` and `.dev.vars` files, and pins wrangler's API address. Step 3 makes CODEOWNERS binding.
- `npm run web:mainnet-off` turns Mainnet writes off and deploys that build (see "Switching Mainnet off").

## Steps (about 17 minutes)

### 1. Cloudflare API token for deploys (4 min)

1. Open https://dash.cloudflare.com/profile/api-tokens, then **Create Token**, then **Create Custom Token** → **Get started**.
2. **Token name:** `dti-multisig web-mainnet deploy`.
3. **Permissions** (use **+ Add more** for each row):
   - Account · Workers Scripts · Edit
   - Account · Account Settings · Read
   - Zone · Workers Routes · Edit
4. **Account Resources:** Include · *the account that owns dashhq.org* (id `23c3b2efbaecdd502503aaf5aa3e57a0`).
5. **Zone Resources:** Include · Specific zone · `dashhq.org`.
6. **TTL:** set an end date 90 days out. Leave Client IP Address Filtering empty, because GitHub's runners use changing addresses.
7. **Continue to summary**, then **Create Token**. Copy the token; it is shown once.

This token can deploy every Worker in the account, because this deploy also re-applies the custom domains, which per-Worker token scopes don't cover. That is why step 4 matters: the workflow deploys only builds Pasta signed. Wrangler uploads the script before it updates the domains, so if a run fails while updating `multisig.dashhq.org`, the new code is already live and the verify step was skipped. In that case add **Zone · DNS · Edit** for `dashhq.org` to the token, and run the workflow again.

### 2. GitHub environment `web-mainnet` (4 min)

1. Open https://github.com/PastaPastaPasta/dash-threshold-identity/settings/environments, then **New environment**. Name it `web-mainnet` and click **Configure environment**.
2. Tick **Required reviewers**, add `PastaPastaPasta`, and leave **Prevent self-review** unticked (Pasta both starts and approves releases). If the environment already exists (it appears as soon as anyone runs the workflow), edit it instead.
3. Untick **Allow administrators to bypass configured protection rules**.
4. Under **Deployment branches and tags**, choose **Selected branches and tags**, then **Add deployment branch or tag rule**. Use the ref type **Branch**, the name pattern `main`, then **Add rule**.
5. Under **Environment secrets**, click **Add environment secret** twice:
   - `CLOUDFLARE_API_TOKEN`: the token from step 1.
   - `CLOUDFLARE_ACCOUNT_ID`: `23c3b2efbaecdd502503aaf5aa3e57a0`.
6. Click **Save protection rules**.

### 3. Make code owners binding on `main` (3 min)

1. Open https://github.com/PastaPastaPasta/dash-threshold-identity/settings/branches, then **Add branch ruleset** (or edit the existing rule for `main`).
2. **Ruleset name:** `main`. **Enforcement status:** Active. **Target branches:** Add target, then **Include default branch**.
3. Tick **Require a pull request before merging**, then set:
   - **Required approvals:** `0`;
   - tick **Dismiss stale pull request approvals when new commits are pushed**;
   - tick **Require review from Code Owners**;
   - tick **Require approval of the most recent reviewable push**.
4. Under **Bypass list**, click **Add bypass**, choose **Repository admin**, and set it to **For pull requests only**. GitHub never counts a PR author's own review, so without this Pasta could not merge his own release PRs. "For pull requests only" keeps the bypass visible on a PR; it never allows a direct push.
5. Click **Create**.

With this rule, a PR that touches a code-owned file needs Pasta's approval of its latest commit. That covers the release keys, the workflows, the Mainnet flag, the release check, the Worker config and the dependencies, so no agent can merge such a change alone. Other PRs still merge without approval, but nothing can be pushed straight to `main` any more: README hash bumps and the off switch's follow-up go through PRs too. Check the rule once by opening a PR that touches `releases/allowed_signers`. It should show "Review required".

### 4. Release key (3 min)

On Pasta's own machine, with a hardware security key if available:

```sh
ssh-keygen -t ed25519-sk -O resident -C dti-release -f ~/.ssh/dti-release   # with a FIDO2 key
# or, without one:
ssh-keygen -t ed25519 -C dti-release -f ~/.ssh/dti-release                   # set a passphrase
```

Then add the public key as an allowed signer, in a PR, which step 3 makes Pasta-only:

```sh
cd dash-threshold-identity && git switch -c release-key
echo "pasta namespaces=\"dti-release\" $(cat ~/.ssh/dti-release.pub)" >> releases/allowed_signers
git commit -am "chore: add Pasta's release key" && git push -u origin release-key
gh pr create --fill && gh pr merge --merge --admin
```

List each key on one line only; `ssh-keygen` matches the first line with a key. The public key is not secret. Pasta can also send `~/.ssh/dti-release.pub` to an agent to open that PR, and approve it.

### 5. Cloudflare zone rules for the host (3 min)

These stop Cloudflare from injecting scripts into the page. The Worker already blocks the analytics beacon with `no-transform` and its CSP; these rules turn the features off at the source.

1. Open https://dash.cloudflare.com, choose the account, then **dashhq.org** → **Rules** → **Configuration Rules** → **Create rule**.
   - **Rule name:** `multisig: no injected scripts`.
   - **If incoming requests match:** Custom filter expression → **Edit expression** → `(http.host in {"multisig.dashhq.org" "new-multisig.dashhq.org"})`.
   - **Then the settings are:** add Rocket Loader **Off**, Email Obfuscation **Off**, Disable Zaraz, Disable Real User Monitoring (RUM) and Disable Apps.
   - Click **Deploy**.
2. **Analytics & Logs** → **Web Analytics** → `dashhq.org` → **Manage site** → **Advanced options** → **Add rule**. Set host `multisig.dashhq.org`, path `*`, **Exclude**, then save. Repeat for `new-multisig.dashhq.org`.

Rollback: delete those rules.

**Total:** about 17 minutes. Then tell the PM it's done. An agent then dispatches the workflow once: Pasta approves the run, and it should stop at "Refuse a build that Pasta has not signed", because nothing is signed yet.

## Each Mainnet release afterwards (about 5 minutes)

```sh
git switch main && git pull && npm ci --ignore-scripts && npm run web:build   # Pasta's machine reproduces the build
node web/release.mjs sign --key ~/.ssh/dti-release             # refuses a dirty checkout; signs this exact page and Worker
git switch -c release-$(date +%F) && git add releases && git commit -m "chore: sign release" && git push -u origin HEAD
gh pr create --fill && gh pr merge --merge --admin
gh workflow run deploy-web-mainnet.yml --ref main              # then approve the run in GitHub
```

Signing on Pasta's machine covers the checklist's "reproduced on a second machine": the signature is over the hashes his own build produced, and the workflow refuses anything else. Before relying on this, compare his first build with the CI build once. If macOS and Linux builds ever differ, the check fails, which is safe, and an agent fixes the build.

## What this does not stop

- **Other account-wide tokens can still deploy the Worker directly**, including the agent box's `dash-nodes` token, without going through GitHub. The signed release makes such a deploy detectable (the live page hash won't match any signed release, and `web:verify` fails), but not impossible. Preventing it needs one of:
  - removing **Workers Scripts · Edit** from the agent token (about 3 minutes, but agents then can't deploy any other dashhq Worker either);
  - or serving Mainnet from a separate Cloudflare account that only the `web-mainnet` token can reach (about 30 minutes, and the host would need a zone in that account).
- **A changed page could still read phrases on Mainnet**, because the Mainnet CSP allows any HTTPS host on port 443 until a named DAPI gateway exists (D6).
- **The funding key is derived from the member's phrase in the page** (D9). Member phrases typed into the page must hold no funds.

## Switching Mainnet off

One command, from a checkout of `main` with Cloudflare credentials in the environment:

```sh
npm run web:mainnet-off
```

It checks that the checkout is a clean, current `origin/main` (pass `--force` to skip that in an emergency). It then sets `MAINNET_WRITES = false` and re-pins the test, runs the tests, rebuilds, publishes the hash, deploys and checks the live site. The credentials are `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for a token that can deploy Workers: an account token an agent uses, or one Pasta keeps. Open a PR with the change afterwards so `main` matches what is live.

For an immediate stop without rebuilding, `npx wrangler rollback <version id>` from `web/` restores an earlier deploy; `npx wrangler deployments list` shows the ids. Cloudflare may refuse a rollback across a Durable Object migration.
