# Mainnet guardrails: what Pasta sets up

This is the deploy-trust part of [MAINNET-SIGNOFF.md](MAINNET-SIGNOFF.md). It takes one sitting of about 15 minutes, and only covers what needs Pasta's GitHub and Cloudflare accounts. Mainnet writes stay off (`MAINNET_WRITES = false`) until Pasta decides otherwise; nothing here turns them on.

## Already done in the repository

- `.github/workflows/deploy-web-mainnet.yml` deploys the hosted app from `main` only, through a `web-mainnet` environment. It runs the tests, rebuilds, checks the README hash, and **refuses to deploy a build that Pasta has not signed** (`node web/release.mjs check`), then checks the live site byte for byte.
- `web/release.mjs` signs and checks releases. A release is `releases/<page sha256>.json` plus an SSH signature (namespace `dti-release`). The keys allowed to sign are listed in `releases/allowed_signers`, which is empty until step 4.
- `.github/CODEOWNERS` names Pasta as owner of `releases/`, `web/src/flags.mjs`, the Mainnet deploy workflow and `CODEOWNERS` itself. Step 3 makes that binding.
- `npm run web:mainnet-off` turns Mainnet writes off and deploys that build (see "Switching Mainnet off").

## Steps (about 15 minutes)

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

Cloudflare cannot limit a token to a single Worker. "Workers Scripts · Edit" covers every Worker in the account. That is why step 4 matters: the workflow deploys only builds Pasta signed. If the first run fails while updating `multisig.dashhq.org`, add **Zone · DNS · Edit** for `dashhq.org` to this token.

### 2. GitHub environment `web-mainnet` (4 min)

1. Open https://github.com/PastaPastaPasta/dash-threshold-identity/settings/environments, then **New environment**. Name it `web-mainnet` and click **Configure environment**.
2. Tick **Required reviewers**, add `PastaPastaPasta`, and leave **Prevent self-review** unticked (Pasta both starts and approves releases).
3. Untick **Allow administrators to bypass configured protection rules**.
4. Under **Deployment branches and tags**, choose **Selected branches and tags**, then **Add deployment branch or tag rule**. Use the ref type **Branch**, the name pattern `main`, then **Add rule**.
5. Under **Environment secrets**, click **Add environment secret** twice:
   - `CLOUDFLARE_API_TOKEN`: the token from step 1.
   - `CLOUDFLARE_ACCOUNT_ID`: `23c3b2efbaecdd502503aaf5aa3e57a0`.
6. Click **Save protection rules**.

### 3. Make code owners binding on `main` (2 min)

1. Open https://github.com/PastaPastaPasta/dash-threshold-identity/settings/branches, then **Add branch ruleset** (or edit the existing rule for `main`).
2. **Ruleset name:** `main`. **Enforcement status:** Active. **Target branches:** Add target, then **Include default branch**.
3. Tick **Require a pull request before merging**. Set **Required approvals** to `0`, and tick **Require review from Code Owners**.
4. Leave the bypass list empty, then click **Create**.

With this rule in place, nobody else (and no agent) can merge a change to the allowed signers, the Mainnet flag or the Mainnet workflow without Pasta's approval. Other PRs merge as before.

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
gh pr create --fill && gh pr merge --merge
```

The public key is not secret. Pasta can also send `~/.ssh/dti-release.pub` to an agent to open that PR, and approve it.

### 5. Cloudflare zone rules for the host (3 min)

These stop Cloudflare from injecting scripts into the page. The Worker already blocks the analytics beacon with `no-transform` and its CSP; these rules turn the features off at the source.

1. Open https://dash.cloudflare.com, choose the account, then **dashhq.org** → **Rules** → **Configuration Rules** → **Create rule**.
   - **Rule name:** `multisig: no injected scripts`.
   - **If incoming requests match:** Custom filter expression → **Edit expression** → `(http.host in {"multisig.dashhq.org" "new-multisig.dashhq.org"})`.
   - **Then the settings are:** add Rocket Loader **Off**, Email Obfuscation **Off**, Disable Zaraz, Disable Real User Monitoring (RUM) and Disable Apps.
   - Click **Deploy**.
2. **Analytics & Logs** → **Web Analytics** → `dashhq.org` → **Manage site** → **Advanced options** → **Add rule**. Set host `multisig.dashhq.org`, path `*`, **Exclude**, then save. Repeat for `new-multisig.dashhq.org`.

Rollback: delete those rules.

**Total:** about 16 minutes. Then tell the PM it's done. An agent checks it with `npm run web:verify -- https://multisig.dashhq.org` and a dry run of the workflow, which should stop at "Refuse a build that Pasta has not signed".

## Each Mainnet release afterwards (about 5 minutes)

```sh
git switch main && git pull && npm ci && npm run web:build      # Pasta's machine reproduces the build
node web/release.mjs sign --key ~/.ssh/dti-release             # signs this exact page hash
git switch -c release-$(date +%F) && git add releases && git commit -m "chore: sign release" && git push -u origin HEAD
gh pr create --fill && gh pr merge --merge
gh workflow run deploy-web-mainnet.yml --ref main              # then approve the run in GitHub
```

Signing on Pasta's machine covers the checklist's "reproduced on a second machine": the signature is over the page hash his own build produced, and the workflow refuses anything else.

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

It sets `MAINNET_WRITES = false` and re-pins the test. It then runs the tests, rebuilds, publishes the hash, deploys, and checks the live site. Commit and push the change afterwards. For an immediate stop without rebuilding, `npx wrangler rollback <previous version id>` from `web/` restores the last deploy; `npx wrangler deployments list` shows the ids.
