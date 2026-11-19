import { sha512 } from '@noble/hashes/sha2.js';
import { digest, isHex, lengthPrefixed, assert, hex } from './util.mjs';
import { dkgCoefficients, deterministicNonce } from './derive.mjs';
import { G1, g1, g1Hex, mod, bytesToScalar, evalPoly, evalCommitments, scalarToHex, scalarFromHex } from './bls.mjs';
import { boxContext, encryptBox, decryptBox, PROTOCOL } from './envelope.mjs';

export const PURPOSES = ['AUTHENTICATION', 'ENCRYPTION', 'DECRYPTION', 'TRANSFER', 'VOTING', 'OWNER'];
export const SECURITY_LEVELS = ['MASTER', 'CRITICAL', 'HIGH', 'MEDIUM'];
export const NETWORKS = ['testnet', 'mainnet'];

export const DEFAULT_KEYS = [
  { slot: 'master', keyId: 0, purpose: 'AUTHENTICATION', securityLevel: 'MASTER' },
  { slot: 'critical', keyId: 1, purpose: 'AUTHENTICATION', securityLevel: 'CRITICAL' },
  { slot: 'high', keyId: 2, purpose: 'AUTHENTICATION', securityLevel: 'HIGH' },
  { slot: 'transfer', keyId: 3, purpose: 'TRANSFER', securityLevel: 'CRITICAL' },
];

export function makeConfig({ network, label, threshold, organizer, participants, keys = DEFAULT_KEYS, createdAt = new Date().toISOString() }) {
  const config = {
    protocol: PROTOCOL,
    network,
    label,
    threshold,
    organizer,
    participants: participants.map((p, i) => ({ index: i + 1, name: p.name, authPub: p.authPub, transportPub: p.transportPub })),
    keys: keys.map((k) => ({ slot: k.slot, keyId: k.keyId, purpose: k.purpose, securityLevel: k.securityLevel })),
    createdAt,
  };
  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  assert(config.protocol === PROTOCOL, `unsupported protocol ${config.protocol}`);
  assert(NETWORKS.includes(config.network), `network must be one of ${NETWORKS.join(', ')}`);
  assert(typeof config.label === 'string' && config.label.length > 0 && config.label.length <= 120, 'label must be 1-120 characters');
  const n = config.participants.length;
  assert(n >= 2 && n <= 64, 'between 2 and 64 participants');
  assert(Number.isInteger(config.threshold) && config.threshold >= 2 && config.threshold <= n, `threshold must be between 2 and ${n}`);
  const auth = new Set();
  const transport = new Set();
  config.participants.forEach((p, i) => {
    assert(p.index === i + 1, 'participant indices must be 1..n in order');
    assert(isHex(p.authPub, 32) && isHex(p.transportPub, 32), `participant ${p.index} has malformed keys`);
    assert(typeof p.name === 'string' && p.name.length <= 64, `participant ${p.index} has a bad name`);
    auth.add(p.authPub);
    transport.add(p.transportPub);
  });
  assert(auth.size === n && transport.size === n, 'participant keys must be unique');
  assert(config.participants.some((p) => p.authPub === config.organizer), 'organizer must be a participant');
  assert(config.keys.length >= 1, 'at least one key slot');
  const slots = new Set();
  const ids = new Set();
  for (const k of config.keys) {
    assert(/^[a-z][a-z0-9-]{0,31}$/.test(k.slot), `bad slot name ${k.slot}`);
    assert(Number.isInteger(k.keyId) && k.keyId >= 0 && k.keyId < 1000, `bad keyId for ${k.slot}`);
    assert(PURPOSES.includes(k.purpose) && SECURITY_LEVELS.includes(k.securityLevel), `bad purpose/level for ${k.slot}`);
    slots.add(k.slot);
    ids.add(k.keyId);
  }
  assert(slots.size === config.keys.length && ids.size === config.keys.length, 'slot names and keyIds must be unique');
  return config;
}

export const ceremonyId = (config) => digest({ ceremony: config });

const pokContext = (cid, slot, index) => lengthPrefixed(`${PROTOCOL}/pok`, cid, slot, index);

function pokChallenge(ctx, R, A) {
  return mod(bytesToScalar(sha512(lengthPrefixed(ctx, R.toBytes(true), A.toBytes(true)))));
}

export function pokProve(seed, secret, cid, slot, index) {
  const ctx = pokContext(cid, slot, index);
  const k = deterministicNonce(seed, 'pok', [cid, slot, index, scalarToHex(secret)]);
  const R = g1(k);
  const c = pokChallenge(ctx, R, g1(secret));
  return { R: g1Hex(R), z: scalarToHex(mod(k + c * secret)) };
}

export function pokVerify(commitmentHex, proof, cid, slot, index) {
  try {
    const A = G1.fromHex(commitmentHex);
    const R = G1.fromHex(proof.R);
    const c = pokChallenge(pokContext(cid, slot, index), R, A);
    return g1(scalarFromHex(proof.z)).equals(R.add(A.multiply(c)));
  } catch {
    return false;
  }
}

export function participantIndex(config, authPub) {
  return config.participants.find((p) => p.authPub === authPub)?.index ?? null;
}

