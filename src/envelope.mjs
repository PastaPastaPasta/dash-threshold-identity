import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { canonical, digest, hex, unhex, utf8, lengthPrefixed, isHex, assert } from './util.mjs';

export const PROTOCOL = 'dti/1';
const MAX_BODY = 256 * 1024;

const signingBytes = (unsigned) => utf8(`${PROTOCOL}|envelope|${canonical(unsigned)}`);

export function sealEnvelope(keys, room, type, body, at = new Date().toISOString()) {
  const unsigned = { v: 1, room, type, from: keys.authPub, at, body };
  const sig = hex(ed25519.sign(signingBytes(unsigned), keys.authSecret));
  return { ...unsigned, sig };
}

export function envelopeId(envelope) {
  return digest(envelope);
}

export function verifyEnvelope(envelope) {
  try {
    const { sig, ...unsigned } = envelope;
    if (unsigned.v !== 1 || typeof unsigned.type !== 'string' || typeof unsigned.room !== 'string') return false;
    if (typeof unsigned.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(unsigned.at)) return false;
    if (!isHex(unsigned.from, 32) || !isHex(sig, 64)) return false;
    if (canonical(unsigned.body).length > MAX_BODY) return false;
    return ed25519.verify(unhex(sig), signingBytes(unsigned), unhex(unsigned.from));
  } catch {
    return false;
  }
}

export function boxKeys(mySecret, theirPub, context) {
  const shared = x25519.getSharedSecret(mySecret, unhex(theirPub));
  assert(shared.some((b) => b !== 0), 'x25519 produced the all-zero shared secret (low-order public key)');
  const okm = hkdf(sha256, shared, utf8(`${PROTOCOL}/box`), lengthPrefixed(...context), 44);
  return { key: okm.slice(0, 32), nonce: okm.slice(32, 44), aad: lengthPrefixed('aad', ...context) };
}

export function boxContext({ cid, slot, from, to, fromTransport, toTransport }) {
  return ['dkg-share', cid, slot, from, to, fromTransport, toTransport];
}

export function encryptBox(mySecret, theirPub, context, plaintext) {
  const { key, nonce, aad } = boxKeys(mySecret, theirPub, context);
  return hex(chacha20poly1305(key, nonce, aad).encrypt(utf8(plaintext)));
}

export function decryptWithKey(key, nonce, context, ciphertextHex) {
  return new TextDecoder().decode(chacha20poly1305(key, nonce, lengthPrefixed('aad', ...context)).decrypt(unhex(ciphertextHex)));
}
