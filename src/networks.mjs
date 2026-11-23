import { assert } from './util.mjs';

const DEVNET = /^devnet-([a-z0-9][a-z0-9-]{0,30})$/;
const overrides = new Map();

export const isNetwork = (id) => id === 'mainnet' || id === 'testnet' || id === 'local' || DEVNET.test(String(id));

export function configureNetwork(id, settings) {
  assert(isNetwork(id), `unknown network ${id}`);
  overrides.set(id, { ...overrides.get(id), ...settings });
}

const env = (name) => globalThis.process?.env?.[name] || undefined;

export function network(id) {
  assert(isNetwork(id), `unknown network "${id}"; use mainnet, testnet, devnet-<name> or local`);
  const o = overrides.get(id) ?? {};
  const devnet = String(id).match(DEVNET)?.[1];
  const base = id === 'mainnet'
    ? { kind: 'mainnet', label: 'Mainnet', coin: 5, core: 'livenet', insight: 'https://insight.dash.org/insight-api', quorums: null }
    : id === 'testnet'
      ? { kind: 'testnet', label: 'Testnet', coin: 1, core: 'testnet', insight: 'https://insight.testnet.networks.dash.org/insight-api', quorums: null }
      : devnet
        ? { kind: 'devnet', label: `Devnet ${devnet}`, devnet, coin: 1, core: 'testnet', insight: `https://insight.${devnet}.networks.dash.org/insight-api`, quorums: `https://quorums.${devnet}.networks.dash.org` }
        : { kind: 'local', label: 'Local', coin: 1, core: 'regtest', insight: env('DTI_LOCAL_INSIGHT') ?? 'http://127.0.0.1:3001/insight-api', quorums: env('DTI_LOCAL_QUORUMS') ?? 'http://127.0.0.1:22444', addresses: env('DTI_LOCAL_DAPI')?.split(',') };
  const insight = id === 'local' ? o.insight ?? base.insight : env('DTI_INSIGHT_URL') ?? o.insight ?? base.insight;
  return { id, unit: base.kind === 'mainnet' ? 'DASH' : 'tDASH', ...base, ...o, insight };
}

export function sdkFor(evo, id, settings) {
  const n = network(id);
  const options = { settings, ...(n.quorums ? { quorumUrl: n.quorums } : {}), ...(n.addresses?.length ? { addresses: n.addresses } : {}) };
  if (n.kind === 'mainnet') return evo.EvoSDK.mainnetTrusted(options);
  if (n.kind === 'testnet') return evo.EvoSDK.testnetTrusted(options);
  if (n.kind === 'devnet') return evo.EvoSDK.devnetTrusted(n.devnet, options);
  return evo.EvoSDK.localTrusted(options);
}

const ROOM_PREFIX = { mainnet: 'm', testnet: 't', local: 'r' };

export function roomPrefix(id) {
  const n = network(id);
  return n.kind === 'devnet' ? `d${n.devnet}` : ROOM_PREFIX[n.kind];
}

export function roomNetwork(room) {
  const m = String(room).match(/^(m|t|r|d[a-z0-9][a-z0-9-]*)_[0-9a-f]{32}$/);
  if (!m) return null;
  if (m[1] === 'm') return 'mainnet';
  if (m[1] === 't') return 'testnet';
  if (m[1] === 'r') return 'local';
  return `devnet-${m[1].slice(1)}`;
}

export function roomOnNetwork(room, id) {
  const tag = roomNetwork(room);
  return tag === null ? id === 'testnet' : tag === id;
}
