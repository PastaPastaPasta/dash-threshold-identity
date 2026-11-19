import { buildTransition, decodeTransition, describeIntent, requirementsFor, expectedLevels, assembleSigned } from './platform/transitions.mjs';
import { retry, errorText } from './platform/sdk.mjs';
import { canonical, assert, hex } from './util.mjs';
import { requirementKey } from './state.mjs';

export async function makeProposalBody(network, intent, note = '') {
  const built = await buildTransition(intent);
  return { network, intent, unsigned: built.unsigned, signable: built.signable, requirements: requirementsFor(intent), derived: built.derived, note };
}

function slotInfo(state, r) {
  const c = state.ceremonies[r.cid];
  return c?.status === 'complete' ? c.result.keys[r.slot] : null;
}

export async function reviewProposal(state, proposalId, { sdk = null } = {}) {
  const p = state.proposals[proposalId];
  assert(p, `unknown proposal ${proposalId}`);
  const { intent } = p.body;
  const problems = [];
  const warnings = [];
  let rebuilt;
  try {
    rebuilt = await buildTransition(intent);
    if (rebuilt.unsigned !== p.body.unsigned) problems.push('the transition bytes do not match the stated intent (rebuilt independently)');
    if (rebuilt.signable !== p.body.signable) problems.push('the bytes to sign do not match the stated intent');
  } catch (e) {
    problems.push(`cannot rebuild the transition from its intent: ${e.message}`);
  }
  if (canonical(requirementsFor(intent)) !== canonical(p.body.requirements)) problems.push('signing requirements do not follow from the intent');
  for (const r of p.body.requirements) if (!slotInfo(state, r)) problems.push(`key ${requirementKey(r)} is not from a completed ceremony`);
  for (const k of intent.keys ?? intent.addKeys ?? []) {
    const info = slotInfo(state, k);
    if (!info) continue;
    if (info.groupPublicKey !== k.publicKey) problems.push(`key ${k.keyId} is not the group key of ${k.slot}`);
    if (info.purpose !== k.purpose || info.securityLevel !== k.securityLevel || info.keyId !== k.keyId) problems.push(`key ${k.keyId} purpose/level/id differ from what the ceremony agreed for ${k.slot}`);
  }
  const ceremonyNetwork = state.ceremonies[p.body.requirements[0]?.cid]?.config.network;
  if (ceremonyNetwork && ceremonyNetwork !== p.body.network) problems.push(`proposal is for ${p.body.network} but the keys are for ${ceremonyNetwork}`);
  const levels = expectedLevels(intent);
  if (intent.signer && levels) {
    const info = slotInfo(state, intent.signer);
    if (info && (!levels.purposes.includes(info.purpose) || !levels.levels.includes(info.securityLevel))) problems.push(`${intent.type} cannot be signed by a ${info.purpose}/${info.securityLevel} key`);
  }
  let decoded = null;
  try {
    decoded = await decodeTransition(p.body.unsigned);
    if (decoded.signableHex !== p.body.signable) problems.push('decoded bytes to sign differ from the proposal');
  } catch (e) {
    problems.push(`cannot decode the transition: ${e.message}`);
  }
  if (sdk) {
    try {
      problems.push(...(await chainChecks(sdk, state, intent)));
    } catch (e) {
      warnings.push(`could not check against Platform: ${errorText(e)}`);
    }
  } else {
    warnings.push('not checked against live Platform state (offline review)');
  }
  return { ok: problems.length === 0, problems, warnings, summary: describeIntent(intent), decoded, status: p.status };
}

async function chainChecks(sdk, state, intent) {
  const problems = [];
  if (intent.type === 'identity-create') return problems;
  const identityId = intent.identityId ?? intent.ownerId;
  const identity = await retry(() => sdk.identities.fetch(identityId));
  if (!identity) return [`identity ${identityId} not found on ${intent.network ?? 'the network'}`];
  const keys = identity.publicKeys.map((k) => k.toJSON());
  const signerKey = keys.find((k) => k.id === intent.signer.keyId);
  const group = slotInfo(state, intent.signer);
  if (!signerKey) problems.push(`identity has no key ${intent.signer.keyId}`);
  else {
    if (Buffer.from(signerKey.data, 'base64').toString('hex') !== group?.groupPublicKey) problems.push(`on-chain key ${intent.signer.keyId} is not the ${intent.signer.slot} group key`);
    if (signerKey.disabledAt) problems.push(`on-chain key ${intent.signer.keyId} is disabled`);
  }
  if (['identity-update', 'contract-create', 'credit-transfer', 'credit-withdrawal'].includes(intent.type)) {
    const current = (await retry(() => sdk.identities.nonce(identityId))) ?? 0n;
    if (BigInt(intent.nonce ?? intent.identityNonce) !== current + 1n) problems.push(`identity nonce is ${current}; proposal uses ${intent.nonce ?? intent.identityNonce} (needs ${current + 1n})`);
  }
  if (intent.type === 'identity-update') {
    const revision = BigInt(identity.revision);
    if (BigInt(intent.revision) !== revision + 1n) problems.push(`identity revision is ${revision}; proposal sets ${intent.revision}`);
    for (const id of intent.disableKeyIds) if (!keys.some((k) => k.id === id)) problems.push(`cannot disable key ${id}: no such key`);
    for (const k of intent.addKeys) if (keys.some((x) => x.id === k.keyId)) problems.push(`key id ${k.keyId} already exists`);
  }
  if (['contract-update', 'document'].includes(intent.type)) {
    const current = (await retry(() => sdk.identities.contractNonce(identityId, intent.contractId))) ?? 0n;
    if (BigInt(intent.identityContractNonce) <= current) problems.push(`identity-contract nonce is ${current}; proposal uses ${intent.identityContractNonce}`);
  }
  if (intent.type === 'contract-update') {
    const contract = await retry(() => sdk.contracts.fetch(intent.contractId));
    if (!contract) problems.push(`contract ${intent.contractId} not found`);
    else {
      if (contract.ownerId.toBase58() !== intent.ownerId) problems.push('contract is owned by another identity');
      if (Number(contract.version) + 1 !== Number(intent.version)) problems.push(`contract is at version ${contract.version}; proposal sets ${intent.version}`);
    }
  }
  return problems;
}

export async function signedTransition(state, proposalId, signatures) {
  const p = state.proposals[proposalId];
  const built = await assembleSigned(p.body.intent, signatures);
  assert(built.signable === p.body.signable, 'attaching signatures changed the bytes that were signed');
  return built;
}

export const transitionHash = (st) => st.hash(false);
export { hex };
