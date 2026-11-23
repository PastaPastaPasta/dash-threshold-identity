// Drives a full 2-of-3 run through the hosted page with three browser profiles on one network:
// start a group, invite and join, check fingerprints, make the keys, fund and create the identity,
// then send credits. Needs `npm i --no-save playwright`.
//   BASE      page URL, default https://multisig.dashhq.org/
//   NETWORK   testnet (default), local or devnet-<name>
//   SEEDS     directory with <name>.txt seed phrases for NAMES (the first one funds the identity)
//   NAMES     three member names, default ana,ben,cho
//   KIND      credit-transfer (default) or credit-withdrawal
//   RECIPIENT identity that receives the credits, or the Core address for a withdrawal
//   OUT       output directory for screenshots and the log
//   INSECURE_TLS=1 accepts the self-signed certificates of a local dashmate network
//   On local, the browser is granted local-network access so a public page can reach 127.0.0.1
import fs from 'node:fs';
import { chromium } from 'playwright';

const NETWORK = process.env.NETWORK ?? 'testnet';
const BASE = `${(process.env.BASE ?? 'https://multisig.dashhq.org/').replace(/\/?(\?.*)?$/, '/')}?network=${NETWORK}`;
const SEEDS = process.env.SEEDS ?? 'seeds';
const NAMES = (process.env.NAMES ?? 'ana,ben,cho').split(',');
const RECIPIENT = process.env.RECIPIENT;
const KIND = process.env.KIND ?? 'credit-transfer';
const OUT = process.env.OUT ?? `web-e2e-out/${NETWORK}`;
if (!RECIPIENT) throw new Error('set RECIPIENT to an identity id on this network');
fs.mkdirSync(`${OUT}/shots`, { recursive: true });
const t0 = Date.now();
const log = (...a) => { const line = `[${((Date.now() - t0) / 1000).toFixed(0)}s] ${a.join(' ')}`; console.log(line); fs.appendFileSync(`${OUT}/log.txt`, `${line}\n`); };

