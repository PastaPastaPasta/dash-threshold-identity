import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { isNetwork, network as networkOf, configureNetwork } from '../../src/networks.mjs';
import { MAINNET_WRITES } from './flags.mjs';

const $ = (sel) => document.querySelector(sel);
const engine = Promise.all([import('./session.mjs'), import('./transport.mjs')]);

const params = new URLSearchParams(location.search);
const asked = params.get('network') ?? 'testnet';
const hash = new URLSearchParams(location.hash.slice(1));
const invite = hash.get('room');
const inviteLabel = hash.get('name')?.slice(0, 80) ?? null;
if (invite) history.replaceState(null, '', `${location.pathname}${location.search}`);

const STRIP = {
  mainnet: MAINNET_WRITES ? '<strong>Mainnet.</strong> Real DASH. Every signature here moves real money.' : '<strong>Mainnet, read only.</strong> Real DASH. You can open groups and check balances; key ceremonies, signing and funding are off in this build until they have been reviewed.',
  testnet: '<strong>Testnet.</strong> Practice money. Your seed phrase stays in this tab and is gone when you close it.',
  devnet: '<strong>Devnet.</strong> A developer network with practice money. Your seed phrase stays in this tab.',
  local: '<strong>Local network.</strong> A Platform network on this computer. Your seed phrase stays in this tab.',
};

function setupNetwork() {
  if (!isNetwork(asked)) {
    $('#landing').hidden = true;
    $('#bad-network').hidden = false;
    $('#bad-network-name').textContent = asked;
    return null;
  }
  const n = networkOf(asked);
  document.documentElement.dataset.network = n.kind;
  const strip = $('.strip');
  strip.innerHTML = STRIP[n.kind];
  const bar = $('dashhq-bar');
  if (n.kind === 'local') bar.removeAttribute('network');
  else bar.setAttribute('network', n.id);
  for (const a of document.querySelectorAll('.nets a')) {
    if (a.dataset.net === n.kind) a.setAttribute('aria-current', 'true');
    else a.removeAttribute('aria-current');
  }
  $('#net-now').textContent = n.label;
  $('#devnet-form').hidden = n.kind !== 'devnet' && !params.has('pick-devnet');
  if (n.kind === 'devnet') $('#devnet-name').value = n.devnet;
  $('#local-settings').hidden = n.kind !== 'local';
  if (n.kind === 'local') {
    $('#local-insight').value = n.insight;
    $('#local-quorums').value = n.quorums;
  }
  document.title = `Multisig (${n.label}) · dashhq`;
  if (invite) $('.landing__title').textContent = 'You were invited to a group';
  return n;
}

const net = setupNetwork();

const go = (id) => location.assign(`${location.pathname}?network=${encodeURIComponent(id)}`);

$('dashhq-bar').addEventListener('dashhq-network', (e) => {
  e.preventDefault();
  go(e.detail.network);
});

$('#devnet-form').onsubmit = (e) => {
  e.preventDefault();
  const name = $('#devnet-name').value.trim().toLowerCase().replace(/^devnet-/, '');
  if (!isNetwork(`devnet-${name}`)) {
    $('#devnet-error').hidden = false;
    return;
  }
  go(`devnet-${name}`);
};

$('#unlock-generate').onclick = () => {
  $('#unlock-mnemonic').value = generateMnemonic(wordlist, 128);
  $('#unlock-generated').hidden = false;
};

$('#lock').onclick = () => location.reload();

$('#form-unlock').onsubmit = async (e) => {
  e.preventDefault();
  if (!net) return;
  const form = e.target;
  const error = $('#unlock-error');
  error.hidden = true;
  let session;
  let attach;
  let platform;
  try {
    if (net.kind === 'local') configureNetwork('local', { insight: $('#local-insight').value.trim(), quorums: $('#local-quorums').value.trim() });
    const [{ NetworkSession }, transport] = await engine;
    attach = transport.attach;
    platform = transport.platform;
    session = new NetworkSession({ mnemonic: form.mnemonic.value, passphrase: form.passphrase.value, relay: location.origin, network: net.id, mainnetWrites: MAINNET_WRITES });
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    return;
  }
  attach(session);
  platform.invite = invite;
  platform.inviteLabel = inviteLabel;
  try {
    await import('../../src/ui/static/app.js');
  } catch {
    error.textContent = 'This page could not finish loading. Reload it and unlock again.';
    error.hidden = false;
    return;
  }
  form.reset();
  $('#unlock-generated').hidden = true;
  $('#landing').hidden = true;
  for (const el of document.querySelectorAll('[data-unlocked]')) el.hidden = false;
  window.scrollTo({ top: 0 });
};
