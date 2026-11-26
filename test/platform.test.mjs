import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MNEMONICS, people, runCeremony } from './helpers.mjs';
import { reduce } from '../src/state.mjs';
import { propose } from '../src/participant.mjs';
import { makeProposalBody, reviewProposal } from '../src/proposals.mjs';
import { buildTransition, decodeTransition, requirementsFor } from '../src/platform/transitions.mjs';
import { verify } from '../src/bls.mjs';
import { approve, combine } from '../src/participant.mjs';
import { assembleSigned } from '../src/platform/transitions.mjs';
import { unhex } from '../src/util.mjs';
import { Session } from '../src/app.mjs';
import { sdkModule, protocolVersionOf } from '../src/platform/sdk.mjs';

const ps = people(5);
const ROOM = 'test-room';
const { cid, state, messages } = runCeremony(ps);
const keys = state.ceremonies[cid].result.keys;
const OWNER = '7nVXwBc8CH98WmLBHWbE3QooBhEdw5j6Eqie3MN39fKY';

const identityCreate = {
  type: 'identity-create',
  assetLockProof: { coreChainLockedHeight: 1594732, txid: '4fef4dde120ee8e24d0c8d020eb0e9ab38a6d7b77ccbe0866efb596f38ecdc1d', vout: 0, keyIndex: 0, funder: ps[0].keys.authPub },
  keys: Object.values(keys).map((k) => ({ cid, slot: k.slot, keyId: k.keyId, purpose: k.purpose, securityLevel: k.securityLevel, publicKey: k.groupPublicKey })),
  userFeeIncrease: 0,
};
const contractCreate = {
  type: 'contract-create', ownerId: OWNER, identityNonce: '1', protocolVersion: 14, userFeeIncrease: 0, signer: { keyId: 1, cid, slot: 'critical' },
  contract: { documentSchemas: { note: { type: 'object', properties: { message: { type: 'string', maxLength: 280, position: 0 } }, required: ['message'], additionalProperties: false } } },
};

test('building is deterministic and needs no network', async () => {
  for (const intent of [identityCreate, contractCreate]) {
    const a = await buildTransition(intent);
    const b = await buildTransition(JSON.parse(JSON.stringify(intent)));
    assert.equal(a.unsigned, b.unsigned);
    assert.equal(a.signable, b.signable);
  }
});

test('identity create needs a proof of possession from every key; transitions need their signer', () => {
  assert.equal(requirementsFor(identityCreate).length, 4);
  assert.deepEqual(requirementsFor(contractCreate), [{ cid, slot: 'critical' }]);
});

test('decoding shows the real transition', async () => {
  const built = await buildTransition(contractCreate);
  const d = await decodeTransition(built.unsigned);
  assert.equal(d.action, 'DataContractCreate');
  assert.equal(d.signaturePublicKeyId, 1);
  assert.equal(d.signableHex, built.signable);
});

async function withProposal(body) {
  const msgs = [...messages, propose(ps[0].keys, ROOM, body)];
  const s = reduce(msgs);
  return { msgs, s, id: Object.keys(s.proposals)[0] };
}

test('an honest proposal passes an offline review', async () => {
  const { s, id } = await withProposal(await makeProposalBody('testnet', contractCreate));
  const r = await reviewProposal(s, id);
  assert.deepEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => /offline/.test(w)));
});

test('review catches bytes that do not match the intent', async () => {
  const honest = await makeProposalBody('testnet', contractCreate);
  const other = await buildTransition({ ...contractCreate, identityNonce: '7' });
  const { s, id } = await withProposal({ ...honest, unsigned: other.unsigned, signable: other.signable });
  const r = await reviewProposal(s, id);
  assert.ok(r.problems.some((p) => /do not match the stated intent/.test(p)));
});

test('review catches a key that is not the group key, a wrong network and a too-weak signer', async () => {
  const wrongKey = JSON.parse(JSON.stringify(identityCreate));
  wrongKey.keys[0].publicKey = keys.critical.groupPublicKey;
  let { s, id } = await withProposal(await makeProposalBody('testnet', wrongKey));
  assert.ok((await reviewProposal(s, id)).problems.some((p) => /not the group key of master/.test(p)));

  ({ s, id } = await withProposal(await makeProposalBody('mainnet', contractCreate)));
  assert.ok((await reviewProposal(s, id)).problems.some((p) => /is for testnet/.test(p)));

  ({ s, id } = await withProposal(await makeProposalBody('testnet', { type: 'contract-update', ownerId: OWNER, contractId: OWNER, identityContractNonce: '2', version: 2, protocolVersion: 14, userFeeIncrease: 0, contract: contractCreate.contract, signer: { keyId: 2, cid, slot: 'high' } })));
  assert.ok((await reviewProposal(s, id)).problems.some((p) => /cannot be signed by a AUTHENTICATION\/HIGH key/.test(p)));
});

