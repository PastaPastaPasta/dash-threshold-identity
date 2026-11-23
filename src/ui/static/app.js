import { api, platform } from './transport.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const friendly = (s) => { const t = String(s ?? '').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
const short = (s, n = 10) => (s && s.length > n + 2 ? `${s.slice(0, n)}…` : s ?? '');
const app = $('#app');
const dialog = $('#dialog');

const CREDITS_PER_DASH = 100000000000n;
const DUFFS_PER_DASH = 100000000;
const STEPS = [
  { id: 'members', title: 'Members' },
  { id: 'keys', title: 'Group keys' },
  { id: 'identity', title: 'Identity' },
  { id: 'proposals', title: 'Proposals' },
];
const PHASES = [
  ['accepted', 'accept the ceremony'],
  ['committed', 'make their key parts'],
  ['revealed', 'share their key parts'],
  ['completed', 'check the result'],
];
const KINDS = {
  'credit-transfer': { title: 'Send credits', desc: 'Move credits to another identity.', slot: 'transfer' },
  'credit-withdrawal': { title: 'Withdraw to Core', desc: 'Turn credits back into DASH at a Core address.', slot: 'transfer' },
  document: { title: 'Write a document', desc: 'Create, replace or delete a document in a data contract.', slot: 'high' },
  'contract-create': { title: 'Register a data contract', desc: 'Publish a new contract owned by the group.', slot: 'critical' },
  'contract-update': { title: 'Update a data contract', desc: "Change one of the group's contracts.", slot: 'critical' },
  'identity-update': { title: 'Change keys', desc: 'Add keys from another key ceremony or disable old ones.', slot: 'master' },
};
const SLOT_NAMES = { master: 'master key', critical: 'critical key', high: 'document key', transfer: 'transfer key' };

let state = null;
let view = null;
let busy = null;
let lastHtml = '';
let kind = 'credit-transfer';
let funding = null;
let picking = false;
let netStatus = null;
let idInfo = null;
let idLoading = false;
const verified = new Set();

const toast = $('#toast');
function say(message, tone = 'info') {
  toast.className = `toast toast--${tone}`;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(say.t);
  if (tone !== 'busy') say.t = setTimeout(() => { toast.hidden = true; }, tone === 'bad' ? 14000 : 4000);
}

async function act(label, fn, { pending, done } = {}) {
  if (busy) return undefined;
  busy = label;
  say(pending ?? `${label}…`, 'busy');
  render();
  try {
    const out = await fn();
    say(done ?? `${label}: done`, 'good');
    await refresh();
    return out;
  } catch (e) {
    say(`${label} failed: ${e.message}`, 'bad');
    return undefined;
  } finally {
    busy = null;
    render();
  }
}

const dashOfCredits = (credits) => {
  const c = BigInt(credits ?? 0);
  const whole = c / CREDITS_PER_DASH;
  const frac = (c % CREDITS_PER_DASH).toString().padStart(11, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac.slice(0, 8)}` : `${whole}`;
};
const dashOfDuffs = (duffs) => (Number(duffs) / DUFFS_PER_DASH).toLocaleString('en-US', { maximumFractionDigits: 8 });
const unit = (network) => (network === 'mainnet' ? 'DASH' : 'tDASH');
const readOnly = () => Boolean(platform.readOnly);
const READ_ONLY = 'Mainnet is read only in this build. You can open groups, compare fingerprints and check balances; making keys, signing and funding are turned off until they have been reviewed.';
const readOnlyNote = () => `<div class="dh-notice dh-notice--info readonly"><p>${READ_ONLY}</p></div>`;
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
};

const members = () => state?.members ?? [];
const myself = () => members().find((m) => m.me) ?? null;
const ceremonies = () => state?.ceremonies ?? [];
const ceremony = () => {
  const list = ceremonies();
  return list.filter((c) => c.status === 'complete').at(-1) ?? list.filter((c) => c.status !== 'failed').at(-1) ?? list.at(-1) ?? null;
};
const ceremonyOf = (key) => ceremonies().find((c) => c.cid === key.split('/')[0]) ?? null;
const identity = () => (state?.identities ?? []).at(-1) ?? null;
const proposals = () => state?.proposals ?? [];
const identityProposal = () => proposals().filter((p) => p.type === 'identity-create' && p.status !== 'invalid').at(-1) ?? null;
const canSign = (p) => p.status === 'collecting' && !p.approvedByMe && p.requirements.some((r) => ceremonyOf(r.key)?.myIndex);
const groupName = () => {
  const room = (state?.rooms ?? []).find((r) => r.room === state.room);
  if (room?.label) return room.label;
  const c = ceremony();
  if (c) return c.label.replace(/\s+keys\b.*$/i, '') || c.label;
  const creator = members()[0];
  return creator ? `${creator.name}'s group` : 'Your group';
};

function stepStatus() {
  const c = ceremony();
  const id = identity();
  const ip = identityProposal();
  const s = {
    members: { done: Boolean(c), note: `${members().length} ${members().length === 1 ? 'member' : 'members'}` },
    keys: { done: c?.status === 'complete', note: c ? (c.status === 'complete' ? `${c.threshold} of ${c.participants.length} needed to sign` : c.status === 'failed' ? 'failed; start again' : 'in progress') : 'not started' },
    identity: { done: Boolean(id), note: id ? short(id.identityId, 12) : ip ? (ip.status === 'ready' ? 'ready to create' : 'collecting signatures') : 'not funded' },
    proposals: { done: false, note: '' },
  };
  const open = proposals().filter((p) => p.type !== 'identity-create' && ['collecting', 'ready'].includes(p.status));
  const mine = open.filter(canSign).length;
  s.proposals.note = !id ? 'after the identity exists' : mine ? `${mine} ${mine === 1 ? 'needs' : 'need'} your signature` : open.length ? `${open.length} open` : 'none open';
  return s;
}

function currentStep(s) {
  if (!ceremony()) return 'members';
  if (!s.keys.done) return 'keys';
  if (!s.identity.done) return 'identity';
  return 'proposals';
}

function seats(people, { threshold, filled = () => false, label = () => '', done = false, refused: refusedRule = false } = {}) {
  return `<ol class="quorum" aria-label="${esc(threshold ? `${threshold} of ${people.length} needed` : 'Members')}">
    ${people.map((p, i) => `<li class="seat${filled(p) ? ' seat--on' : ''}${p.me ? ' seat--me' : ''}">
      <span class="seat__disc" aria-hidden="true">${esc((p.name ?? '?').slice(0, 1).toUpperCase())}</span>
      <span class="seat__name">${esc(p.name)}${p.me ? ' <span class="seat__you">you</span>' : ''}</span>
      <span class="seat__state">${esc(label(p, i))}</span>
    </li>`).join('')}
  </ol>${threshold ? quorumRule(people.filter(filled).length, threshold, { done, refused: refusedRule }) : ''}`;
}

function quorumRule(n, t, { done = false, refused: no = false } = {}) {
  if (no) return `<p class="quorum__rule"><span class="quorum__count">${n} signed</span>, ${t} needed. Platform refused it; see below.</p>`;
  if (done) return `<p class="quorum__rule"><span class="quorum__count">${n} signed</span>. Done on Platform.</p>`;
  return `<p class="quorum__rule"><span class="quorum__count">${n} signed</span>, ${t} needed.${n >= t ? ' Enough to go ahead.' : ` ${t - n} more to go.`}</p>`;
}

function waitingOn(c) {
  for (const [field, what] of PHASES) {
    const missing = c.participants.filter((p) => !p[field]);
    if (missing.length) return { field, what, missing };
  }
  return null;
}

