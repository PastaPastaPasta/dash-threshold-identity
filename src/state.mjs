import { envelopeId, verifyEnvelope } from './envelope.mjs';
import { validateConfig, ceremonyId, participantIndex, revealDigest, checkRevealShape, groupKeys, transcriptDigest } from './ceremony.mjs';
import { verify } from './bls.mjs';
import { fingerprint } from './derive.mjs';
import { digest, isHex, unhex, memo, sha256hex } from './util.mjs';

const verifiedEnvelope = memo((m) => verifyEnvelope(m), (m) => envelopeId(m));
const cachedShape = memo(checkRevealShape, (config, cid, reveal, index) => `${cid}|${index}|${revealDigest(reveal)}`);
const cachedGroupKeys = memo(groupKeys, (config, reveals) => digest({ config, reveals: Object.keys(reveals).sort().map((i) => revealDigest(reveals[i])) }), 200);
const cachedVerify = memo(verify, (sig, message, pk) => `${sig}|${pk}|${sha256hex(message)}`);

const ORDER = ['hello', 'config', 'accept', 'dkg-commit', 'dkg-reveal', 'dkg-complete', 'dkg-complaint', 'proposal', 'approve', 'reject', 'broadcast'];

export const requirementKey = (r) => `${r.cid}/${r.slot}`;

function sortMessages(messages) {
  return [...messages].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
}

function firstPer(map, key, value, onConflict) {
  if (!(key in map)) map[key] = value;
  else if (map[key].digest !== value.digest) onConflict(map[key], value);
}

export function reduce(messages, { room } = {}) {
  const byId = new Map();
  const invalid = [];
  for (const m of messages) {
    const id = envelopeId(m);
    if (byId.has(id)) continue;
    if (!verifiedEnvelope(m) || (room && m.room !== room)) { invalid.push({ id, reason: 'bad signature or wrong room' }); continue; }
    byId.set(id, { ...m, id });
  }
  const hellos = {};
  const ceremonies = {};
  const proposals = {};
  const problems = [];

  for (const m of sortMessages(byId.values())) {
    const b = m.body ?? {};
    try {
      switch (m.type) {
        case 'hello':
          if (typeof b.name === 'string' && isHex(b.transportPub, 32)) hellos[m.from] = { authPub: m.from, name: b.name.slice(0, 64), transportPub: b.transportPub, fingerprint: fingerprint(m.from, b.transportPub), at: m.at };
          break;
        case 'config': {
          const config = validateConfig(b.config);
          if (m.from !== config.organizer) throw new Error('config not sent by its organizer');
          const cid = ceremonyId(config);
          ceremonies[cid] ??= { cid, config, configMessage: m.id, accepts: {}, commits: {}, reveals: {}, revealDigests: {}, completes: {}, complaints: [], equivocations: [], problems: [] };
          break;
        }
        case 'accept': {
          const c = ceremonies[b.cid];
          const idx = c && participantIndex(c.config, m.from);
          if (idx) c.accepts[idx] = m.id;
          break;
        }
        case 'dkg-commit': {
          const c = ceremonies[b.cid];
          const idx = c && participantIndex(c.config, m.from);
          if (idx && isHex(b.digest, 32)) firstPer(c.commits, idx, { digest: b.digest, id: m.id }, () => c.equivocations.push({ index: idx, phase: 'commit' }));
          break;
        }
        case 'dkg-reveal': {
          const c = ceremonies[b.cid];
          const idx = c && participantIndex(c.config, m.from);
          if (!idx || !b.reveal) break;
          const d = revealDigest(b.reveal);
          if (c.commits[idx]?.digest !== d) { c.problems.push({ index: idx, reason: 'reveal does not match its commitment' }); break; }
          const shape = cachedShape(c.config, c.cid, b.reveal, idx);
          if (shape.length) { c.problems.push({ index: idx, reason: shape.join('; ') }); break; }
          c.reveals[idx] = b.reveal;
          c.revealDigests[idx] = d;
          break;
        }
        case 'dkg-complete': {
          const c = ceremonies[b.cid];
          const idx = c && participantIndex(c.config, m.from);
          if (idx) firstPer(c.completes, idx, { digest: digest(b), body: b, id: m.id }, () => c.equivocations.push({ index: idx, phase: 'complete' }));
          break;
        }
        case 'dkg-complaint': {
          const c = ceremonies[b.cid];
          const idx = c && participantIndex(c.config, m.from);
          if (idx) c.complaints.push({ from: idx, against: b.against, slot: b.slot, reason: String(b.reason).slice(0, 300) });
          break;
        }
        case 'proposal':
          proposals[m.id] = { id: m.id, from: m.from, at: m.at, body: b, approvals: {}, rejections: {}, broadcasts: [] };
          break;
        case 'approve': {
          const p = proposals[b.proposalId];
          if (p && !(m.from in p.approvals)) p.approvals[m.from] = { id: m.id, at: m.at, shares: b.shares ?? {} };
          break;
        }
        case 'reject': {
          const p = proposals[b.proposalId];
          if (p) p.rejections[m.from] = { id: m.id, at: m.at, reason: String(b.reason ?? '').slice(0, 500) };
          break;
        }
        case 'broadcast': {
          const p = proposals[b.proposalId];
          if (p) p.broadcasts.push({ id: m.id, from: m.from, at: m.at, ...b });
          break;
        }
        default:
          break;
      }
    } catch (e) {
      problems.push({ id: m.id, type: m.type, from: m.from, reason: e.message });
    }
  }

  for (const c of Object.values(ceremonies)) finishCeremony(c);
  for (const p of Object.values(proposals)) finishProposal(p, ceremonies);
  return { hellos, ceremonies, proposals, invalid, problems, messageCount: byId.size };
}

