import fs from 'node:fs';
import path from 'node:path';
import { Session } from '../src/app.mjs';
import { recoverShares } from '../src/participant.mjs';
import { signShare, combineShares, verify } from '../src/bls.mjs';
import { buildTransition } from '../src/platform/transitions.mjs';
import { reviewProposal } from '../src/proposals.mjs';
import { reduce } from '../src/state.mjs';
import { sealEnvelope } from '../src/envelope.mjs';
import { errorText } from '../src/platform/sdk.mjs';
import { unhex } from '../src/util.mjs';

const [dir, contractId] = process.argv.slice(2);
if (!dir || !contractId) throw new Error('usage: node scripts/testnet-refusals.mjs <e2e-dir> <contractId>');
const room = fs.readFileSync(path.join(dir, 'room.txt'), 'utf8').trim();
const who = ['p1', 'p2', 'p3', 'p4', 'p5', 'funder'];
const sessions = Object.fromEntries(who.map((w) => {
  process.env.DTI_HOME = path.join(dir, 'homes', w);
  const s = new Session({ mnemonic: fs.readFileSync(path.join(dir, `${w}.mnemonic`), 'utf8'), room });
  return [w, s];
}));
const s = sessions.p1;
process.env.DTI_HOME = path.join(dir, 'homes', 'p1');
await s.sync();
const state = s.state();
const identity = s.identity();
const sdk = await s.sdk(identity.network);
const results = [];
const sigRefused = (text) => /20002|signature/i.test(text);

async function attempt(name, st, expect) {
  let outcome;
  try {
    await sdk.stateTransitions.broadcastAndWait(st);
    outcome = 'ACCEPTED';
  } catch (e) {
    outcome = errorText(e);
  }
  const pass = outcome !== 'ACCEPTED' && expect(outcome);
  results.push({ name, pass, outcome: outcome.slice(0, 300) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${outcome.slice(0, 200)}`);
}

function sharesFor(names, cid, slot, message) {
  const out = {};
  for (const n of names) {
    process.env.DTI_HOME = path.join(dir, 'homes', n);
    const { index, shares } = recoverShares(sessions[n].seed, sessions[n].keys, state, cid);
    out[index] = signShare(shares[slot], message);
  }
  return out;
}

const contract = await sdk.contracts.fetch(contractId);
const cnonce = (await sdk.identities.contractNonce(identity.identityId, contractId)) ?? 0n;
const critical = s.signerFor(identity, 'critical');
const intent = {
  type: 'contract-update', ownerId: identity.identityId, contractId, identityContractNonce: String(cnonce + 1n), version: Number(contract.version) + 1,
  protocolVersion: 14, userFeeIncrease: 0, signer: critical,
  contract: { documentSchemas: { note: { type: 'object', properties: { message: { type: 'string', maxLength: 280, position: 0 }, mood: { type: 'string', maxLength: 32, position: 1 }, tag: { type: 'string', maxLength: 32, position: 2 }, extra: { type: 'string', maxLength: 8, position: 3 } }, required: ['message', '$createdAt', '$updatedAt'], additionalProperties: false } } },
};
const built = await buildTransition(intent);
const message = unhex(built.signable);
const group = state.ceremonies[critical.cid].result.keys.critical.groupPublicKey;
const members = state.ceremonies[critical.cid].config.participants.map((p) => who.find((w) => sessions[w].keys.authPub === p.authPub));
const shares = sharesFor(members.slice(0, 3), critical.cid, 'critical', message);
const idx = Object.keys(shares).map(Number);

const cases = {
  'two shares interpolated': combineShares({ [idx[0]]: shares[idx[0]], [idx[1]]: shares[idx[1]] }),
  'one share alone': shares[idx[2]],
  'three shares under a wrong index': combineShares({ [idx[0]]: shares[idx[0]], [idx[1]]: shares[idx[1]], [idx[2] === 5 ? 4 : 5]: shares[idx[2]] }),
};
for (const [name, sig] of Object.entries(cases)) {
  if (verify(sig, message, group)) throw new Error(`${name} unexpectedly verifies locally`);
  built.st.signature = unhex(sig);
  await attempt(`contract v${intent.version} with ${name}`, built.st, sigRefused);
}

const oldKey = identity.keys[1];
const oldIntent = { ...intent, signer: { keyId: 1, cid: oldKey.cid, slot: oldKey.slot } };
const oldBuilt = await buildTransition(oldIntent);
const oldMessage = unhex(oldBuilt.signable);
const oldMembers = reduce(s.data.messages).ceremonies[oldKey.cid].config.participants.map((p) => who.find((w) => sessions[w].keys.authPub === p.authPub));
const bobAndTwo = [oldMembers.find((w) => w === 'p2'), ...oldMembers.filter((w) => w !== 'p2').slice(0, 2)];
const oldShares = sharesFor(bobAndTwo, oldKey.cid, 'critical', oldMessage);
const oldSig = combineShares(oldShares);
if (!verify(oldSig, oldMessage, oldKey.publicKey)) throw new Error('old-key signature should verify locally');
oldBuilt.st.signature = unhex(oldSig);
await attempt('a valid 3-of-5 signature from the disabled pre-rotation key (bob + two others)', oldBuilt.st, (t) => /disabled|40\d\d\d|2\d\d\d\d/i.test(t));

const fake = await buildTransition({ ...intent, version: intent.version + 5 });
const forgedProposal = sealEnvelope(sessions.p2.keys, room, 'proposal', { network: identity.network, intent, unsigned: fake.unsigned, signable: fake.signable, requirements: [{ cid: critical.cid, slot: 'critical' }], derived: {}, note: 'bytes do not match intent' });
const st2 = reduce([...s.data.messages, forgedProposal]);
const review = await reviewProposal(st2, Object.keys(st2.proposals).find((id) => st2.proposals[id].body.note === 'bytes do not match intent'), { sdk });
const tamperPass = !review.ok && review.problems.some((p) => /do not match the stated intent/.test(p));
results.push({ name: 'a proposal whose bytes differ from its intent is refused at review', pass: tamperPass, outcome: review.problems.join('; ') });
console.log(`${tamperPass ? 'PASS' : 'FAIL'} tampered proposal: ${review.problems.join('; ')}`);

const after = await sdk.contracts.fetch(contractId);
const unchanged = Number(after.version) === Number(contract.version);
results.push({ name: 'contract unchanged after all refusals', pass: unchanged, outcome: `version ${after.version}` });
console.log(`${unchanged ? 'PASS' : 'FAIL'} contract still at version ${after.version}`);
fs.writeFileSync(path.join(dir, 'refusals.json'), `${JSON.stringify({ at: new Date().toISOString(), results }, null, 1)}\n`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
