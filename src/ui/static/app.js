const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? sessionStorage.getItem('dti-token');
if (token) sessionStorage.setItem('dti-token', token);
history.replaceState(null, '', location.pathname);

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (s, n = 12) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? '');
let state = null;
let busy = false;
const unchecked = new Set();
let activeRoom = null;

const rendered = new WeakMap();

function setOptions(el, html) {
  if (rendered.get(el) === html) return;
  rendered.set(el, html);
  const before = el.value;
  el.innerHTML = html;
  if (before && [...el.options].some((o) => o.value === before)) el.value = before;
}

async function api(method, path, body) {
  const url = method === 'GET' && body ? `${path}?${new URLSearchParams(body)}` : path;
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-dti-token': token ?? '' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

function flash(message, bad = false) {
  const el = $('#flash');
  el.textContent = message;
  el.className = `flash${bad ? ' bad' : ''}`;
  el.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { el.hidden = true; }, bad ? 12000 : 5000);
}

async function act(label, fn) {
  if (busy) return;
  busy = true;
  document.body.style.cursor = 'progress';
  try {
    const out = await fn();
    flash(`${label}: done`);
    await refresh();
    return out;
  } catch (e) {
    flash(`${label}: ${e.message}`, true);
  } finally {
    busy = false;
    document.body.style.cursor = '';
  }
}

function showDialog(html) {
  $('#dialog-body').innerHTML = html;
  $('#dialog').showModal();
}
$('#dialog-close').onclick = () => $('#dialog').close();

for (const b of document.querySelectorAll('#tabs button')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('#tabs button')) x.classList.toggle('active', x === b);
    for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== `tab-${b.dataset.tab}`;
  };
}

const statusChip = (s) => {
  const cls = ['complete', 'executed', 'ready'].includes(s) ? 'ok' : ['failed', 'invalid'].includes(s) ? 'bad' : 'warn';
  return `<span class="chip ${cls}">${esc(s)}</span>`;
};

function renderRoom() {
  $('#me').innerHTML = state.me ? `You: <span class="fp">${esc(state.me.fingerprint)}</span>` : '';
  setOptions($('#room-select'), (state.rooms ?? []).map((r) => `<option value="${esc(r.room)}" ${r.room === state.room ? 'selected' : ''}>${esc(r.label ?? r.room)} (${r.messages} messages)</option>`).join(''));
  if (state.room && state.room !== activeRoom) {
    activeRoom = state.room;
    $('#room-select').value = state.room;
  }
  $('#room-info').innerHTML = state.room
    ? `Room <code>${esc(state.room)}</code><br>Relay: ${state.relay ? `<code>${esc(state.relay)}</code>` : 'none (exchange bundles as files)'}${state.invalidMessages ? `<br><span class="chip bad">${state.invalidMessages} invalid messages ignored</span>` : ''}`
    : 'No room selected.';
  $('#members').innerHTML = `<tr><th>Name</th><th>Fingerprint</th><th>Key</th></tr>${(state.members ?? []).map((m) => `<tr><td>${esc(m.name)}${m.me ? ' <span class="chip">you</span>' : ''}</td><td class="fp">${esc(m.fingerprint)}</td><td class="mono">${esc(short(m.authPub, 20))}</td></tr>`).join('')}`;
  const members = (state.members ?? []).map((m) => `<label><input type="checkbox" name="member" value="${esc(m.authPub)}"${unchecked.has(m.authPub) ? '' : ' checked'}> ${esc(m.name)}</label>`).join('');
  const roster = (state.members ?? []).map((m) => `${m.authPub}:${m.name}`).join(',');
  if (rendered.get($('#ceremony-members')) !== roster) {
    rendered.set($('#ceremony-members'), roster);
    $('#ceremony-members').innerHTML = members;
  }
}

