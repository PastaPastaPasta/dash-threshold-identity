import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MNEMONICS, people, runCeremony } from './helpers.mjs';
import { serveRelay } from '../src/relay/node-server.mjs';
import { Session } from '../src/app.mjs';
import { isNetwork, network, roomPrefix, roomNetwork, roomOnNetwork } from '../src/networks.mjs';
import { NetworkSession } from '../web/src/session.mjs';
import { attach, api, platform } from '../web/src/transport.mjs';
import { MAINNET_WRITES } from '../web/src/flags.mjs';
import { securityFor, pageNetwork } from '../web/headers.mjs';
import { exportBundle } from '../src/store.mjs';
import * as memory from '../src/storage/memory.mjs';

const phrase = { mnemonic: MNEMONICS[0], passphrase: 'TREZOR' };

async function relayFixture(t) {
  process.env.DTI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dti-web-'));
  const server = await serveRelay({ port: 0 });
  t.after(() => {
    server.close();
    fs.rmSync(process.env.DTI_HOME, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (relay, room, messages) => Promise.all(messages.map((m) => fetch(`${relay}/v1/rooms/${room}/messages`, { method: 'POST', body: JSON.stringify(m) })));

test('the live build keeps mainnet writes off until they are signed off', () => {
  assert.equal(MAINNET_WRITES, false);
});

test('the browser storage keeps JSON in memory and lists by directory', () => {
  memory.writeJson('rooms/a.json', { room: 'a', n: 1 });
  memory.writeJson('journal/x.json', {});
  const copy = memory.readJson('rooms/a.json');
  copy.n = 2;
  assert.equal(memory.readJson('rooms/a.json').n, 1);
  assert.deepEqual(memory.listJson('rooms'), ['rooms/a.json']);
  assert.equal(memory.readJson('rooms/missing.json', null), null);
  assert.equal(memory.withLock('rooms/a.json', () => 7), 7);
});

test('networks have their own address versions, coin types, explorers and room tags', () => {
  for (const id of ['mainnet', 'testnet', 'local', 'devnet-paloma', 'devnet-a-1']) assert.ok(isNetwork(id), id);
  for (const id of ['devnet', 'devnet-', 'devnet-UP', 'regtest', 'main', '', null, 'devnet-mainnet', 'devnet-testnet', 'devnet-local', 'devnet-regtest', `devnet-${'a'.repeat(29)}`]) assert.ok(!isNetwork(id), String(id));
  assert.ok(isNetwork(`devnet-${'a'.repeat(28)}`));
  assert.match(`${roomPrefix(`devnet-${'a'.repeat(28)}`)}_${'ab'.repeat(16)}`, /^[A-Za-z0-9_-]{8,64}$/);
  assert.deepEqual([network('mainnet').core, network('mainnet').coin, network('mainnet').unit], ['livenet', 5, 'DASH']);
  assert.deepEqual([network('testnet').core, network('testnet').coin, network('testnet').unit], ['testnet', 1, 'tDASH']);
  assert.equal(network('local').core, 'regtest');
  assert.equal(network('devnet-paloma').quorums, 'https://quorums.paloma.networks.dash.org');
  assert.equal(network('devnet-paloma').insight, 'https://insight.paloma.networks.dash.org/insight-api');
  assert.equal(roomPrefix('devnet-paloma'), 'dpaloma');
  const hex = 'ab'.repeat(16);
  assert.equal(roomNetwork(`m_${hex}`), 'mainnet');
  assert.equal(roomNetwork(`t_${hex}`), 'testnet');
  assert.equal(roomNetwork(`r_${hex}`), 'local');
  assert.equal(roomNetwork(`dmtest_${hex}`), 'devnet-mtest');
  assert.equal(roomNetwork(hex), null);
  assert.ok(roomOnNetwork(hex, 'testnet'));
  assert.ok(!roomOnNetwork(hex, 'mainnet'));
  assert.ok(!roomOnNetwork(`t_${hex}`, 'mainnet'));
  assert.ok(!roomOnNetwork(`dpaloma_${hex}`, 'devnet-other'));
});

test('each network gets a CSP that reaches only its own hosts', () => {
  const csp = (id) => securityFor(id)['content-security-policy'];
  assert.match(csp('testnet'), /insight\.testnet\.networks\.dash\.org/);
  assert.doesNotMatch(csp('testnet'), /insight\.dash\.org|:443\b|127\.0\.0\.1/);
  assert.match(csp('mainnet'), /https:\/\/insight\.dash\.org/);
  assert.doesNotMatch(csp('mainnet'), /testnet|:1443|127\.0\.0\.1/);
  assert.match(csp('devnet-paloma'), /quorums\.paloma\.networks\.dash\.org/);
  assert.doesNotMatch(csp('devnet-paloma'), /testnet\.networks|insight\.dash\.org/);
  assert.match(csp('local'), /connect-src 'self' http:\/\/127\.0\.0\.1:\*/);
  assert.doesNotMatch(csp('local'), /dash\.org/);
  assert.equal(pageNetwork('https://x/?network=mainnet'), 'mainnet');
  assert.equal(pageNetwork('https://x/?network=nope'), 'testnet');
  assert.equal(pageNetwork('https://x/'), 'testnet');
});

test('a hosted page uses only groups, ceremonies and bundles of its own network', async (t) => {
  const relay = await relayFixture(t);
  const ps = people(3);
  const legacy = 'hosted-lock-room';
  const { cid, messages } = runCeremony(ps, { room: legacy, threshold: 2, network: 'mainnet' });
  await post(relay, legacy, messages);

  const s = new NetworkSession({ ...phrase, relay, network: 'testnet' });
  s.useRoom(legacy);
  await s.sync();
  assert.equal(s.status().ceremonies[0].network, 'mainnet');
  const wrongNet = /is on Mainnet, but this page is on Testnet/;
  await assert.rejects(s.advanceCeremony(cid), wrongNet);
  await assert.rejects(s.proposeIdentityCreate({ cid, duffs: 1000000 }), wrongNet);
  await assert.rejects(s.sdk('mainnet'), wrongNet);
  await assert.rejects(s.assetLock('mainnet', { duffs: 1000000 }), wrongNet);
  await assert.rejects(s.propose('mainnet', {}, ''), wrongNet);
  assert.throws(() => s.funding('mainnet'), wrongNet);
  await assert.rejects(s.proposeCeremony({ network: 'mainnet', threshold: 2, label: 'x' }), wrongNet);

  const { cid: own } = await s.proposeCeremony({ threshold: 2, label: 'testnet keys', members: ps.map((p) => p.keys.authPub) });
  assert.equal(s.ceremony(own).config.network, 'testnet');
  s.data.relay = 'https://relay.example.org';
  assert.equal(s.requireRoom().relay, relay);

  const created = await s.createRoom({ label: 'fresh', name: 'p1' });
  assert.match(created.room, /^t_[0-9a-f]{32}$/);
  assert.throws(() => s.useRoom(`m_${'cd'.repeat(16)}`), /on Mainnet, but this page is on Testnet/);

  attach(s);
  assert.deepEqual([platform.network, platform.readOnly, platform.unit], ['testnet', false, 'tDASH']);
  await assert.rejects(api('POST', '/api/room/import', { kind: 'dti-bundle', room: `m_${'ef'.repeat(16)}`, messages: [] }), /on Mainnet/);
  await assert.rejects(api('POST', '/api/room/join', { room: `dpaloma_${'ef'.repeat(16)}`, name: 'p1' }), /on Devnet paloma/);
  const bundle = exportBundle(s.data);
  const main = new NetworkSession({ ...phrase, relay, network: 'mainnet' });
  attach(main);
  await assert.rejects(api('POST', '/api/room/import', bundle), /on Testnet, but this page is on Mainnet/);
});

test('mainnet is read only unless the build turns writes on', async (t) => {
  const relay = await relayFixture(t);
  const s = new NetworkSession({ ...phrase, relay, network: 'mainnet' });
  const { room } = await s.createRoom({ label: 'mainnet group', name: 'p1' });
  assert.match(room, /^m_/);
  assert.match(s.funding('mainnet').address, /^X/);
  const off = /turned off on Mainnet/;
  const members = [s.keys.authPub];
  await assert.rejects(s.proposeCeremony({ threshold: 2, label: 'k', members }), off);
  await assert.rejects(s.advanceCeremony('x'), off);
  await assert.rejects(s.assetLock('mainnet', { duffs: 1000000 }), off);
  await assert.rejects(s.proposeIdentityCreate({ duffs: 1000000 }), off);
  await assert.rejects(s.propose('mainnet', {}, ''), off);
  await assert.rejects(s.approve('x'), off);
  await assert.rejects(s.reject('x', 'no'), off);
  await assert.rejects(s.execute('x'), off);
  await assert.rejects(s.topUp({}), off);
  attach(s);
  assert.equal(platform.readOnly, true);
  for (const [route, body] of [['/api/ceremony/propose', { threshold: 2, label: 'k', members }], ['/api/ceremony/advance', { cid: 'x', accept: true }], ['/api/approve', { id: 'x' }], ['/api/execute', { id: 'x' }], ['/api/reject', { id: 'x', reason: 'no' }], ['/api/propose', { kind: 'credit-transfer', args: {} }], ['/api/identity/create', { cid: 'x', duffs: 1000000 }]]) {
    await assert.rejects(api('POST', route, body), off, route);
  }

  const w = new NetworkSession({ ...phrase, relay, network: 'mainnet', mainnetWrites: true });
  w.useRoom(room);
  await assert.rejects(w.assetLock('mainnet', { duffs: 1000000 }), /confirm it explicitly/);
  await assert.rejects(w.proposeCeremony({ threshold: 2, label: 'k', members }), /at least|threshold|participants|members/i);
});

test('a hosted page refuses proposals and identities found in a group that belong to another network', (t) => {
  const s = new NetworkSession({ ...phrase, relay: 'http://relay', network: 'testnet' });
  t.mock.method(Session.prototype, 'findProposal', () => ({ s: {}, p: { id: 'a'.repeat(64), body: { network: 'mainnet' } } }));
  t.mock.method(Session.prototype, 'identity', () => ({ identityId: 'X', network: 'devnet-paloma' }));
  assert.throws(() => s.findProposal('a'), /is on Mainnet, but this page is on Testnet/);
  assert.throws(() => s.identity('X'), /is on Devnet paloma, but this page is on Testnet/);
});

test('the base session still accepts any known network for the CLI', () => {
  const s = new Session(phrase);
  for (const id of ['mainnet', 'testnet', 'local', 'devnet-paloma']) assert.ok(s.funding(id).address);
  assert.match(s.funding('mainnet').address, /^X/);
  assert.match(s.funding('devnet-paloma').address, /^y/);
});
