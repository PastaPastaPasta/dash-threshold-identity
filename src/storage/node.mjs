import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function home() {
  return process.env.DTI_HOME || path.join(os.homedir(), '.dti');
}

const full = (key) => path.join(home(), key);

export function readJson(key, fallback) {
  const file = full(key);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

export function writeJson(key, value) {
  const file = full(key);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

export function listJson(dir) {
  const d = full(dir);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => `${dir}/${f}`);
}

const pause = new Int32Array(new SharedArrayBuffer(4));

export function withLock(key, fn) {
  const file = full(key);
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs > 30000) fs.rmSync(lock, { recursive: true, force: true });
      if (Date.now() >= deadline) throw new Error(`${path.basename(file)} is locked by another process (${lock})`);
      Atomics.wait(pause, 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}