const names = (list) => {
  const n = list.map((p) => (p.index === ceremony()?.myIndex || p.me ? 'you' : p.name));
  return n.length <= 2 ? n.join(' and ') : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`;
};

function inviteText() {
  if (!state?.room) return '';
  return platform.inviteUrl ? platform.inviteUrl(state.room, groupName()) : `room ${state.room}${state.relay ? ` on relay ${state.relay}` : ''}`;
}

/* ---------------------------------------------------------------- views */

function startView() {
  const invited = platform.invite;
  const rooms = state?.rooms ?? [];
  return `<section class="start">
    <div class="start__intro">
      <h1 class="start__title">${invited ? `Join ${platform.inviteLabel ? `"${esc(platform.inviteLabel)}"` : 'your group'}` : 'Start or join a group'}</h1>
      <p class="lede">A group is the people who will hold the identity together. One member starts it and invites the others with a link.</p>
    </div>
    <div class="start__paths${invited ? ' start__paths--invited' : ''}">
      <form class="panel panel--path" id="form-join-room" data-form="join">
        <h2 class="panel__title">${invited ? 'You were invited' : 'Join with an invite'}</h2>
        ${invited ? `<p>Group <code>${esc(short(invited, 12))}</code>. Choose the name the others will see.</p><input type="hidden" name="room" value="${esc(invited)}">` : `<div class="dh-field"><label class="dh-field__label" for="join-room">Invite link or group id</label><input class="dh-input dh-input--mono" id="join-room" name="room" autocomplete="off" spellcheck="false" required></div>`}
        <div class="dh-field"><label class="dh-field__label" for="join-name">Your name in the group</label><input class="dh-input" id="join-name" name="name" autocomplete="off" required></div>
        ${platform.relayField ? `<div class="dh-field"><label class="dh-field__label" for="join-relay">Relay URL <span class="dh-field__optional">optional</span></label><input class="dh-input" id="join-relay" name="relay" autocomplete="off"></div>` : ''}
        <button class="dh-btn ${invited ? 'dh-btn--primary' : ''}">Join group</button>
      </form>
      <form class="panel panel--path" id="form-create-room" data-form="create">
        <h2 class="panel__title">Start a new group</h2>
        <div class="dh-field"><label class="dh-field__label" for="create-label">Group name</label><input class="dh-input" id="create-label" name="label" placeholder="Example foundation" autocomplete="off" required></div>
        <div class="dh-field"><label class="dh-field__label" for="create-name">Your name in the group</label><input class="dh-input" id="create-name" name="name" autocomplete="off" required></div>
        ${platform.relayField ? `<div class="dh-field"><label class="dh-field__label" for="create-relay">Relay URL <span class="dh-field__optional">optional; without one, pass bundles around</span></label><input class="dh-input" id="create-relay" name="relay" autocomplete="off"></div>` : ''}
        <button class="dh-btn ${invited ? '' : 'dh-btn--primary'}">Start group</button>
      </form>
    </div>
    ${rooms.length ? `<p class="start__resume">Or open a group from this session: ${rooms.map((r) => `<button class="dh-btn dh-btn--link" data-action="open-room" data-room="${esc(r.room)}">${esc(r.label ?? short(r.room, 8))}</button>`).join(' ')}</p>` : ''}
    <p class="start__resume"><label class="dh-btn dh-btn--link file">Import a group bundle<input type="file" id="import-start" accept="application/json"></label></p>
  </section>`;
}

function rail(s, active) {
  const current = currentStep(s);
  return `<nav class="rail" aria-label="Steps">
    <ol>
      ${STEPS.map((step, i) => {
        const st = s[step.id];
        const state_ = st.done ? 'done' : step.id === current ? 'now' : 'todo';
        return `<li class="rail__step rail__step--${state_}"${step.id === active ? ' aria-current="step"' : ''}>
          <button type="button" data-action="view" data-view="${step.id}">
            <span class="rail__mark" aria-hidden="true">${st.done ? '✓' : i + 1}</span>
            <span class="rail__text"><span class="rail__title">${esc(step.title)}</span><span class="rail__note">${esc(st.note)}</span></span>
          </button>
        </li>`;
      }).join('')}
    </ol>
  </nav>`;
}

function header() {
  const c = ceremony();
  const meta = [`${members().length} ${members().length === 1 ? 'member' : 'members'}`];
  if (c?.status === 'complete') meta.push(`${c.threshold} of ${c.participants.length} sign`);
  if (idInfo && identity()?.identityId === idInfo.identityId) meta.push(`balance ${dashOfCredits(idInfo.balance)} ${platform.unit ?? unit(identity()?.network ?? ceremony()?.network)}`);
  meta.push(platform.hosted ? platform.label : c?.network ?? '');
  return `<header class="group">
    <div class="group__text">
      <h1 class="group__name">${esc(groupName())}</h1>
      <p class="group__meta">${meta.filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join('')}</p>
    </div>
    <div class="group__actions">
      ${c?.status === 'complete' || members().length < 2 ? '' : '<button class="dh-btn" data-action="copy-invite">Copy invite link</button>'}
      <details class="more" id="more-menu">
        <summary class="dh-btn dh-btn--quiet" aria-label="More actions">More</summary>
        <div class="more__menu" role="menu">
          ${c?.status === 'complete' ? '<button role="menuitem" data-action="copy-invite">Copy invite link</button>' : ''}
          <button role="menuitem" data-action="sync">Check for updates now</button>
          <button role="menuitem" data-action="export">Export group bundle</button>
          <label role="menuitem" class="file">Import group bundle<input type="file" id="import" accept="application/json"></label>
          <button role="menuitem" data-action="copy-room">Copy group id</button>
          <button role="menuitem" data-action="leave">Open or start another group</button>
        </div>
      </details>
    </div>
  </header>`;
}

function membersView() {
  const list = members();
  const me = myself();
  const alone = list.length < 2;
  const allChecked = list.filter((m) => !m.me).every((m) => verified.has(m.authPub));
  return `<section class="step">
    <h2 class="step__title">Members</h2>
    <p class="step__lede">Everyone who will hold the identity joins this group from their own device, with their own seed phrase.</p>
    ${alone ? `<div class="empty">
      <p class="empty__title">You're the only member so far</p>
      <p>Send the invite link to the others. They appear here as soon as they join.</p>
      <div class="dh-actions"><button class="dh-btn dh-btn--primary" data-action="copy-invite">Copy invite link</button></div>
      <p class="invite"><code>${esc(inviteText())}</code></p>
      ${platform.hosted && /\/\/(127\.0\.0\.1|localhost)[:/]/.test(inviteText()) ? '<p class="note">This page runs on this computer, so the link only works here. Others can join with the group id instead.</p>' : ''}
    </div>` : `<p>Each member has a fingerprint made from their keys. Read yours aloud on a call, and check everyone else's against what they read. Mark each one when it matches; a wrong fingerprint means someone else joined under that name.</p>
    <ul class="people">
      ${list.map((m) => `<li class="person${m.me ? ' person--me' : ''}">
        <span class="seat__disc" aria-hidden="true">${esc(m.name.slice(0, 1).toUpperCase())}</span>
        <span class="person__name">${esc(m.name)}${m.me ? ' <span class="seat__you">you</span>' : ''}</span>
        <code class="fp">${esc(m.fingerprint)}</code>
        ${m.me ? '<span class="person__check">Read this one aloud</span>' : `<label class="dh-check person__check"><input type="checkbox" data-action="verify" data-key="${esc(m.authPub)}"${verified.has(m.authPub) ? ' checked' : ''}> Matches</label>`}
      </li>`).join('')}
    </ul>
    <div class="dh-actions">
      ${!ceremony() && !readOnly() ? `<button class="dh-btn${allChecked ? ' dh-btn--primary' : ''}" data-action="view" data-view="keys">${allChecked ? 'Continue to group keys' : 'Continue without checking'}</button>` : ''}
      <button class="dh-btn" data-action="copy-invite">Copy invite link</button>
    </div>
    <p class="note">If a fingerprint doesn't match, stop here. Ask that member to read it again; if it still differs, someone else may have joined under their name, so start a new group without them.</p>
    ${!allChecked ? `<p class="note" id="fp-note"><strong>${list.filter((m) => !m.me && !verified.has(m.authPub)).length} of ${list.length - 1} fingerprints left to check.</strong> Accepting the key ceremony asks for every one of them.</p>` : ''}`}
    ${me ? '' : '<p class="note">You have not joined this group yet.</p>'}
    ${platform.hosted ? networkPanel() : ''}
  </section>`;
}

function networkPanel() {
  const s = netStatus;
  const f = funding;
  return `<details class="dh-disclosure netcheck" id="netcheck"${readOnly() ? ' open' : ''}><summary><span>Network check</span></summary>
    <p>${s ? `${esc(platform.label)} Platform is reachable: block ${esc(Number(s.height).toLocaleString('en-US'))}, protocol ${esc(s.protocolVersion)}, Drive ${esc(s.drive)}.` : 'Connect to the network to check it is reachable and see your funding address.'}</p>
    ${f ? `<p>Your funding address <code class="wrap">${esc(f.address)}</code> holds <strong>${esc(dashOfDuffs(f.duffs))} ${esc(platform.unit)}</strong>.</p>` : ''}
    <div class="dh-actions"><button class="dh-btn" data-action="netcheck">Check the network and my balance</button></div>
  </details>`;
}

function keysView() {
  const c = ceremony();
  const list = members();
  if (!c || c.status === 'failed') {
    const t = Math.max(2, Math.min(list.length, Math.ceil((list.length + 1) / 2)));
    return `<section class="step">
      <h2 class="step__title">Make the group keys</h2>
      <p class="step__lede">The members create the identity's keys together. Afterwards each member holds a share, and a set number of them must sign for anything to happen. Nobody, at any point, holds a whole key.</p>
      ${c?.status === 'failed' ? `<div class="dh-notice dh-notice--error"><p>The last key ceremony failed: ${esc(c.problems.map((p) => p.reason ?? JSON.stringify(p)).join('; ') || 'a member reported a problem')}. Start a new one; members who acted honestly lose nothing.</p></div>` : ''}
      ${readOnly() ? readOnlyNote() : list.length < 2 ? `<div class="empty"><p class="empty__title">Waiting for members</p><p>A key ceremony needs at least two members. Invite the others first.</p><div class="dh-actions"><button class="dh-btn dh-btn--primary" data-action="copy-invite">Copy invite link</button></div></div>` : `
      <form class="panel" id="form-ceremony" data-form="ceremony">
        <fieldset class="dh-fieldset"><legend class="dh-field__label">Who holds a share</legend>
          <div class="picks">${list.map((m) => `<label class="dh-check"><input type="checkbox" name="member" value="${esc(m.authPub)}" checked> ${esc(m.name)}</label>`).join('')}</div>
        </fieldset>
        <div class="dh-field">
          <label class="dh-field__label" for="ceremony-threshold">Signatures needed</label>
          <div class="threshold"><input class="dh-input" id="ceremony-threshold" name="threshold" type="number" min="2" max="${list.length}" value="${t}" required><span>of the members above</span></div>
          <p class="dh-field__help">With ${t} of ${list.length}, any ${t} members can act together, and the identity survives losing ${list.length - t} seed ${list.length - t === 1 ? 'phrase' : 'phrases'}.</p>
        </div>
        <div class="dh-field"><label class="dh-field__label" for="ceremony-label">What the keys are for</label><input class="dh-input" id="ceremony-label" name="label" value="${esc(`${groupName()} keys`)}" required></div>
        ${platform.networks.length > 1 ? `<div class="dh-field"><label class="dh-field__label" for="ceremony-network">Network</label><select class="dh-select" id="ceremony-network" name="network">${platform.networks.map((n) => `<option>${esc(n)}</option>`).join('')}</select></div>` : ''}
        <details class="dh-disclosure"><summary><span>Key layout (advanced)</span></summary><p class="dh-field__help">Leave empty for the standard four keys: master, critical, document and transfer.</p><textarea class="dh-textarea dh-input--mono" id="ceremony-keys" name="keys" rows="6"></textarea></details>
        <div class="dh-actions"><button class="dh-btn dh-btn--primary">Propose the key ceremony</button></div>
        <p class="note">Every member then confirms the fingerprints and accepts. The rest runs by itself while their pages are open.</p>
      </form>`}
    </section>`;
  }
  const me = c.participants.find((p) => p.index === c.myIndex);
  const wait = waitingOn(c);
  const done = c.status === 'complete';
  const label = (p) => (p.completed ? 'done' : p.revealed ? 'checking' : p.committed ? 'sharing' : p.accepted ? 'accepted' : 'not yet');
  return `<section class="step">
    <h2 class="step__title">${done ? 'The group keys are ready' : 'Making the group keys'}</h2>
    <p class="step__lede">${esc(c.label)}. ${c.threshold} of ${c.participants.length} members must sign anything the identity does.</p>
    ${seats(c.participants.map((p) => ({ ...p, me: p.index === c.myIndex })), { filled: (p) => (done ? true : p.accepted), label })}
    ${done ? `<div class="dh-actions"><button class="dh-btn dh-btn--primary" data-action="view" data-view="identity">Continue to the identity</button></div>
      <details class="dh-disclosure"><summary><span>Group public keys</span></summary>${keyTable(Object.entries(c.keys ?? {}).map(([slot, k]) => ({ slot, ...k })))}</details>`
      : me && !me.accepted ? (readOnly() ? readOnlyNote() : acceptPanel(c))
      : `<div class="waiting" role="status"><span class="dh-spin" aria-hidden="true"></span><p>${wait ? `Waiting for ${esc(names(wait.missing))} to ${esc(wait.what)}.` : 'Finishing.'} ${me ? 'Your part runs by itself while this page is open.' : ''}</p></div>`}
    ${c.warnings?.length ? `<details class="dh-disclosure"><summary><span>${c.warnings.length} warnings</span></summary><pre>${esc(JSON.stringify(c.warnings, null, 1))}</pre></details>` : ''}
    <p class="note">Ceremony <code>${esc(short(c.cid, 12))}</code></p>
  </section>`;
}

function acceptPanel(c) {
  const others = c.participants.filter((p) => p.index !== c.myIndex);
  return `<form class="panel" id="form-accept" data-form="accept" data-cid="${esc(c.cid)}">
    <h3 class="panel__title">Confirm the members, then accept</h3>
    <p>Check each fingerprint against what its owner reads to you. Accept only if all of them match.</p>
    <ul class="people people--compact">
      ${others.map((p) => {
        const m = members().find((x) => x.fingerprint === p.fingerprint);
        return `<li class="person"><span class="person__name">${esc(p.name)}</span><code class="fp">${esc(p.fingerprint)}</code><label class="dh-check person__check"><input type="checkbox" id="fp-${p.index}" name="fp" value="${esc(m?.authPub ?? p.fingerprint)}" required${verified.has(m?.authPub ?? p.fingerprint) ? ' checked' : ''}> Matches</label></li>`;
      }).join('')}
    </ul>
    <div class="dh-actions"><button class="dh-btn dh-btn--primary">Accept and make my key share</button></div>
  </form>`;
}

function keyTable(keys) {
  return `<table class="dh-table dh-table--compact keys"><thead><tr><th scope="col">Key</th><th scope="col">Used for</th><th scope="col">Public key</th></tr></thead><tbody>
    ${keys.map((k) => `<tr${k.disabled ? ' class="is-off"' : ''}><td>${esc(SLOT_NAMES[k.slot] ?? k.slot)} <span class="muted">#${Number(k.keyId)}</span>${k.disabled ? ' <span class="dh-badge dh-badge--bad">disabled</span>' : ''}</td><td>${esc(friendly(k.purpose))}, ${esc(String(k.securityLevel).toLowerCase())}</td><td><code>${esc(short(k.groupPublicKey ?? k.publicKey, 18))}</code></td></tr>`).join('')}
  </tbody></table>`;
}

function identityView() {
  const c = ceremony();
  const id = identity();
  if (id) {
    return `<section class="step">
      <h2 class="step__title">The group's identity</h2>
      <p class="step__lede">This identity exists on Platform. Its keys are the group keys, so it acts only when enough members sign.</p>
      <dl class="dh-kv dh-kv--ruled">
        <dt>Balance</dt><dd>${idInfo?.identityId === id.identityId ? `${creditsLine(idInfo.balance)} <span class="dh-badge dh-badge--good">proved</span>` : '<span class="dh-loading"><span class="dh-spin" aria-hidden="true"></span>Reading from Platform…</span>'}</dd>
        <dt>Identity</dt><dd><code class="wrap">${esc(id.identityId)}</code> <button class="dh-btn dh-btn--sm" data-action="copy" data-text="${esc(id.identityId)}">Copy</button></dd>
        <dt>Network</dt><dd>${esc(id.network)}</dd>
      </dl>
      ${keyTable(Object.values(id.keys))}
      <div class="dh-actions"><button class="dh-btn dh-btn--primary" data-action="view" data-view="proposals">Go to proposals</button><button class="dh-btn" data-action="read-identity" data-id="${esc(id.identityId)}">Check balance and keys on Platform</button></div>
    </section>`;
  }
  if (!c || c.status !== 'complete') {
    return `<section class="step"><h2 class="step__title">Create the identity</h2>
      <div class="empty"><p class="empty__title">The group keys come first</p><p>Once the key ceremony is complete, one member funds the identity and the group signs its creation.</p><div class="dh-actions"><button class="dh-btn" data-action="view" data-view="keys">Go to group keys</button></div></div></section>`;
  }
  const ip = identityProposal();
  if (ip) return `<section class="step"><h2 class="step__title">Create the identity</h2>
    <p class="step__lede">${esc(ip.proposer)} funded the identity. The group now signs its keys, and ${esc(ip.proposer)} creates it.</p>
    ${proposalCard(ip, { focus: true })}</section>`;
  const net = c.network;
  const f = funding;
  const enough = f && f.duffs >= 0.5 * DUFFS_PER_DASH + 20000;
  return `<section class="step">
    <h2 class="step__title">Fund and create the identity</h2>
    <p class="step__lede">One member pays for the identity by locking ${unit(net)} from their own address. It becomes the identity's starting balance. Any member can do this; the others then sign.</p>
    <div class="panel">
      <h3 class="panel__title">Your funding address</h3>
      ${f ? `<p class="address"><code class="wrap">${esc(f.address)}</code> <button class="dh-btn dh-btn--sm" data-action="copy" data-text="${esc(f.address)}">Copy</button></p>
        <p>Balance: <strong>${esc(dashOfDuffs(f.duffs))} ${unit(net)}</strong> <button class="dh-btn dh-btn--sm dh-btn--quiet" data-action="funding">Refresh</button></p>`
        : `<div class="dh-loading" role="status"><span class="dh-spin" aria-hidden="true"></span>Reading your address and balance…</div>`}
      ${net === 'testnet' ? '<p><a class="dh-link" href="https://faucet.dashhq.org/?network=testnet" target="_blank" rel="noopener noreferrer">Get testnet DASH from the faucet ↗</a> Paste your address there, then refresh.</p>' : ''}
    </div>
    <form class="panel" id="form-identity-create" data-form="identity">
      <div class="dh-field"><label class="dh-field__label" for="fund-amount">Amount to lock</label>
        <div class="dh-input-group"><input class="dh-input" id="fund-amount" name="amount" inputmode="decimal" value="0.5" required><span class="dh-input-group__addon">${unit(net)}</span></div>
        <p class="dh-field__help">Creating the identity costs about 0.001 ${unit(net)}; the rest stays as its balance. A small network fee is added.</p></div>
      ${readOnly() ? readOnlyNote() : `<div class="dh-actions"><button class="dh-btn dh-btn--primary"${f && !enough ? ' disabled aria-describedby="fund-why"' : ''}>Lock and propose the identity</button>${f && !enough ? `<span class="dh-actions__note" id="fund-why">Waiting for at least 0.5002 ${unit(net)} at your address.</span>` : ''}</div>`}
      <p class="note">This takes one to three minutes while the network confirms the lock. Keep this page open.</p>
    </form>
  </section>`;
}

function proposalCard(p, { focus = false } = {}) {
  const sign = canSign(p) && !readOnly();
  const mine = myself();
  const reqs = p.requirements.map((r) => {
    const c = ceremonyOf(r.key);
    const people = c ? c.participants.map((x) => ({ ...x, me: x.index === c.myIndex })) : [];
    return { r, c, people };
  });
  const first = reqs[0];
  const failed = refused(p);
  const execute = !readOnly() && p.status === 'ready' && !replaced(p) && (p.type !== 'identity-create' || p.proposer === mine?.name);
  return `<article class="proposal proposal--${esc(p.status)}${focus ? ' proposal--focus' : ''}">
    <header class="proposal__head">
      <h3 class="proposal__title">${esc(titleOf(p.type))}</h3>
      ${statusBadge(p)}
    </header>
    <p class="proposal__meta">Proposed by ${esc(p.proposer)} ${esc(ago(p.at))}${p.note ? `. ${esc(p.note)}` : ''}</p>
    ${facts(p.intent) || `<ul class="proposal__summary">${p.summary.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`}
    ${first ? seats(first.people, { threshold: first.r.threshold, done: p.status === 'executed', refused: p.status === 'ready' && refused(p), filled: (x) => first.r.approvals.includes(x.index), label: (x) => (first.r.approvals.includes(x.index) ? 'signed' : '') }) : ''}
    ${reqs.length > 1 && p.status !== 'executed' ? `<p class="note">Needs signatures for ${reqs.length} keys; the count above is for the ${esc(SLOT_NAMES[first.r.slot] ?? first.r.slot)}.</p>` : ''}
    ${p.rejections.map((r) => `<p class="dh-notice dh-notice--warn">${esc(r.by)} rejected it: ${esc(r.reason || 'no reason given')}</p>`).join('')}
    ${replaced(p) ? '<p class="note">Another proposal used the same nonce and went through, so this one can no longer be sent.</p>' : p.status === 'executed' ? '' : p.broadcasts.filter((b) => !b.ok).slice(-1).map((b) => `<div class="dh-notice dh-notice--error"><p>${esc(b.by)} tried to send it, and Platform refused: ${esc(plainError(b.error))}</p><details><summary>What Platform said</summary><pre>${esc(b.error)}</pre></details></div>`).join('')}
    <div class="dh-actions">
      ${sign ? `<button class="dh-btn dh-btn--primary" data-action="review" data-id="${esc(p.id)}" data-sign="1">Review and sign</button>` : ''}
      ${execute ? `<button class="dh-btn${failed ? '' : ' dh-btn--primary'}" data-action="execute" data-id="${esc(p.id)}">${failed ? 'Try sending again' : p.type === 'identity-create' ? 'Create the identity' : 'Broadcast to Platform'}</button>` : ''}
      ${!sign ? `<button class="dh-btn" data-action="review" data-id="${esc(p.id)}">View details</button>` : ''}
      ${p.status === 'ready' && !execute ? `<p class="note">Enough members signed. ${esc(p.proposer)} creates the identity, since they funded it.</p>` : ''}
    </div>
  </article>`;
}

const creditsLine = (c) => `${dashOfCredits(c)} ${platform.unit ?? unit(identity()?.network ?? ceremony()?.network)} <span class="muted">(${esc(BigInt(c ?? 0).toLocaleString('en-US'))} credits)</span>`;
const idLabel = (id) => {
  const ours = (state?.identities ?? []).some((x) => x.identityId === id);
  return `<code class="wrap">${esc(id)}</code> ${ours ? '<span class="dh-badge dh-badge--info">this group</span>' : '<span class="dh-badge dh-badge--outline">not one of this group\'s identities</span>'}`;
};

function facts(intent, { full = false } = {}) {
  if (!intent || typeof intent !== 'object') return '';
  const rows = [];
  const key = intent.signer ? `${esc(SLOT_NAMES[intent.signer.slot] ?? intent.signer.slot)} #${Number(intent.signer.keyId)}` : null;
  switch (intent.type) {
    case 'credit-transfer':
      rows.push(['Amount', creditsLine(intent.amount)], ['From', idLabel(intent.identityId)], ['To', idLabel(intent.recipientId)]);
      break;
    case 'credit-withdrawal':
      rows.push(['Amount', creditsLine(intent.amount)], ['From', idLabel(intent.identityId)], ['To Core address', `<code class="wrap">${esc(intent.outputAddress)}</code>`], ['Core fee', `${esc(intent.coreFeePerByte)} duff per byte`]);
      break;
    case 'document':
      rows.push(['Change', `${esc(intent.document?.action)} a <strong>${esc(intent.document?.documentType)}</strong> document`], ['Contract', `<code class="wrap">${esc(intent.contractId)}</code>`]);
      if (intent.document?.id) rows.push(['Document', `<code class="wrap">${esc(intent.document.id)}</code>`]);
      if (full && intent.document?.properties) rows.push(['Fields', `<pre>${esc(JSON.stringify(intent.document.properties, null, 2))}</pre>`]);
      break;
    case 'contract-create':
    case 'contract-update':
      rows.push(['Owner', idLabel(intent.ownerId)]);
      if (intent.contractId) rows.push(['Contract', `<code class="wrap">${esc(intent.contractId)}</code>`], ['New version', esc(intent.version)]);
      rows.push(['Document types', esc(Object.keys(intent.contract?.documentSchemas ?? {}).join(', ') || 'none')]);
      break;
    case 'identity-create':
      rows.push(['Funded by', `asset lock <code class="wrap">${esc(short(intent.assetLockProof?.txid, 16))}</code>`], ['Keys', esc((intent.keys ?? []).map((k) => SLOT_NAMES[k.slot] ?? k.slot).join(', '))]);
      break;
    case 'identity-update':
      rows.push(['Identity', idLabel(intent.identityId)], ['Add keys', esc((intent.addKeys ?? []).map((k) => `${SLOT_NAMES[k.slot] ?? k.slot} #${k.keyId}`).join(', ') || 'none')], ['Disable keys', esc((intent.disableKeyIds ?? []).map((k) => `#${k}`).join(', ') || 'none')]);
      break;
    default:
  }
  if (key) rows.push(['Signed with', key]);
  if (full && (intent.nonce ?? intent.identityContractNonce ?? intent.identityNonce)) rows.push(['Nonce', esc(intent.nonce ?? intent.identityContractNonce ?? intent.identityNonce)]);
  return rows.length ? `<dl class="dh-kv dh-kv--ruled facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>` : '';
}

