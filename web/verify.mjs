import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleManifest, sha256, MANIFEST } from './manifest.mjs';
import { SECURITY } from './headers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'web', 'dist');
const readme = path.join(root, 'README.md');
const MARKER = /(Bundle hash of this commit: `)([0-9a-f]{64})(`)/;

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('web/dist is missing; run `npm run web:build` first');
  process.exit(2);
}
const manifest = bundleManifest(dist);
if (manifest !== fs.readFileSync(path.join(dist, MANIFEST), 'utf8')) throw new Error(`web/dist/${MANIFEST} does not match the files next to it; rebuild`);
const bundleHash = sha256(manifest);
const indexHtml = fs.readFileSync(path.join(dist, 'index.html'));
console.log(`local build: bundle sha256 ${bundleHash}, index.html sha256 ${sha256(indexHtml)}`);

const [arg] = process.argv.slice(2);
const failures = [];

if (arg === '--readme' || arg === '--write-readme') {
  const text = fs.readFileSync(readme, 'utf8');
  const found = text.match(MARKER);
  if (!found) throw new Error('README.md has no "Bundle hash of this commit" line');
  if (arg === '--write-readme') fs.writeFileSync(readme, text.replace(MARKER, `$1${bundleHash}$3`));
  else if (found[2] !== bundleHash) failures.push(`README.md publishes ${found[2]}, but this commit builds ${bundleHash}; run \`npm run web:hash\``);
} else if (arg) {
  const base = arg.endsWith('/') ? arg : `${arg}/`;
  const get = async (file) => {
    const response = await fetch(new URL(file, base), { cache: 'no-store' });
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    return { response, bytes: Buffer.from(await response.arrayBuffer()) };
  };
  const page = await get('');
  if (!page.bytes.equals(indexHtml)) failures.push(`index.html differs from the local build (live sha256 ${sha256(page.bytes)})`);
  for (const [name, value] of Object.entries(SECURITY)) {
    if (page.response.headers.get(name) !== value) failures.push(`header ${name} is "${page.response.headers.get(name)}", expected "${value}"`);
  }
  const live = (await get(MANIFEST)).bytes.toString('utf8');
  if (live !== manifest) failures.push(`the live ${MANIFEST} lists different files or hashes`);
  for (const line of manifest.trim().split('\n')) {
    const [hash, file] = line.split('  ');
    const { bytes } = await get(file);
    if (sha256(bytes) !== hash) failures.push(`${file} differs from the local build`);
  }
  console.log(`checked ${base}: index.html, ${manifest.trim().split('\n').length} files, ${Object.keys(SECURITY).length} security headers`);
}

if (failures.length) {
  for (const f of failures) console.error(`MISMATCH: ${f}`);
  process.exit(1);
}
console.log('OK');
