import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { handle, memoryStore, admit, windowLimiter, clientBucket, CLIENT_HEADER, MAX_MESSAGE_BYTES } from './core.mjs';

export function fileStore(dir) {
  const mem = memoryStore();
  fs.mkdirSync(dir, { recursive: true });
  const file = (room) => path.join(dir, `${room}.jsonl`);
  const slotFile = (room) => path.join(dir, `${room}.slots.json`);
  const slots = new Map();
  const loadSlots = (room) => {
    if (!slots.has(room)) {
      let counts = {};
      try {
        counts = JSON.parse(fs.readFileSync(slotFile(room), 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') console.error(`ignoring unreadable ${slotFile(room)}: ${e.message}`);
      }
      slots.set(room, counts);
    }
    return slots.get(room);
  };
  const loaded = new Set();
  const load = (room) => {
    if (loaded.has(room)) return;
    let text;
    try {
      text = fs.readFileSync(file(room), 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      loaded.add(room);
      return;
    }
    const r = { rows: [], ids: new Set(), policy: null };
    const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
    if (complete.length !== text.length) fs.truncateSync(file(room), Buffer.byteLength(complete));
    for (const line of complete.split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      r.rows.push(row);
      r.ids.add(row.id);
      const verdict = admit(r.policy, JSON.parse(row.body));
      if (verdict.ok) r.policy = verdict.next;
    }
    mem.rooms.set(room, r);
    loaded.add(room);
  };
  return {
    async append(room, id, body, from) {
      load(room);
      if (!mem.rooms.has(room)) mem.rooms.set(room, { rows: [], ids: new Set(), policy: null });
      const r = mem.rooms.get(room);
      if (r.ids.has(id)) return null;
      const seq = r.rows.length + 1;
      const size = fs.existsSync(file(room)) ? fs.statSync(file(room)).size : 0;
      try {
        fs.appendFileSync(file(room), `${JSON.stringify({ seq, id, body, from })}\n`);
      } catch (e) {
        if (fs.existsSync(file(room))) fs.truncateSync(file(room), size);
        throw e;
      }
      r.ids.add(id);
      r.rows.push({ seq, id, body, from });
      return seq;
    },
    async countFrom(room, from) { load(room); return mem.countFrom(room, from); },
    async hellosFrom(room, slot) {
      return loadSlots(room)[slot] ?? 0;
    },
    async addHello(room, slot) {
      const counts = { ...loadSlots(room), [slot]: (loadSlots(room)[slot] ?? 0) + 1 };
      fs.writeFileSync(`${slotFile(room)}.tmp`, JSON.stringify(counts));
      fs.renameSync(`${slotFile(room)}.tmp`, slotFile(room));
      slots.set(room, counts);
    },
    async exists(room, id) { load(room); return mem.exists(room, id); },
    async policy(room) { load(room); return mem.policy(room); },
    async setPolicy(room, policy) { load(room); return mem.setPolicy(room, policy); },
    async list(room, after, limit) { load(room); return mem.list(room, after, limit); },
    async ids(room) { load(room); return mem.ids(room); },
    async count(room) { load(room); return mem.count(room); },
  };
}

export async function toRequest(req, origin, limit = MAX_MESSAGE_BYTES + 1024, client = null) {
  const chunks = [];
  let size = 0;
  await new Promise((resolve, reject) => {
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
  if (size > limit) throw Object.assign(new Error('message too large'), { status: 413 });
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers(Object.entries(req.headers).filter(([, v]) => typeof v === 'string'));
  headers.delete(CLIENT_HEADER);
  if (client) headers.set(CLIENT_HEADER, client);
  return new Request(new URL(req.url, origin), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
}

export async function sendResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

export function serveRelay({ port = 8787, host = '127.0.0.1', dir = null, limits = false, limiter = limits ? windowLimiter() : null } = {}) {
  const store = dir ? fileStore(dir) : memoryStore();
  const server = http.createServer(async (req, res) => {
    try {
      await sendResponse(res, await handle(await toRequest(req, `http://${host}:${port}`, undefined, limiter ? clientBucket(req.socket.remoteAddress) : null), async () => store, limiter));
    } catch (e) {
      res.writeHead(e.status ?? 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
