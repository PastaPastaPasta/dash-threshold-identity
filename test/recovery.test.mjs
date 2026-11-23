import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dashcore from '@dashevo/dashcore-lib';
import { MNEMONICS, people, runCeremony } from './helpers.mjs';
import { Session } from '../src/app.mjs';
import { openRoom, addMessages } from '../src/store.mjs';
import { buildTransition } from '../src/platform/transitions.mjs';
import * as core from '../src/platform/core.mjs';

const { Transaction, Script, Address } = dashcore;
const NET = 'testnet';
const ROOM = 'recovery-room';
const ps = people(3);
const { cid, state, messages } = runCeremony(ps, { room: ROOM, threshold: 2, network: NET });
const funder = ps[0];
const funding = core.fundingAccount(funder.seed, NET);
const p2pkh = (address) => Script.buildPublicKeyHashOut(Address.fromString(address, 'testnet')).toHex();

let coin = 0;
function fundingCoin(satoshis) {
  const tx = new Transaction().from({ txId: (++coin).toString(16).padStart(64, '0'), outputIndex: 0, script: p2pkh(funding.address), satoshis: satoshis + 1000 }).to(funding.address, satoshis);
  return { txid: tx.id, vout: 0, satoshis, confirmations: 6, rawtx: tx.serialize(true), scriptPubKey: p2pkh(funding.address) };
}

function lockTx(kind, index, duffs) {
  const credit = (kind === 'registration' ? core.registrationKey : core.topUpKey)(funder.seed, NET, index);
  const built = core.buildAssetLock({ network: NET, funding, utxoList: [fundingCoin(duffs + 50000)], creditAddress: credit.address, duffs });
  return { ...built, kind, index, duffs };
}

function fakeChain({ locks = [], fillers = 0, utxos = [], evicted = new Set() } = {}) {
  const raw = new Map();
  const history = [];
  for (const l of locks) {
    raw.set(l.txid, l.rawtx);
    history.push({ txid: l.txid, type: 8, blockheight: 100 });
  }
  for (let i = 0; i < fillers; i++) history.push({ txid: `f${i}`.padStart(64, '0'), blockheight: 50 });
  for (const u of utxos) raw.set(u.txid, u.rawtx);
  const sent = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/insight-api/, '');
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    let m;
    if ((m = p.match(/^\/addrs\/([^/]+)\/txs$/))) {
      assert.equal(m[1], funding.address);
      const from = Number(u.searchParams.get('from'));
      const to = Number(u.searchParams.get('to'));
      if (to - from > 50) return json({ error: 'range' }, 400);
      return json({ totalItems: history.length, from, to: Math.min(to, history.length), items: history.slice(from, to) });
    }
    if ((m = p.match(/^\/rawtx\/(\w+)$/))) return raw.has(m[1]) ? json({ rawtx: raw.get(m[1]) }) : json({}, 404);
    if (p === '/tx/send' && init.method === 'POST') {
      const { rawtx } = JSON.parse(init.body);
      const tx = new Transaction(rawtx);
      sent.push(tx);
      raw.set(tx.id, rawtx);
      evicted.delete(tx.id);
      return json({ txid: tx.id });
    }
    if ((m = p.match(/^\/tx\/(\w+)$/))) return raw.has(m[1]) && !evicted.has(m[1]) ? json({ txid: m[1], blockheight: 100 }) : json({}, 404);
    if ((m = p.match(/^\/addr\/([^/]+)\/utxo$/))) return json(utxos.map(({ rawtx, scriptPubKey, ...x }) => ({ ...x, address: m[1] })));
    return json({ error: `unexpected ${p}` }, 500);
  };
  return { fetch, sent };
}

function fakeSdk(existing = new Set()) {
  return {
    system: { status: async () => ({ toJSON: () => ({ chain: { coreChainLockedHeight: 200 } }) }) },
    identities: { fetch: async (id) => (existing.has(id) ? { id } : undefined) },
  };
}

function session(t, chain, sdk, home = fs.mkdtempSync(path.join(os.tmpdir(), 'dti-recovery-'))) {
  process.env.DTI_HOME = home;
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', chain.fetch);
  const logs = [];
  const s = new Session({ mnemonic: MNEMONICS[0], passphrase: 'TREZOR', log: (m) => logs.push(m) });
  s.sdks[NET] = Promise.resolve(sdk);
  s.data = openRoom(ROOM);
  addMessages(s.data, messages);
  return { s, logs, home };
}

const identityCreates = (s) => Object.values(s.state().proposals).filter((p) => p.body.intent.type === 'identity-create');

test('the identity id of an asset lock is the one the identity-create transition derives', async () => {
  const txid = lockTx('registration', 0, 200000).txid;
  const built = await buildTransition({
    type: 'identity-create',
    assetLockProof: { coreChainLockedHeight: 1234, txid, vout: 0, keyIndex: 0, funder: funder.keys.authPub },
    keys: Object.values(state.ceremonies[cid].result.keys).map((k) => ({ cid, slot: k.slot, keyId: k.keyId, purpose: k.purpose, securityLevel: k.securityLevel, publicKey: k.groupPublicKey })),
    userFeeIncrease: 0,
  });
  assert.equal(await core.assetLockIdentityId(txid, 0), built.derived.identityId);
});