function plainError(text) {
  const m = String(text).match(/balance (\d+) required (\d+)/);
  if (m) return `The identity has ${dashOfCredits(m[1])} ${platform.unit ?? unit(identity()?.network ?? ceremony()?.network)}; this needs ${dashOfCredits(m[2])}.`;
  if (/nonce/i.test(text)) return 'Platform refused it because another transaction already used its nonce. Propose it again.';
  return String(text).split(/\n|\| /).filter(Boolean).at(-1)?.slice(0, 200) ?? String(text);
}

const titleOf = (type) => KINDS[type]?.title ?? (type === 'identity-create' ? 'Create the identity' : type);
const refused = (p) => p.broadcasts.some((b) => !b.ok);
const replaced = (p) => p.status === 'ready' && refused(p) && p.intent && proposals().some((q) => q !== p && q.status === 'executed' && q.intent?.nonce !== undefined && q.intent?.nonce === p.intent.nonce && (q.intent?.identityId ?? q.intent?.ownerId) === (p.intent.identityId ?? p.intent.ownerId));

function doneRow(p) {
  const f = p.intent?.amount ? ` ${dashOfCredits(p.intent.amount)} ${platform.unit ?? unit(identity()?.network)}` : '';
  return `<details class="done-row"><summary><span class="done-row__title">${esc(titleOf(p.type))}${esc(f)}</span><span class="muted">${esc(ago(p.at))}, proposed by ${esc(p.proposer)}</span>${replaced(p) ? '<span class="dh-badge dh-badge--outline">replaced</span>' : '<span class="dh-badge dh-badge--good">done</span>'}</summary>${proposalCard(p)}</details>`;
}

