# Verifying the hosted build

The page at https://multisig.dashhq.org handles your seed phrase, so you should be able to check that it is exactly the code in this repository. The build is reproducible: the same commit and lockfile always produce the same bytes.

## What gets published

- `build-manifest.txt` lists every served file except `index.html` (scripts, styles, fonts, the shell), each with its SHA-256. Its own hash is the **bundle hash**.
- `index.html` carries the bundle hash, so the **page hash**, the SHA-256 of `index.html`, covers the whole site.
- The README on `main` publishes the page hash for that commit, and CI fails if it doesn't match what the commit builds.
- The unlock screen shows the full bundle hash and the footer its first 12 characters. Treat those as a label, not proof: a modified page could print the right hash and still load other code. The check below is the proof.

## Checking the live site

You need git and Node 22 or newer.

```sh
git clone https://github.com/PastaPastaPasta/dash-threshold-identity
cd dash-threshold-identity
git checkout <commit>            # the commit you expect to be deployed, e.g. main
npm ci --ignore-scripts          # a real node_modules directory; a symlinked or pnpm layout builds different bytes
npm run web:verify -- https://multisig.dashhq.org   # builds, then compares
```

`web:verify` builds the commit you checked out, then fetches `index.html`, `build-manifest.txt` and every file in it from the site, without following redirects, and compares each one with your build. It also compares the live security headers (the CSP and the others in `web/headers.mjs`) with the source and flags headers that could load or redirect to other content. It prints `OK` or each mismatch and exits non-zero.

The page hash it prints should equal the one in the README at that commit.

## What this does and does not prove

- It proves the files the site served **to you, when you ran the check** were built from that commit. It does not stop a later deploy from serving different code, or a server from serving different code to someone else. Run it again before a session that matters.
- The Worker that serves the files is not covered byte for byte. The check covers its visible behaviour: the files it serves and the headers it sends.
- The CSP and the testnet lock are part of the checked source; see [HOSTED.md](HOSTED.md).
- A mainnet build would need more than this; see [MAINNET-SIGNOFF.md](MAINNET-SIGNOFF.md).
