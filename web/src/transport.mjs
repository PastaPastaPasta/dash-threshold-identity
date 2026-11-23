import { routes } from '../../src/ui/routes.mjs';
import { jsonReplacer } from '../../src/util.mjs';
import { network as networkOf } from '../../src/networks.mjs';

export const platform = { hosted: true, network: 'testnet', networks: ['testnet'], relayField: false, readOnly: false, invite: null, inviteUrl: (room, label) => `${location.origin}/?network=${encodeURIComponent(platform.network)}#room=${room}${label ? `&name=${encodeURIComponent(label)}` : ''}` };

let table = null;
let queue = Promise.resolve();

export function attach(session) {
  const n = networkOf(session.network);
  Object.assign(platform, { network: n.id, networks: [n.id], readOnly: session.readOnly, unit: n.unit, label: n.label });
  const base = routes(session);
  const pinned = (route, fix) => async (b) => base[route]({ ...b, ...fix });
  table = {
    'GET /api/status': base['GET /api/status'],
    'POST /api/sync': base['POST /api/sync'],
    'POST /api/room/select': async (b) => { session.checkRoom(b.room); return base['POST /api/room/select'](b); },
    'POST /api/room/create': pinned('POST /api/room/create', { relay: session.relay }),
    'POST /api/room/join': pinned('POST /api/room/join', { relay: session.relay }),
    'GET /api/room/export': base['GET /api/room/export'],
    'POST /api/room/import': async (b) => { session.checkRoom(b?.room); return base['POST /api/room/import'](b); },
    'POST /api/ceremony/propose': pinned('POST /api/ceremony/propose', { network: session.network }),
    'POST /api/ceremony/advance': base['POST /api/ceremony/advance'],
    'GET /api/funding': pinned('GET /api/funding', { network: session.network }),
    'GET /api/network': pinned('GET /api/network', { network: session.network }),
    'POST /api/identity/create': base['POST /api/identity/create'],
    'POST /api/identity/topup': base['POST /api/identity/topup'],
    'GET /api/identity': base['GET /api/identity'],
    'POST /api/propose': base['POST /api/propose'],
    'GET /api/review': base['GET /api/review'],
    'POST /api/approve': base['POST /api/approve'],
    'POST /api/reject': base['POST /api/reject'],
    'POST /api/execute': base['POST /api/execute'],
  };
}

export async function api(method, path, body) {
  const handler = table?.[`${method} ${path}`];
  if (!handler) throw new Error(table ? 'unknown action' : 'unlock with your seed phrase first');
  const run = async () => JSON.parse(JSON.stringify(await handler(body ?? {}), jsonReplacer));
  if (method === 'GET' && path === '/api/status') return run();
  const job = queue.then(run, run);
  queue = job.catch(() => {});
  return job;
}
