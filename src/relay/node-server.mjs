import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { handle, memoryStore, admit } from './core.mjs';

export function fileStore(dir) {
  const mem = memoryStore();
  fs.mkdirSync(dir, { recursive: true });
  const file = (room) => path.join(dir, `${room}.jsonl`);
  const loaded = new Set();
  const load = (room) => {
    if (loaded.has(room)) return;
    loaded.add(room);
    if (!fs.existsSync(file(room))) return;
    const r = { rows: [], ids: new Set(), policy: null };
    for (const line of fs.readFileSync(file(room), 'utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      r.rows.push(row);
      r.ids.add(row.id);
      const verdict = admit(r.policy, JSON.parse(row.body));
      if (verdict.ok) r.policy = verdict.next;
    }
    mem.rooms.set(room, r);
  };
  return {
    async append(room, id, body, from) {
      load(room);
      const seq = await mem.append(room, id, body, from);
      if (seq !== null) fs.appendFileSync(file(room), `${JSON.stringify({ seq, id, body, from })}\n`);
      return seq;
    },
    async countFrom(room, from) { load(room); return mem.countFrom(room, from); },
    async exists(room, id) { load(room); return mem.exists(room, id); },
    async policy(room) { load(room); return mem.policy(room); },
    async setPolicy(room, policy) { load(room); return mem.setPolicy(room, policy); },
    async list(room, after, limit) { load(room); return mem.list(room, after, limit); },
    async ids(room) { load(room); return mem.ids(room); },
    async count(room) { load(room); return mem.count(room); },
  };
}

export async function toRequest(req, origin) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(new URL(req.url, origin), { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
}

export async function sendResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

export function serveRelay({ port = 8787, host = '127.0.0.1', dir = null } = {}) {
  const store = dir ? fileStore(dir) : memoryStore();
  const server = http.createServer(async (req, res) => {
    try {
      await sendResponse(res, await handle(await toRequest(req, `http://${host}:${port}`), async () => store));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
