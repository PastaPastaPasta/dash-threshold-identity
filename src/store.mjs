import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envelopeId, verifyEnvelope } from './envelope.mjs';
import { assert, ROOM_PATTERN } from './util.mjs';

export function home() {
  return process.env.DTI_HOME || path.join(os.homedir(), '.dti');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);

const roomFile = (room) => {
  assert(ROOM_PATTERN.test(room), `bad room id ${room}`);
  return path.join(home(), 'rooms', `${room}.json`);
};

export function listRooms() {
  const dir = path.join(home(), 'rooms');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f))).map((r) => ({ room: r.room, relay: r.relay, label: r.label, messages: r.messages.length }));
}

export function loadRoom(room) {
  return readJson(roomFile(room), null);
}

export function saveRoom(data) {
  writeJson(roomFile(data.room), data);
}

export function openRoom(room, { relay, label } = {}) {
  const existing = loadRoom(room);
  const data = existing ?? { room, relay: relay ?? null, label: label ?? null, cursor: 0, messages: [] };
  if (relay !== undefined && relay !== null) data.relay = relay;
  if (label) data.label = label;
  saveRoom(data);
  return data;
}

export function addMessages(data, messages) {
  const known = new Set(data.messages.map(envelopeId));
  let added = 0;
  for (const m of messages) {
    if (m.room !== data.room || !verifyEnvelope(m)) continue;
    const id = envelopeId(m);
    if (known.has(id)) continue;
    known.add(id);
    data.messages.push(m);
    added++;
  }
  if (added) saveRoom(data);
  return added;
}

export function exportBundle(data) {
  return { kind: 'dti-bundle', room: data.room, label: data.label, messages: data.messages };
}

export function importBundle(bundle) {
  assert(bundle?.kind === 'dti-bundle' && ROOM_PATTERN.test(bundle.room), 'not a dti bundle');
  const data = openRoom(bundle.room, { label: bundle.label });
  return { data, added: addMessages(data, bundle.messages ?? []) };
}

export function journal(name) {
  const file = path.join(home(), 'journal', `${name}.json`);
  return { get: () => readJson(file, {}), set: (value) => writeJson(file, value) };
}
