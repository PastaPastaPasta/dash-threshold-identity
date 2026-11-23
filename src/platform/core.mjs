import dashcore from '@dashevo/dashcore-lib';
import { coreKey, coreFundingPath, assetLockRegistrationPath, assetLockTopUpPath } from '../derive.mjs';
import { assert, hex, sleep } from '../util.mjs';
import { sdkModule, retry } from './sdk.mjs';

const { PrivateKey, Transaction, Script, Opcode, Address } = dashcore;

import { network as networkOf } from '../networks.mjs';

const coreNet = (network) => networkOf(network).core;
const FEE_PER_KB = 1000;
const MAX_FEE = 100000;
const DUST = 546;
export const MIN_IDENTITY_CREATE_DUFFS = 200000;

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

const HISTORY_PAGE = 50;
const HISTORY_MAX_PAGES = 400;

export async function addressHistory(network, address) {
  const seen = new Map();
  for (let page = 0, from = 0; ; page++, from += HISTORY_PAGE) {
    assert(page < HISTORY_MAX_PAGES, `${address} has more than ${HISTORY_PAGE * HISTORY_MAX_PAGES} transactions; scan it another way`);
    const body = await getJson(`${insight(network)}/addrs/${address}/txs?from=${from}&to=${from + HISTORY_PAGE}`);
    assert(Array.isArray(body?.items), `${insight(network)} returned no transaction history for ${address}; cannot check it for earlier asset locks`);
    for (const t of body.items) if (typeof t?.txid === 'string') seen.set(t.txid, t);
    if (!body.items.length || from + HISTORY_PAGE >= Number(body.totalItems)) break;
  }
  return [...seen.values()];
}

const p2pkh = (network, address) => Script.buildPublicKeyHashOut(Address.fromString(address, coreNet(network)));

export function assetLockCredits(rawtx, txid) {
  const tx = new Transaction(rawtx);
  assert(tx.hash === txid, `Insight returned a transaction that does not hash to ${txid}`);
  if (tx.type !== Transaction.TYPES.TRANSACTION_ASSET_LOCK) return [];
  return tx.extraPayload.creditOutputs.map((o, vout) => ({ txid, vout, duffs: o.satoshis, script: o.script.toHex(), rawtx }));
}

export async function findAssetLocks(network, seed, { gap = 64, through = -1 } = {}) {
  const { address } = fundingAccount(seed, network);
  const credits = [];
  for (const t of await addressHistory(network, address)) {
    if (Number(t.type) !== Transaction.TYPES.TRANSACTION_ASSET_LOCK) continue;
    const raw = await getJson(`${insight(network)}/rawtx/${t.txid}`);
    assert(raw?.rawtx, `no raw transaction for ${t.txid}`);
    credits.push(...assetLockCredits(raw.rawtx, t.txid));
  }
  const found = [];
  for (const [kind, derive] of [['registration', registrationKey], ['topup', topUpKey]]) {
    for (let i = 0, last = -1; i <= Math.max(last + gap, through) && found.length < credits.length; i++) {
      const { address: creditAddress } = derive(seed, network, i);
      const script = p2pkh(network, creditAddress).toHex();
      for (const c of credits) {
        if (c.script !== script) continue;
        found.push({ kind, index: i, txid: c.txid, vout: c.vout, duffs: c.duffs, creditAddress, rawtx: c.rawtx });
        last = i;
      }
    }
  }
  return found.sort((a, b) => a.kind.localeCompare(b.kind) || a.index - b.index || a.txid.localeCompare(b.txid));
}

export async function assetLockIdentityId(txid, vout) {
  const m = await sdkModule();
  return m.AssetLockProof.createChainAssetLockProof(0, new m.OutPoint(txid, vout)).createIdentityId().toBase58();
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
    creditOutputs: [{ satoshis: duffs, script: p2pkh(network, creditAddress).toString() }],
  });
  const tx = new Transaction()
    .setType(Transaction.TYPES.TRANSACTION_ASSET_LOCK)
    .from(selected.map((u) => ({ txId: u.txid, outputIndex: u.vout, script: u.scriptPubKey, satoshis: u.satoshis, address: funding.address })))
    .addOutput(new Transaction.Output({ satoshis: duffs, script: new Script().add(Opcode.OP_RETURN).add(Buffer.alloc(0)) }))
    .setExtraPayload(payload)
    .feePerKb(FEE_PER_KB)
    .change(funding.address)
    .sign(funding.privateKey);
  const minFee = (bytes) => Math.ceil((bytes * FEE_PER_KB) / 1000);
  tx.fee(Math.max(tx.getFee(), minFee(tx.toBuffer().length + selected.length))).sign(funding.privateKey);
  const fee = total - tx.outputs.reduce((a, o) => a + o.satoshis, 0);
  const size = tx.toBuffer().length;
  assert(fee >= minFee(size) && fee <= MAX_FEE, `refusing an asset lock with a fee of ${fee} duffs for ${size} bytes`);
  assert(tx.outputs.slice(1).every((o) => o.satoshis >= DUST), 'refusing an asset lock whose change would be dust');
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
