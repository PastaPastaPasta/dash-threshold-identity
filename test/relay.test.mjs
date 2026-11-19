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

test('the relay refuses forged, misrouted and malformed messages', async () => {
  const forged = { ...hello(ps[0].keys, ROOM, 'a'), body: { name: 'mallory', transportPub: ps[1].keys.transportPub } };
  assert.equal((await call('POST', `/v1/rooms/${ROOM}/messages`, forged)).status, 400);
  assert.equal((await call('POST', `/v1/rooms/${ROOM}/messages`, hello(ps[0].keys, 'some-other-room', 'a'))).status, 400);
  assert.equal((await call('POST', `/v1/rooms/${ROOM}/messages`, 'not an envelope')).status, 400);
  assert.equal((await call('GET', '/v1/rooms/bad/messages')).status, 404);
  const big = sealEnvelope(ps[0].keys, ROOM, 'proposal', { blob: 'x'.repeat(320 * 1024) });
  assert.equal((await call('POST', `/v1/rooms/${ROOM}/messages`, big)).status, 413);
});

test('the Node relay keeps messages on disk across restarts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dti-relay-'));
  let server = await serveRelay({ port: 0, dir });
  const url = (s) => `http://127.0.0.1:${s.address().port}/v1/rooms/${ROOM}/messages`;
  await fetch(url(server), { method: 'POST', body: JSON.stringify(hello(ps[0].keys, ROOM, 'a')) });
  server.close();
  server = await serveRelay({ port: 0, dir });
  const page = await (await fetch(`${url(server)}?after=0`)).json();
  server.close();
  assert.equal(page.messages.length, 1);
  fs.rmSync(dir, { recursive: true });
});
