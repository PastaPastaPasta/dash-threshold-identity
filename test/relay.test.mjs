import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { people } from './helpers.mjs';
import { admit, handle, memoryStore, windowLimiter, clientBucket, CLIENT_HEADER, MAX_HELLOS_PER_CLIENT } from '../src/relay/core.mjs';
import { serveRelay } from '../src/relay/node-server.mjs';
import { hello } from '../src/participant.mjs';
import { participantKeys } from '../src/derive.mjs';
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

test('one network can take only a few join slots in a room, and open only a few rooms', async () => {
  const store = memoryStore();
  const limiter = windowLimiter({ reads: { limit: 999, periodMs: 60000 }, posts: { limit: 999, periodMs: 60000 }, rooms: { limit: 1, periodMs: 60000 } });
  const room = 'limit-room-slots';
  const keys = Array.from({ length: MAX_HELLOS_PER_CLIENT + 2 }, (_, i) => participantKeys(new Uint8Array(32).fill(i + 1)));
  const statuses = [];
  for (const k of keys.slice(0, MAX_HELLOS_PER_CLIENT + 1)) statuses.push((await post(store, limiter, '203.0.113.7', room, hello(k, room, 'x'))).status);
  assert.deepEqual(statuses, [...Array(MAX_HELLOS_PER_CLIENT).fill(200), 403]);
  assert.equal((await post(store, limiter, '203.0.113.8', room, hello(keys.at(-1), room, 'y'))).status, 200);
  const other = 'limit-room-second';
  assert.equal((await post(store, limiter, '203.0.113.7', other, hello(keys[0], other, 'z'))).status, 429);
  assert.equal((await post(store, limiter, '203.0.113.9', other, hello(keys[0], other, 'z'))).status, 200);
});

test('a member who already joined can post another hello without using a join slot', async () => {
  const store = memoryStore();
  const limiter = windowLimiter({ reads: { limit: 999, periodMs: 60000 }, posts: { limit: 999, periodMs: 60000 }, rooms: { limit: 9, periodMs: 60000 } });
  const room = 'limit-room-rehello';
  const keys = Array.from({ length: MAX_HELLOS_PER_CLIENT }, (_, i) => participantKeys(new Uint8Array(32).fill(i + 40)));
  for (const k of keys) assert.equal((await post(store, limiter, '203.0.113.20', room, hello(k, room, 'x'))).status, 200);
  assert.equal((await post(store, limiter, '203.0.113.20', room, hello(keys[1], room, 'x', { funding: 'ab'.repeat(32) }))).status, 200);
  const extra = participantKeys(new Uint8Array(32).fill(99));
  assert.equal((await post(store, limiter, '203.0.113.20', room, hello(extra, room, 'y'))).status, 403);
});

test('a slow new-room check cannot let two first joins both own a room', async () => {
  const store = memoryStore();
  let release;
  const gate = new Promise((r) => (release = r));
  let checks = 0;
  const limiter = { allow: async (kind) => { if (kind === 'rooms') { checks++; await gate; } return true; } };
  const room = 'limit-room-race';
  const [a, b] = people(2);
  const first = post(store, limiter, '198.51.100.20', room, hello(a.keys, room, 'a'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(checks, 1);
  const second = post(store, limiter, '198.51.100.21', room, hello(b.keys, room, 'b'));
  await new Promise((r) => setTimeout(r, 20));
  release();
  const statuses = (await Promise.all([first, second])).map((r) => r.status);
  assert.deepEqual(statuses, [200, 200]);
  const rows = await store.list(room, 0, 10);
  const policy = await store.policy(room);
  assert.equal(policy.owner, JSON.parse(rows[0].body).from);
  assert.equal(policy.hellos, 2);
});

test('addresses are bucketed per IPv4 address and per IPv6 /64', () => {
  assert.equal(clientBucket('198.51.100.7'), '198.51.100.7');
  assert.equal(clientBucket('::ffff:198.51.100.7'), '198.51.100.7');
  assert.equal(clientBucket('2001:db8:1:2:aaaa::1'), '2001:0db8:0001:0002::/64');
  assert.equal(clientBucket('2001:db8:1:2:ffff:ffff:ffff:ffff'), '2001:0db8:0001:0002::/64');
  assert.equal(clientBucket('2001:db8::1'), '2001:0db8:0000:0000::/64');
  assert.equal(clientBucket('::1'), '0000:0000:0000:0000::/64');
  assert.equal(clientBucket('fe80::1%eth0'), 'fe80:0000:0000:0000::/64');
  assert.equal(clientBucket(''), 'unknown');
  assert.equal(clientBucket(null), 'unknown');
});

test('the Node relay uses the socket address, not a client-supplied header', async (t) => {
  const seen = [];
  const server = await serveRelay({ port: 0, limits: true, limiter: { allow: async (kind, client) => { seen.push(client); return true; } } });
  t.after(() => server.close());
  await fetch(`http://127.0.0.1:${server.address().port}/v1/rooms/${ROOM}/messages?after=0`, { headers: { [CLIENT_HEADER]: '192.0.2.1' } });
  assert.deepEqual(seen, ['127.0.0.1']);
});

test('the Node relay keeps join counts on disk across restarts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dti-slots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = 'slots-restart-room';
  const keys = Array.from({ length: MAX_HELLOS_PER_CLIENT + 1 }, (_, i) => participantKeys(new Uint8Array(32).fill(i + 40)));
  const send = (server, k) => fetch(`http://127.0.0.1:${server.address().port}/v1/rooms/${room}/messages`, { method: 'POST', body: JSON.stringify(hello(k, room, 'x')) });
  let server = await serveRelay({ port: 0, dir, limits: true });
  for (const k of keys.slice(0, MAX_HELLOS_PER_CLIENT)) assert.equal((await send(server, k)).status, 200);
  server.close();
  server = await serveRelay({ port: 0, dir, limits: true });
  assert.equal((await send(server, keys.at(-1))).status, 403);
  server.close();
});

test('without --limits the Node relay applies no per-address limits, even to a spoofed header', async (t) => {
  const server = await serveRelay({ port: 0 });
  t.after(() => server.close());
  const room = 'no-limits-room';
  const statuses = [];
  for (let i = 0; i <= MAX_HELLOS_PER_CLIENT; i++) {
    const k = participantKeys(new Uint8Array(32).fill(i + 90));
    statuses.push((await fetch(`http://127.0.0.1:${server.address().port}/v1/rooms/${room}/messages`, { method: 'POST', headers: { [CLIENT_HEADER]: '192.0.2.1' }, body: JSON.stringify(hello(k, room, 'x')) })).status);
  }
  assert.deepEqual(statuses, Array(MAX_HELLOS_PER_CLIENT + 1).fill(200));
});
