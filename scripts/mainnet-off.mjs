// Turns Mainnet writes off and deploys that build to the hosted page.
//   npm run web:mainnet-off              set the flag false, test, build, deploy, check the live site
//   npm run web:mainnet-off -- --no-deploy   only change and test the source
// Deploying needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, the same as `npm run web:deploy`.
// Commit and push the change afterwards so `main` matches what is live.
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

fs.writeFileSync(FLAGS, 'export const MAINNET_WRITES = false;\n');
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
console.log(`Mainnet writes are off${deploy ? ` on ${SITE}` : ''}. Commit web/src/flags.mjs, test/web.test.mjs and README.md, then push.`);
