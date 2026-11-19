import { envelopeId, verifyEnvelope } from './envelope.mjs';
import { validateConfig, ceremonyId, participantIndex, revealDigest, checkRevealShape, groupKeys, transcriptDigest, judgeComplaint, NETWORKS, SLOT_PATTERN } from './ceremony.mjs';
import { verify } from './bls.mjs';
import { fingerprint } from './derive.mjs';
import { digest, isHex, unhex, memo, sha256hex, getOwn } from './util.mjs';

const verifiedEnvelope = memo(verifyEnvelope, envelopeId);
const cachedShape = memo(checkRevealShape, (config, cid, reveal, index) => `${cid}|${index}|${revealDigest(reveal)}`);
const cachedGroupKeys = memo(groupKeys, (config, reveals) => digest({ config, reveals: Object.keys(reveals).sort().map((i) => revealDigest(reveals[i])) }), 200);
const cachedVerify = memo(verify, (sig, message, pk) => `${sig}|${pk}|${sha256hex(message)}`);

const ORDER = ['hello', 'config', 'accept', 'dkg-commit', 'dkg-reveal', 'dkg-complete', 'dkg-complaint', 'proposal', 'approve', 'reject', 'broadcast'];

export const requirementKey = (r) => `${r.cid}/${r.slot}`;
const dict = () => Object.create(null);
const has = (o, k) => Object.hasOwn(o, k);
const count = (o) => Object.keys(o).length;
const lookup = (o, k) => (typeof k === 'string' ? getOwn(o, k) : null);

