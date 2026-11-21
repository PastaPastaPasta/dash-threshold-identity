import { sdkModule, protocolVersionOf } from './sdk.mjs';
import { hex, unhex, assert, toPlain, isHex } from '../util.mjs';

export const INTENT_TYPES = ['identity-create', 'identity-update', 'contract-create', 'contract-update', 'document', 'credit-transfer', 'credit-withdrawal'];

export const DEFAULT_CONTRACT_CONFIG = {
  $formatVersion: '1',
  canBeDeleted: false,
  readonly: false,
  keepsHistory: true,
  documentsKeepHistoryContractDefault: false,
  documentsMutableContractDefault: true,
  documentsCanBeDeletedContractDefault: true,
  requiresIdentityEncryptionBoundedKey: null,
  requiresIdentityDecryptionBoundedKey: null,
  sizedIntegerTypes: true,
};

const ID = /^[1-9A-HJ-NP-Za-km-z]{42,44}$/;
const UINT = /^(0|[1-9][0-9]{0,19})$/;
const isInt = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const isUint = (v) => typeof v === 'string' && UINT.test(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const KEY_FIELDS = ['cid', 'slot', 'keyId', 'purpose', 'securityLevel', 'publicKey'];

function exactly(obj, required, optional = []) {
  assert(isObj(obj), 'expected an object');
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(obj)) assert(allowed.has(k), `unexpected field "${k}"`);
  for (const k of required) assert(Object.hasOwn(obj, k), `missing field "${k}"`);
}

const checkSigner = (s) => {
  exactly(s, ['keyId', 'cid', 'slot']);
  assert(isInt(s.keyId, 999) && isHex(s.cid, 32) && typeof s.slot === 'string', 'bad signer');
};

const checkKeys = (list) => {
  assert(Array.isArray(list) && list.length <= 16, 'keys must be a list');
  for (const k of list) {
    exactly(k, KEY_FIELDS);
    assert(isHex(k.cid, 32) && typeof k.slot === 'string' && isInt(k.keyId, 999) && typeof k.purpose === 'string' && typeof k.securityLevel === 'string' && isHex(k.publicKey, 48), 'bad key entry');
  }
  assert(new Set(list.map((k) => k.keyId)).size === list.length, 'duplicate key ids');
};

const COMMON = ['type', 'userFeeIncrease'];
const SHAPES = {
  'identity-create': { required: [...COMMON, 'assetLockProof', 'keys'] },
  'identity-update': { required: [...COMMON, 'identityId', 'revision', 'nonce', 'addKeys', 'disableKeyIds', 'signer'] },
  'contract-create': { required: [...COMMON, 'ownerId', 'identityNonce', 'protocolVersion', 'contract', 'signer'] },
  'contract-update': { required: [...COMMON, 'ownerId', 'contractId', 'identityContractNonce', 'version', 'protocolVersion', 'contract', 'signer'] },
  document: { required: [...COMMON, 'ownerId', 'contractId', 'identityContractNonce', 'document', 'signer'] },
  'credit-transfer': { required: [...COMMON, 'identityId', 'recipientId', 'amount', 'nonce', 'signer'] },
  'credit-withdrawal': { required: [...COMMON, 'identityId', 'amount', 'coreFeePerByte', 'pooling', 'outputAddress', 'outputPubKeyHash', 'nonce', 'signer'] },
};

