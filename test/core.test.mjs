import test from 'node:test';
import assert from 'node:assert/strict';
import { bls12_381 } from '@noble/curves/bls12-381.js';
import { people, runCeremony, advance } from './helpers.mjs';
import { reduce } from '../src/state.mjs';
import { approve, combine, propose, recoverShares, hello, proposeCeremony } from '../src/participant.mjs';
import { participantKeys, seedFromMnemonic } from '../src/derive.mjs';
import { sealEnvelope } from '../src/envelope.mjs';
import { verify, interpolatePublic, lagrangeAtZero, mod, g1, g1Hex, scalarToHex, DST } from '../src/bls.mjs';
import { hex, unhex, utf8 } from '../src/util.mjs';
import { revealDigest, judgeComplaint as ceremonyJudge } from '../src/ceremony.mjs';
import { boxContext, boxKeys, encryptBox } from '../src/envelope.mjs';
import { MNEMONICS } from './helpers.mjs';

const ps = people(5);
const ROOM = 'test-room';
const base = runCeremony(ps);
const message = utf8('a transition signable payload');

function proposal(state, slots = ['critical']) {
  return propose(ps[0].keys, ROOM, { network: 'testnet', intent: { type: 'test' }, unsigned: '00', signable: hex(message), requirements: slots.map((slot) => ({ cid: base.cid, slot })) });
}

