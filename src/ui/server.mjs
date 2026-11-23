import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { kdf } from '../derive.mjs';
import { hex, jsonReplacer } from '../util.mjs';
import { routes } from './routes.mjs';

const STATIC = path.join(path.dirname(new URL(import.meta.url).pathname), 'static');
const SHELL = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'web', 'vendor', 'dashhq');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2' };
const SHELL_FILES = new Set(['dashhq-tokens.css', 'dashhq-components.css', 'fonts/archivo-latin-var.woff2']);

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
      const shellFile = url.pathname.startsWith('/dashhq/') ? url.pathname.slice('/dashhq/'.length) : null;
      const file = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
      const full = shellFile !== null ? (SHELL_FILES.has(shellFile) ? path.join(SHELL, shellFile) : '/nonexistent') : path.join(STATIC, file);
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
