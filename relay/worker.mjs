import { DurableObject } from 'cloudflare:workers';
import { handle, handleRoom, json, parseRoute } from '../src/relay/core.mjs';

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, body TEXT NOT NULL)');
    try { this.sql.exec('ALTER TABLE messages ADD COLUMN sender TEXT'); } catch { /* column exists */ }
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  }

  async fetch(request) {
    const room = request.headers.get('x-dti-room');
    const sql = this.sql;
    const store = {
      async append(_room, id, body, from) {
        const existing = sql.exec('SELECT seq FROM messages WHERE id = ?', id).toArray();
        if (existing.length) return null;
        sql.exec('INSERT INTO messages (id, body, sender) VALUES (?, ?, ?)', id, body, from);
        return sql.exec('SELECT seq FROM messages WHERE id = ?', id).one().seq;
      },
      async list(_room, after, limit) {
        return sql.exec('SELECT seq, id, body FROM messages WHERE seq > ? ORDER BY seq LIMIT ?', after, limit).toArray();
      },
      async ids() {
        return sql.exec('SELECT id FROM messages ORDER BY seq').toArray().map((r) => r.id);
      },
      async count() {
        return sql.exec('SELECT COUNT(*) AS n FROM messages').one().n;
      },
      async countFrom(_room, from) {
        return sql.exec('SELECT COUNT(*) AS n FROM messages WHERE sender = ?', from).one().n;
      },
      async exists(_room, id) {
        return sql.exec('SELECT 1 FROM messages WHERE id = ?', id).toArray().length > 0;
      },
      async policy() {
        const row = sql.exec("SELECT v FROM meta WHERE k = 'policy'").toArray()[0];
        return row ? JSON.parse(row.v) : null;
      },
      async setPolicy(_room, policy) {
        sql.exec("INSERT INTO meta (k, v) VALUES ('policy', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(policy));
      },
    };
    return handleRoom(request, room, store);
  }
}

export default {
  async fetch(request, env) {
    try {
      const room = parseRoute(request.url);
      if (!room) return await handle(request, async () => null);
      const forwarded = new Request(request);
      forwarded.headers.set('x-dti-room', room);
      return await env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(forwarded);
    } catch (e) {
      return json(500, { error: String(e?.message ?? e) });
    }
  },
};