function statusBadge(p) {
  const map = {
    executed: ['good', 'done'], ready: refused(p) ? ['bad', 'refused by Platform'] : ['info', 'ready to broadcast'], collecting: [canSign(p) ? 'warn' : 'info', canSign(p) ? 'needs your signature' : p.approvedByMe ? 'you signed' : 'collecting signatures'],
    invalid: ['bad', 'invalid'], failed: ['bad', 'failed'],
  };
  const [tone, text] = map[p.status] ?? ['info', p.status];
  return `<span class="dh-badge dh-badge--${tone}">${esc(text)}</span>`;
}

function proposalsView() {
  const id = identity();
  if (!id) return `<section class="step"><h2 class="step__title">Proposals</h2><div class="empty"><p class="empty__title">Nothing to propose yet</p><p>Once the identity exists, anything it does starts here as a proposal that enough members sign.</p></div></section>`;
  const list = proposals().filter((p) => p.type !== 'identity-create' || p.status === 'executed').slice().reverse();
  const groups = [
    ['Needs your signature', list.filter(canSign)],
    ['Ready to broadcast', list.filter((p) => p.status === 'ready' && !refused(p))],
    ['Refused by Platform', list.filter((p) => p.status === 'ready' && refused(p) && !replaced(p))],
    ['Waiting for others', list.filter((p) => p.status === 'collecting' && !canSign(p))],
    ['Done', list.filter((p) => p.status === 'executed' || replaced(p))],
    ['Rejected or invalid', list.filter((p) => ['invalid', 'failed'].includes(p.status))],
  ].filter(([, items]) => items.length);
  return `<section class="step">
    <div class="step__head"><h2 class="step__title">Proposals</h2>${readOnly() || view === 'new' ? '' : '<button class="dh-btn dh-btn--primary" data-action="new-proposal">New proposal</button>'}</div>
    ${readOnly() ? readOnlyNote() : ''}
    <p class="step__lede">Everything the identity does starts as a proposal. Before you sign, your page rebuilds the transaction from the proposal and checks that it is exactly what the proposal shows. Whether the payment itself is right is for the group to agree.</p>
    ${view === 'new' ? newProposal(id) : ''}
    ${groups.length ? groups.map(([title, items]) => `<h3 class="group-title">${esc(title)} <span class="count">${items.length}</span></h3>${items.map((p) => (title === 'Done' ? doneRow(p) : proposalCard(p))).join('')}`).join('')
      : view === 'new' ? '' : '<div class="empty"><p class="empty__title">No proposals yet</p><p>Propose sending credits, writing a document or anything else the identity should do. The others see it here and sign.</p></div>'}
  </section>`;
}

