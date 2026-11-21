import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MNEMONICS, people, runCeremony } from './helpers.mjs';
import { serveRelay } from '../src/relay/node-server.mjs';
import { Session } from '../src/app.mjs';
import { TestnetSession } from '../web/src/session.mjs';
import { attach, api } from '../web/src/transport.mjs';
import * as memory from '../src/storage/memory.mjs';

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

test('the hosted session refuses every mainnet path and pins its relay', async (t) => {
  process.env.DTI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dti-web-'));
  const server = await serveRelay({ port: 0 });
  t.after(() => {
    server.close();
    fs.rmSync(process.env.DTI_HOME, { recursive: true, force: true });
  });
  const relay = `http://127.0.0.1:${server.address().port}`;
  const room = 'hosted-lock-room';
  const ps = people(3);
  const { cid, messages } = runCeremony(ps, { room, threshold: 2, network: 'mainnet' });
  for (const m of messages) await fetch(`${relay}/v1/rooms/${room}/messages`, { method: 'POST', body: JSON.stringify(m) });

  const s = new TestnetSession({ mnemonic: MNEMONICS[0], passphrase: 'TREZOR', relay });
  s.useRoom(room);
  await s.sync();
  assert.equal(s.status().ceremonies[0].network, 'mainnet');
  const refused = /testnet only/;
  await assert.rejects(s.advanceCeremony(cid), refused);
  await assert.rejects(s.proposeIdentityCreate({ cid, duffs: 1000000 }), refused);
  await assert.rejects(s.proposeCeremony({ network: 'mainnet', threshold: 2, label: 'x' }), refused);
  await assert.rejects(s.sdk('mainnet'), refused);
  await assert.rejects(s.assetLock('mainnet', { duffs: 1000000 }), refused);
  await assert.rejects(s.propose('mainnet', {}, ''), refused);
  assert.throws(() => s.funding('mainnet'), refused);

  const { cid: testnetCid } = await s.proposeCeremony({ threshold: 2, label: 'testnet keys', members: ps.map((p) => p.keys.authPub) });
  assert.equal(s.ceremony(testnetCid).config.network, 'testnet');

  s.data.relay = 'https://relay.example.org';
  assert.equal(s.requireRoom().relay, relay);

  attach(s);
  const viaRoutes = await api('POST', '/api/ceremony/propose', { network: 'mainnet', threshold: 2, label: 'routed', members: ps.map((p) => p.keys.authPub) });
  assert.equal(s.ceremony(viaRoutes.cid).config.network, 'testnet');
  assert.equal((await api('POST', '/api/room/join', { room, name: 'p1', relay: 'https://relay.example.org' })).relay, relay);
  await assert.rejects(api('POST', '/api/ceremony/advance', { cid, accept: true }), refused);
});

test('the hosted session refuses mainnet proposals and identities found in a room', (t) => {
  const s = new TestnetSession({ mnemonic: MNEMONICS[0], passphrase: 'TREZOR', relay: 'http://relay' });
  t.mock.method(Session.prototype, 'findProposal', () => ({ s: {}, p: { id: 'a'.repeat(64), body: { network: 'mainnet' } } }));
  t.mock.method(Session.prototype, 'identity', () => ({ identityId: 'X', network: 'mainnet' }));
  assert.throws(() => s.findProposal('a'), /testnet only/);
  assert.throws(() => s.identity('X'), /testnet only/);
});
