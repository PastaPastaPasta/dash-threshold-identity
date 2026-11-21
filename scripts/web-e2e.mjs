// Drives a full 2-of-3 run through the hosted page with three browser profiles:
// a room, a key ceremony, an identity funded by alice (SEEDS/alice.txt must hold tDASH
// at its funding address), and a credit transfer to RECIPIENT. Needs `npm i --no-save playwright`.
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'https://new-multisig.dashhq.org/';
const RECIPIENT = process.env.RECIPIENT ?? 'GSv2XVR4yJguY1trogMTZCDNCvc56qc7KYw7cYwRgEQ6';
const OUT = process.env.OUT ?? 'web-e2e-out';
const SEEDS = process.env.SEEDS ?? 'seeds';
fs.mkdirSync(`${OUT}/shots`, { recursive: true });
const t0 = Date.now();
const log = (...a) => { const line = `[${((Date.now() - t0) / 1000).toFixed(0)}s] ${a.join(' ')}`; console.log(line); fs.appendFileSync(`${OUT}/log.txt`, `${line}\n`); };

const MEMBERS = {
  alice: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  bob: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  carol: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

const pages = {};
for (const [name, opts] of Object.entries(MEMBERS)) {
  const dir = `${OUT}/profile-${name}`;
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, { ...opts, serviceWorkers: 'block', args: process.env.RESOLVE ? [`--host-resolver-rules=${process.env.RESOLVE}`] : [] });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.setDefaultTimeout(180000);
  page.on('pageerror', (e) => log(name, 'PAGEERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log(name, `console.${m.type()}`, m.text().slice(0, 300)); });
  pages[name] = page;
}
const { alice, bob, carol } = pages;

async function shot(page, label) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  if (width > page.viewportSize().width) log('OVERFLOW', label, width);
  await page.screenshot({ path: `${OUT}/shots/${label}.png`, fullPage: true });
  log('shot', label);
}

async function tab(page, name) {
  const isPhone = page.viewportSize().width < 600;
  if (isPhone) {
    const visible = await page.locator(`#tabs button[data-tab=${name}]`).isVisible();
    if (!visible) {
      await page.locator('dashhq-bar').locator('button.menu').click();
    }
  }
  await page.locator(`#tabs button[data-tab=${name}]`).click();
}

async function act(page, label, fn, timeout = 180000) {
  await page.evaluate(() => { const f = document.querySelector('#flash'); f.hidden = true; f.textContent = ''; });
  await fn();
  const handle = await page.waitForFunction((l) => { const f = document.querySelector('#flash'); return !f.hidden && f.textContent.startsWith(`${l}:`) ? f.textContent : null; }, label, { timeout, polling: 500 });
  const text = await handle.jsonValue();
  log(label, '->', text.slice(0, 400));
  if (!text.endsWith(': done')) throw new Error(text);
  return text;
}

async function sync(page) {
  await tab(page, 'room');
  await act(page, 'Sync', () => page.click('#sync'));
}

for (const [name, page] of Object.entries(pages)) {
  await page.goto(BASE);
  if (name === 'alice') await shot(page, 'unlock__desktop');
  if (name === 'carol') await shot(page, 'unlock__phone');
  await page.fill('#unlock-mnemonic', fs.readFileSync(`${SEEDS}/${name}.txt`, 'utf8').trim());
  await page.click('#form-unlock button:not([type])');
  await page.waitForSelector('#tab-room', { state: 'visible' });
  log(name, 'unlocked', await page.textContent('#me'));
}

await act(alice, 'Create room', async () => {
  await alice.fill('#form-create-room [name=label]', 'E2E 2-of-3 group');
  await alice.fill('#form-create-room [name=name]', 'alice');
  await alice.click('#form-create-room button');
});
const room = (await alice.textContent('#room-info')).match(/Room ([0-9a-f]{32})/)[1];
log('room', room);
for (const name of ['bob', 'carol']) {
  const page = pages[name];
  await act(page, 'Join room', async () => {
    await page.fill('#form-join-room [name=room]', room);
    await page.fill('#form-join-room [name=name]', name);
    await page.click('#form-join-room button');
  });
}
await sync(alice);
await alice.waitForFunction(() => document.querySelectorAll('#members tr').length === 4);
await shot(alice, 'room-members__desktop');

await tab(alice, 'keys');
await alice.waitForFunction(() => document.querySelectorAll('#ceremony-members input[name=member]').length === 3);
await act(alice, 'Propose ceremony', async () => {
  await alice.fill('#form-ceremony [name=threshold]', '2');
  await alice.fill('#form-ceremony [name=label]', 'E2E group keys (2-of-3)');
  await alice.click('#form-ceremony button');
});

for (const name of ['bob', 'carol']) { await sync(pages[name]); await tab(pages[name], 'keys'); }
for (const [name, page] of Object.entries(pages)) {
  await page.waitForSelector('[data-accept]');
  await act(page, 'Accept', () => page.click('[data-accept]'));
}
for (let round = 0; round < 40; round++) {
  let pending = 0;
  for (const [name, page] of Object.entries(pages)) {
    const status = await page.textContent('#ceremonies .card h2 .chip');
    if (status.trim() === 'complete') continue;
    pending++;
    if (await page.locator('[data-advance]').count()) await act(page, 'Ceremony step', () => page.click('[data-advance]'));
  }
  log('ceremony round', round, 'pending', pending);
  if (!pending) break;
}
const cid = (await alice.textContent('#ceremonies .card .muted')).match(/ceremony ([0-9a-f]{64})/)[1];
log('ceremony complete', cid);
await shot(alice, 'keys-complete__desktop');
await shot(carol, 'keys-complete__phone');

await tab(alice, 'identity');
await act(alice, 'Lock funds and propose identity (this waits for a ChainLock)', async () => {
  await alice.selectOption('#identity-cid', cid);
  await alice.fill('#form-identity-create [name=duffs]', '50000000');
  await alice.click('#form-identity-create button');
}, 30 * 60 * 1000);

async function approveLatest(page) {
  await sync(page);
  await tab(page, 'proposals');
  await page.waitForSelector('[data-approve]');
  await act(page, 'Review', () => page.locator('[data-approve]').first().click());
  await page.waitForSelector('#sign-now');
  return page;
}

for (const name of ['bob', 'carol']) {
  const page = await approveLatest(pages[name]);
  if (name === 'carol') await shot(page, 'review-identity-create__phone');
  if (name === 'bob') await shot(page, 'review-identity-create__desktop-bob');
  await act(page, 'Sign', () => page.click('#sign-now'));
}
await sync(alice);
await tab(alice, 'proposals');
await alice.waitForSelector('[data-execute]');
await act(alice, 'Broadcast', () => alice.locator('[data-execute]').first().click(), 10 * 60 * 1000);
await tab(alice, 'identity');
await alice.waitForSelector('[data-show]');
const identityId = await alice.locator('[data-show]').first().getAttribute('data-show');
log('identity', identityId);
await act(alice, 'Read identity', () => alice.locator('[data-show]').first().click());
fs.writeFileSync(`${OUT}/identity-proved-read.txt`, await alice.textContent('#dialog-body'));
await shot(alice, 'identity-proved-read__desktop');
await alice.click('#dialog-close');

await sync(bob);
await tab(bob, 'new');
await bob.waitForFunction(() => document.querySelector('#propose-identity').options.length > 0);
await act(bob, 'Propose', async () => {
  await bob.selectOption('#propose-kind', 'credit-transfer');
  await bob.fill('#form-propose [name=signer]', 'transfer');
  await bob.fill('#form-propose [name=recipientId]', RECIPIENT);
  await bob.fill('#form-propose [name=amount]', '100000000');
  await bob.fill('#form-propose [name=note]', 'hosted-preview e2e: 0.001 DASH of credits');
  await bob.click('#form-propose button');
}, 10 * 60 * 1000);

for (const name of ['carol', 'alice']) {
  const page = await approveLatest(pages[name]);
  if (name === 'alice') await shot(page, 'review-transfer__desktop');
  if (name === 'carol') await shot(page, 'review-transfer__phone');
  await act(page, 'Sign', () => page.click('#sign-now'));
}
await sync(carol);
await tab(carol, 'proposals');
await carol.waitForSelector('[data-execute]');
await act(carol, 'Broadcast', () => carol.locator('[data-execute]').first().click(), 10 * 60 * 1000);
for (const [name, page] of Object.entries(pages)) { await sync(page); await tab(page, 'proposals'); }
fs.writeFileSync(`${OUT}/proposals-alice.txt`, await alice.textContent('#proposals'));
await shot(alice, 'proposals-executed__desktop');
await shot(carol, 'proposals-executed__phone');
await alice.evaluate(() => window.dashhq.theme.set('dark'));
await shot(alice, 'proposals-executed__desktop-dark');
await tab(alice, 'room');
await shot(alice, 'room__desktop-dark');
log('DONE', JSON.stringify({ room, cid, identityId }));
for (const p of Object.values(pages)) await p.context().close();