test('keys come only from the seed and are stable', () => {
  const again = participantKeys(seedFromMnemonic(MNEMONICS[0], 'TREZOR'));
  assert.equal(again.authPub, ps[0].keys.authPub);
  assert.equal(again.transportPub, ps[0].keys.transportPub);
  assert.notEqual(ps[0].keys.authPub, ps[1].keys.authPub);
  assert.notEqual(participantKeys(seedFromMnemonic(MNEMONICS[0], '')).authPub, ps[0].keys.authPub);
  assert.throws(() => seedFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'));
});

test('a 3-of-5 ceremony completes and every member agrees', () => {
  const c = base.state.ceremonies[base.cid];
  assert.equal(c.status, 'complete');
  for (const slot of ['master', 'critical', 'high', 'transfer']) {
    const k = c.result.keys[slot];
    assert.equal(g1Hex(interpolatePublic({ 1: k.publicShares[1], 3: k.publicShares[3], 5: k.publicShares[5] })), k.groupPublicKey);
    assert.notEqual(g1Hex(interpolatePublic({ 1: k.publicShares[1], 3: k.publicShares[3] })), k.groupPublicKey);
  }
  assert.equal(new Set(Object.values(c.result.keys).map((k) => k.groupPublicKey)).size, 4);
});

test('the whole ceremony is deterministic: rerunning it gives the same keys', () => {
  const again = runCeremony(people(5));
  assert.equal(again.cid, base.cid);
  assert.deepEqual(again.state.ceremonies[again.cid].result, base.state.ceremonies[base.cid].result);
});

test('a different roster gives unrelated keys', () => {
  const other = runCeremony(people(6).slice(1), { room: 'other-room' });
  const a = base.state.ceremonies[base.cid].result.keys.master.groupPublicKey;
  assert.notEqual(other.state.ceremonies[other.cid].result.keys.master.groupPublicKey, a);
});

test('any three approvals produce the same valid signature; two do not', () => {
  const sigs = [];
  for (const subset of [[0, 1, 2], [1, 3, 4], [0, 2, 4]]) {
    const messages = [...base.messages, proposal(base.state)];
    const pid = Object.keys(reduce(messages).proposals)[0];
    for (const i of subset.slice(0, 2)) messages.push(approve(ps[i].seed, ps[i].keys, ROOM, reduce(messages), pid));
    assert.equal(reduce(messages).proposals[pid].status, 'collecting');
    messages.push(approve(ps[subset[2]].seed, ps[subset[2]].keys, ROOM, reduce(messages), pid));
    const state = reduce(messages);
    assert.equal(state.proposals[pid].status, 'ready');
    const out = combine(state, pid)[`${base.cid}/critical`];
    assert.ok(verify(out.signature, message, out.groupPublicKey));
    sigs.push(out.signature);
  }
  assert.equal(new Set(sigs).size, 1);
});

test('a tampered share is not counted', () => {
  const messages = [...base.messages, proposal(base.state)];
  const pid = Object.keys(reduce(messages).proposals)[0];
  const good = approve(ps[1].seed, ps[1].keys, ROOM, reduce(messages), pid);
  const key = `${base.cid}/critical`;
  const bad = sealEnvelope(ps[2].keys, ROOM, 'approve', { proposalId: pid, shares: { [key]: { index: 3, share: good.body.shares[key].share } } });
  messages.push(good, bad, approve(ps[3].seed, ps[3].keys, ROOM, reduce(messages), pid));
  const p = reduce(messages).proposals[pid];
  assert.deepEqual(p.requirements[0].invalidShares, [3]);
  assert.equal(p.status, 'collecting');
});

test('a share is recoverable from the seed and the public transcript alone', () => {
  const fresh = reduce(JSON.parse(JSON.stringify(base.messages)));
  const { index, shares } = recoverShares(ps[2].seed, ps[2].keys, fresh, base.cid);
  assert.equal(index, 3);
  assert.equal(g1Hex(g1(shares.master)), fresh.ceremonies[base.cid].result.keys.master.publicShares[3]);
  const wrong = people(6)[5];
  assert.throws(() => recoverShares(wrong.seed, ps[2].keys, fresh, base.cid));
});

test('threshold signatures equal an ordinary BLS basic signature by the (never formed) group secret', () => {
  const recovered = [0, 1, 2].map((i) => recoverShares(ps[i].seed, ps[i].keys, base.state, base.cid).shares.high);
  const x = mod(recovered.reduce((acc, s, i) => acc + s * lagrangeAtZero(i + 1, [1, 2, 3]), 0n));
  const k = base.state.ceremonies[base.cid].result.keys.high;
  assert.equal(g1Hex(g1(x)), k.groupPublicKey);
  const ordinary = hex(bls12_381.longSignatures.Signature.toBytes(bls12_381.longSignatures.sign(bls12_381.longSignatures.hash(message, DST), unhex(scalarToHex(x)))));
  const messages = [...base.messages, proposal(base.state, ['high'])];
  const pid = Object.keys(reduce(messages).proposals)[0];
  for (const i of [2, 3, 4]) messages.push(approve(ps[i].seed, ps[i].keys, ROOM, reduce(messages), pid));
  assert.equal(combine(reduce(messages), pid)[`${base.cid}/high`].signature, ordinary);
});

test('envelopes with a modified body are ignored', () => {
  const messages = JSON.parse(JSON.stringify(base.messages));
  const reveal = messages.find((m) => m.type === 'dkg-reveal');
  reveal.body.reveal.slots.master.commitments[1] = reveal.body.reveal.slots.master.commitments[2];
  const state = reduce(messages);
  assert.equal(state.invalid.length, 1);
  assert.equal(state.ceremonies[base.cid].status, 'revealing');
});

test('a second, different commitment from the same member fails the ceremony', () => {
  const messages = base.messages.filter((m) => !['dkg-reveal', 'dkg-complete'].includes(m.type));
  messages.push(sealEnvelope(ps[4].keys, ROOM, 'dkg-commit', { cid: base.cid, digest: 'ab'.repeat(32) }));
  assert.equal(reduce(messages).ceremonies[base.cid].status, 'failed');
});

test('a member who reveals something other than what they committed is caught', () => {
  const messages = base.messages.filter((m) => !['dkg-reveal', 'dkg-complete'].includes(m.type));
  const mine = base.messages.find((m) => m.type === 'dkg-reveal' && m.from === ps[1].keys.authPub);
  const altered = JSON.parse(JSON.stringify(mine.body));
  altered.reveal.slots.master.boxes['1'] = altered.reveal.slots.master.boxes['3'];
  messages.push(sealEnvelope(ps[1].keys, ROOM, 'dkg-reveal', altered));
  const c = reduce(messages).ceremonies[base.cid];
  assert.equal(c.status, 'failed');
  assert.match(c.problems[0].reason, /does not match its commitment/);
});

function tamperedCeremony(room, mutate) {
  const messages = [];
  for (const p of ps) messages.push(hello(p.keys, room, p.name));
  const { cid, envelope } = proposeCeremony(ps[0].keys, room, reduce(messages), { network: 'testnet', label: 'x', threshold: 3, members: ps.map((p) => p.keys.authPub), createdAt: '2026-11-19T00:00:00.000Z' });
  messages.push(envelope);
  const evil = ps[4];
  advance(ps, room, messages, cid, 3);
  const at = (type) => messages.findIndex((m) => m.type === type && m.from === evil.keys.authPub);
  const reveal = JSON.parse(JSON.stringify(messages[at('dkg-reveal')].body));
  mutate(reveal.reveal, cid);
  messages[at('dkg-commit')] = sealEnvelope(evil.keys, room, 'dkg-commit', { cid, digest: revealDigest(reveal.reveal) });
  messages[at('dkg-reveal')] = sealEnvelope(evil.keys, room, 'dkg-reveal', reveal);
  return advance(ps.slice(0, 4), room, messages.filter((m) => m.type !== 'dkg-complete'), cid, 3).ceremonies[cid];
}

test('a wrong but decryptable share is proven against its sender', () => {
  const c = tamperedCeremony('bad-share-proven', (reveal, cid) => {
    const ctx = boxContext({ cid, slot: 'critical', from: 5, to: 1, fromTransport: ps[4].keys.transportPub, toTransport: ps[0].keys.transportPub });
    reveal.slots.critical.boxes['1'] = encryptBox(ps[4].keys.transportSecret, ps[0].keys.transportPub, ctx, scalarToHex(12345n));
  });
  assert.equal(c.status, 'failed');
  assert.ok(c.complaints.some((x) => x.from === 1 && x.against === 5 && x.slot === 'critical' && x.verdict === 'proven'));
});

test('a box that does not decrypt fails the ceremony, with blame left open', () => {
  const c = tamperedCeremony('bad-share-unproven', (reveal) => {
    reveal.slots.critical.boxes['1'] = reveal.slots.critical.boxes['2'];
  });
  assert.equal(c.status, 'failed');
  assert.ok(c.complaints.some((x) => x.from === 1 && x.against === 5 && x.verdict === 'unproven'));
});

test('late complaints or conflicting messages cannot undo a completed ceremony', () => {
  const messages = [...base.messages];
  messages.push(sealEnvelope(ps[3].keys, ROOM, 'dkg-commit', { cid: base.cid, digest: 'cd'.repeat(32) }, '2000-01-01T00:00:00.000Z'));
  messages.push(sealEnvelope(ps[2].keys, ROOM, 'dkg-complaint', { cid: base.cid, against: 4, slot: 'master', reason: 'made up' }));
  const c = reduce(messages).ceremonies[base.cid];
  assert.equal(c.status, 'complete');
  assert.deepEqual(c.result, base.state.ceremonies[base.cid].result);
  assert.ok(c.warnings.length >= 2);
});

test('a complaint against an honest share is shown to be false', () => {
  const messages = base.messages.filter((m) => m.type !== 'dkg-complete');
  const c0 = reduce(messages).ceremonies[base.cid];
  const p1 = ps[0];
  const accused = c0.config.participants[1];
  const ctx = boxContext({ cid: base.cid, slot: 'master', from: 2, to: 1, fromTransport: accused.transportPub, toTransport: p1.keys.transportPub });
  const mat = boxKeys(p1.keys.transportSecret, accused.transportPub, ctx);
  const verdict = ceremonyJudge(c0.config, base.cid, { from: 1, against: 2, slot: 'master', evidence: { key: hex(mat.key), nonce: hex(mat.nonce) } }, c0.reveals[2]);
  assert.equal(verdict, 'false');
});

test('junk from outsiders cannot crash the room or fake an execution', () => {
  const outsider = people(6)[5];
  const messages = [...base.messages, proposal(base.state)];
  const pid = Object.keys(reduce(messages).proposals)[0];
  messages.push(sealEnvelope(outsider.keys, ROOM, 'proposal', { network: 'testnet', intent: { type: 'x' }, unsigned: '00', signable: '00', requirements: [null] }));
  messages.push(sealEnvelope(outsider.keys, ROOM, 'proposal', { network: 'testnet', intent: { type: 'x' }, unsigned: '00', signable: '00', requirements: [{ cid: 'constructor', slot: 'master' }] }));
  messages.push(sealEnvelope(outsider.keys, ROOM, 'approve', { proposalId: 'constructor', shares: null }));
  messages.push(sealEnvelope(outsider.keys, ROOM, 'broadcast', { proposalId: pid, result: { ok: true } }));
  messages.push(sealEnvelope(ps[1].keys, ROOM, 'broadcast', { proposalId: pid, result: { ok: true } }));
  const state = reduce(messages);
  assert.equal(state.proposals[pid].status, 'collecting');
  assert.equal(state.problems.filter((p) => /malformed proposal/.test(p.reason)).length, 2);
});
