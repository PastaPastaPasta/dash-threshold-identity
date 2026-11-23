import { isNetwork, network as networkOf } from '../src/networks.mjs';

export const DEFAULT_NETWORK = 'testnet';

export const pageNetwork = (url) => {
  const id = new URL(url, 'https://x').searchParams.get('network') ?? DEFAULT_NETWORK;
  return isNetwork(id) ? id : DEFAULT_NETWORK;
};

function connectSources(id) {
  const n = networkOf(id);
  if (n.kind === 'local') return ['http://127.0.0.1:*', 'https://127.0.0.1:*', 'http://localhost:*', 'https://localhost:*'];
  const origin = (url) => new URL(url).origin;
  if (n.kind === 'mainnet') return [origin(n.insight), 'https://quorums.mainnet.networks.dash.org', 'https://*:443'];
  if (n.kind === 'testnet') return [origin(n.insight), 'https://quorums.testnet.networks.dash.org', 'https://*:1443'];
  return [origin(n.insight), origin(n.quorums), 'https://*:1443'];
}

export function securityFor(id = DEFAULT_NETWORK) {
  const csp = [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self'",
    'worker-src blob:',
    "font-src 'self'",
    `connect-src 'self' ${connectSources(id).join(' ')}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
  return {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), clipboard-read=()',
    'strict-transport-security': 'max-age=31536000',
  };
}

export const SECURITY = securityFor(DEFAULT_NETWORK);
