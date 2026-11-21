import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';

export { bytesToHex as hex, hexToBytes as unhex, utf8ToBytes as utf8 };

export const base64ToHex = (b64) => bytesToHex(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

export const sha256hex = (bytes) => bytesToHex(sha256(typeof bytes === 'string' ? utf8ToBytes(bytes) : bytes));

export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`non-integer number in canonical JSON: ${value}`);
    if (value === undefined) throw new Error('undefined in canonical JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export const digest = (value) => sha256hex(canonical(value));

export function u32be(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

export function lengthPrefixed(...parts) {
  return concatBytes(...parts.flatMap((p) => {
    const bytes = typeof p === 'string' ? utf8ToBytes(p) : typeof p === 'number' ? u32be(p) : p;
    return [u32be(bytes.length), bytes];
  }));
}

export const jsonReplacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? bytesToHex(v) : v);
export const toPlain = (v) => JSON.parse(JSON.stringify(v, jsonReplacer));

export function assert(cond, message) {
  if (!cond) throw new Error(message);
}

export const getOwn = (o, k) => (Object.hasOwn(o, k) ? o[k] : null);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ROOM_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const isHex = (s, bytes) => typeof s === 'string' && /^[0-9a-f]*$/.test(s) && s.length % 2 === 0 && (bytes === undefined || s.length === bytes * 2);

export function memo(fn, keyOf, limit = 5000) {
  const cache = new Map();
  return (...args) => {
    const key = keyOf(...args);
    if (cache.has(key)) return cache.get(key);
    const value = fn(...args);
    if (cache.size >= limit) cache.delete(cache.keys().next().value);
    cache.set(key, value);
    return value;
  };
}
