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

const big = (v) => BigInt(v);

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
  return { $formatVersion: '1', id, ownerId: intent.ownerId, version, config: config ?? DEFAULT_CONTRACT_CONFIG, documentSchemas, ...rest };
}

export async function buildTransition(intent, { popSignatures = {} } = {}) {
  const m = await sdkModule();
  assert(INTENT_TYPES.includes(intent.type), `unknown intent type ${intent.type}`);
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
        revision: big(intent.revision),
        nonce: big(intent.nonce),
        addPublicKeys: intent.addKeys.map((k) => keyInCreation(m, k, popSignatures[k.keyId])),
        disablePublicKeys: intent.disableKeyIds,
        userFeeIncrease: fee,
      });
      st = t.toStateTransition();
      break;
    }
    case 'contract-create': {
      const pv = await platformVersion(m, intent);
      const nonce = big(intent.identityNonce);
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
      st = new m.DataContractUpdateTransition(dc, big(intent.identityContractNonce), pv).toStateTransition();
      st.userFeeIncrease = fee;
      break;
    }
    case 'document': {
      const d = intent.document;
      const base = { properties: d.properties ?? {}, documentTypeName: d.documentType, dataContractId: intent.contractId, ownerId: intent.ownerId };
      const nonce = big(intent.identityContractNonce);
      let transition;
      if (d.action === 'create') {
        assert(isHex(d.entropy, 32), 'document create needs 32 bytes of entropy (hex)');
        transition = new m.DocumentCreateTransition({ document: new m.Document({ ...base, entropy: unhex(d.entropy) }), identityContractNonce: nonce });
      } else if (d.action === 'replace') {
        transition = new m.DocumentReplaceTransition({ document: new m.Document({ ...base, id: d.id, revision: big(d.revision) }), identityContractNonce: nonce });
        derived = { documentId: d.id, newRevision: String(big(d.revision) + 1n) };
      } else if (d.action === 'delete') {
        transition = new m.DocumentDeleteTransition({ document: new m.Document({ ...base, properties: {}, id: d.id, revision: big(d.revision ?? 1) }), identityContractNonce: nonce });
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
        $formatVersion: '0', identityId: intent.identityId, recipientId: intent.recipientId, amount: big(intent.amount), nonce: big(intent.nonce),
        userFeeIncrease: fee, signaturePublicKeyId: intent.signer.keyId, signature: new Uint8Array(),
      }).toStateTransition();
      break;
    }
    case 'credit-withdrawal': {
      st = new m.IdentityCreditWithdrawalTransition({
        identityId: intent.identityId,
        amount: big(intent.amount),
        coreFeePerByte: intent.coreFeePerByte,
        pooling: intent.pooling ?? 'Never',
        outputScript: m.CoreScript.fromP2PKH(unhex(intent.outputPubKeyHash)),
        nonce: big(intent.nonce),
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
  switch (intent.type) {
    case 'identity-create':
      return [`Create a new identity funded by asset lock ${intent.assetLockProof.txid}:${intent.assetLockProof.vout} (chain-locked at ${intent.assetLockProof.coreChainLockedHeight})`,
        ...intent.keys.map((k) => `  key ${k.keyId}: ${k.purpose}/${k.securityLevel} BLS ${k.publicKey.slice(0, 16)}… (${k.slot})`)];
    case 'identity-update':
      return [`Update identity ${intent.identityId} to revision ${intent.revision} (nonce ${intent.nonce})${signer}`,
        ...intent.addKeys.map((k) => `  add key ${k.keyId}: ${k.purpose}/${k.securityLevel} BLS ${k.publicKey.slice(0, 16)}… (${k.slot})`),
        ...intent.disableKeyIds.map((id) => `  disable key ${id}`)];
    case 'contract-create':
      return [`Register a data contract owned by ${intent.ownerId} (identity nonce ${intent.identityNonce})${signer}`, `  document types: ${Object.keys(intent.contract.documentSchemas).join(', ')}`];
    case 'contract-update':
      return [`Update contract ${intent.contractId} to version ${intent.version} (contract nonce ${intent.identityContractNonce})${signer}`, `  document types: ${Object.keys(intent.contract.documentSchemas).join(', ')}`];
    case 'document':
      return [`${intent.document.action} a "${intent.document.documentType}" document in contract ${intent.contractId}${intent.document.id ? ` (id ${intent.document.id})` : ''}${signer}`,
        ...(intent.document.properties ? [`  properties: ${JSON.stringify(intent.document.properties).slice(0, 400)}`] : [])];
    case 'credit-transfer':
      return [`Transfer ${intent.amount} credits from ${intent.identityId} to ${intent.recipientId} (nonce ${intent.nonce})${signer}`];
    case 'credit-withdrawal':
      return [`Withdraw ${intent.amount} credits from ${intent.identityId} to Core P2PKH ${intent.outputAddress ?? intent.outputPubKeyHash} (nonce ${intent.nonce})${signer}`];
    default:
      return [`unknown intent ${intent.type}`];
  }
}

export async function assembleSigned(intent, signatures) {
  const sig = (r) => signatures[`${r.cid}/${r.slot}`]?.signature;
  const pops = {};
  for (const k of intent.keys ?? intent.addKeys ?? []) {
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
