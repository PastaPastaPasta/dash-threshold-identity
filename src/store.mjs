import { readJson, writeJson, listJson, withLock } from '#storage';
import { envelopeId, verifyEnvelope } from './envelope.mjs';
import { assert, ROOM_PATTERN } from './util.mjs';

const roomFile = (room) => {
  assert(ROOM_PATTERN.test(room), `bad room id ${room}`);
  return `rooms/${room}.json`;
};

export function listRooms() {
  return listJson('rooms').map((f) => readJson(f)).map((r) => ({ room: r.room, relay: r.relay, label: r.label, messages: r.messages.length }));
}

export function loadRoom(room) {
  return readJson(roomFile(room), null);
}

function merged(data, onDisk) {
  if (!onDisk) return data.messages;
  const ids = new Set(onDisk.messages.map(envelopeId));
  return [...onDisk.messages, ...data.messages.filter((m) => !ids.has(envelopeId(m)))];
}

export function saveRoom(data) {
  const file = roomFile(data.room);
  withLock(file, () => {
    data.messages = merged(data, readJson(file, null));
    writeJson(file, data);
  });
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
  const file = `journal/${name}.json`;
  return {
    get: () => readJson(file, {}),
    update: (fn) =>
      withLock(file, () => {
        const value = readJson(file, {});
        fn(value);
        writeJson(file, value);
        return value;
      }),
  };
}