export function validateIntent(intent) {
  assert(isObj(intent) && Object.hasOwn(SHAPES, intent.type), `unknown intent type ${intent?.type}`);
  exactly(intent, SHAPES[intent.type].required);
  assert(isInt(intent.userFeeIncrease, 65535), 'bad userFeeIncrease');
  for (const f of ['identityId', 'ownerId', 'contractId', 'recipientId']) if (Object.hasOwn(intent, f)) assert(typeof intent[f] === 'string' && ID.test(intent[f]), `bad ${f}`);
  for (const f of ['revision', 'nonce', 'identityNonce', 'identityContractNonce', 'amount']) if (Object.hasOwn(intent, f)) assert(isUint(intent[f]), `bad ${f}`);
  if (intent.signer !== undefined) checkSigner(intent.signer);
  switch (intent.type) {
    case 'identity-create':
      exactly(intent.assetLockProof, ['coreChainLockedHeight', 'txid', 'vout', 'keyIndex', 'funder']);
      assert(isInt(intent.assetLockProof.coreChainLockedHeight) && isHex(intent.assetLockProof.txid, 32) && isInt(intent.assetLockProof.vout) && isInt(intent.assetLockProof.keyIndex) && isHex(intent.assetLockProof.funder, 32), 'bad asset lock proof');
      checkKeys(intent.keys);
      assert(intent.keys.length >= 1, 'identity needs keys');
      break;
    case 'identity-update':
      checkKeys(intent.addKeys);
      assert(Array.isArray(intent.disableKeyIds) && intent.disableKeyIds.every((id) => isInt(id, 999)), 'bad disableKeyIds');
      break;
    case 'contract-create':
    case 'contract-update':
      assert(isInt(intent.protocolVersion, 1000) && isObj(intent.contract) && isObj(intent.contract.documentSchemas), 'bad contract');
      if (intent.type === 'contract-update') assert(isInt(intent.version), 'bad version');
      break;
    case 'document':
      exactly(intent.document, ['action', 'documentType'], ['properties', 'entropy', 'id', 'revision']);
      assert(['create', 'replace', 'delete'].includes(intent.document.action) && typeof intent.document.documentType === 'string', 'bad document');
      if (intent.document.action !== 'create') assert(typeof intent.document.id === 'string' && ID.test(intent.document.id), 'bad document id');
      if (intent.document.properties !== undefined) assert(isObj(intent.document.properties), 'bad document properties');
      break;
    case 'credit-withdrawal':
      assert(isInt(intent.coreFeePerByte, 1 << 20) && typeof intent.pooling === 'string' && typeof intent.outputAddress === 'string' && isHex(intent.outputPubKeyHash, 20), 'bad withdrawal');
      break;
    default:
      break;
  }
  return intent;
}

export function keysAdded(intent) {
  if (intent.type === 'identity-create') return intent.keys;
  if (intent.type === 'identity-update') return intent.addKeys;
  return [];
}

export function requirementsFor(intent) {
  switch (intent.type) {
    case 'identity-create':
      return intent.keys.map((k) => ({ cid: k.cid, slot: k.slot }));
    case 'identity-update':
      return [{ cid: intent.signer.cid, slot: intent.signer.slot }, ...intent.addKeys.map((k) => ({ cid: k.cid, slot: k.slot }))];
    default:
      return [{ cid: intent.signer.cid, slot: intent.signer.slot }];
  }
}

export function expectedLevels(intent) {
  switch (intent.type) {
    case 'identity-update': return { purposes: ['AUTHENTICATION'], levels: ['MASTER'] };
    case 'contract-create': return { purposes: ['AUTHENTICATION'], levels: ['CRITICAL', 'HIGH'] };
    case 'contract-update': return { purposes: ['AUTHENTICATION'], levels: ['CRITICAL'] };
    case 'document': return { purposes: ['AUTHENTICATION'], levels: ['CRITICAL', 'HIGH', 'MEDIUM'] };
    case 'credit-transfer': return { purposes: ['TRANSFER'], levels: ['CRITICAL'] };
    case 'credit-withdrawal': return { purposes: ['TRANSFER'], levels: ['CRITICAL'] };
    default: return null;
  }
}

function keyInCreation(m, k, signature) {
  return new m.IdentityPublicKeyInCreation({
    keyId: k.keyId,
    purpose: k.purpose,
    securityLevel: k.securityLevel,
    keyType: 'BLS12_381',
    data: unhex(k.publicKey),
    ...(signature ? { signature: unhex(signature) } : {}),
  });
}

async function platformVersion(m, intent) {
  const pv = m.PlatformVersion.latest();
  assert(protocolVersionOf(pv) === intent.protocolVersion, `this build of the SDK speaks protocol ${protocolVersionOf(pv)}, the proposal was built for ${intent.protocolVersion}`);
  return pv;
}

function contractJson(intent, id, version) {
  const { config, documentSchemas, ...rest } = intent.contract;
  return { ...rest, $formatVersion: '1', id, ownerId: intent.ownerId, version, config: config ?? DEFAULT_CONTRACT_CONFIG, documentSchemas };
}

