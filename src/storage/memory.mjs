const files = new Map();

export const readJson = (key, fallback) => (files.has(key) ? JSON.parse(files.get(key)) : fallback);

export function writeJson(key, value) {
  files.set(key, JSON.stringify(value));
}

export const listJson = (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`) && k.endsWith('.json'));

export const withLock = (_key, fn) => fn();
