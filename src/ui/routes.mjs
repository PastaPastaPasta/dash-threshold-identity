import { listRooms, loadRoom, exportBundle, importBundle } from '../store.mjs';
import { DEFAULT_KEYS } from '../ceremony.mjs';

export function routes(session) {
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
    'POST /api/fund/claim': async (b) => session.claimFunding(String(b.cid)),
    'POST /api/room/join': async (b) => session.joinRoom({ room: b.room, relay: b.relay || undefined, name: b.name, label: typeof b.label === 'string' ? b.label.slice(0, 80) : undefined }),
    'GET /api/room/export': async () => exportBundle(loadRoom(session.requireRoom().room)),
    'POST /api/room/import': async (b) => { const { data, added } = importBundle(b); session.data = data; return { room: data.room, added }; },
    'POST /api/ceremony/propose': async (b) => session.proposeCeremony({ network: b.network, threshold: Number(b.threshold), label: b.label, members: b.members, keys: b.keys ?? DEFAULT_KEYS }),
    'POST /api/ceremony/advance': async (b) => session.advanceCeremony(b.cid, { confirm: async () => Boolean(b.accept) }),
    'GET /api/network': async (b) => session.networkStatus(b.network ?? 'testnet'),
    'GET /api/funding': async (b) => session.fundingBalance(b.network ?? 'testnet'),
    'POST /api/identity/create': async (b) => session.proposeIdentityCreate({ cid: b.cid, duffs: Number(b.duffs), newLock: b.newLock === true, confirmMainnet: b.confirmMainnet === true }),
    'POST /api/identity/topup': async (b) => session.topUp({ identityId: b.identityId, duffs: Number(b.duffs), confirmMainnet: b.confirmMainnet === true }),
    'GET /api/identity': async (b) => session.showIdentity(b.identityId),
    'POST /api/propose': async (b) => session.prepare(b.kind, b.args ?? {}),
    'GET /api/review': async (b) => session.review(b.id),
    'POST /api/approve': async (b) => session.approve(b.id, { confirm: async () => true, acknowledgeKeys: b.acknowledgeKeys === true }),
    'POST /api/reject': async (b) => session.reject(b.id, b.reason ?? ''),
    'POST /api/execute': async (b) => session.execute(b.id),
  };
}