export async function buildTransition(intent, { popSignatures = {} } = {}) {
  const m = await sdkModule();
  validateIntent(intent);
  const fee = intent.userFeeIncrease ?? 0;
  let st;
  let derived = {};
  switch (intent.type) {
    case 'identity-create': {
      const p = intent.assetLockProof;
      const proof = m.AssetLockProof.createChainAssetLockProof(p.coreChainLockedHeight, new m.OutPoint(p.txid, p.vout));
      const t = new m.IdentityCreateTransition({ publicKeys: intent.keys.map((k) => keyInCreation(m, k, popSignatures[k.keyId])), assetLockProof: proof, userFeeIncrease: fee });
      derived = { identityId: t.identityId.toBase58() };
      st = t.toStateTransition();
      break;
    }
    case 'identity-update': {
      const t = new m.IdentityUpdateTransition({
        identityId: intent.identityId,
        revision: BigInt(intent.revision),
        nonce: BigInt(intent.nonce),
        addPublicKeys: intent.addKeys.map((k) => keyInCreation(m, k, popSignatures[k.keyId])),
        disablePublicKeys: intent.disableKeyIds,
        userFeeIncrease: fee,
      });
      st = t.toStateTransition();
      break;
    }
    case 'contract-create': {
      const pv = await platformVersion(m, intent);
      const nonce = BigInt(intent.identityNonce);
      const id = m.DataContract.generateId(intent.ownerId, nonce).toBase58();
      const dc = m.DataContract.fromJSON(contractJson(intent, id, 1), true, pv);
      st = new m.DataContractCreateTransition(dc, nonce, pv).toStateTransition();
      st.userFeeIncrease = fee;
      derived = { contractId: id };
      break;
    }
    case 'contract-update': {
      const pv = await platformVersion(m, intent);
      const dc = m.DataContract.fromJSON(contractJson(intent, intent.contractId, intent.version), true, pv);
      st = new m.DataContractUpdateTransition(dc, BigInt(intent.identityContractNonce), pv).toStateTransition();
      st.userFeeIncrease = fee;
      break;
    }
    case 'document': {
      const d = intent.document;
      const base = { properties: d.properties ?? {}, documentTypeName: d.documentType, dataContractId: intent.contractId, ownerId: intent.ownerId };
      const nonce = BigInt(intent.identityContractNonce);
      let transition;
      if (d.action === 'create') {
        assert(isHex(d.entropy, 32), 'document create needs 32 bytes of entropy (hex)');
        transition = new m.DocumentCreateTransition({ document: new m.Document({ ...base, entropy: unhex(d.entropy) }), identityContractNonce: nonce });
      } else if (d.action === 'replace') {
        transition = new m.DocumentReplaceTransition({ document: new m.Document({ ...base, id: d.id, revision: BigInt(d.revision) }), identityContractNonce: nonce });
        derived = { documentId: d.id, newRevision: String(BigInt(d.revision) + 1n) };
      } else if (d.action === 'delete') {
        transition = new m.DocumentDeleteTransition({ document: new m.Document({ ...base, properties: {}, id: d.id, revision: BigInt(d.revision ?? 1) }), identityContractNonce: nonce });
        derived = { documentId: d.id };
      } else {
        throw new Error(`unknown document action ${d.action}`);
      }
      const batch = m.BatchTransition.fromBatchedTransitions([new m.BatchedTransition(transition.toDocumentTransition())], intent.ownerId, fee);
      if (d.action === 'create') derived = { documentId: batch.toJSON().transitions[0].$id };
      st = batch.toStateTransition();
      break;
    }
    case 'credit-transfer': {
      st = m.IdentityCreditTransfer.fromObject({
        $formatVersion: '0', identityId: intent.identityId, recipientId: intent.recipientId, amount: BigInt(intent.amount), nonce: BigInt(intent.nonce),
        userFeeIncrease: fee, signaturePublicKeyId: intent.signer.keyId, signature: new Uint8Array(),
      }).toStateTransition();
      break;
    }
    case 'credit-withdrawal': {
      st = new m.IdentityCreditWithdrawalTransition({
        identityId: intent.identityId,
        amount: BigInt(intent.amount),
        coreFeePerByte: intent.coreFeePerByte,
        pooling: intent.pooling ?? 'Never',
        outputScript: m.CoreScript.fromP2PKH(unhex(intent.outputPubKeyHash)),
        nonce: BigInt(intent.nonce),
        userFeeIncrease: fee,
      }).toStateTransition();
      break;
    }
    default:
      throw new Error(`unsupported intent ${intent.type}`);
  }
  if (intent.signer) st.signaturePublicKeyId = intent.signer.keyId;
  return { st, unsigned: hex(st.toBytes()), signable: hex(st.getSignableBytes()), derived };
}

