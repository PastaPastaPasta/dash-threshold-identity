// Turns Mainnet writes off and deploys that build to the hosted page.
//   npm run web:mainnet-off              set the flag false, test, build, deploy, check the live site
//   npm run web:mainnet-off -- --no-deploy   only change and test the source
//   --force   skip the check that this is a clean, current checkout of origin/main
// Deploying needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID for an account token that can deploy Workers
// (an account token an agent uses, or Pasta's own).
// Open a PR with the change afterwards so `main` matches what is live.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLAGS = path.join(root, 'web', 'src', 'flags.mjs');
const TEST = path.join(root, 'test', 'web.test.mjs');
const SITE = process.env.SITE ?? 'https://multisig.dashhq.org';
const deploy = !process.argv.includes('--no-deploy');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

if (deploy && !process.argv.includes('--force')) {
  git('fetch', '--quiet', 'origin', 'main');
  if (git('status', '--porcelain')) throw new Error('the checkout has uncommitted changes; use a clean checkout of main (or pass --force)');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) throw new Error('HEAD is not origin/main; run `git switch main && git pull` first (or pass --force)');
}

const flags = fs.readFileSync(FLAGS, 'utf8');
const off = flags.replace(/export const MAINNET_WRITES = (true|false);/, 'export const MAINNET_WRITES = false;');
if (!/export const MAINNET_WRITES = false;/.test(off)) throw new Error('could not find MAINNET_WRITES in web/src/flags.mjs');
fs.writeFileSync(FLAGS, off);
const test = fs.readFileSync(TEST, 'utf8');
const pinned = test.replace(/assert\.equal\(MAINNET_WRITES, (true|false)\);/, 'assert.equal(MAINNET_WRITES, false);');
if (!/assert\.equal\(MAINNET_WRITES, false\);/.test(pinned)) throw new Error('could not find the MAINNET_WRITES pin in test/web.test.mjs');
fs.writeFileSync(TEST, pinned);
console.log('MAINNET_WRITES = false');

run('node', ['--test', 'test/web.test.mjs']);
run('npm', ['run', 'web:hash']);
if (deploy) {
  run('npx', ['wrangler', 'deploy', '--config', 'web/wrangler.toml']);
  let ok = false;
  for (let i = 0; i < 5 && !ok; i++) {
    try {
      run('node', ['web/verify.mjs', SITE]);
      ok = true;
    } catch {
      execFileSync('sleep', ['15']);
    }
  }
  if (!ok) throw new Error(`deployed, but ${SITE} does not match this build yet; run node web/verify.mjs ${SITE}`);
}
console.log(`Mainnet writes are off${deploy ? ` on ${SITE}` : ''}. Open a PR with web/src/flags.mjs, test/web.test.mjs and README.md so main matches.`);