function amountField() {
  const u = platform.unit ?? unit(identity()?.network);
  const bal = idInfo?.identityId === identity()?.identityId ? ` The identity holds ${dashOfCredits(idInfo.balance)} ${u}.` : '';
  return `<div class="dh-field"><label class="dh-field__label" for="np-amount">Amount</label><div class="dh-input-group"><input class="dh-input" id="np-amount" name="amount" inputmode="decimal" autocomplete="off" required><span class="dh-input-group__addon">${esc(u)}</span></div><p class="dh-field__help">Sent as credits: 1 ${esc(u)} is 100,000,000,000 credits.${esc(bal)}</p></div>`;
}

const creditsOf = (text) => {
  const t = String(text).trim().replace(/[,_\s]/g, '');
  if (!/^\d+(\.\d{1,11})?$/.test(t)) throw new Error('Enter the amount as a number, for example 0.001');
  const [whole, frac = ''] = t.split('.');
  return (BigInt(whole) * CREDITS_PER_DASH + BigInt(frac.padEnd(11, '0'))).toString();
};

function newProposal(id) {
  const k = KINDS[kind];
  const field = (name, label, help = '', attrs = '', mono = false) => `<div class="dh-field"><label class="dh-field__label" for="np-${name}">${label}</label><input class="dh-input${mono ? ' dh-input--mono' : ''}" id="np-${name}" name="${name}" ${attrs}>${help ? `<p class="dh-field__help">${help}</p>` : ''}</div>`;
  const area = (name, label, help = '', placeholder = '') => `<div class="dh-field"><label class="dh-field__label" for="np-${name}">${label}</label><textarea class="dh-textarea dh-input--mono" id="np-${name}" name="${name}" rows="6" placeholder="${esc(placeholder)}"></textarea>${help ? `<p class="dh-field__help">${help}</p>` : ''}</div>`;
  const fields = {
    'credit-transfer': field('recipientId', 'Recipient identity', '', 'required autocomplete="off" spellcheck="false"', true) + amountField(),
    'credit-withdrawal': field('toAddress', 'Core address', 'A P2PKH address on the same network.', 'required autocomplete="off" spellcheck="false"', true) + amountField(),
    document: field('contractId', 'Contract id', '', 'required autocomplete="off" spellcheck="false"') + field('documentType', 'Document type', '', 'required autocomplete="off"')
      + `<div class="dh-field"><label class="dh-field__label" for="np-action">Change</label><select class="dh-select" id="np-action" name="action"><option value="create">Create a document</option><option value="replace">Replace a document</option><option value="delete">Delete a document</option></select></div>`
      + field('documentId', 'Document id', 'Only for replace and delete.', 'autocomplete="off" spellcheck="false"') + area('properties', 'Document fields (JSON)', '', '{"message": "hello"}'),
    'contract-create': area('contract', 'Contract (JSON)', 'The document schemas, or a full contract with <code>documentSchemas</code>.', '{"note": {"type": "object", ...}}'),
    'contract-update': field('contractId', 'Contract id', '', 'required autocomplete="off" spellcheck="false"') + area('contract', 'New contract (JSON)'),
    'identity-update': field('addKeys', 'Keys to add', 'Ceremony id and key name, comma separated, e.g. <code>7801516c/master</code>.', 'autocomplete="off" spellcheck="false"') + field('disableKeyIds', 'Key numbers to disable', 'Comma separated, e.g. 0, 1.', 'autocomplete="off"'),
  };
  return `<form class="panel panel--new" id="form-propose" data-form="propose">
    <h3 class="panel__title">What should the identity do?</h3>
    <div class="dh-choices kinds">${Object.entries(KINDS).map(([key, v]) => `<button type="button" class="dh-choice" data-action="kind" data-kind="${key}" aria-pressed="${key === kind}"><span class="dh-choice__title">${esc(v.title)}</span><span class="dh-choice__desc">${esc(v.desc)}</span></button>`).join('')}</div>
    ${fields[kind]}
    ${field('note', 'Note for the group <span class="dh-field__optional">optional</span>', '', 'autocomplete="off"')}
    <details class="dh-disclosure"><summary><span>Signing key</span></summary>${field('signer', 'Key', `Defaults to the ${esc(SLOT_NAMES[k.slot])}, which Platform requires for this.`, `value="${esc(k.slot)}" autocomplete="off"`)}</details>
    <div class="dh-actions"><button class="dh-btn dh-btn--primary">Propose to the group</button><button type="button" class="dh-btn dh-btn--quiet" data-action="cancel-new">Cancel</button></div>
    <p class="note">For ${esc(short(id.identityId, 12))}. Nothing happens until enough members sign and someone broadcasts it.</p>
  </form>`;
}