const TYPED = {
  IdentityCreate: 'IdentityCreateTransition',
  IdentityUpdate: 'IdentityUpdateTransition',
  IdentityTopUp: 'IdentityTopUpTransition',
  DataContractCreate: 'DataContractCreateTransition',
  DataContractUpdate: 'DataContractUpdateTransition',
  IdentityCreditTransfer: 'IdentityCreditTransfer',
  IdentityCreditWithdrawal: 'IdentityCreditWithdrawalTransition',
};

export async function decodeTransition(unsignedHex) {
  const m = await sdkModule();
  const st = m.StateTransition.fromBytes(unhex(unsignedHex));
  const action = String(st.actionType);
  const typedName = action.startsWith('DocumentsBatch') ? 'BatchTransition' : TYPED[action];
  let json = null;
  if (typedName && m[typedName]?.fromStateTransition) json = toPlain(m[typedName].fromStateTransition(st).toJSON());
  return { action, signaturePublicKeyId: st.signaturePublicKeyId ?? null, signableHex: hex(st.getSignableBytes()), json };
}

export function describeIntent(intent) {
  const signer = intent.signer ? ` signed by key ${intent.signer.keyId} (${intent.signer.slot})` : '';
  const fee = intent.userFeeIncrease ? [`  fee increase: ${intent.userFeeIncrease}%`] : [];
  const json = (v) => JSON.stringify(v);
  switch (intent.type) {
    case 'identity-create':
      return [`Create a new identity funded by asset lock ${intent.assetLockProof.txid}:${intent.assetLockProof.vout} (chain-locked at ${intent.assetLockProof.coreChainLockedHeight})`,
        ...intent.keys.map((k) => `  key ${k.keyId}: ${k.purpose}/${k.securityLevel} BLS ${k.publicKey} (${k.slot})`), ...fee];
    case 'identity-update':
      return [`Update identity ${intent.identityId} to revision ${intent.revision} (nonce ${intent.nonce})${signer}`,
        ...intent.addKeys.map((k) => `  add key ${k.keyId}: ${k.purpose}/${k.securityLevel} BLS ${k.publicKey} (${k.slot})`),
        ...intent.disableKeyIds.map((id) => `  disable key ${id}`), ...fee];
    case 'contract-create':
      return [`Register a data contract owned by ${intent.ownerId} (identity nonce ${intent.identityNonce})${signer}`, `  contract: ${json(intent.contract)}`, ...fee];
    case 'contract-update':
      return [`Update contract ${intent.contractId} to version ${intent.version} (contract nonce ${intent.identityContractNonce})${signer}`, `  contract: ${json(intent.contract)}`, ...fee];
    case 'document':
      return [`${intent.document.action} a "${intent.document.documentType}" document in contract ${intent.contractId}${intent.document.id ? ` (id ${intent.document.id})` : ''}${signer}`,
        ...(intent.document.properties ? [`  properties: ${json(intent.document.properties)}`] : []), ...fee];
    case 'credit-transfer':
      return [`Transfer ${intent.amount} credits from ${intent.identityId} to ${intent.recipientId} (nonce ${intent.nonce})${signer}`, ...fee];
    case 'credit-withdrawal':
      return [`Withdraw ${intent.amount} credits from ${intent.identityId} to Core address ${intent.outputAddress} (nonce ${intent.nonce}, core fee ${intent.coreFeePerByte}/byte, pooling ${intent.pooling ?? 'Never'})${signer}`, ...fee];
    default:
      return [`unknown intent ${intent.type}`];
  }
}

export async function assembleSigned(intent, signatures) {
  const sig = (r) => signatures[`${r.cid}/${r.slot}`]?.signature;
  const pops = {};
  for (const k of keysAdded(intent)) {
    pops[k.keyId] = sig(k);
    assert(pops[k.keyId], `missing proof-of-possession signature for key ${k.keyId}`);
  }
  const built = await buildTransition(intent, { popSignatures: pops });
  if (intent.signer) {
    const s = sig(intent.signer);
    assert(s, 'missing transition signature');
    built.st.signature = unhex(s);
  }
  return built;
}
