// The first-start page: log in with RESTOCK_USER / RESTOCK_PASSWORD, then choose a passphrase.
// The browser derives PBKDF2-HMAC-SHA256(NFKC(passphrase), salt, 600000, 64 bytes); only the
// first 32 bytes (the authKey) go to the server. The web app makes the vault when you sign in.

import { pbkdf2 } from './pbkdf2.js';
import { checkPassphrase } from './strength.js';

const $ = (id) => document.getElementById(id);
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let user = 'admin';

function showError(el, text) {
  el.textContent = text;
  el.hidden = !text;
}
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  let data = {};
  try {
    data = await r.json();
  } catch {
    data = {};
  }
  return { ok: r.ok, status: r.status, data };
}
const friendly = (r) => r.data.message || (r.status === 429 ? 'Too many tries. Wait a while and try again.' : "That didn't work. Check the server is running and try again.");

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('login-error');
  showError(err, '');
  const button = e.submitter || $('login').querySelector('button');
  button.disabled = true;
  try {
    user = $('user').value.trim().normalize('NFKC');
    const r = await post('/api/v2/login', { user, password: $('password').value });
    if (!r.ok) return showError(err, r.status === 401 ? 'Wrong user name or password.' : friendly(r));
    $('password').value = '';
    $('choose-user').value = user;
    $('login').hidden = true;
    $('choose').hidden = false;
    $('pass').focus();
  } catch {
    showError(err, "Couldn't reach the server. Check it's running and try again.");
  } finally {
    button.disabled = false;
  }
});

function meter() {
  const c = checkPassphrase($('pass').value, user);
  const bar = $('meter-bar');
  bar.style.width = `${$('pass').value ? 20 + c.score * 20 : 0}%`;
  bar.dataset.score = c.ok ? String(c.score) : '0';
  $('meter-text').textContent = $('pass').value ? (c.ok ? `${c.label}.` : c.reason) : 'Use at least 20 characters, or four or more words.';
  return c;
}
$('pass').addEventListener('input', meter);
$('show').addEventListener('change', () => {
  for (const id of ['pass', 'pass2']) $(id).type = $('show').checked ? 'text' : 'password';
});

$('choose').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('choose-error');
  showError(err, '');
  const c = meter();
  if (!c.ok) return showError(err, c.reason);
  if ($('pass').value !== $('pass2').value) return showError(err, "The two passphrases don't match.");
  const go = $('choose-go');
  go.disabled = true;
  go.textContent = 'Working… (a few seconds)';
  await new Promise((r) => setTimeout(r, 50)); // let the page show that before the work starts
  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const bits = await pbkdf2(new TextEncoder().encode($('pass').value.normalize('NFKC')), salt, 600000, 64);
    const r = await post('/api/v2/passphrase', { salt: b64u(salt), auth: b64u(bits.subarray(0, 32)) });
    bits.fill(0);
    if (!r.ok) {
      if (r.status === 401 || r.data.error === 'signed-out') {
        $('choose').hidden = true;
        $('login').hidden = false;
        return showError($('login-error'), 'That took too long and you were signed out. Log in again.');
      }
      return showError(err, friendly(r));
    }
    // Start the web app signed out, so it asks for the passphrase and opens the vault itself.
    await post('/api/v2/logout', {}).catch(() => {});
    $('pass').value = '';
    $('pass2').value = '';
    $('choose').hidden = true;
    $('done').hidden = false;
  } catch {
    showError(err, "Couldn't reach the server. Check it's running and try again.");
  } finally {
    go.disabled = false;
    go.textContent = 'Set passphrase';
  }
});