function renderCeremonies() {
  const list = state.ceremonies ?? [];
  setOptions($('#identity-cid'), list.filter((c) => c.status === 'complete').map((c) => `<option value="${esc(c.cid)}">${esc(c.label)} (${esc(short(c.cid))})</option>`).join(''));
  $('#ceremonies').innerHTML = list.slice().reverse().map((c) => `
    <div class="card">
      <h2>${esc(c.label)} ${statusChip(c.status)}</h2>
      <div class="muted">${esc(c.network)} · ${c.threshold}-of-${c.participants.length} · ceremony <code>${esc(c.cid)}</code></div>
      <table>
        <tr><th>#</th><th>Member</th><th>Fingerprint</th><th>Accepted</th><th>Committed</th><th>Revealed</th><th>Completed</th></tr>
        ${c.participants.map((p) => `<tr><td>${p.index}</td><td>${esc(p.name)}${p.index === c.myIndex ? ' <span class="chip">you</span>' : ''}</td><td class="fp">${esc(p.fingerprint)}</td>${['accepted', 'committed', 'revealed', 'completed'].map((k) => `<td>${p[k] ? '✓' : '·'}</td>`).join('')}</tr>`).join('')}
      </table>
      ${c.keys ? `<h3>Group keys</h3><table><tr><th>Slot</th><th>Key id</th><th>Purpose / level</th><th>Public key</th></tr>${Object.entries(c.keys).map(([slot, k]) => `<tr><td>${esc(slot)}</td><td>${k.keyId}</td><td>${esc(k.purpose)} / ${esc(k.securityLevel)}</td><td class="mono">${esc(k.groupPublicKey)}</td></tr>`).join('')}</table>` : ''}
      ${c.problems.length ? `<pre>${esc(JSON.stringify(c.problems, null, 1))}</pre>` : ''}
      ${c.myIndex && !['complete', 'failed'].includes(c.status) ? `<div class="row end">${!c.participants.find((p) => p.index === c.myIndex).accepted ? `<button data-accept="${esc(c.cid)}">I checked the fingerprints: accept</button>` : `<button class="secondary" data-advance="${esc(c.cid)}">Take my next step</button>`}</div>` : ''}
    </div>`).join('') || '<div class="card muted">No key ceremonies yet.</div>';
  for (const b of document.querySelectorAll('[data-accept]')) b.onclick = () => act('Accept', () => api('POST', '/api/ceremony/advance', { cid: b.dataset.accept, accept: true }));
  for (const b of document.querySelectorAll('[data-advance]')) b.onclick = () => act('Ceremony step', () => api('POST', '/api/ceremony/advance', { cid: b.dataset.advance }));
}

function renderIdentities() {
  const ids = state.identities ?? [];
  setOptions($('#propose-identity'), ids.map((i) => `<option value="${esc(i.identityId)}">${esc(i.identityId)}</option>`).join(''));
  $('#identities').innerHTML = ids.map((i) => `
    <div class="card">
      <h2>Identity <code>${esc(i.identityId)}</code></h2>
      <div class="muted">${esc(i.network)}</div>
      <table><tr><th>Key</th><th>Slot</th><th>Purpose / level</th><th>Status</th></tr>
      ${Object.values(i.keys).map((k) => `<tr><td>${Number(k.keyId)}</td><td>${esc(k.slot)}</td><td>${esc(k.purpose)} / ${esc(k.securityLevel)}</td><td>${k.disabled ? '<span class="chip bad">disabled</span>' : '<span class="chip ok">enabled</span>'}</td></tr>`).join('')}</table>
      <div class="row end"><button class="secondary" data-show="${esc(i.identityId)}">Proved read from Platform</button></div>
    </div>`).join('') || '<div class="card muted">No identity yet.</div>';
  for (const b of document.querySelectorAll('[data-show]')) b.onclick = () => act('Read identity', async () => showDialog(`<h2>On-chain identity</h2><pre>${esc(JSON.stringify(await api('GET', '/api/identity', { identityId: b.dataset.show }), null, 2))}</pre>`));
}

