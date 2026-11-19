import { bls12_381 } from '@noble/curves/bls12-381.js';
import { hex, unhex } from './util.mjs';

export const DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_';
const Fr = bls12_381.fields.Fr;
const sigs = bls12_381.longSignatures;
export const R = Fr.ORDER;
export const G1 = bls12_381.G1.Point;
export const G2 = bls12_381.G2.Point;

export const mod = (a) => {
  const x = a % R;
  return x >= 0n ? x : x + R;
};
export const bytesToScalar = (bytes) => BigInt(`0x${hex(bytes) || '0'}`);
export const scalarToHex = (s) => s.toString(16).padStart(64, '0');
export const scalarFromHex = (h) => mod(BigInt(`0x${h}`));

export const g1 = (scalar) => G1.BASE.multiply(scalar);
export const g1Hex = (point) => point.toHex(true);
export const g1FromHex = (h) => G1.fromHex(h);

export function evalPoly(coefficients, x) {
  let acc = 0n;
  let xk = 1n;
  for (const a of coefficients) {
    acc = mod(acc + a * xk);
    xk = mod(xk * BigInt(x));
  }
  return acc;
}

export function evalCommitments(commitmentsHex, x) {
  let acc = G1.ZERO;
  let xk = 1n;
  for (const c of commitmentsHex) {
    acc = acc.add(G1.fromHex(c).multiply(xk));
    xk = mod(xk * BigInt(x));
  }
  return acc;
}

export function lagrangeAtZero(i, indices) {
  let num = 1n;
  let den = 1n;
  for (const j of indices) {
    if (j === i) continue;
    num = mod(num * BigInt(j));
    den = mod(den * BigInt(j - i));
  }
  return mod(num * Fr.inv(den));
}

export const hashToG2 = (message) => sigs.hash(message, DST);

export function signShare(share, message) {
  return hex(sigs.Signature.toBytes(hashToG2(message).multiply(share)));
}

export function verify(signatureHex, message, publicKeyHex) {
  try {
    const pk = G1.fromHex(publicKeyHex);
    const sig = sigs.Signature.fromBytes(unhex(signatureHex));
    if (pk.equals(G1.ZERO) || sig.equals(G2.ZERO)) return false;
    return sigs.verify(sig, hashToG2(message), pk.toBytes(true));
  } catch {
    return false;
  }
}

export function combineShares(sharesByIndex) {
  const indices = Object.keys(sharesByIndex).map(Number).sort((a, b) => a - b);
  let acc = null;
  for (const i of indices) {
    const term = sigs.Signature.fromBytes(unhex(sharesByIndex[i])).multiply(lagrangeAtZero(i, indices));
    acc = acc ? acc.add(term) : term;
  }
  return hex(sigs.Signature.toBytes(acc));
}

export function interpolatePublic(pointsByIndex) {
  const indices = Object.keys(pointsByIndex).map(Number);
  return indices.reduce((acc, i) => acc.add(G1.fromHex(pointsByIndex[i]).multiply(lagrangeAtZero(i, indices))), G1.ZERO);
}