function finishCeremony(c) {
  const n = c.config.participants.length;
  const count = (o) => Object.keys(o).length;
  c.result = null;
  if (c.equivocations.length || c.complaints.length || c.problems.length) {
    c.status = 'failed';
    return;
  }
  if (count(c.accepts) < n) { c.status = 'accepting'; return; }
  if (count(c.commits) < n) { c.status = 'committing'; return; }
  if (count(c.reveals) < n) { c.status = 'revealing'; return; }
  let keys;
  try {
    keys = cachedGroupKeys(c.config, c.reveals);
  } catch (e) {
    c.status = 'failed';
    c.problems.push({ reason: e.message });
    return;
  }
  const transcript = transcriptDigest(c.cid, c.config, c.revealDigests);
  c.computed = { keys, transcript };
  if (count(c.completes) < n) { c.status = 'completing'; return; }
  const mismatch = Object.entries(c.completes).filter(([, v]) => {
    const body = v.body;
    if (body.transcript !== transcript) return true;
    return c.config.keys.some(({ slot }) => body.keys?.[slot]?.groupPublicKey !== keys[slot].groupPublicKey || body.keys?.[slot]?.publicSharesDigest !== digest(keys[slot].publicShares));
  });
  if (mismatch.length) {
    c.status = 'failed';
    c.problems.push({ reason: `completion mismatch from participant(s) ${mismatch.map(([i]) => i).join(', ')}` });
    return;
  }
  c.status = 'complete';
  c.result = { cid: c.cid, network: c.config.network, threshold: c.config.threshold, transcript, keys: Object.fromEntries(c.config.keys.map((k) => [k.slot, { ...k, ...keys[k.slot] }])) };
}

function finishProposal(p, ceremonies) {
  const b = p.body;
  p.requirements = [];
  p.status = 'invalid';
  if (!Array.isArray(b.requirements) || !b.requirements.length || !isHex(b.signable)) { p.error = 'malformed proposal'; return; }
  const proposerIsMember = b.requirements.some((r) => ceremonies[r.cid] && participantIndex(ceremonies[r.cid].config, p.from));
  if (!proposerIsMember) { p.error = 'proposer is not a member of any required ceremony'; return; }
  const message = unhex(b.signable);
  let ready = true;
  for (const r of b.requirements) {
    const c = ceremonies[r.cid];
    const key = requirementKey(r);
    const entry = { ...r, key, threshold: c?.config.threshold ?? null, shares: {}, invalidShares: [] };
    p.requirements.push(entry);
    if (!c || c.status !== 'complete' || !c.result.keys[r.slot]) { entry.error = 'ceremony not complete or slot unknown'; ready = false; continue; }
    const publicShares = c.result.keys[r.slot].publicShares;
    for (const [authPub, approval] of Object.entries(p.approvals)) {
      const idx = participantIndex(c.config, authPub);
      const s = approval.shares[key];
      if (!idx || !s) continue;
      if (s.index === idx && cachedVerify(s.share, message, publicShares[idx])) entry.shares[idx] = s.share;
      else entry.invalidShares.push(idx);
    }
    if (Object.keys(entry.shares).length < c.config.threshold) ready = false;
  }
  const ok = p.broadcasts.find((x) => x.result?.ok);
  p.status = ok ? 'executed' : ready ? 'ready' : 'collecting';
  if (!ok && p.broadcasts.length) p.lastBroadcastError = p.broadcasts.at(-1).result?.error;
}
