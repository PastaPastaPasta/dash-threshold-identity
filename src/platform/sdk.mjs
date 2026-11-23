import * as evo from '@dashevo/evo-sdk';
import { sleep } from '../util.mjs';
import { sdkFor } from '../networks.mjs';

let ready;
export async function sdkModule() {
  ready ??= evo.ensureInitialized().then(() => evo);
  return ready;
}

export function protocolVersionOf(pv) {
  const v = pv?.version ?? pv?.protocolVersion;
  return typeof v === 'bigint' ? Number(v) : v;
}

export async function connect(network, { timeoutMs = 30000, attempts = 6 } = {}) {
  const m = await sdkModule();
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const sdk = sdkFor(m, network, { timeoutMs });
      await sdk.connect();
      await sdk.system.status();
      return sdk;
    } catch (e) {
      last = e;
      await sleep(4000);
    }
  }
  throw new Error(`could not connect to ${network}: ${errorText(last)}`);
}

export function errorText(e) {
  if (!e) return 'unknown error';
  const parts = [e.name, e.kind, e.code, e.message ?? String(e)].filter((x) => x !== undefined && x !== null && x !== '');
  return [...new Set(parts.map(String))].join(' | ').slice(0, 1500);
}

export async function retry(fn, attempts = 5, delayMs = 2500) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(delayMs);
    }
  }
  throw last;
}
