import { DurableObject } from 'cloudflare:workers';
import { handle, handleRoom, json, parseRoute, admit, frontDoor, windowLimiter, CLIENT_HEADER } from '../src/relay/core.mjs';

export class Limits extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.limiter = windowLimiter();
  }

  allow(kind, client) {
    return this.limiter.allow(kind, client);
  }
}

const durableLimiter = (env) => ({
  allow: (kind, client) => env.LIMITS.get(env.LIMITS.idFromName(client)).allow(kind, client),
});

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, body TEXT NOT NULL)');
    try { this.sql.exec('ALTER TABLE messages ADD COLUMN sender TEXT'); } catch { /* column exists */ }
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS hello_slots (k TEXT PRIMARY KEY, n INTEGER NOT NULL)');
  }

  async fetch(request) {
    const room = request.headers.get('x-dti-room');
    const sql = this.sql;
    if (!sql.exec("SELECT 1 FROM meta WHERE k = 'policy'").toArray().length && sql.exec('SELECT COUNT(*) AS n FROM messages').one().n > 0) {
      let policy = null;
      for (const row of sql.exec('SELECT body FROM messages ORDER BY seq').toArray()) {
        const verdict = admit(policy, JSON.parse(row.body));
        if (verdict.ok) policy = verdict.next;
      }
      sql.exec("INSERT INTO meta (k, v) VALUES ('policy', ?)", JSON.stringify(policy));
    }
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
      async hellosFrom(_room, slot) {
        return sql.exec('SELECT n FROM hello_slots WHERE k = ?', slot).toArray()[0]?.n ?? 0;
      },
      async addHello(_room, slot) {
        sql.exec('INSERT INTO hello_slots (k, n) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1', slot);
      },
    };
    return handleRoom(request, room, store, durableLimiter(this.env));
  }
}

export default {
  async fetch(request, env) {
    try {
      const limiter = durableLimiter(env);
      const forwarded = new Request(request);
      forwarded.headers.set(CLIENT_HEADER, request.headers.get('cf-connecting-ip') ?? '');
      const room = parseRoute(request.url);
      if (!room) return await handle(forwarded, async () => null, limiter);
      const refused = await frontDoor(forwarded, limiter);
      if (refused) return refused;
      forwarded.headers.set('x-dti-room', room);
      return await env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(forwarded);
    } catch (e) {
      return json(500, { error: String(e?.message ?? e) });
    }
  },
};