const VIEWS = [
  { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark' },
  { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const members = [];
for (const [i, name] of NAMES.entries()) {
  const dir = `${OUT}/profile-${name}`;
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, { ...VIEWS[i], serviceWorkers: 'block', ignoreHTTPSErrors: process.env.INSECURE_TLS === '1' });
  if (NETWORK === 'local') await ctx.grantPermissions(['local-network-access'], { origin: new URL(BASE).origin }).catch(() => {});
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.setDefaultTimeout(240000);
  page.on('pageerror', (e) => log(name, 'PAGEERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') log(name, 'console.error', m.text().slice(0, 300)); });
  members.push({ name, page, seed: fs.readFileSync(`${SEEDS}/${name}.txt`, 'utf8').trim() });
}
const [a, b, c] = members;

const until = (page, fn, arg, timeout) => page.waitForFunction(fn, arg, { polling: 500, ...(timeout ? { timeout } : {}) });
const idle = (page) => until(page, () => !document.body.classList.contains('is-busy'));
async function shot(m, label) {
  if ((await m.page.evaluate(() => document.querySelector('#unlock-mnemonic')?.value?.length ?? 0)) > 0) throw new Error('seed field not empty at screenshot time');
  const width = await m.page.evaluate(() => document.documentElement.scrollWidth);
  if (width > m.page.viewportSize().width) log('OVERFLOW', label, width);
  await m.page.screenshot({ path: `${OUT}/shots/${label}.png`, fullPage: true });
  log('shot', label);
}
async function toast(m) {
  return (await m.page.textContent('#toast')) ?? '';
}
async function failIfToastBad(m, what) {
  if (await m.page.locator('#toast.toast--bad:not([hidden])').count()) throw new Error(`${m.name} ${what}: ${await toast(m)}`);
}
const view = (m, step) => m.page.click(`.rail [data-view=${step}]`);
const checkAll = async (page, sel) => { while (await page.locator(sel).count()) await page.locator(sel).first().click(); };

async function unlock(m, url = BASE) {
  await m.page.goto(url);
  await m.page.fill('#unlock-mnemonic', m.seed);
  await m.page.click('#form-unlock button.dh-btn--primary');
  await m.page.waitForSelector('#app:not([hidden]) .start');
  log(m.name, 'unlocked');
}

await a.page.goto(BASE);
await shot(a, 'landing');
await unlock(a);
await a.page.fill('#create-label', `E2E ${NETWORK} group`);
await a.page.fill('#create-name', a.name);
await a.page.click('#form-create-room button');
await a.page.waitForSelector('.groupid code');
const room = (await a.page.textContent('.groupid code')).trim();
const invite = `${BASE}#room=${room}`;
log('room', room, 'invite', invite);
await shot(a, 'alone');

for (const m of [b, c]) {
  await unlock(m, invite.replace(/^https?:\/\/[^/]+\//, BASE.replace(/\?.*$/, '')));
  await m.page.fill('#join-name', m.name);
  await m.page.click('#form-join-room button');
  await m.page.waitForSelector('.group');
  await failIfToastBad(m, 'join');
  log(m.name, 'joined');
}
await until(a.page, () => document.querySelectorAll('.person').length === 3, null, 60000);
await checkAll(a.page, '[data-action=verify]:not(:checked)');
await shot(a, 'members');

await a.page.click('[data-action=view][data-view=keys]');
await a.page.fill('#ceremony-threshold', '2');
await a.page.click('#form-ceremony button.dh-btn--primary');
await idle(a.page);
for (const m of members) {
  if (m !== a) await view(m, 'keys');
  await m.page.waitForSelector('#form-accept', { timeout: 60000 });
  await checkAll(m.page, '#form-accept input[name=fp]:not(:checked)');
  await m.page.click('#form-accept button');
  await idle(m.page);
  await failIfToastBad(m, 'accept');
  log(m.name, 'accepted');
}
for (const m of members) await until(m.page, () => /keys are ready/.test(document.querySelector('.step__title')?.textContent ?? ''), null, 180000);
const cid = (await a.page.textContent('.stage .note code')).trim();
log('ceremony complete', cid);
await shot(a, 'keys-ready');
await shot(c, 'keys-ready-phone');

await view(a, 'identity');
await until(a.page, () => /Balance/.test(document.querySelector('.stage')?.textContent ?? ''), null, 60000);
await shot(a, 'fund');
await a.page.click('[data-action=claim-fund]');
await a.page.waitForSelector('#fund-amount');
await a.page.fill('#fund-amount', '0.5');
await a.page.click('#form-identity-create button.dh-btn--primary');
await idle(a.page);
await failIfToastBad(a, 'fund');
log(a.name, 'asset lock and identity proposal:', await toast(a));

for (const m of [b, c]) {
  await view(m, 'identity');
  await m.page.waitForSelector('[data-action=review][data-sign="1"]', { timeout: 120000 });
  await m.page.click('[data-action=review][data-sign="1"]');
  await m.page.waitForSelector('#dialog[open] [data-action=sign]');
  if (m === c) await shot(m, 'review-identity-phone');
  await m.page.click('#dialog [data-action=sign]');
  await idle(m.page);
  await failIfToastBad(m, 'sign identity');
  log(m.name, 'signed the identity');
}
await view(a, 'identity');
await a.page.waitForSelector('[data-action=execute]', { timeout: 120000 });
await a.page.click('[data-action=execute]');
await idle(a.page);
await failIfToastBad(a, 'create identity');
await until(a.page, () => /The group's identity/.test(document.querySelector('.step__title')?.textContent ?? ''), null, 120000);
const identityId = (await a.page.textContent('.stage .dh-kv dd code')).trim();
log('identity', identityId);
await until(a.page, () => /proved/.test(document.querySelector('.stage .dh-kv')?.textContent ?? ''), null, 120000);
await shot(a, 'identity');

await view(b, 'proposals');
await b.page.click('[data-action=new-proposal]');
await b.page.click(`[data-action=kind][data-kind=${KIND}]`);
await b.page.fill(KIND === 'credit-withdrawal' ? '#np-toAddress' : '#np-recipientId', RECIPIENT);
await b.page.fill('#np-amount', '0.001');
await b.page.fill('#np-note', `e2e on ${NETWORK}`);
await b.page.click('#form-propose button.dh-btn--primary');
await idle(b.page);
await failIfToastBad(b, 'propose');
log(b.name, `proposed a ${KIND}`);

for (const m of [c, a]) {
  await view(m, 'proposals');
  await m.page.waitForSelector('[data-action=review][data-sign="1"]', { timeout: 120000 });
  await m.page.click('[data-action=review][data-sign="1"]');
  await m.page.waitForSelector('#dialog[open] [data-action=sign]');
  if (m === a) await shot(m, 'review-transfer');
  if (m === c) await shot(m, 'review-transfer-phone');
  await m.page.click('#dialog [data-action=sign]');
  await idle(m.page);
  await failIfToastBad(m, 'sign transfer');
  log(m.name, 'signed the transfer');
}
await view(c, 'proposals');
await c.page.waitForSelector('[data-action=execute]', { timeout: 120000 });
await c.page.click('[data-action=execute]');
await idle(c.page);
await failIfToastBad(c, 'broadcast transfer');
await until(c.page, () => /History/.test(document.querySelector('.stage')?.textContent ?? '') && !document.querySelector('[data-action=execute]'), null, 120000);
log(c.name, 'broadcast the transfer:', await toast(c));
for (const m of members) { await view(m, 'proposals'); await idle(m.page); }
await shot(a, 'proposals-done');
await shot(c, 'proposals-done-phone');
fs.writeFileSync(`${OUT}/result.json`, JSON.stringify({ network: NETWORK, room, cid, identityId, recipient: RECIPIENT }, null, 1));
log('DONE', JSON.stringify({ network: NETWORK, room, cid, identityId }));
for (const m of members) await m.page.context().close();
