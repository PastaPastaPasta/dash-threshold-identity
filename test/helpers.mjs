import { seedFromMnemonic, participantKeys } from '../src/derive.mjs';
import { reduce } from '../src/state.mjs';
import { hello, proposeCeremony, nextCeremonyStep } from '../src/participant.mjs';

export const MNEMONICS = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
  'ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic',
  'gravity machine north sort system female filter attitude volume fold club stay feature office ecology stable narrow fog',
];

export function people(count = 5, passphrase = 'TREZOR') {
  return MNEMONICS.slice(0, count).map((m, i) => {
    const seed = seedFromMnemonic(m, passphrase);
    return { name: `p${i + 1}`, seed, keys: participantKeys(seed) };
  });
}

export function advance(ps, room, messages, cid, rounds = 10) {
  let state = reduce(messages);
  for (let round = 0; round < rounds; round++) {
    const c = state.ceremonies[cid];
    if (c.status === 'complete' || c.status === 'failed') break;
    for (const p of ps) messages.push(...nextCeremonyStep(p.seed, p.keys, room, state, cid).envelopes);
    state = reduce(messages);
  }
  return state;
}

export function runCeremony(ps, { room = 'test-room', threshold = 3, network = 'testnet', label = 'test group', keys, messages = [], createdAt = '2026-11-19T00:00:00.000Z' } = {}) {
  for (const p of ps) messages.push(hello(p.keys, room, p.name));
  const { cid, envelope } = proposeCeremony(ps[0].keys, room, reduce(messages), { network, label, threshold, members: ps.map((p) => p.keys.authPub), keys, createdAt });
  messages.push(envelope);
  const state = advance(ps, room, messages, cid);
  return { cid, state, messages };
}
