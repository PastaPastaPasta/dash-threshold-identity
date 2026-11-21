import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { people } from './helpers.mjs';
import { hello } from '../src/participant.mjs';

test('two writers holding stale copies of a room both keep their messages', async () => {
  process.env.DTI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dti-store-'));
  const { openRoom, loadRoom, addMessages } = await import(`../src/store.mjs?${Date.now()}`);
  const [a, b] = people(2);
  const room = 'store-merge-room';
  openRoom(room);
  const first = loadRoom(room);
  const second = loadRoom(room);
  const ha = hello(a.keys, room, 'a');
  const hb = hello(b.keys, room, 'b');
  addMessages(first, [ha]);
  addMessages(second, [hb]);
  assert.deepEqual(loadRoom(room).messages.map((m) => m.from), [ha.from, hb.from]);
  fs.rmSync(process.env.DTI_HOME, { recursive: true });
});

test('journal updates from stale readers keep each other\'s records', async () => {
  process.env.DTI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dti-store-'));
  const { journal } = await import(`../src/store.mjs?${Date.now()}`);
  const one = journal('locks');
  const two = journal('locks');
  one.get();
  two.get();
  one.update((all) => (all['registration/0'] = { index: 0 }));
  two.update((all) => (all['registration/1'] = { index: 1 }));
  assert.deepEqual(Object.keys(journal('locks').get()).sort(), ['registration/0', 'registration/1']);
  fs.rmSync(process.env.DTI_HOME, { recursive: true });
});
