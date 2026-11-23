// Signed releases for the hosted page.
//   node web/release.mjs sign --key ~/.ssh/dti-release   sign the page hash of web/dist (run after `npm run web:build`)
//   node web/release.mjs check                            fail unless web/dist's page hash has a valid signature
// A release is releases/<page sha256>.json with a detached SSH signature next to it (namespace "dti-release").
// releases/allowed_signers lists the keys allowed to sign, in ssh-keygen's allowed_signers format.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bundleManifest, sha256 } from './manifest.mjs';

const NAMESPACE = 'dti-release';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'web', 'dist');
const dir = path.join(root, 'releases');
const signers = path.join(dir, 'allowed_signers');

const pageHash = sha256(fs.readFileSync(path.join(dist, 'index.html')));
const bundleHash = sha256(bundleManifest(dist));
const file = path.join(dir, `${pageHash}.json`);
const [command, ...rest] = process.argv.slice(2);

if (command === 'sign') {
  const key = rest[rest.indexOf('--key') + 1];
  if (!rest.includes('--key') || !key) throw new Error('pass --key <path to your private release key>');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ pageHash, bundleHash, signedAt: new Date().toISOString() }, null, 1)}\n`);
  fs.rmSync(`${file}.sig`, { force: true });
  execFileSync('ssh-keygen', ['-Y', 'sign', '-f', key, '-n', NAMESPACE, file], { stdio: 'inherit' });
  console.log(`signed ${path.relative(root, file)}; commit it and ${path.relative(root, file)}.sig`);
} else if (command === 'check') {
  if (!fs.existsSync(file) || !fs.existsSync(`${file}.sig`)) throw new Error(`no signed release for page hash ${pageHash} (expected releases/${pageHash}.json and .sig)`);
  const release = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (release.pageHash !== pageHash || release.bundleHash !== bundleHash) throw new Error('the release file does not match this build');
  const principals = execFileSync('ssh-keygen', ['-Y', 'find-principals', '-f', signers, '-s', `${file}.sig`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (!principals.length) throw new Error('the signature is not from a key in releases/allowed_signers');
  execFileSync('ssh-keygen', ['-Y', 'verify', '-f', signers, '-I', principals[0], '-n', NAMESPACE, '-s', `${file}.sig`], { input: fs.readFileSync(file), stdio: ['pipe', 'inherit', 'inherit'] });
  console.log(`page ${pageHash} is signed by ${principals[0]}`);
} else {
  console.error('usage: node web/release.mjs sign --key <key> | check');
  process.exit(2);
}