function renderProposals() {
  const list = (state.proposals ?? []).slice().reverse();
  $('#proposals').innerHTML = list.map((p) => `
    <div class="card">
      <h2>${esc(p.type)} ${statusChip(p.status)}</h2>
      <div class="muted">by ${esc(p.proposer)} · ${esc(p.at)} · <code>${esc(short(p.id, 16))}</code>${p.note ? ` · ${esc(p.note)}` : ''}</div>
      <ul class="summary">${p.summary.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      <table><tr><th>Key</th><th>Approvals</th></tr>${p.requirements.map((r) => `<tr><td>${esc(r.slot)} <span class="muted">(${esc(short(r.key.split('/')[0], 8))})</span></td><td>${r.approvals.length} of ${r.threshold ?? '?'} ${r.approvals.length ? `(members ${r.approvals.join(', ')})` : ''}${r.invalid.length ? ` <span class="chip bad">invalid from ${r.invalid.join(', ')}</span>` : ''}</td></tr>`).join('')}</table>
      ${p.rejections.length ? `<p>${p.rejections.map((r) => `<span class="chip bad">rejected by ${esc(r.by)}: ${esc(r.reason)}</span>`).join(' ')}</p>` : ''}
      ${p.broadcasts.map((b) => `<p class="muted">Broadcast by ${esc(b.by)}: ${b.ok ? '<span class="chip ok">accepted</span>' : `<span class="chip bad">${esc(b.error)}</span>`}${b.stHash ? ` <code>${esc(short(b.stHash, 16))}</code>` : ''}</p>`).join('')}
      <div class="row end">
        <button class="secondary" data-review="${esc(p.id)}">Review</button>
        ${p.status === 'collecting' && !p.approvedByMe ? `<button data-approve="${esc(p.id)}">Review and sign</button><button class="danger" data-reject="${esc(p.id)}">Reject</button>` : ''}
        ${p.status === 'ready' ? `<button data-execute="${esc(p.id)}">Combine and broadcast</button>` : ''}
      </div>
    </div>`).join('') || '<div class="card muted">No proposals yet.</div>';
  for (const b of document.querySelectorAll('[data-review]')) b.onclick = () => act('Review', async () => showReview(await api('GET', '/api/review', { id: b.dataset.review }), false));
  for (const b of document.querySelectorAll('[data-approve]')) b.onclick = () => act('Review', async () => showReview(await api('GET', '/api/review', { id: b.dataset.approve }), true));
  for (const b of document.querySelectorAll('[data-reject]')) b.onclick = () => { const reason = prompt('Why are you rejecting this proposal?'); if (reason !== null) act('Reject', () => api('POST', '/api/reject', { id: b.dataset.reject, reason })); };
  for (const b of document.querySelectorAll('[data-execute]')) b.onclick = () => act('Broadcast', async () => { const r = await api('POST', '/api/execute', { id: b.dataset.execute }); if (!r.ok) throw new Error(r.error); return r; });
}

