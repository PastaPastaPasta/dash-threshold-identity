import { buildTransition, decodeTransition, describeIntent, requirementsFor, expectedLevels, assembleSigned, validateIntent, keysAdded } from './platform/transitions.mjs';
import { retry, errorText } from './platform/sdk.mjs';
import { canonical, assert, getOwn, base64ToHex } from './util.mjs';
import { requirementKey } from './state.mjs';
import { participantIndex } from './ceremony.mjs';
import { addressToPubKeyHash } from './platform/core.mjs';

export async function makeProposalBody(network, intent, note = '') {
  const built = await buildTransition(intent);
  return { network, intent, unsigned: built.unsigned, signable: built.signable, requirements: requirementsFor(intent), derived: built.derived, note };
}

function slotInfo(state, r) {
  const c = getOwn(state.ceremonies, r.cid);
  return c?.status === 'complete' && Object.hasOwn(c.result.keys, r.slot) ? c.result.keys[r.slot] : null;
}

function ceremonyLine(state, cid) {
  const c = state.ceremonies[cid];
  return `"${c.config.label}" ${c.config.threshold}-of-${c.config.participants.length}: ${c.config.participants.map((p) => p.name).join(', ')}`;
}

function rosterKey(state, cid) {
  const c = state.ceremonies[cid];
  return `${c.config.threshold}|${c.config.participants.map((p) => p.authPub).sort().join(',')}`;
}

function attentionFor(state, intent, me) {
  const out = [];
  const signerCid = intent.signer?.cid;
  for (const k of keysAdded(intent)) {
    if (!slotInfo(state, k)) continue;
    const lines = [`key ${k.keyId} (${k.purpose}/${k.securityLevel}) will be controlled by ceremony ${ceremonyLine(state, k.cid)}`];
    if (me && !participantIndex(state.ceremonies[k.cid].config, me)) lines.push('  you are NOT a member of that ceremony');
    if (signerCid && slotInfo(state, intent.signer) && rosterKey(state, k.cid) !== rosterKey(state, signerCid)) lines.push('  its members or threshold differ from the group signing this change');
    out.push(lines.join('\n'));
  }
  return out;
}

export async function reviewProposal(state, proposalId, { sdk = null, online = false, me = null } = {}) {
  const p = getOwn(state.proposals, proposalId);
  assert(p, `unknown proposal ${proposalId}`);
  const { intent } = p.body;
  try {
    validateIntent(intent);
  } catch (e) {
    return { ok: false, problems: [`malformed intent: ${e.message}`], warnings: [], attention: [], summary: [`malformed ${String(intent?.type)} proposal`], decoded: null, status: p.status };
  }
  const problems = [];
  const warnings = [];
  let rebuilt;
  try {
    rebuilt = await buildTransition(intent);
    if (rebuilt.unsigned !== p.body.unsigned) problems.push('the transition bytes do not match the stated intent (rebuilt independently)');
    if (rebuilt.signable !== p.body.signable) problems.push('the bytes to sign do not match the stated intent');
    if (canonical(rebuilt.derived ?? {}) !== canonical(p.body.derived ?? {})) problems.push('the ids the proposal claims (derived) do not follow from the intent');
  } catch (e) {
    problems.push(`cannot rebuild the transition from its intent: ${e.message}`);
  }
  if (canonical(requirementsFor(intent)) !== canonical(p.body.requirements)) problems.push('signing requirements do not follow from the intent');
  for (const r of p.body.requirements) if (!slotInfo(state, r)) problems.push(`key ${requirementKey(r)} is not from a completed ceremony`);
  for (const k of keysAdded(intent)) {
    const info = slotInfo(state, k);
    if (!info) continue;
    if (info.groupPublicKey !== k.publicKey) problems.push(`key ${k.keyId} is not the group key of ${k.slot}`);
    if (info.purpose !== k.purpose || info.securityLevel !== k.securityLevel || info.keyId !== k.keyId) problems.push(`key ${k.keyId} purpose/level/id differ from what the ceremony agreed for ${k.slot}`);
  }
  for (const r of p.body.requirements) {
    const network = getOwn(state.ceremonies, r.cid)?.config.network ?? null;
    if (network && network !== p.body.network) problems.push(`proposal is for ${p.body.network} but key ${r.slot} is for ${network}`);
  }
  if (intent.type === 'credit-withdrawal') {
    try {
      if (addressToPubKeyHash(p.body.network, intent.outputAddress) !== intent.outputPubKeyHash) problems.push('the withdrawal address shown does not match the address in the transition');
    } catch (e) {
      problems.push(`bad withdrawal address: ${e.message}`);
    }
  }
  if ((intent.userFeeIncrease ?? 0) > 100) problems.push(`fee increase of ${intent.userFeeIncrease}% is unusually high`);
  if (intent.signer) {
    const info = slotInfo(state, intent.signer);
    if (info && info.keyId !== intent.signer.keyId) problems.push(`signing key id ${intent.signer.keyId} is not the id the ceremony gave ${intent.signer.slot} (${info.keyId})`);
  }
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
  if (online) {
    if (!sdk) problems.push('could not reach Platform to check the identity, keys and nonces (use --offline to review without it)');
    else {
      try {
        problems.push(...(await chainChecks(sdk, state, intent)));
      } catch (e) {
        problems.push(`could not check against Platform: ${errorText(e)}`);
      }
    }
  } else {
    warnings.push('not checked against live Platform state (offline review)');
  }
  return { ok: problems.length === 0, problems, warnings, attention: attentionFor(state, intent, me), summary: describeIntent(intent), decoded, status: p.status };
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
    if (base64ToHex(signerKey.data) !== group?.groupPublicKey) problems.push(`on-chain key ${intent.signer.keyId} is not the ${intent.signer.slot} group key`);
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
  assert(canonical(built.derived ?? {}) === canonical(p.body.derived ?? {}), 'the proposal\'s derived ids do not follow from its intent');
  return built;
}
