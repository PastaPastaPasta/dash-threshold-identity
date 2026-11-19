import { verifyEnvelope, envelopeId } from '../envelope.mjs';
import { ROOM_PATTERN } from '../util.mjs';
export const MAX_MESSAGE_BYTES = 300 * 1024;
export const MAX_MESSAGES_PER_ROOM = 5000;
export const MAX_MESSAGES_PER_SENDER = 500;
const PAGE = 200;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });

export function parseRoute(url) {
  const m = new URL(url).pathname.match(/^\/v1\/rooms\/([^/]+)\/messages$/);
  if (!m) return null;
  const room = decodeURIComponent(m[1]);
  return ROOM_PATTERN.test(room) ? room : null;
}

export async function handleRoom(request, room, store) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  if (request.method === 'GET') {
    if (url.searchParams.get('idsOnly')) return json(200, { ids: await store.ids(room) });
    const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
    const rows = await store.list(room, after, PAGE + 1);
    const page = rows.slice(0, PAGE);
    return json(200, { messages: page.map((r) => ({ seq: r.seq, envelope: JSON.parse(r.body) })), next: page.length ? page.at(-1).seq : after, more: rows.length > PAGE });
  }
  if (request.method === 'POST') {
    const text = await request.text();
    if (text.length > MAX_MESSAGE_BYTES) return json(413, { error: 'message too large' });
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      return json(400, { error: 'body is not JSON' });
    }
    if (envelope?.room !== room) return json(400, { error: 'envelope is for another room' });
    if (!verifyEnvelope(envelope)) return json(400, { error: 'envelope signature does not verify' });
    if ((await store.count(room)) >= MAX_MESSAGES_PER_ROOM) return json(429, { error: 'room is full' });
    if ((await store.countFrom(room, envelope.from)) >= MAX_MESSAGES_PER_SENDER) return json(429, { error: 'too many messages from this key' });
    const id = envelopeId(envelope);
    const seq = await store.append(room, id, JSON.stringify(envelope), envelope.from);
    return json(200, { id, seq, duplicate: seq === null });
  }
  return json(405, { error: 'method not allowed' });
}

export async function handle(request, storeFor) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  if (url.pathname === '/' || url.pathname === '/v1/health') return json(200, { ok: true, service: 'dti-relay', version: 1 });
  const room = parseRoute(request.url);
  if (!room) return json(404, { error: 'not found' });
  return handleRoom(request, room, await storeFor(room));
}

export function memoryStore() {
  const rooms = new Map();
  const get = (room) => rooms.get(room) ?? rooms.set(room, { rows: [], ids: new Set() }).get(room);
  return {
    async append(room, id, body, from) {
      const r = get(room);
      if (r.ids.has(id)) return null;
      r.ids.add(id);
      const seq = r.rows.length + 1;
      r.rows.push({ seq, id, body, from });
      return seq;
    },
    async countFrom(room, from) {
      return get(room).rows.filter((x) => x.from === from).length;
    },
    async list(room, after, limit) {
      return get(room).rows.filter((x) => x.seq > after).slice(0, limit);
    },
    async ids(room) {
      return [...get(room).ids];
    },
    async count(room) {
      return get(room).rows.length;
    },
    rooms,
  };
}