test('a lock found on chain with no journal is resumed, not rebuilt, and history is paged', async (t) => {
  const lock = lockTx('registration', 0, 250000);
  const chain = fakeChain({ locks: [lock], fillers: 120, utxos: [fundingCoin(5000000)] });
  const { s, logs } = session(t, chain, fakeSdk());
  const out = await s.proposeIdentityCreate({ cid, duffs: 400000 });
  assert.equal(chain.sent.length, 0, 'no second asset lock is broadcast');
  const [p] = identityCreates(s);
  assert.equal(p.id, out.id);
  assert.deepEqual({ txid: p.body.intent.assetLockProof.txid, vout: p.body.intent.assetLockProof.vout, keyIndex: p.body.intent.assetLockProof.keyIndex }, { txid: lock.txid, vout: 0, keyIndex: 0 });
  assert.ok(logs.some((m) => m === `resuming an unused asset lock of 0.0025 tDASH from ${lock.txid}`), logs.join('\n'));
  const rec = s.assetLockJournal(NET).get()['registration/0'];
  assert.equal(rec.txid, lock.txid);
  assert.equal(rec.proposedBy, out.id);
});

test('used locks are skipped and a new lock takes the next index above every lock on chain', async (t) => {
  const used0 = lockTx('registration', 0, 200000);
  const used2 = lockTx('registration', 2, 200000);
  const topup = lockTx('topup', 0, 300000);
  const existing = new Set([await core.assetLockIdentityId(used0.txid, 0), await core.assetLockIdentityId(used2.txid, 0)]);
  const chain = fakeChain({ locks: [used0, used2, topup], utxos: [fundingCoin(5000000)] });
  const { s } = session(t, chain, fakeSdk(existing));
  const found = await s.findAssetLocks(NET);
  assert.deepEqual(found.map((l) => [l.kind, l.index, l.used]), [['registration', 0, true], ['registration', 2, true], ['topup', 0, null]]);
  const lock = await s.assetLock(NET, { duffs: 200000 });
  assert.equal(chain.sent.length, 1);
  assert.equal(lock.index, 3);
  assert.equal(chain.sent[0].extraPayload.creditOutputs[0].script.toHex(), p2pkh(core.registrationKey(funder.seed, NET, 3).address));
  await assert.rejects(s.assetLock(NET, { duffs: 200000, index: 2 }), /registration\/2 was already used/);
});

test('an earlier top-up lock is reported but not reused unless its index is given', async (t) => {
  const topup = lockTx('topup', 0, 300000);
  const chain = fakeChain({ locks: [topup], utxos: [fundingCoin(5000000)] });
  const { s, logs } = session(t, chain, fakeSdk());
  const fresh = await s.assetLock(NET, { duffs: 150000, kind: 'topup' });
  assert.equal(fresh.index, 1);
  assert.equal(chain.sent.length, 1);
  assert.ok(logs.some((m) => m.includes('top-up lock') && m.includes(topup.txid)));
  fs.rmSync(path.join(process.env.DTI_HOME, 'journal'), { recursive: true });
  const again = await s.assetLock(NET, { duffs: 150000, kind: 'topup', index: 0 });
  assert.deepEqual([again.txid, again.state, chain.sent.length], [topup.txid, 'chainlocked', 1]);
});

test('proposing again with the same asset lock returns the open proposal instead of posting another', async (t) => {
  const lock = lockTx('registration', 0, 250000);
  const chain = fakeChain({ locks: [lock] });
  const { s, logs, home } = session(t, chain, fakeSdk());
  const first = await s.proposeIdentityCreate({ cid, duffs: 250000 });
  const rerun = await s.proposeIdentityCreate({ cid, duffs: 250000 });
  fs.rmSync(path.join(home, 'journal'), { recursive: true });
  const fresh = new Session({ mnemonic: MNEMONICS[0], passphrase: 'TREZOR', log: (m) => logs.push(m) });
  fresh.sdks[NET] = Promise.resolve(fakeSdk());
  fresh.data = s.data;
  const recovered = await fresh.proposeIdentityCreate({ cid });
  assert.deepEqual([rerun.id, rerun.existing, recovered.id, recovered.existing], [first.id, true, first.id, true]);
  assert.equal(identityCreates(s).length, 1);
  assert.equal(chain.sent.length, 0);
});

