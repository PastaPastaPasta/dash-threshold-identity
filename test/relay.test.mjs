import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { people } from './helpers.mjs';
import { handle, memoryStore } from '../src/relay/core.mjs';
import { serveRelay } from '../src/relay/node-server.mjs';
import { hello } from '../src/participant.mjs';
import { sealEnvelope } from '../src/envelope.mjs';

const ps = people(2);
const ROOM = 'relay-test-room';
const store = memoryStore();
const call = (method, url, body) => handle(new Request(`http://relay${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), async () => store);

test('the relay stores signed envelopes once and pages them in order', async () => {
  const a = hello(ps[0].keys, ROOM, 'a');
  const b = hello(ps[1].keys, ROOM, 'b');
  assert.equal((await (await call('POST', `/v1/rooms/${ROOM}/messages`, a)).json()).seq, 1);
  assert.equal((await (await call('POST', `/v1/rooms/${ROOM}/messages`, a)).json()).duplicate, true);
  assert.equal((await (await call('POST', `/v1/rooms/${ROOM}/messages`, b)).json()).seq, 2);
  const page = await (await call('GET', `/v1/rooms/${ROOM}/messages?after=1`)).json();
  assert.deepEqual(page.messages.map((m) => m.envelope.body.name), ['b']);
  assert.equal(page.next, 2);
});

test('only the room creator and ceremony members can post beyond a hello', async () => {
  const [owner, member] = ps;
  const outsider = people(3)[2];
  const room = 'pinned-room-test';
  const post = async (env) => (await call('POST', `/v1/rooms/${room}/messages`, env)).status;
  assert.equal(await post(sealEnvelope(outsider.keys, room, 'proposal', { x: 1 })), 403);
  assert.equal(await post(hello(owner.keys, room, 'owner')), 200);
  assert.equal(await post(hello(member.keys, room, 'member')), 200);
  assert.equal(await post(hello(outsider.keys, room, 'outsider')), 200);
  assert.equal(await post(sealEnvelope(member.keys, room, 'config', { config: { participants: [{ authPub: outsider.keys.authPub }] } })), 403);
  assert.equal(await post(sealEnvelope(outsider.keys, room, 'proposal', { x: 2 })), 403);
  assert.equal(await post(sealEnvelope(owner.keys, room, 'config', { config: { participants: [{ authPub: owner.keys.authPub }, { authPub: member.keys.authPub }] } })), 200);
  assert.equal(await post(sealEnvelope(member.keys, room, 'accept', { cid: 'x' })), 200);
  assert.equal(await post(sealEnvelope(outsider.keys, room, 'accept', { cid: 'x' })), 403);
});

test('the relay refuses forged, misrouted and malformed messages', async () => {
  const forged = { ...hello(ps[0].keys, ROOM, 'a'), body: { name: 'mallory', transportPub: ps[1].keys.transportPub } };
  assert.equal((await call('POST', `/v1/rooms/${ROOM}/messages`, forged)).status, 400);
  assert.equal((await call('POST', `/v1/rooms/${ROOM}/messages`, hello(ps[0].keys, 'some-other-room', 'a'))).status, 400);
  assert.equal((await call('POST', `/v1/rooms/${ROOM}/messages`, 'not an envelope')).status, 400);
  assert.equal((await call('GET', '/v1/rooms/bad/messages')).status, 404);
  const big = sealEnvelope(ps[0].keys, ROOM, 'proposal', { blob: 'x'.repeat(320 * 1024) });
  assert.equal((await call('POST', `/v1/rooms/${ROOM}/messages`, big)).status, 413);
});

test('the Node relay answers 413 to an oversized body and recovers from a torn last line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dti-relay-'));
  let server = await serveRelay({ port: 0, dir });
  const url = (s) => `http://127.0.0.1:${s.address().port}/v1/rooms/${ROOM}/messages`;
  const big = await fetch(url(server), { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(big.status, 413);
  await fetch(url(server), { method: 'POST', body: JSON.stringify(hello(ps[0].keys, ROOM, 'a')) });
  server.close();
  fs.appendFileSync(path.join(dir, `${ROOM}.jsonl`), '{"seq":2,"id":"torn');
  server = await serveRelay({ port: 0, dir });
  const ok = await fetch(url(server), { method: 'POST', body: JSON.stringify(hello(ps[1].keys, ROOM, 'b')) });
  const page = await (await fetch(`${url(server)}?after=0`)).json();
  server.close();
  assert.equal(ok.status, 200);
  assert.deepEqual(page.messages.map((m) => m.seq), [1, 2]);
  fs.rmSync(dir, { recursive: true });
});

test('the Node relay keeps messages on disk across restarts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dti-relay-'));
  let server = await serveRelay({ port: 0, dir });
  const url = (s) => `http://127.0.0.1:${s.address().port}/v1/rooms/${ROOM}/messages`;
  await fetch(url(server), { method: 'POST', body: JSON.stringify(hello(ps[0].keys, ROOM, 'a')) });
  server.close();
  server = await serveRelay({ port: 0, dir });
  const page = await (await fetch(`${url(server)}?after=0`)).json();
  const outsider = await fetch(url(server), { method: 'POST', body: JSON.stringify(sealEnvelope(ps[1].keys, ROOM, 'proposal', { x: 1 })) });
  server.close();
  assert.equal(page.messages.length, 1);
  assert.equal(outsider.status, 403);
  fs.rmSync(dir, { recursive: true });
});
