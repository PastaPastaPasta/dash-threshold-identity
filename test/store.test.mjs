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
  addMessages(first, [hello(a.keys, room, 'a')]);
  addMessages(second, [hello(b.keys, room, 'b')]);
  assert.equal(loadRoom(room).messages.length, 2);
  fs.rmSync(process.env.DTI_HOME, { recursive: true });
});
