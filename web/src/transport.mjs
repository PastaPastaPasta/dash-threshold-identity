import { routes } from '../../src/ui/routes.mjs';
import { jsonReplacer } from '../../src/util.mjs';
import { NETWORK } from './session.mjs';

let table = null;
let queue = Promise.resolve();

export function attach(session) {
  const base = routes(session);
  const pinned = (route, fix) => async (b) => base[route]({ ...b, ...fix });
  table = {
    'GET /api/status': base['GET /api/status'],
    'POST /api/sync': base['POST /api/sync'],
    'POST /api/room/select': base['POST /api/room/select'],
    'POST /api/room/create': pinned('POST /api/room/create', { relay: session.relay }),
    'POST /api/room/join': pinned('POST /api/room/join', { relay: session.relay }),
    'GET /api/room/export': base['GET /api/room/export'],
    'POST /api/room/import': base['POST /api/room/import'],
    'POST /api/ceremony/propose': pinned('POST /api/ceremony/propose', { network: NETWORK }),
    'POST /api/ceremony/advance': base['POST /api/ceremony/advance'],
    'GET /api/funding': pinned('GET /api/funding', { network: NETWORK }),
    'POST /api/identity/create': pinned('POST /api/identity/create', { confirmMainnet: false }),
    'POST /api/identity/topup': pinned('POST /api/identity/topup', { confirmMainnet: false }),
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
