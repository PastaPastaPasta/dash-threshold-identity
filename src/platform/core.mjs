import dashcore from '@dashevo/dashcore-lib';
import { coreKey, coreFundingPath, assetLockRegistrationPath, assetLockTopUpPath } from '../derive.mjs';
import { assert, hex, sleep } from '../util.mjs';
import { sdkModule, retry } from './sdk.mjs';

const { PrivateKey, Transaction, Script, Opcode, Address } = dashcore;

import { network as networkOf } from '../networks.mjs';

const coreNet = (network) => networkOf(network).core;
const FEE_PER_KB = 1000;
const MAX_FEE = 100000;

const insight = (network) => networkOf(network).insight;

async function getJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} -> ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export function keyAddress(network, path, seed) {
  const k = coreKey(seed, path);
  const pk = new PrivateKey(k.privateKeyHex, coreNet(network));
  return { path, privateKey: pk, address: pk.toAddress(coreNet(network)).toString() };
}

export const fundingAccount = (seed, network) => keyAddress(network, coreFundingPath(network, 0), seed);
export const registrationKey = (seed, network, index) => keyAddress(network, assetLockRegistrationPath(network, index), seed);
export const topUpKey = (seed, network, index) => keyAddress(network, assetLockTopUpPath(network, index), seed);

export function addressToPubKeyHash(network, address) {
  const a = Address.fromString(address, coreNet(network));
  assert(a.isPayToPublicKeyHash(), 'withdrawals go to a P2PKH address');
  return hex(a.hashBuffer);
}

export async function utxos(network, address) {
  return (await getJson(`${insight(network)}/addr/${address}/utxo`)) ?? [];
}

export async function verifiedUtxos(network, address) {
  const out = [];
  for (const u of await utxos(network, address)) {
    const raw = await getJson(`${insight(network)}/rawtx/${u.txid}`);
    assert(raw?.rawtx, `no raw transaction for ${u.txid}`);
    const tx = new Transaction(raw.rawtx);
    assert(tx.hash === u.txid, `Insight returned a transaction that does not hash to ${u.txid}`);
    const output = tx.outputs[u.vout];
    assert(output && output.script.toAddress(coreNet(network))?.toString() === address, `output ${u.txid}:${u.vout} does not pay ${address}`);
    out.push({ ...u, satoshis: output.satoshis, scriptPubKey: output.script.toHex() });
  }
  return out;
}

export async function fetchTx(network, txid) {
  return getJson(`${insight(network)}/tx/${txid}`);
}

export async function broadcastRaw(network, rawtx) {
  const body = await getJson(`${insight(network)}/tx/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rawtx }) });
  return body?.txid ?? body;
}

export function buildAssetLock({ network, funding, utxoList, creditAddress, duffs }) {
  const spendable = utxoList.filter((u) => u.confirmations > 0 || u.txlock).sort((a, b) => b.satoshis - a.satoshis);
  const selected = [];
  let total = 0;
  for (const u of spendable) {
    selected.push(u);
    total += u.satoshis;
    if (total >= duffs + 20000) break;
  }
  assert(total >= duffs + 20000, `funding address ${funding.address} holds ${total} spendable duffs; need ${duffs} + fees`);
  const payload = Transaction.Payload.AssetLockPayload.fromJSON({
    version: 1,
    creditOutputs: [{ satoshis: duffs, script: Script.buildPublicKeyHashOut(Address.fromString(creditAddress, coreNet(network))).toString() }],
  });
  const tx = new Transaction()
    .setType(Transaction.TYPES.TRANSACTION_ASSET_LOCK)
    .from(selected.map((u) => ({ txId: u.txid, outputIndex: u.vout, script: u.scriptPubKey, satoshis: u.satoshis, address: funding.address })))
    .addOutput(new Transaction.Output({ satoshis: duffs, script: new Script().add(Opcode.OP_RETURN).add(Buffer.alloc(0)) }))
    .setExtraPayload(payload)
    .feePerKb(FEE_PER_KB)
    .change(funding.address)
    .sign(funding.privateKey);
  const fee = tx.getFee();
  assert(fee > 0 && fee <= MAX_FEE, `refusing an asset lock with a fee of ${fee} duffs`);
  return { txid: tx.id, rawtx: tx.serialize(true), fee };
}

export async function waitForChainLock(network, sdk, txid, { timeoutMs = 20 * 60 * 1000, onWait } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tx = await fetchTx(network, txid).catch(() => undefined);
    const height = tx?.blockheight > 0 ? tx.blockheight : null;
    if (tx === undefined) {
      onWait?.('Insight did not answer; retrying');
    } else if (height) {
      const status = await retry(() => sdk.system.status());
      const j = status.toJSON();
      const locked = Number(j.chain?.coreChainLockedHeight ?? 0);
      if (locked >= height) return { height, coreChainLockedHeight: locked };
      onWait?.(`mined at ${height}, Platform chain-locked height ${locked}`);
    } else {
      onWait?.('waiting for the asset lock to be mined');
    }
    await sleep(10000);
  }
  throw new Error(`asset lock ${txid} was not chain-locked within ${timeoutMs / 60000} minutes`);
}

export async function signWithAssetLockKey(st, keyPair) {
  const m = await sdkModule();
  st.signByPrivateKey(m.PrivateKey.fromBytes(keyPair.privateKey.toBuffer(), keyPair.privateKey.network.name === 'livenet' ? 'mainnet' : 'testnet'), undefined, 'ECDSA_SECP256K1');
  return st;
}

export async function topUpTransition({ network, seed, index, identityId, proof }) {
  const m = await sdkModule();
  const key = topUpKey(seed, network, index);
  const assetLockProof = m.AssetLockProof.createChainAssetLockProof(proof.coreChainLockedHeight, new m.OutPoint(proof.txid, proof.vout));
  const st = new m.IdentityTopUpTransition({ assetLockProof, identityId }).toStateTransition();
  return signWithAssetLockKey(st, key);
}
