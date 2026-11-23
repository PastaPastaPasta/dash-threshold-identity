import { sealEnvelope } from './envelope.mjs';
import { makeConfig, ceremonyId, participantIndex, buildReveal, revealDigest, receiveShares, buildCompletion, publicShareOf } from './ceremony.mjs';
import { signShare, combineShares, verify } from './bls.mjs';
import { requirementKey } from './state.mjs';
import { unhex, assert, getOwn } from './util.mjs';

export function hello(keys, room, name, { group, funding } = {}) {
  return sealEnvelope(keys, room, 'hello', { name, transportPub: keys.transportPub, fingerprint: keys.fingerprint, ...(group ? { group } : {}), ...(funding ? { funding } : {}) });
}

export function proposeCeremony(keys, room, state, { network, label, threshold, members, keys: slots, createdAt }) {
  assert(members.every((a) => Object.hasOwn(state.hellos, a)), 'every member must join the room first');
  const participants = members.map((authPub) => {
    const h = state.hellos[authPub];
    assert(h, `no hello from ${authPub.slice(0, 12)}…; every member must join the room first`);
    return { name: h.name, authPub, transportPub: h.transportPub };
  });
  const config = makeConfig({ room, network, label, threshold, organizer: keys.authPub, participants, keys: slots, createdAt });
  return { cid: ceremonyId(config), envelope: sealEnvelope(keys, room, 'config', { config }) };
}

export function accept(keys, room, cid) {
  return sealEnvelope(keys, room, 'accept', { cid });
}

function myCeremony(state, cid, keys) {
  const c = getOwn(state.ceremonies, cid);
  assert(c, `unknown ceremony ${cid}`);
  const me = participantIndex(c.config, keys.authPub);
  assert(me, 'you are not a participant in this ceremony');
  return { c, me };
}

export function nextCeremonyStep(seed, keys, room, state, cid) {
  const { c, me } = myCeremony(state, cid, keys);
  const n = c.config.participants.length;
  const has = (o) => Object.hasOwn(o, me);
  const all = (o) => Object.keys(o).length === n;
  if (c.status === 'failed') return { action: 'failed', envelopes: [] };
  if (!has(c.accepts)) return { action: 'accept', needsConfirmation: true, envelopes: [accept(keys, room, cid)] };
  if (!all(c.accepts)) return { action: 'wait-accepts', envelopes: [] };
  if (!has(c.commits)) {
    const reveal = buildReveal(seed, keys, c.config, cid);
    return { action: 'commit', envelopes: [sealEnvelope(keys, room, 'dkg-commit', { cid, digest: revealDigest(reveal) })] };
  }
  if (!all(c.commits)) return { action: 'wait-commits', envelopes: [] };
  if (!has(c.reveals)) {
    const reveal = buildReveal(seed, keys, c.config, cid);
    assert(revealDigest(reveal) === c.commits[me], 'my reveal no longer matches my commitment (wrong seed?)');
    return { action: 'reveal', envelopes: [sealEnvelope(keys, room, 'dkg-reveal', { cid, reveal })] };
  }
  if (!all(c.reveals)) return { action: 'wait-reveals', envelopes: [] };
  if (!has(c.completes)) {
    const { shares, complaints } = receiveShares(seed, keys, c.config, cid, c.reveals);
    if (complaints.length) {
      return { action: 'complain', envelopes: complaints.map((x) => sealEnvelope(keys, room, 'dkg-complaint', { cid, ...x })) };
    }
    const completion = buildCompletion(c.config, cid, c.reveals, c.revealDigests, shares);
    return { action: 'complete', envelopes: [sealEnvelope(keys, room, 'dkg-complete', completion)] };
  }
  if (c.status !== 'complete') return { action: 'wait-completes', envelopes: [] };
  return { action: 'done', envelopes: [] };
}

export function recoverShares(seed, keys, state, cid) {
  const { c, me } = myCeremony(state, cid, keys);
  assert(c.status === 'complete', `ceremony ${cid.slice(0, 12)} is ${c.status}, not complete`);
  const { shares, complaints } = receiveShares(seed, keys, c.config, cid, c.reveals);
  assert(!complaints.length, `cannot recover shares: ${complaints.map((x) => x.reason).join('; ')}`);
  for (const [slot, share] of Object.entries(shares)) {
    assert(publicShareOf(share) === c.result.keys[slot].publicShares[me], `recovered ${slot} share does not match the public transcript (wrong seed?)`);
  }
  return { index: me, shares };
}

export function propose(keys, room, body) {
  return sealEnvelope(keys, room, 'proposal', body);
}

export function approve(seed, keys, room, state, proposalId) {
  const p = state.proposals[proposalId];
  assert(p, `unknown proposal ${proposalId}`);
  const message = unhex(p.body.signable);
  const shares = {};
  for (const r of p.body.requirements) {
    const c = state.ceremonies[r.cid];
    if (!c || !participantIndex(c.config, keys.authPub)) continue;
    const { index, shares: mine } = recoverShares(seed, keys, state, r.cid);
    assert(mine[r.slot] !== undefined, `slot ${r.slot} not in ceremony ${r.cid.slice(0, 12)}`);
    shares[requirementKey(r)] = { index, share: signShare(mine[r.slot], message) };
  }
  assert(Object.keys(shares).length, 'you hold no share for any key this proposal needs');
  return sealEnvelope(keys, room, 'approve', { proposalId, shares });
}

export function combine(state, proposalId) {
  const p = state.proposals[proposalId];
  assert(p, `unknown proposal ${proposalId}`);
  assert(p.status === 'ready' || p.status === 'executed', `proposal is ${p.status}${p.error ? `: ${p.error}` : ''}`);
  const message = unhex(p.body.signable);
  const signatures = {};
  for (const r of p.requirements) {
    const indices = Object.keys(r.shares).map(Number).sort((a, b) => a - b).slice(0, r.threshold);
    const signature = combineShares(Object.fromEntries(indices.map((i) => [i, r.shares[i]])));
    const groupPublicKey = state.ceremonies[r.cid].result.keys[r.slot].groupPublicKey;
    assert(verify(signature, message, groupPublicKey), `${r.key}: combined signature does not verify under the group key`);
    signatures[r.key] = { signature, signers: indices, groupPublicKey };
  }
  return signatures;
}

export function reject(keys, room, proposalId, reason) {
  return sealEnvelope(keys, room, 'reject', { proposalId, reason });
}

export function recordBroadcast(keys, room, proposalId, result) {
  return sealEnvelope(keys, room, 'broadcast', { proposalId, result });
}
