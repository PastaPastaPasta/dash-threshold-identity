// Signed releases of the hosted app: the page, the Worker script and its config.
//   node web/release.mjs sign --key ~/.ssh/dti-release   sign this checkout's build (run `npm run web:build` first)
//   node web/release.mjs check                            fail unless this build has a valid signature
// A release is releases/<page sha256>.json with a detached SSH signature next to it (namespace "dti-release").
// It names the page hash, the bundle hash of web/dist, the hash of the Worker script wrangler would upload,
// and the hash of web/wrangler.toml. releases/allowed_signers lists the keys allowed to sign.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bundleManifest, sha256 } from './manifest.mjs';

const NAMESPACE = 'dti-release';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'web', 'dist');
const dir = path.join(root, 'releases');
const signers = path.join(dir, 'allowed_signers');
const config = path.join(root, 'web', 'wrangler.toml');

function workerHash() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dti-worker-'));
  try {
    execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', out, '--config', config], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
    return sha256(fs.readFileSync(path.join(out, 'worker.js')));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

const build = {
  pageHash: sha256(fs.readFileSync(path.join(dist, 'index.html'))),
  bundleHash: sha256(bundleManifest(dist)),
  workerHash: workerHash(),
  configHash: sha256(fs.readFileSync(config)),
};
const file = path.join(dir, `${build.pageHash}.json`);
const [command, ...rest] = process.argv.slice(2);

if (command === 'sign') {
  const at = rest.indexOf('--key');
  const key = at >= 0 ? rest[at + 1] : null;
  if (!key) throw new Error('pass --key <path to your private release key>');
  const dirty = execFileSync('git', ['status', '--porcelain', '--', '.', ':!releases'], { cwd: root, encoding: 'utf8' }).trim();
  if (dirty) throw new Error(`the checkout has uncommitted changes; sign only a clean checkout of main:\n${dirty}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...build, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), signedAt: new Date().toISOString() }, null, 1)}\n`);
  fs.rmSync(`${file}.sig`, { force: true });
  execFileSync('ssh-keygen', ['-Y', 'sign', '-f', key, '-n', NAMESPACE, file], { stdio: 'inherit' });
  console.log(`signed ${path.relative(root, file)}; commit it with its .sig`);
} else if (command === 'check') {
  if (!fs.existsSync(file) || !fs.existsSync(`${file}.sig`)) throw new Error(`no signed release for page hash ${build.pageHash} (expected releases/${build.pageHash}.json and .sig)`);
  const release = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(build)) if (release[k] !== v) throw new Error(`the release's ${k} is ${release[k]}, but this build has ${v}`);
  const principals = execFileSync('ssh-keygen', ['-Y', 'find-principals', '-f', signers, '-s', `${file}.sig`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const signer = principals.find((p) => {
    try {
      execFileSync('ssh-keygen', ['-Y', 'verify', '-f', signers, '-I', p, '-n', NAMESPACE, '-s', `${file}.sig`], { input: fs.readFileSync(file), stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    } catch {
      return false;
    }
  });
  if (!signer) throw new Error('the signature is not a valid dti-release signature from a key in releases/allowed_signers');
  console.log(`page ${build.pageHash}, worker ${build.workerHash} signed by ${signer}`);
} else {
  console.error('usage: node web/release.mjs sign --key <key> | check');
  process.exit(2);
}
