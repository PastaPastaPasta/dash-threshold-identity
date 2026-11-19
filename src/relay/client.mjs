import { envelopeId } from '../envelope.mjs';
import { addMessages, saveRoom } from '../store.mjs';

async function call(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`relay ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const base = (relay, room) => `${relay.replace(/\/$/, '')}/v1/rooms/${encodeURIComponent(room)}/messages`;

export async function pull(data) {
  let added = 0;
  data.cursors ??= {};
  for (;;) {
    const after = data.cursors[data.relay] ?? 0;
    const page = await call(`${base(data.relay, data.room)}?after=${after}`);
    added += addMessages(data, page.messages.map((x) => x.envelope));
    if (!Number.isSafeInteger(page.next) || page.next <= after) break;
    data.cursors[data.relay] = page.next;
    if (!page.more) break;
  }
  saveRoom(data);
  return added;
}

export async function push(data, envelopes) {
  for (const envelope of envelopes) {
    await call(base(data.relay, data.room), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) });
  }
  return envelopes.map(envelopeId);
}

export async function sync(data) {
  if (!data.relay) return { pulled: 0, pushed: 0 };
  const pulled = await pull(data);
  const page = await call(`${base(data.relay, data.room)}?after=0&idsOnly=1`);
  const remote = new Set(page.ids ?? []);
  const missing = data.messages.filter((m) => !remote.has(envelopeId(m)));
  await push(data, missing);
  return { pulled, pushed: missing.length };
}
