import relay from '../relay/worker.mjs';

export { Room } from '../relay/worker.mjs';

const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self'",
  "worker-src blob:",
  "font-src 'self'",
  "connect-src 'self' https://insight.testnet.networks.dash.org https://quorums.testnet.networks.dash.org https://*:1443",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const SECURITY = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), clipboard-read=()',
  'strict-transport-security': 'max-age=31536000',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/v1/')) {
      const response = new Response(...(await relay.fetch(request, env).then((r) => [r.body, r])));
      response.headers.set('x-content-type-options', 'nosniff');
      response.headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
      response.headers.set('cache-control', 'no-store');
      return response;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: SECURITY });
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    for (const [k, v] of Object.entries(SECURITY)) response.headers.set(k, v);
    const hashed = /-[A-Z0-9]{8}\.js$/.test(url.pathname);
    response.headers.set('cache-control', !response.ok ? 'no-store' : hashed ? 'public, max-age=31536000, immutable' : 'no-cache, no-transform');
    return response;
  },
};