test('review catches a withdrawal whose shown address is not the paid one, and lying derived ids', async () => {
  const withdrawal = { type: 'credit-withdrawal', identityId: OWNER, amount: '5000000000', coreFeePerByte: 1, pooling: 'Never', outputAddress: 'yehTPpUrcj3nAUQBBDG6MLCnFMbipTW1Gr', outputPubKeyHash: '00'.repeat(20), nonce: '3', userFeeIncrease: 0, signer: { keyId: 3, cid, slot: 'transfer' } };
  let { s, id } = await withProposal(await makeProposalBody('testnet', withdrawal));
  assert.ok((await reviewProposal(s, id)).problems.some((p) => /address shown does not match/.test(p)));
  const honest = await makeProposalBody('testnet', identityCreate);
  ({ s, id } = await withProposal({ ...honest, derived: { identityId: 'E2RdP9SgvDff6JMBr1FTGMEhKSo4WKps6uYop9JhoLTM' } }));
  assert.ok((await reviewProposal(s, id)).problems.some((p) => /derived/.test(p)));
});

test('review names who will control keys a proposal adds, and fails closed without Platform', async () => {
  const update = { type: 'identity-update', identityId: OWNER, revision: '1', nonce: '2', userFeeIncrease: 0, signer: { keyId: 0, cid, slot: 'master' }, disableKeyIds: [], addKeys: [{ cid, slot: 'high', keyId: 2, purpose: 'AUTHENTICATION', securityLevel: 'HIGH', publicKey: keys.high.groupPublicKey }] };
  const { s, id } = await withProposal(await makeProposalBody('testnet', update));
  const offline = await reviewProposal(s, id, { me: ps[0].keys.authPub });
  assert.equal(offline.attention.length, 1);
  assert.match(offline.attention[0], /3-of-5/);
  const online = await reviewProposal(s, id, { online: true, sdk: null });
  assert.ok(online.problems.some((p) => /could not reach Platform/.test(p)));
});

test('an identity update cannot hide added keys from review', async () => {
  const sneaky = { type: 'identity-update', identityId: OWNER, revision: '1', nonce: '2', userFeeIncrease: 0, signer: { keyId: 0, cid, slot: 'master' }, disableKeyIds: [], keys: [], addKeys: [{ cid, slot: 'high', keyId: 7, purpose: 'AUTHENTICATION', securityLevel: 'MASTER', publicKey: keys.critical.groupPublicKey }] };
  let { s, id } = await withProposal({ network: 'testnet', intent: sneaky, unsigned: '00', signable: '00', requirements: [{ cid, slot: 'master' }, { cid, slot: 'high' }], derived: {} });
  let r = await reviewProposal(s, id);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /unexpected field "keys"/);
  const { keys: _ignored, ...plain } = sneaky;
  ({ s, id } = await withProposal(await makeProposalBody('testnet', plain)));
  r = await reviewProposal(s, id);
  assert.ok(r.problems.some((p) => /not the group key of high/.test(p)));
  assert.ok(r.problems.some((p) => /differ from what the ceremony agreed/.test(p)));
  assert.equal(r.attention.length, 1);
});

test('three approvals assemble a signed identity create whose proofs verify and whose signable bytes are unchanged', async () => {
  const body = await makeProposalBody('testnet', identityCreate);
  const { msgs, id } = await withProposal(body);
  for (const i of [0, 2, 4]) msgs.push(approve(ps[i].seed, ps[i].keys, ROOM, reduce(msgs), id));
  const s = reduce(msgs);
  assert.equal(s.proposals[id].status, 'ready');
  const sigs = combine(s, id);
  const built = await assembleSigned(identityCreate, sigs);
  assert.equal(built.signable, body.signable);
  for (const k of identityCreate.keys) assert.ok(verify(sigs[`${cid}/${k.slot}`].signature, unhex(body.signable), k.publicKey));
});

test('proposals are stamped with the protocol version the network runs, not the newest one the SDK knows', async () => {
  const latest = protocolVersionOf((await sdkModule()).PlatformVersion.latest());
  const s = new Session({ mnemonic: MNEMONICS[0], passphrase: 'TREZOR' });
  s.sdks.mainnet = Promise.resolve({
    identities: { nonce: async () => 4n, fetch: async () => ({ revision: 1 }) },
    system: { status: async () => ({ toJSON: () => ({ version: { protocol: { drive: { current: latest - 1, latest } } } }) }) },
  });
  const ctx = await s.chainContext('mainnet', OWNER);
  assert.equal(ctx.protocolVersion, latest - 1);
});

test('a contract built for protocol 14 is what SDK 5.0.3 built, and a protocol below 14 or newer than the SDK is refused', async () => {
  const latest = protocolVersionOf((await sdkModule()).PlatformVersion.latest());
  const built = await buildTransition(contractCreate);
  assert.equal(createHash('sha256').update(built.unsigned).digest('hex'), '21956d8593f5da11f1f664376c098346594187d20418daf48231e831a3bdf9cb');
  for (const protocolVersion of [13, latest + 1]) await assert.rejects(buildTransition({ ...contractCreate, protocolVersion }), new RegExp(`builds protocols 14 to ${latest}`));
});