function render() {
  if (!state) return;
  let html;
  if (!state.room || picking) html = startView();
  else {
    const s = stepStatus();
    const active = view === 'new' ? 'proposals' : view ?? currentStep(s);
    const body = { members: membersView, keys: keysView, identity: identityView, proposals: proposalsView }[active]();
    html = `${header()}<div class="layout">${rail(s, active)}<div class="stage">${state.invalidMessages ? `<p class="dh-notice dh-notice--warn">${state.invalidMessages} messages in this group failed their checks and were ignored.</p>` : ''}${body}</div></div>`;
  }
  document.body.classList.toggle('is-busy', Boolean(busy));
  if (html === lastHtml) return;
  lastHtml = html;
  morph(app, html);
}

function morph(root, html) {
  const keep = new Map();
  for (const el of root.querySelectorAll('input, textarea, select')) {
    if (!el.id || el.type === 'file' || el.type === 'hidden') continue;
    keep.set(el.id, el.type === 'checkbox' ? { checked: el.checked } : { value: el.value });
  }
  const open = new Set([...root.querySelectorAll('details')].map((d, i) => (d.open ? d.id || `#${i}` : null)).filter(Boolean));
  const focus = document.activeElement && root.contains(document.activeElement) ? { id: document.activeElement.id, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
  root.innerHTML = html;
  for (const [id, v] of keep) {
    const el = root.querySelector(`#${CSS.escape(id)}`);
    if (!el) continue;
    if ('checked' in v) el.checked = v.checked;
    else el.value = v.value;
  }
  [...root.querySelectorAll('details')].forEach((d, i) => { if (open.has(d.id || `#${i}`)) d.open = true; });
  if (focus?.id) {
    const el = root.querySelector(`#${CSS.escape(focus.id)}`);
    if (el) {
      el.focus();
      try { if (focus.start !== null && focus.start !== undefined) el.setSelectionRange(focus.start, focus.end); } catch { /* not a text field */ }
    }
  }
}

/* ---------------------------------------------------------------- dialogs */

function showDialog(html) {
  dialog.innerHTML = `<div class="dlg">${html}</div>`;
  if (!dialog.open) dialog.showModal();
}
dialog.addEventListener('click', (e) => {
  if (e.target === dialog || e.target.closest('[data-action=close]')) dialog.close();
});

function reviewDialog(r, offerSign) {
  const title = titleOf(r.intent?.type);
  showDialog(`
    <header class="dlg__head"><h2 class="dlg__title">${esc(title)}</h2>${r.status === 'executed' ? '<span class="dh-badge dh-badge--good">already done</span>' : r.ok ? '<span class="dh-badge dh-badge--info">matches the proposal</span>' : '<span class="dh-badge dh-badge--bad">do not sign</span>'}</header>
    <p class="dlg__lede">Proposed by ${esc(r.proposer)}${r.proposal?.note ? `, with the note "${esc(r.proposal.note)}"` : ''}.</p>
    ${facts(r.intent, { full: true }) || `<ul class="proposal__summary">${r.summary.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`}
    ${offerSign && r.ok && r.intent?.amount ? `<p class="confirm">Before you sign, confirm with ${esc(r.proposer)} that the group agreed to send <strong>${esc(dashOfCredits(r.intent.amount))} ${esc(platform.unit ?? unit(identity()?.network))}</strong> to <code>${esc(short(r.intent.recipientId ?? r.intent.outputAddress, 10))}</code>.</p>` : ''}
    ${r.ok ? `<div class="checks"><p><strong>What your page checked</strong></p><ul>
      <li>It rebuilt the transaction from the proposal above, and the bytes to sign are exactly those.</li>
      <li>The signing key is the group's own key, with the level Platform requires for this.</li>
      <li>On Platform, that key is enabled on the identity and the nonce is current.</li>
    </ul></div>` : ''}
    ${r.problems.length ? `<div class="dh-notice dh-notice--error"><p><strong>Why not to sign</strong></p><ul>${r.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
    ${r.attention?.length ? `<div class="dh-notice dh-notice--warn"><p><strong>This puts keys under a group's control.</strong> Check who holds them:</p><pre>${esc(r.attention.join('\n'))}</pre></div>` : ''}
    ${r.warnings.length ? `<div class="dh-notice dh-notice--info"><ul>${r.warnings.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
    <details class="dh-disclosure" open><summary><span>The exact transaction your share signs (${esc(r.decoded?.action ?? 'decoded')})</span></summary><pre>${esc(JSON.stringify(r.decoded?.json, null, 2))}</pre></details>
    <details class="dh-disclosure"><summary><span>The proposal as written</span></summary><pre>${esc(JSON.stringify(r.intent, null, 2))}</pre></details>
    ${offerSign && r.ok ? `<form class="reject" id="form-reject" data-form="reject" data-id="${esc(r.id)}" hidden><div class="dh-field"><label class="dh-field__label" for="reject-reason">Why are you rejecting it?</label><input class="dh-input" id="reject-reason" name="reason" required></div><div class="dh-actions"><button class="dh-btn dh-btn--destructive">Reject proposal</button></div></form>` : ''}
    <div class="dh-actions dh-actions--end dlg__foot">
      ${offerSign ? '<button class="dh-btn dh-btn--quiet" data-action="show-reject">Reject…</button>' : ''}
      <button class="dh-btn" data-action="close">${offerSign && r.ok ? 'Not now' : 'Close'}</button>
      ${offerSign && r.ok ? `<button class="dh-btn dh-btn--primary" data-action="sign" data-id="${esc(r.id)}" data-ack="${r.attention?.length ? 1 : 0}">Sign with my share</button>` : ''}
    </div>`);
}

/* ---------------------------------------------------------------- events */

const enteredGroup = () => { view = null; picking = false; funding = null; platform.invite = null; };

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function labelFromInvite(text) {
  const m = String(text).match(/[#&]name=([^&]+)/);
  try { return m ? decodeURIComponent(m[1]).slice(0, 80) : undefined; } catch { return undefined; }
}

function roomFromInvite(text) {
  const t = String(text).trim();
  const m = t.match(/[#&?]room=([A-Za-z0-9_-]{8,64})/);
  return m ? m[1] : t;
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    say(`${what} copied`, 'good');
  } catch {
    showDialog(`<header class="dlg__head"><h2 class="dlg__title">${esc(what)}</h2></header><p><code class="wrap">${esc(text)}</code></p><div class="dh-actions dh-actions--end"><button class="dh-btn" data-action="close">Close</button></div>`);
  }
}

async function importFile(file) {
  if (!file) return;
  await act('Import group bundle', async () => api('POST', '/api/room/import', JSON.parse(await file.text())));
}

document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const f = formData(form);
  switch (form.dataset.form) {
    case 'create':
      act('Start group', () => api('POST', '/api/room/create', { label: f.label, name: f.name, relay: f.relay || undefined }), { done: 'Group started. Copy the invite link for the others.' }).then(enteredGroup);
      break;
    case 'join':
      act('Join group', () => api('POST', '/api/room/join', { room: roomFromInvite(f.room), name: f.name, relay: f.relay || undefined, label: platform.inviteLabel ?? labelFromInvite(f.room) }), { done: 'Joined the group' }).then(enteredGroup);
      break;
    case 'ceremony': {
      const chosen = [...form.querySelectorAll('input[name=member]:checked')].map((x) => x.value);
      let keys;
      try {
        keys = f.keys?.trim() ? JSON.parse(f.keys) : undefined;
      } catch {
        say('The key layout is not valid JSON', 'bad');
        return;
      }
      act('Propose the key ceremony', () => api('POST', '/api/ceremony/propose', { network: f.network ?? platform.networks[0], threshold: f.threshold, label: f.label, members: chosen, keys }), { done: 'Key ceremony proposed. Accept it below.' });
      break;
    }
    case 'accept':
      for (const box of form.querySelectorAll('input[name=fp]')) verified.add(box.value);
      act('Accept', () => api('POST', '/api/ceremony/advance', { cid: form.dataset.cid, accept: true }), { done: 'Accepted. Your part now runs by itself.' }).then(advanceCeremonies);
      break;
    case 'identity': {
      const amount = Number(String(f.amount).replace(',', '.'));
      if (!(amount > 0)) { say('Enter how much to lock', 'bad'); return; }
      const c = ceremony();
      const body = { cid: c.cid, duffs: Math.round(amount * DUFFS_PER_DASH) };
      if (c.network === 'mainnet') {
        if (prompt(`This locks ${amount} DASH of real money on mainnet. Type "mainnet" to continue.`) !== 'mainnet') return;
        body.confirmMainnet = true;
      }
      act('Lock and propose the identity', () => api('POST', '/api/identity/create', body), { pending: 'Locking funds and waiting for the network to confirm it. This takes one to three minutes; keep this page open.', done: 'Identity proposed. The others can sign it now.' });
      break;
    }
    case 'propose': {
      const args = { identityId: identity()?.identityId, note: f.note, signer: f.signer || KINDS[kind].slot };
      try {
        if (kind === 'contract-create' || kind === 'contract-update') { const c = JSON.parse(f.contract); args.contract = c.documentSchemas ? c : { documentSchemas: c }; }
        if (kind === 'contract-update' || kind === 'document') args.contractId = f.contractId;
        if (kind === 'document') Object.assign(args, { documentType: f.documentType, action: f.action, documentId: f.documentId || undefined, properties: f.properties ? JSON.parse(f.properties) : undefined });
      } catch {
        say('That JSON is not valid', 'bad');
        return;
      }
      try {
        if (kind === 'credit-transfer') Object.assign(args, { recipientId: f.recipientId.trim(), amount: creditsOf(f.amount) });
        if (kind === 'credit-withdrawal') Object.assign(args, { toAddress: f.toAddress.trim(), amount: creditsOf(f.amount) });
      } catch (err) {
        say(err.message, 'bad');
        return;
      }
      if (kind === 'identity-update') Object.assign(args, { addKeys: f.addKeys.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [cid, slot] = x.split('/'); return { cid, slot }; }), disableKeyIds: f.disableKeyIds.split(',').map((x) => x.trim()).filter(Boolean).map(Number) });
      act('Propose', () => api('POST', '/api/propose', { kind, args }), { done: 'Proposed. The others see it now.' }).then((out) => { if (out) view = 'proposals'; });
      break;
    }
    case 'reject':
      dialog.close();
      act('Reject', () => api('POST', '/api/reject', { id: form.dataset.id, reason: f.reason }));
      break;
    default:
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'import' || e.target.id === 'import-start') importFile(e.target.files[0]);
  if (e.target.name === 'fp') {
    if (e.target.checked) verified.add(e.target.value);
    else verified.delete(e.target.value);
  }
  if (e.target.dataset?.action === 'verify') {
    if (e.target.checked) verified.add(e.target.dataset.key);
    else verified.delete(e.target.dataset.key);
    lastHtml = '';
    render();
  }
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (!b || b.tagName === 'INPUT') return;
  const a = b.dataset.action;
  const menu = $('#more-menu');
  if (menu?.open && b.closest('#more-menu') && a !== undefined) menu.open = false;
  switch (a) {
    case 'view': view = b.dataset.view; if (view === 'identity' && !funding) loadFunding(); render(); window.scrollTo({ top: 0 }); break;
    case 'copy-invite': copy(inviteText(), 'Invite link'); break;
    case 'copy-room': copy(state.room, 'Group id'); break;
    case 'copy': copy(b.dataset.text, 'Copied text'); break;
    case 'sync': act('Check for updates', () => api('POST', '/api/sync'), { done: 'Up to date' }); break;
    case 'export': act('Export group bundle', async () => {
      const bundle = await api('GET', '/api/room/export');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 1)], { type: 'application/json' }));
      link.download = `group-${bundle.room}.json`;
      link.click();
    }); break;
    case 'leave': picking = true; view = null; render(); break;
    case 'open-room': act('Open group', () => api('POST', '/api/room/select', { room: b.dataset.room })).then(() => { picking = false; funding = null; view = null; render(); }); break;
    case 'funding': loadFunding(); break;
    case 'netcheck': act('Network check', async () => {
      netStatus = await api('GET', '/api/network', { network: platform.network });
      funding = await api('GET', '/api/funding', { network: platform.network });
    }, { pending: `Connecting to ${platform.label} Platform…`, done: `${platform.label} is reachable` }); break;
    case 'new-proposal': view = 'new'; render(); break;
    case 'cancel-new': view = 'proposals'; render(); break;
    case 'kind': kind = b.dataset.kind; render(); break;
    case 'read-identity': act('Read from Platform', async () => {
      const r = await api('GET', '/api/identity', { identityId: b.dataset.id });
      showDialog(`<header class="dlg__head"><h2 class="dlg__title">On Platform now</h2><span class="dh-badge dh-badge--good">proved read</span></header>
        <dl class="dh-kv dh-kv--ruled"><dt>Balance</dt><dd>${esc(dashOfCredits(r.balance))} ${unit(r.network)} <span class="muted">(${esc(BigInt(r.balance ?? 0).toLocaleString('en-US'))} credits)</span></dd><dt>Revision</dt><dd>${esc(r.revision)}</dd></dl>
        <table class="dh-table dh-table--compact"><thead><tr><th>Key</th><th>Matches the group key</th><th>Status</th></tr></thead><tbody>${r.keys.map((k) => `<tr><td>${esc(SLOT_NAMES[k.slot] ?? k.slot ?? '')} #${Number(k.id)}</td><td>${k.matchesGroupKey ? 'yes' : '<strong>no</strong>'}</td><td>${k.disabledAt ? 'disabled' : 'enabled'}</td></tr>`).join('')}</tbody></table>
        <div class="dh-actions dh-actions--end"><button class="dh-btn" data-action="close">Close</button></div>`);
    }, { done: 'Read from Platform' }); break;
    case 'review': act('Review', async () => reviewDialog(await api('GET', '/api/review', { id: b.dataset.id }), b.dataset.sign === '1'), { pending: 'Rebuilding the transaction and checking it against Platform…', done: 'Review ready' }); break;
    case 'show-reject': { const f = $('#form-reject'); if (f) { f.hidden = false; $('#reject-reason').focus(); } break; }
    case 'sign': dialog.close(); act('Sign', () => api('POST', '/api/approve', { id: b.dataset.id, acknowledgeKeys: b.dataset.ack === '1' }), { done: 'Signed with your share' }); break;
    case 'execute': act('Broadcast', async () => {
      const r = await api('POST', '/api/execute', { id: b.dataset.id });
      if (!r.ok) throw new Error(r.error);
      return r;
    }, { pending: 'Combining the signatures and sending the transaction to Platform…', done: 'Done on Platform' }); break;
    default:
  }
});

document.addEventListener('click', (e) => {
  const menu = $('#more-menu');
  if (menu?.open && !menu.contains(e.target)) menu.open = false;
});

/* ---------------------------------------------------------------- data */

async function loadIdentity() {
  idLoading = true;
  try {
    idInfo = await api('GET', '/api/identity', { identityId: identity().identityId });
  } catch { /* shown as still loading; the next refresh retries */ }
  idLoading = false;
  lastHtml = '';
  render();
}

async function loadFunding() {
  const c = ceremony();
  if (!c) return;
  try {
    funding = await api('GET', '/api/funding', { network: platform.hosted ? platform.network : c.network });
  } catch (e) {
    say(`Could not read your balance: ${e.message}`, 'bad');
  }
  lastHtml = '';
  render();
}

let advancing = false;
async function advanceCeremonies() {
  if (advancing) return;
  advancing = true;
  try {
    for (const c of ceremonies()) {
      const me = c.participants.find((p) => p.index === c.myIndex);
      if (me?.accepted && !['complete', 'failed'].includes(c.status)) await api('POST', '/api/ceremony/advance', { cid: c.cid });
    }
  } catch (e) {
    say(`Key ceremony: ${e.message}`, 'bad');
  } finally {
    advancing = false;
  }
}

async function refresh() {
  try {
    state = await api('GET', '/api/status');
  } catch (e) {
    say(e.message, 'bad');
    return;
  }
  if (!state.room) view = null;
  const step = state.room ? (view === 'new' ? 'proposals' : view ?? currentStep(stepStatus())) : null;
  if (step === 'identity' && !funding && ceremony()?.status === 'complete' && !identity()) loadFunding();
  if ((step === 'identity' || step === 'proposals') && identity() && idInfo?.identityId !== identity().identityId && !idLoading) loadIdentity();
  render();
}

const active = () => ceremonies().some((c) => c.myIndex && !['complete', 'failed'].includes(c.status));
async function tick() {
  if (!busy && !dialog.open && state?.room) {
    try {
      await api('POST', '/api/sync');
      await advanceCeremonies();
    } catch { /* the next tick retries */ }
    await refresh();
  }
  setTimeout(tick, active() ? 3000 : 8000);
}

await refresh();
setTimeout(tick, 3000);
