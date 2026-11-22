import relay from '../relay/worker.mjs';

export { Room, Limits } from '../relay/worker.mjs';
import { SECURITY } from './headers.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/v1/')) {
      const upstream = await relay.fetch(request, env);
      const response = new Response(upstream.body, upstream);
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
