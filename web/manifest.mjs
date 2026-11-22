import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MANIFEST = 'build-manifest.txt';
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  return e.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
});

export function bundleManifest(dir) {
  const files = walk(dir).filter((f) => f !== 'index.html' && f !== MANIFEST).sort();
  return files.map((f) => `${sha256(fs.readFileSync(path.join(dir, f)))}  ${f}\n`).join('');
}
