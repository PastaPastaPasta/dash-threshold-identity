import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { kdf } from '../derive.mjs';
import { hex, jsonReplacer } from '../util.mjs';
import { listRooms, loadRoom, exportBundle, importBundle } from '../store.mjs';
import { DEFAULT_KEYS } from '../ceremony.mjs';

const STATIC = path.join(path.dirname(new URL(import.meta.url).pathname), 'static');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2 * 1024 * 1024) throw new Error('request too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function routes(session) {
  return {
    'GET /api/status': async () => (session.data ? { ...session.status(), rooms: listRooms() } : { me: session.whoami(), rooms: listRooms() }),
    'POST /api/sync': async () => session.sync(),
    'POST /api/room/select': async (b) => {
      if (b.room) {
        const r = loadRoom(b.room);
        if (!r) throw new Error(`unknown room ${b.room}`);
        session.data = r;
      }
      return session.status();
    },
    'POST /api/room/create': async (b) => session.createRoom({ label: b.label, relay: b.relay || undefined, name: b.name }),
    'POST /api/room/join': async (b) => session.joinRoom({ room: b.room, relay: b.relay || undefined, name: b.name }),
    'GET /api/room/export': async () => exportBundle(loadRoom(session.requireRoom().room)),
    'POST /api/room/import': async (b) => { const { data, added } = importBundle(b); session.data = data; return { room: data.room, added }; },
    'POST /api/ceremony/propose': async (b) => session.proposeCeremony({ network: b.network, threshold: Number(b.threshold), label: b.label, members: b.members, keys: b.keys ?? DEFAULT_KEYS }),
    'POST /api/ceremony/advance': async (b) => session.advanceCeremony(b.cid, { confirm: async () => Boolean(b.accept) }),
    'GET /api/funding': async (b) => session.fundingBalance(b.network ?? 'testnet'),
    'POST /api/identity/create': async (b) => session.proposeIdentityCreate({ cid: b.cid, duffs: Number(b.duffs), confirmMainnet: b.confirmMainnet === true }),
    'POST /api/identity/topup': async (b) => session.topUp({ identityId: b.identityId, duffs: Number(b.duffs), confirmMainnet: b.confirmMainnet === true }),
    'GET /api/identity': async (b) => session.showIdentity(b.identityId),
    'POST /api/propose': async (b) => session.prepare(b.kind, b.args ?? {}),
    'GET /api/review': async (b) => session.review(b.id),
    'POST /api/approve': async (b) => session.approve(b.id, { confirm: async () => true, acknowledgeKeys: b.acknowledgeKeys === true }),
    'POST /api/reject': async (b) => session.reject(b.id, b.reason ?? ''),
    'POST /api/execute': async (b) => session.execute(b.id),
  };
}

export function serveUi(session, { port = 8770, host = '127.0.0.1' } = {}) {
  const token = hex(kdf(session.seed, 'ui/session-token', [String(process.pid), String(Date.now())], 24));
  const table = routes(session);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  let queue = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'" });
      res.end(type === 'application/json' ? JSON.stringify(body, jsonReplacer) : body);
    };
    if (!allowedHosts.has(req.headers.host ?? '')) return send(403, { error: 'bad host' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!url.pathname.startsWith('/api/')) {
      const file = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
      const full = path.join(STATIC, file);
      if (!fs.existsSync(full)) return send(404, 'not found', 'text/plain');
      return send(200, fs.readFileSync(full), TYPES[path.extname(full)] ?? 'application/octet-stream');
    }
    if (req.headers['x-dti-token'] !== token) return send(401, { error: 'missing or wrong session token; open the URL printed by `dti ui`' });
    const handler = table[`${req.method} ${url.pathname}`];
    if (!handler) return send(404, { error: 'unknown endpoint' });
    const run = async () => {
      const body = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody(req);
      return handler(body);
    };
    const readOnly = req.method === 'GET' && url.pathname === '/api/status';
    const job = readOnly ? run() : queue.then(run, run);
    if (!readOnly) queue = job.catch(() => {});
    try {
      send(200, await job);
    } catch (e) {
      send(400, { error: e.message });
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(`http://${host}:${port}/#token=${token}`)));
}
