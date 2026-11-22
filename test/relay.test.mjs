import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { people } from './helpers.mjs';
import { admit, handle, memoryStore, windowLimiter, CLIENT_HEADER, MAX_HELLOS_PER_CLIENT } from '../src/relay/core.mjs';
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

test('a config whose participants is not a list names no one', () => {
  const [owner] = ps;
  const start = admit(null, hello(owner.keys, 'odd-config-room', 'owner')).next;
  const after = admit(start, sealEnvelope(owner.keys, 'odd-config-room', 'config', { config: { participants: {} } }));
  assert.deepEqual(after, { ok: true, next: start });
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

test('the Node relay answers 413 to an oversized body and recovers from a torn last line', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dti-relay-'));
  let server = await serveRelay({ port: 0, dir });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
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
});

test('the Node relay keeps messages on disk across restarts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dti-relay-'));
  let server = await serveRelay({ port: 0, dir });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = (s) => `http://127.0.0.1:${s.address().port}/v1/rooms/${ROOM}/messages`;
  await fetch(url(server), { method: 'POST', body: JSON.stringify(hello(ps[0].keys, ROOM, 'a')) });
  server.close();
  server = await serveRelay({ port: 0, dir });
  const page = await (await fetch(`${url(server)}?after=0`)).json();
  const outsider = await fetch(url(server), { method: 'POST', body: JSON.stringify(sealEnvelope(ps[1].keys, ROOM, 'proposal', { x: 1 })) });
  server.close();
  assert.equal(page.messages.length, 1);
  assert.equal(outsider.status, 403);
});

const post = (store, limiter, client, room, envelope) =>
  handle(new Request(`http://relay/v1/rooms/${room}/messages`, { method: 'POST', headers: client ? { [CLIENT_HEADER]: client } : {}, body: JSON.stringify(envelope) }), async () => store, limiter);

test('the window limiter counts per kind and client and resets each period', async () => {
  let now = 0;
  const limiter = windowLimiter({ posts: { limit: 2, periodMs: 1000 } }, () => now);
  assert.deepEqual([await limiter.allow('posts', 'a'), await limiter.allow('posts', 'a'), await limiter.allow('posts', 'a')], [true, true, false]);
  assert.equal(await limiter.allow('posts', 'b'), true);
  now = 1000;
  assert.equal(await limiter.allow('posts', 'a'), true);
});

test('the relay answers 429 once one address posts or reads too often', async () => {
  const limits = { reads: { limit: 1, periodMs: 60000 }, posts: { limit: 2, periodMs: 60000 }, rooms: { limit: 99, periodMs: 60000 } };
  const store = memoryStore();
  const limiter = windowLimiter(limits);
  const room = 'limit-room-posts';
  const [a, b, c] = people(3).map((p, i) => hello(p.keys, room, `m${i}`));
  assert.equal((await post(store, limiter, '198.51.100.1', room, a)).status, 200);
  assert.equal((await post(store, limiter, '198.51.100.1', room, b)).status, 200);
  const refused = await post(store, limiter, '198.51.100.1', room, c);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('retry-after'), '60');
  assert.equal((await post(store, limiter, '198.51.100.2', room, c)).status, 200);
  assert.equal((await post(store, limiter, null, room, c)).status, 200);
  const read = () => handle(new Request(`http://relay/v1/rooms/${room}/messages?after=0`, { headers: { [CLIENT_HEADER]: '198.51.100.3' } }), async () => store, limiter);
  assert.equal((await read()).status, 200);
  assert.equal((await read()).status, 429);
});

test('one address can take only a few join slots in a room, and open only a few rooms', async () => {
  const store = memoryStore();
  const limiter = windowLimiter({ reads: { limit: 99, periodMs: 60000 }, posts: { limit: 99, periodMs: 60000 }, rooms: { limit: 1, periodMs: 60000 } });
  const room = 'limit-room-slots';
  const joiners = people(6);
  const statuses = [];
  for (const p of joiners.slice(0, MAX_HELLOS_PER_CLIENT + 1)) statuses.push((await post(store, limiter, '203.0.113.7', room, hello(p.keys, room, 'x'))).status);
  assert.deepEqual(statuses, [...Array(MAX_HELLOS_PER_CLIENT).fill(200), 429]);
  assert.equal((await post(store, limiter, '203.0.113.8', room, hello(joiners[5].keys, room, 'y'))).status, 200);
  const other = 'limit-room-second';
  assert.equal((await post(store, limiter, '203.0.113.7', other, hello(joiners[0].keys, other, 'z'))).status, 429);
  assert.equal((await post(store, limiter, '203.0.113.9', other, hello(joiners[0].keys, other, 'z'))).status, 200);
});

test('the Node relay uses the socket address, not a client-supplied header', async (t) => {
  const seen = [];
  const server = await serveRelay({ port: 0, limiter: { allow: async (kind, client) => { seen.push(client); return true; } } });
  t.after(() => server.close());
  await fetch(`http://127.0.0.1:${server.address().port}/v1/rooms/${ROOM}/messages?after=0`, { headers: { [CLIENT_HEADER]: '192.0.2.1' } });
  assert.deepEqual(seen, ['127.0.0.1']);
});