function sortMessages(messages) {
  return [...messages].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

export function validProposalBody(b) {
  if (!b || typeof b !== 'object' || !NETWORKS.includes(b.network)) return false;
  if (!b.intent || typeof b.intent !== 'object' || typeof b.intent.type !== 'string') return false;
  if (!isHex(b.unsigned) || !isHex(b.signable) || !b.signable.length) return false;
  if (!Array.isArray(b.requirements) || !b.requirements.length || b.requirements.length > 16) return false;
  if (!b.requirements.every((r) => r && typeof r === 'object' && isHex(r.cid, 32) && typeof r.slot === 'string' && SLOT_PATTERN.test(r.slot))) return false;
  if (new Set(b.requirements.map(requirementKey)).size !== b.requirements.length) return false;
  if (b.derived !== undefined && (b.derived === null || typeof b.derived !== 'object' || Array.isArray(b.derived))) return false;
  return b.note === undefined || typeof b.note === 'string';
}

function newCeremony(cid, config, id) {
  return { cid, config, configMessage: id, accepts: dict(), raw: { commits: dict(), reveals: dict(), completes: dict() }, commits: dict(), reveals: dict(), revealDigests: dict(), completes: dict(), complaints: [], warnings: [], problems: [] };
}

const push = (map, key, value) => { (map[key] ??= []).push(value); };

export function reduce(messages, { room } = {}) {
  const byId = new Map();
  const invalid = [];
  for (const m of messages) {
    let id;
    try { id = envelopeId(m); } catch { invalid.push({ id: null, reason: 'not an envelope' }); continue; }
    if (byId.has(id)) continue;
    if (!verifiedEnvelope(m) || (room && m.room !== room)) { invalid.push({ id, reason: 'bad signature or wrong room' }); continue; }
    byId.set(id, { ...m, id });
  }
  const hellos = dict();
  const ceremonies = dict();
  const proposals = dict();
  const problems = [];

  for (const m of sortMessages(byId.values())) {
    const b = m.body && typeof m.body === 'object' ? m.body : {};
    const c = lookup(ceremonies, b.cid);
    const idx = c ? participantIndex(c.config, m.from) : null;
    try {
      switch (m.type) {
        case 'hello':
          if (typeof b.name === 'string' && isHex(b.transportPub, 32)) hellos[m.from] = { authPub: m.from, name: b.name.slice(0, 64), transportPub: b.transportPub, fingerprint: fingerprint(m.from, b.transportPub), at: m.at };
          break;
        case 'config': {
          const config = validateConfig(b.config);
          if (m.from !== config.organizer) throw new Error('config not sent by its organizer');
          if (config.room !== m.room) throw new Error('config is for another room');
          const cid = ceremonyId(config);
          if (!has(ceremonies, cid)) ceremonies[cid] = newCeremony(cid, config, m.id);
          break;
        }
        case 'accept':
          if (idx) c.accepts[idx] = m.id;
          break;
        case 'dkg-commit':
          if (idx && isHex(b.digest, 32)) push(c.raw.commits, idx, b.digest);
          break;
        case 'dkg-reveal':
          if (idx && b.reveal && typeof b.reveal === 'object') push(c.raw.reveals, idx, b.reveal);
          break;
        case 'dkg-complete':
          if (idx && typeof b.transcript === 'string' && b.keys && typeof b.keys === 'object') push(c.raw.completes, idx, b);
          break;
        case 'dkg-complaint':
          if (idx) c.complaints.push({ from: idx, against: b.against, slot: b.slot, reason: String(b.reason ?? '').slice(0, 300), evidence: b.evidence ?? null });
          break;
        case 'proposal':
          if (!validProposalBody(b)) throw new Error('malformed proposal');
          proposals[m.id] = { id: m.id, from: m.from, at: m.at, body: b, approvals: dict(), rejections: dict(), broadcasts: [] };
          break;
        case 'approve': {
          const p = lookup(proposals, b.proposalId);
          if (p && !has(p.approvals, m.from) && b.shares && typeof b.shares === 'object') p.approvals[m.from] = { id: m.id, at: m.at, shares: b.shares };
          break;
        }
        case 'reject': {
          const p = lookup(proposals, b.proposalId);
          if (p) p.rejections[m.from] = { id: m.id, at: m.at, reason: String(b.reason ?? '').slice(0, 500) };
          break;
        }
        case 'broadcast': {
          const p = lookup(proposals, b.proposalId);
          if (p && b.result && typeof b.result === 'object') p.broadcasts.push({ id: m.id, from: m.from, at: m.at, result: b.result });
          break;
        }
        default:
          break;
      }
    } catch (e) {
      problems.push({ id: m.id, type: m.type, from: m.from, reason: e.message });
    }
  }

  for (const c of Object.values(ceremonies)) {
    try {
      finishCeremony(c);
    } catch (e) {
      c.status = 'failed';
      c.result = null;
      c.problems.push({ reason: e.message });
    }
  }
  for (const p of Object.values(proposals)) {
    try {
      finishProposal(p, ceremonies);
    } catch (e) {
      p.status = 'invalid';
      p.error = e.message;
    }
  }
  return { hellos, ceremonies, proposals, invalid, problems, messageCount: byId.size };
}

function validReveals(c, index) {
  const commits = [...new Set(c.raw.commits[index] ?? [])];
  const out = [];
  for (const reveal of c.raw.reveals[index] ?? []) {
    const d = revealDigest(reveal);
    if (!commits.includes(d) || out.some((x) => x.digest === d)) continue;
    if (cachedShape(c.config, c.cid, reveal, index).length) continue;
    out.push({ reveal, digest: d });
  }
  return { commits, reveals: out };
}

function completionMatches(c, body, keys, transcript) {
  return body.transcript === transcript && c.config.keys.every(({ slot }) => body.keys?.[slot]?.groupPublicKey === keys[slot].groupPublicKey && body.keys?.[slot]?.publicSharesDigest === digest(keys[slot].publicShares));
}

function select(c, participants, per, chosen) {
  c.commits = dict();
  c.reveals = dict();
  c.revealDigests = dict();
  c.completes = dict();
  participants.forEach((i, k) => {
    if (per[i].commits.length) c.commits[i] = per[i].commits[0];
    const r = chosen?.[k] ?? per[i].reveals[0];
    if (r) { c.reveals[i] = r.reveal; c.revealDigests[i] = r.digest; }
    if ((c.raw.completes[i] ?? []).length) c.completes[i] = c.raw.completes[i][0];
  });
}

function agreedCompletion(c, participants, per) {
  const completesOf = (i) => c.raw.completes[i] ?? [];
  const listOf = (body) => (Array.isArray(body.reveals) && body.reveals.length === participants.length && body.reveals.every((d) => isHex(d, 32)) ? body.reveals.join(',') : null);
  const candidates = new Set(completesOf(participants[0]).map(listOf).filter(Boolean));
  for (const candidate of candidates) {
    const digests = candidate.split(',');
    if (!participants.every((i) => completesOf(i).some((body) => listOf(body) === candidate))) continue;
    const chosen = participants.map((i, k) => per[i].reveals.find((r) => r.digest === digests[k]));
    if (chosen.some((r) => !r)) continue;
    const transcript = transcriptDigest(c.cid, c.config, Object.fromEntries(participants.map((i, k) => [i, digests[k]])));
    let keys;
    try { keys = cachedGroupKeys(c.config, Object.fromEntries(participants.map((i, k) => [i, chosen[k].reveal]))); } catch { continue; }
    if (participants.every((i) => completesOf(i).some((body) => listOf(body) === candidate && completionMatches(c, body, keys, transcript)))) return { chosen, keys, transcript };
  }
  return null;
}

function finishCeremony(c) {
  const participants = c.config.participants.map((p) => p.index);
  const n = participants.length;
  c.result = null;
  const per = Object.fromEntries(participants.map((i) => [i, validReveals(c, i)]));
  const completesOf = (i) => c.raw.completes[i] ?? [];
  const equivocators = participants.filter((i) => per[i].commits.length > 1 || new Set(completesOf(i).map((x) => digest(x))).size > 1);
  const allCompleted = participants.every((i) => completesOf(i).length);
  const allRevealed = participants.every((i) => per[i].reveals.length);

  const agreed = allCompleted ? agreedCompletion(c, participants, per) : null;
  if (agreed) {
    select(c, participants, per, agreed.chosen);
    c.status = 'complete';
    c.result = { cid: c.cid, network: c.config.network, threshold: c.config.threshold, transcript: agreed.transcript, keys: Object.fromEntries(c.config.keys.map((k) => [k.slot, { ...k, ...agreed.keys[k.slot] }])) };
    if (equivocators.length) c.warnings.push({ reason: `conflicting messages after completion from participant(s) ${equivocators.join(', ')}` });
    if (c.complaints.length) c.warnings.push({ reason: `${c.complaints.length} complaint(s) posted after every member completed`, complaints: c.complaints });
    return;
  }

  select(c, participants, per, null);
  if (equivocators.length) {
    c.status = 'failed';
    c.problems.push({ reason: `participant(s) ${equivocators.join(', ')} sent conflicting commitments or completions` });
    return;
  }
  for (const i of participants) {
    if ((c.raw.reveals[i] ?? []).length && !per[i].reveals.length) c.problems.push({ index: i, reason: 'reveal does not match its commitment or is malformed' });
  }
  c.complaints = c.complaints.map((x) => ({ ...x, verdict: judgeComplaint(c.config, c.cid, x, per[x.against]?.reveals[0]?.reveal) }));
  for (const x of c.complaints.filter((y) => y.verdict === 'false')) c.warnings.push({ reason: `participant ${x.from} complained about ${x.against}, but the evidence shows the share was valid` });
  if (c.problems.length || c.complaints.some((x) => x.verdict !== 'false')) { c.status = 'failed'; return; }
  if (count(c.accepts) < n) { c.status = 'accepting'; return; }
  if (count(c.commits) < n) { c.status = 'committing'; return; }
  if (!allRevealed) { c.status = 'revealing'; return; }
  if (!allCompleted) { c.status = 'completing'; return; }
  c.status = 'failed';
  c.problems.push({ reason: 'the members\' completions do not agree on the keys or transcript' });
}

function finishProposal(p, ceremonies) {
  const b = p.body;
  p.requirements = [];
  p.status = 'invalid';
  const member = (authPub) => b.requirements.some((r) => has(ceremonies, r.cid) && participantIndex(ceremonies[r.cid].config, authPub));
  if (!member(p.from)) { p.error = 'proposer is not a member of any required ceremony'; return; }
  const message = unhex(b.signable);
  let ready = true;
  for (const r of b.requirements) {
    const c = getOwn(ceremonies, r.cid);
    const key = requirementKey(r);
    const entry = { cid: r.cid, slot: r.slot, key, threshold: c?.config.threshold ?? null, shares: {}, invalidShares: [] };
    p.requirements.push(entry);
    if (!c || c.status !== 'complete' || !has(c.result.keys, r.slot)) { entry.error = 'ceremony not complete or slot unknown'; ready = false; continue; }
    const publicShares = c.result.keys[r.slot].publicShares;
    for (const [authPub, approval] of Object.entries(p.approvals)) {
      const idx = participantIndex(c.config, authPub);
      const s = getOwn(approval.shares, key);
      if (!idx || !s) continue;
      if (s.index === idx && typeof s.share === 'string' && cachedVerify(s.share, message, publicShares[idx])) entry.shares[idx] = s.share;
      else entry.invalidShares.push(idx);
    }
    if (count(entry.shares) < c.config.threshold) ready = false;
  }
  const memberBroadcasts = p.broadcasts.filter((x) => member(x.from));
  const ok = ready && memberBroadcasts.find((x) => x.result.ok === true);
  p.status = ok ? 'executed' : ready ? 'ready' : 'collecting';
  if (!ok && memberBroadcasts.length) p.lastBroadcastError = memberBroadcasts.at(-1).result.error;
}
