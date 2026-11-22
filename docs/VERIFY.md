# Verifying the hosted build

The page at https://new-multisig.dashhq.org handles your seed phrase, so you should be able to check that it is exactly the code in this repository. The build is reproducible: the same commit and lockfile always produce the same bytes.

## What the page tells you

- The unlock screen shows the full **bundle hash**, and the footer shows its first 12 characters.
- The bundle hash is the SHA-256 of `build-manifest.txt`. That file lists every served file except `index.html` (scripts, styles, fonts, the shell), each with its own SHA-256. You can open it at https://new-multisig.dashhq.org/build-manifest.txt.
- `index.html` cannot contain its own hash, so the check below compares it byte for byte instead.
- The README on `main` publishes the bundle hash for that commit, and CI fails if it doesn't match what the commit builds.

## Checking the live site

You need git and Node 22 or newer.

```sh
git clone https://github.com/PastaPastaPasta/dash-threshold-identity
cd dash-threshold-identity
git checkout <commit>            # the commit you expect to be deployed, e.g. main
npm ci --ignore-scripts
npm run web:build                # prints "bundle sha256 …"
npm run web:verify -- https://new-multisig.dashhq.org
```

`web:verify` fetches `index.html`, `build-manifest.txt` and every file in it from the site and compares each one with your local build. It also compares the live security headers (the CSP and the others in `web/headers.mjs`) with the source. It prints `OK` or each mismatch and exits non-zero.

The bundle hash printed by your build should equal the one on the page and in the README at that commit.

## What this does and does not prove

- It proves the files the site served **to you, when you ran the check** were built from that commit. It does not stop a later deploy from serving different code, or a server from serving different code to someone else. Check again before a session that matters, and compare the hash on the page you are using.
- The Worker that serves the files is not covered byte for byte. The check covers its visible behaviour: the files it serves and the headers it sends.
- The CSP and the testnet lock are part of the checked source; see [HOSTED.md](HOSTED.md).
- A mainnet build would need more than this; see [MAINNET-SIGNOFF.md](MAINNET-SIGNOFF.md).