function showReview(r, offerSign) {
  showDialog(`
    <h2>Proposal from ${esc(r.proposer)} ${r.status === 'executed' ? '<span class="chip ok">already executed</span>' : r.ok ? '<span class="chip ok">checks pass</span>' : '<span class="chip bad">do not sign</span>'}</h2>
    <ul class="summary">${r.summary.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    ${r.problems.length ? `<h3>Problems</h3><ul>${r.problems.map((p) => `<li class="chip bad">${esc(p)}</li>`).join('')}</ul>` : ''}
    ${r.attention?.length ? `<h3>Who will control new keys</h3><pre>${esc(r.attention.join('\n'))}</pre>` : ''}
    ${r.warnings.length ? `<h3>Warnings</h3><ul>${r.warnings.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    <h3>The exact transition you would sign (decoded: ${esc(r.decoded?.action)})</h3>
    <pre>${esc(JSON.stringify(r.decoded?.json, null, 2))}</pre>
    <details><summary>Intent</summary><pre>${esc(JSON.stringify(r.intent, null, 2))}</pre></details>
    ${offerSign && r.ok ? `<div class="row end"><button id="sign-now">Sign with my share</button></div>` : ''}`);
  const b = $('#sign-now');
  if (b) b.onclick = () => { $('#dialog').close(); act('Sign', () => api('POST', '/api/approve', { id: r.id, acknowledgeKeys: Boolean(r.attention?.length) })); };
}

async function refresh() {
  try {
    state = await api('GET', '/api/status');
  } catch (e) {
    flash(e.message, true);
    return;
  }
  renderRoom();
  renderCeremonies();
  renderIdentities();
  renderProposals();
}

$('#ceremony-members').addEventListener('change', (e) => {
  if (e.target.name !== 'member') return;
  if (e.target.checked) unchecked.delete(e.target.value);
  else unchecked.add(e.target.value);
});

const formData = (form) => Object.fromEntries(new FormData(form).entries());

$('#form-create-room').onsubmit = (e) => { e.preventDefault(); act('Create room', () => api('POST', '/api/room/create', formData(e.target))); };
$('#form-join-room').onsubmit = (e) => { e.preventDefault(); act('Join room', () => api('POST', '/api/room/join', formData(e.target))); };
$('#room-select-go').onclick = () => act('Open room', () => api('POST', '/api/room/select', { room: $('#room-select').value }));
$('#sync').onclick = () => act('Sync', () => api('POST', '/api/sync'));
$('#export').onclick = () => act('Export', async () => {
  const bundle = await api('GET', '/api/room/export');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 1)], { type: 'application/json' }));
  a.download = `dti-${bundle.room}.json`;
  a.click();
});
$('#import').onchange = (e) => { const f = e.target.files[0]; if (f) act('Import', async () => api('POST', '/api/room/import', JSON.parse(await f.text()))); };
$('#fund-check').onclick = () => act('Funding', async () => { $('#fund-out').textContent = JSON.stringify(await api('GET', '/api/funding', { network: $('#fund-network').value }), null, 2); });

$('#form-ceremony').onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  const members = [...f.querySelectorAll('input[name=member]:checked')].map((x) => x.value);
  const keys = f.keys.value.trim() ? JSON.parse(f.keys.value) : undefined;
  act('Propose ceremony', () => api('POST', '/api/ceremony/propose', { network: f.network.value, threshold: f.threshold.value, label: f.label.value, members, keys }));
};
$('#form-identity-create').onsubmit = (e) => {
  e.preventDefault();
  const body = formData(e.target);
  const ceremony = (state.ceremonies ?? []).find((c) => c.cid === body.cid);
  if (ceremony?.network === 'mainnet') {
    if (prompt(`This locks ${Number(body.duffs) / 1e8} DASH of real money on mainnet. Type "mainnet" to continue.`) !== 'mainnet') return;
    body.confirmMainnet = true;
  }
  act('Lock funds and propose identity (this waits for a ChainLock)', () => api('POST', '/api/identity/create', body));
};

const kindSelect = $('#propose-kind');
const showKindFields = () => { for (const el of document.querySelectorAll('[data-kinds]')) el.hidden = !el.dataset.kinds.split(' ').includes(kindSelect.value); };
kindSelect.onchange = showKindFields;
showKindFields();
$('#form-propose').onsubmit = (e) => {
  e.preventDefault();
  const f = formData(e.target);
  const kind = f.kind;
  const args = { identityId: f.identityId || undefined, note: f.note, signer: f.signer || undefined };
  if (kind === 'contract-create' || kind === 'contract-update') { const c = JSON.parse(f.contract); args.contract = c.documentSchemas ? c : { documentSchemas: c }; }
  if (kind === 'contract-update' || kind === 'document') args.contractId = f.contractId;
  if (kind === 'document') Object.assign(args, { documentType: f.documentType, action: f.action, documentId: f.documentId || undefined, properties: f.properties ? JSON.parse(f.properties) : undefined });
  if (kind === 'credit-transfer') Object.assign(args, { recipientId: f.recipientId, amount: f.amount });
  if (kind === 'credit-withdrawal') Object.assign(args, { toAddress: f.toAddress, amount: f.amount });
  if (kind === 'identity-update') Object.assign(args, { addKeys: f.addKeys.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [cid, slot] = x.split('/'); return { cid, slot }; }), disableKeyIds: f.disableKeyIds.split(',').map((x) => x.trim()).filter(Boolean).map(Number) });
  act('Propose', () => api('POST', '/api/propose', { kind, args }));
};

if (!token) flash('Open the URL that `dti ui` printed; it carries this session\'s token.', true);
refresh();
setInterval(() => { if (!busy && !document.querySelector('dialog[open]')) api('POST', '/api/sync').then(refresh).catch(() => {}); }, 8000);
