import { Buffer } from 'buffer';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { sha1, ripemd160 } from '@noble/hashes/legacy.js';
import { hmac } from '@noble/hashes/hmac.js';

const HASHES = { sha1, sha256, sha512, ripemd160, rmd160: ripemd160 };

const algorithm = (name) => {
  const h = HASHES[String(name).toLowerCase()];
  if (!h) throw new Error(`crypto shim: unsupported hash ${name}`);
  return h;
};

const bytes = (data, encoding) => (typeof data === 'string' ? Buffer.from(data, encoding) : data);

function digester(make) {
  const parts = [];
  return {
    update(data, encoding) {
      parts.push(bytes(data, encoding));
      return this;
    },
    digest(encoding) {
      const out = Buffer.from(make(Buffer.concat(parts)));
      return encoding ? out.toString(encoding) : out;
    },
  };
}

export const createHash = (name) => digester((m) => algorithm(name)(m));
export const createHmac = (name, key) => digester((m) => hmac(algorithm(name), bytes(key), m));
export const randomBytes = (n) => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n)));

export default { createHash, createHmac, randomBytes };
