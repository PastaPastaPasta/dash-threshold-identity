import { verifyEnvelope, envelopeId } from '../envelope.mjs';
import { ROOM_PATTERN, isHex, sha256hex } from '../util.mjs';

export const MAX_MESSAGE_BYTES = 300 * 1024;
export const MAX_MESSAGES_PER_ROOM = 5000;
export const MAX_MESSAGES_PER_SENDER = 500;
export const MAX_HELLOS = 256;
export const MAX_HELLOS_PER_CLIENT = 16;
export const CLIENT_HEADER = 'x-dti-client';
export const RATE_LIMITS = { reads: { limit: 600, periodMs: 60000 }, posts: { limit: 60, periodMs: 60000 }, rooms: { limit: 10, periodMs: 60000 } };
const PAGE = 200;

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS, ...headers } });

const slowDown = (what) => json(429, { error: `too many ${what} from this address; try again in a minute` }, { 'retry-after': '60' });

export function clientBucket(address) {
  const a = String(address ?? '').trim().toLowerCase().replace(/%.*$/, '');
  if (!a) return 'unknown';
  const mapped = a.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  if (!a.includes(':')) return a;
  const [head, tail] = a.split('::');
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}::/64`;
}

export function windowLimiter(limits = RATE_LIMITS, now = Date.now) {
  const windows = new Map();
  return {
    async allow(kind, client) {
      const { limit, periodMs } = limits[kind];
      const start = Math.floor(now() / periodMs) * periodMs;
      const key = `${kind}|${client}`;
      const w = windows.get(key);
      if (!w || w.start !== start) {
        if (windows.size > 50000) for (const [k, v] of windows) if (v.start !== start) windows.delete(k);
        windows.set(key, { start, n: 1 });
        return true;
      }
      w.n++;
      return w.n <= limit;
    },
  };
}

export async function frontDoor(request, limiter) {
  const client = request.headers.get(CLIENT_HEADER);
  if (!limiter || !client || request.method === 'OPTIONS') return null;
  const kind = request.method === 'GET' || request.method === 'HEAD' ? 'reads' : 'posts';
  return (await limiter.allow(kind, client)) ? null : slowDown('requests');
}

export function parseRoute(url) {
  const m = new URL(url).pathname.match(/^\/v1\/rooms\/([^/]+)\/messages$/);
  if (!m) return null;
  const room = decodeURIComponent(m[1]);
  return ROOM_PATTERN.test(room) ? room : null;
}

export function admit(policy, envelope) {
  const p = policy ?? { owner: null, pinned: [], hellos: 0 };
  if (envelope.type === 'hello') {
    if (!p.owner) return { ok: true, next: { owner: envelope.from, pinned: [envelope.from], hellos: 1 } };
    if (p.hellos >= MAX_HELLOS) return { ok: false, reason: 'this room has had too many joins' };
    return { ok: true, next: { ...p, hellos: p.hellos + 1 } };
  }
  if (!p.owner) return { ok: false, reason: 'the room creator must post the first message' };
  if (!p.pinned.includes(envelope.from)) return { ok: false, reason: 'only the room creator and members named in a ceremony may post this' };
  if (envelope.type !== 'config') return { ok: true, next: p };
  const listed = envelope.body?.config?.participants;
  const named = (Array.isArray(listed) ? listed : []).map((x) => x?.authPub).filter((k) => isHex(k, 32));
  return { ok: true, next: { ...p, pinned: [...new Set([...p.pinned, ...named])] } };
}

const queues = new Map();

function serially(key, fn) {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => queues.get(key) === tail && queues.delete(key));
  return run;
}

export async function handleRoom(request, room, store, limiter = null) {
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
    return serially(room, async () => {
      const id = envelopeId(envelope);
      if (await store.exists(room, id)) return json(200, { id, seq: null, duplicate: true });
      if ((await store.count(room)) >= MAX_MESSAGES_PER_ROOM) return json(429, { error: 'room is full' });
      if ((await store.countFrom(room, envelope.from)) >= MAX_MESSAGES_PER_SENDER) return json(429, { error: 'too many messages from this key' });
      const client = request.headers.get(CLIENT_HEADER);
      const slot = client && envelope.type === 'hello' ? sha256hex(`dti-relay|${room}|${client}`).slice(0, 32) : null;
      if (slot) {
        if (!(await store.count(room)) && limiter && !(await limiter.allow('rooms', client))) return slowDown('new rooms');
        if ((await store.hellosFrom(room, slot)) >= MAX_HELLOS_PER_CLIENT) return json(403, { error: `this network has already joined ${MAX_HELLOS_PER_CLIENT} members to this room; join from another network or start a new room` });
      }
      const verdict = admit(await store.policy(room), envelope);
      if (!verdict.ok) return json(403, { error: verdict.reason });
      const seq = await store.append(room, id, JSON.stringify(envelope), envelope.from);
      if (slot) await store.addHello(room, slot);
      await store.setPolicy(room, verdict.next);
      return json(200, { id, seq, duplicate: false });
    });
  }
  return json(405, { error: 'method not allowed' });
}

export async function handle(request, storeFor, limiter = null) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const refused = await frontDoor(request, limiter);
  if (refused) return refused;
  const url = new URL(request.url);
  if (url.pathname === '/' || url.pathname === '/v1/health') return json(200, { ok: true, service: 'dti-relay', version: 1 });
  const room = parseRoute(request.url);
  if (!room) return json(404, { error: 'not found' });
  return handleRoom(request, room, await storeFor(room), limiter);
}

export function memoryStore() {
  const rooms = new Map();
  const get = (room) => rooms.get(room) ?? rooms.set(room, { rows: [], ids: new Set(), policy: null }).get(room);
  const hellos = new Map();
  return {
    async hellosFrom(room, slot) {
      return hellos.get(`${room}|${slot}`) ?? 0;
    },
    async addHello(room, slot) {
      hellos.set(`${room}|${slot}`, (hellos.get(`${room}|${slot}`) ?? 0) + 1);
    },
    async exists(room, id) {
      return get(room).ids.has(id);
    },
    async policy(room) {
      return get(room).policy;
    },
    async setPolicy(room, policy) {
      get(room).policy = policy;
    },
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
