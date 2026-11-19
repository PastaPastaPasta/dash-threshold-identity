import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { hex, utf8, lengthPrefixed, sha256hex, assert } from './util.mjs';
import { R, mod, bytesToScalar } from './bls.mjs';

const SALT = utf8('dash-threshold-identity/v1');

export function seedFromMnemonic(mnemonic, passphrase = '') {
  const words = String(mnemonic).trim().toLowerCase().split(/\s+/).join(' ');
  assert(validateMnemonic(words, wordlist), 'invalid BIP39 mnemonic (English wordlist, checksum must match)');
  return mnemonicToSeedSync(words, passphrase);
}

export function kdf(seed, label, parts = [], length = 32) {
  assert(seed instanceof Uint8Array && seed.length >= 32, 'seed must be at least 32 bytes');
  return hkdf(sha256, seed, SALT, lengthPrefixed(label, ...parts), length);
}

export function kdfScalar(seed, label, parts = []) {
  for (let counter = 0; ; counter++) {
    const x = mod(bytesToScalar(kdf(seed, label, [...parts, counter], 64)));
    if (x !== 0n) return x;
  }
}

export function participantKeys(seed) {
  const authSecret = kdf(seed, 'auth/ed25519');
  const transportSecret = kdf(seed, 'transport/x25519');
  const authPub = hex(ed25519.getPublicKey(authSecret));
  const transportPub = hex(x25519.getPublicKey(transportSecret));
  return { authSecret, authPub, transportSecret, transportPub, fingerprint: fingerprint(authPub, transportPub) };
}

export function fingerprint(authPub, transportPub) {
  const h = sha256hex(`dti-fingerprint|${authPub}|${transportPub}`).slice(0, 20).toUpperCase();
  return h.match(/.{4}/g).join('-');
}

export function dkgCoefficients(seed, cid, slot, threshold) {
  return Array.from({ length: threshold }, (_, k) => kdfScalar(seed, 'dkg/coefficient', [cid, slot, k]));
}

export function deterministicNonce(seed, label, parts) {
  return kdfScalar(seed, `nonce/${label}`, parts);
}

const COIN = { mainnet: 5, testnet: 1 };

export function coreKey(seed, path) {
  const node = HDKey.fromMasterSeed(seed).derive(path);
  assert(node.privateKey, `no private key at ${path}`);
  return { path, privateKeyHex: hex(node.privateKey), publicKeyHex: hex(node.publicKey) };
}

export const coreFundingPath = (network, index = 0) => `m/44'/${COIN[network]}'/0'/0/${index}`;
export const assetLockRegistrationPath = (network, index) => `m/9'/${COIN[network]}'/5'/1'/${index}'`;
export const assetLockTopUpPath = (network, index) => `m/9'/${COIN[network]}'/5'/2'/${index}'`;

export { R };
