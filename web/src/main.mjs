import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const $ = (sel) => document.querySelector(sel);
const engine = Promise.all([import('./session.mjs'), import('./transport.mjs')]);

const invite = new URLSearchParams(location.hash.slice(1)).get('room');
if (invite) history.replaceState(null, '', location.pathname);

function selectTab(name) {
  for (const b of document.querySelectorAll('#tabs button')) {
    if (b.dataset.tab === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
}

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) selectTab(b.dataset.tab);
});
selectTab('room');

$('#unlock-generate').onclick = () => {
  $('#unlock-mnemonic').value = generateMnemonic(wordlist, 128);
  $('#unlock-generated').hidden = false;
};

$('#lock').onclick = () => location.reload();

$('#form-unlock').onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target;
  const error = $('#unlock-error');
  error.hidden = true;
  let session;
  let attach;
  try {
    const [{ TestnetSession }, transport] = await engine;
    attach = transport.attach;
    session = new TestnetSession({ mnemonic: form.mnemonic.value, passphrase: form.passphrase.value, relay: location.origin });
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    return;
  }
  form.reset();
  $('#unlock-generated').hidden = true;
  attach(session);
  $('#unlock').hidden = true;
  for (const el of document.querySelectorAll('[data-unlocked]')) el.hidden = false;
  if (invite) document.querySelector('#form-join-room [name=room]').value = invite;
  await import('../../src/ui/static/app.js');
};