test('a journal record whose identity another member created is marked used and skipped', async (t) => {
  const lock = lockTx('registration', 0, 250000);
  const chain = fakeChain({ locks: [lock], utxos: [fundingCoin(5000000)] });
  const existing = new Set();
  const { s, logs } = session(t, chain, fakeSdk(existing));
  await s.assetLock(NET, { duffs: 250000 });
  existing.add(await core.assetLockIdentityId(lock.txid, 0));
  const next = await s.assetLock(NET, { duffs: 250000 });
  assert.equal(next.index, 1);
  assert.equal(chain.sent.length, 1);
  assert.match(s.assetLockJournal(NET).get()['registration/0'].usedBy, /^identity:/);
  assert.ok(logs.some((m) => m.includes('marked it used')));
});

test('locks too small for an identity, or skipped with newLock, are not resumed', async (t) => {
  const small = lockTx('registration', 0, 150000);
  const big = lockTx('registration', 1, 300000);
  const chain = fakeChain({ locks: [small, big], utxos: [fundingCoin(5000000)] });
  const { s, logs } = session(t, chain, fakeSdk());
  const fresh = await s.assetLock(NET, { duffs: 200000, newLock: true });
  assert.deepEqual([fresh.index, chain.sent.length], [2, 1]);
  assert.ok(logs.some((m) => m.includes(big.txid) && m.includes('a new lock was asked for')));
  fs.rmSync(path.join(process.env.DTI_HOME, 'journal'), { recursive: true });
  const resumed = await s.assetLock(NET, { duffs: 200000 });
  assert.equal(resumed.txid, big.txid);
  fs.rmSync(path.join(process.env.DTI_HOME, 'journal'), { recursive: true });
  const onlySmall = fakeChain({ locks: [small], utxos: [fundingCoin(5000000)] });
  t.mock.method(globalThis, 'fetch', onlySmall.fetch);
  const built = await s.assetLock(NET, { duffs: 200000 });
  assert.deepEqual([built.index, onlySmall.sent.length], [1, 1]);
  assert.ok(logs.some((m) => m.includes(small.txid) && m.includes('at least 200000 duffs')));
});

test('an explicit index far past the others still finds the lock there', async (t) => {
  const far = lockTx('registration', 100, 250000);
  const chain = fakeChain({ locks: [far], utxos: [fundingCoin(5000000)] });
  const { s } = session(t, chain, fakeSdk());
  const lock = await s.assetLock(NET, { duffs: 250000, index: 100 });
  assert.deepEqual([lock.txid, chain.sent.length], [far.txid, 0]);
});

test('a recovered lock that left the mempool is broadcast again', async (t) => {
  const lock = lockTx('registration', 0, 250000);
  const chain = fakeChain({ locks: [lock], evicted: new Set([lock.txid]) });
  const { s } = session(t, chain, fakeSdk());
  const out = await s.assetLock(NET, { duffs: 250000 });
  assert.deepEqual([out.txid, out.state, chain.sent.map((x) => x.id)], [lock.txid, 'chainlocked', [lock.txid]]);
});

test('without an address history from Insight no new lock is built', async (t) => {
  const chain = fakeChain({ utxos: [fundingCoin(5000000)] });
  const insight = chain.fetch;
  const { s } = session(t, { fetch: (url, init) => (String(url).includes('/addrs/') ? Promise.resolve(new Response('{}', { status: 404 })) : insight(url, init)) }, fakeSdk());
  await assert.rejects(s.assetLock(NET, { duffs: 200000 }), /cannot check it for earlier asset locks/);
  assert.equal(chain.sent.length, 0);
});

test('asset locks with many inputs pay at least the minimum relay fee', () => {
  const utxoList = Array.from({ length: 8 }, () => fundingCoin(100000));
  const built = core.buildAssetLock({ network: NET, funding, utxoList, creditAddress: core.registrationKey(funder.seed, NET, 0).address, duffs: 700000 });
  const tx = new Transaction(built.rawtx);
  const fee = 800000 - tx.outputs.reduce((a, o) => a + o.satoshis, 0);
  assert.equal(fee, built.fee);
  assert.ok(fee >= built.rawtx.length / 2, `fee ${fee} for ${built.rawtx.length / 2} bytes`);
  assert.equal(tx.outputs[0].satoshis, 700000);
  assert.equal(tx.outputs[1].script.toAddress('testnet').toString(), funding.address);
});

test('a journaled lock that left the mempool is sent again instead of waiting forever', async (t) => {
  const lock = lockTx('registration', 0, 250000);
  const chain = fakeChain({ locks: [lock], evicted: new Set([lock.txid]) });
  const { s, logs } = session(t, chain, fakeSdk());
  s.assetLockJournal(NET).update((all) => {
    all['registration/0'] = { kind: 'registration', index: 0, duffs: 250000, txid: lock.txid, vout: 0, state: 'broadcast', rawtx: lock.rawtx, fee: lock.fee };
  });
  const out = await s.assetLock(NET, { duffs: 300000 });
  assert.deepEqual([out.txid, out.state, chain.sent.map((x) => x.id)], [lock.txid, 'chainlocked', [lock.txid]]);
  assert.ok(logs.some((m) => /no longer known to the network/.test(m)));
});