export function buildReveal(seed, keys, config, cid) {
  const me = participantIndex(config, keys.authPub);
  assert(me, 'you are not a participant in this ceremony');
  const slots = {};
  for (const { slot } of config.keys) {
    const coefficients = dkgCoefficients(seed, cid, slot, config.threshold);
    const boxes = {};
    for (const p of config.participants) {
      if (p.index === me) continue;
      const ctx = boxContext({ cid, slot, from: me, to: p.index, fromTransport: keys.transportPub, toTransport: p.transportPub });
      boxes[p.index] = encryptBox(keys.transportSecret, p.transportPub, ctx, scalarToHex(evalPoly(coefficients, p.index)));
    }
    slots[slot] = {
      commitments: coefficients.map((a) => g1Hex(g1(a))),
      pok: pokProve(seed, coefficients[0], cid, slot, me),
      boxes,
    };
  }
  return { cid, index: me, slots };
}

export const revealDigest = (reveal) => digest({ reveal });

export function checkRevealShape(config, cid, reveal, index) {
  const problems = [];
  if (reveal.cid !== cid || reveal.index !== index) problems.push('reveal is for another ceremony or index');
  for (const { slot } of config.keys) {
    const s = reveal.slots?.[slot];
    if (!s) { problems.push(`missing slot ${slot}`); continue; }
    if (!Array.isArray(s.commitments) || s.commitments.length !== config.threshold) problems.push(`${slot}: expected ${config.threshold} commitments`);
    else if (!pokVerify(s.commitments[0], s.pok, cid, slot, index)) problems.push(`${slot}: bad proof of knowledge`);
    else if (G1.fromHex(s.commitments[config.threshold - 1]).equals(G1.ZERO)) problems.push(`${slot}: degenerate polynomial (top coefficient is zero)`);
    const expected = config.participants.filter((p) => p.index !== index).map((p) => String(p.index)).sort();
    if (Object.keys(s.boxes ?? {}).sort().join() !== expected.join()) problems.push(`${slot}: boxes do not cover every other participant`);
  }
  return problems;
}

export function receiveShares(seed, keys, config, cid, reveals) {
  const me = participantIndex(config, keys.authPub);
  assert(me, 'you are not a participant in this ceremony');
  const shares = {};
  const complaints = [];
  for (const { slot } of config.keys) {
    let share = evalPoly(dkgCoefficients(seed, cid, slot, config.threshold), me);
    for (const p of config.participants) {
      if (p.index === me) continue;
      const reveal = reveals[p.index];
      if (!reveal) { complaints.push({ against: p.index, slot, reason: 'no reveal' }); continue; }
      const s = reveal.slots[slot];
      const ctx = boxContext({ cid, slot, from: p.index, to: me, fromTransport: p.transportPub, toTransport: keys.transportPub });
      let value;
      try {
        value = scalarFromHex(decryptBox(keys.transportSecret, p.transportPub, ctx, s.boxes[me]));
      } catch {
        complaints.push({ against: p.index, slot, reason: 'share box does not decrypt' });
        continue;
      }
      if (!g1(value).equals(evalCommitments(s.commitments, me))) {
        complaints.push({ against: p.index, slot, reason: 'share does not match commitments' });
        continue;
      }
      share = mod(share + value);
    }
    shares[slot] = share;
  }
  return { shares, complaints };
}

export function groupKeys(config, reveals) {
  const out = {};
  for (const { slot } of config.keys) {
    const commitmentSets = config.participants.map((p) => reveals[p.index].slots[slot].commitments);
    const groupPublicKey = commitmentSets.reduce((acc, c) => acc.add(G1.fromHex(c[0])), G1.ZERO);
    const publicShares = {};
    for (const p of config.participants) {
      publicShares[p.index] = g1Hex(commitmentSets.reduce((acc, c) => acc.add(evalCommitments(c, p.index)), G1.ZERO));
    }
    assert(!groupPublicKey.equals(G1.ZERO), `${slot}: group public key is the identity point`);
    const top = commitmentSets.reduce((acc, c) => acc.add(G1.fromHex(c[config.threshold - 1])), G1.ZERO);
    assert(!top.equals(G1.ZERO), `${slot}: joint polynomial has degree below threshold-1`);
    out[slot] = { groupPublicKey: g1Hex(groupPublicKey), publicShares };
  }
  return out;
}

export function transcriptDigest(cid, config, revealDigests) {
  return digest({ transcript: cid, reveals: config.participants.map((p) => revealDigests[p.index]) });
}

export function buildCompletion(config, cid, reveals, revealDigests, shares) {
  const keysOut = groupKeys(config, reveals);
  for (const { slot } of config.keys) {
    const me = Object.entries(keysOut[slot].publicShares).find(([, pub]) => pub === g1Hex(g1(shares[slot])));
    assert(me, `${slot}: my share does not match the public commitments`);
  }
  return {
    cid,
    transcript: transcriptDigest(cid, config, revealDigests),
    keys: Object.fromEntries(Object.entries(keysOut).map(([slot, k]) => [slot, { groupPublicKey: k.groupPublicKey, publicSharesDigest: digest(k.publicShares) }])),
  };
}

export const shareHex = (share) => scalarToHex(share);
export const publicShareOf = (share) => g1Hex(g1(share));
export { hex };
