// The passphrase rules (docs/server-protocol.md): at least 20 characters or 4 words, not a
// common password, not the user name, not "admin". Also a rough strength for the meter.

const COMMON = [
  'password', 'passw0rd', 'password1', 'password123', 'p@ssw0rd', '123456', '1234567', '12345678', '123456789', '1234567890', '12345678910',
  'qwerty', 'qwertyuiop', 'qwerty123', 'asdfghjkl', 'zxcvbnm', '1q2w3e4r', '1q2w3e4r5t', 'letmein', 'iloveyou', 'welcome', 'monkey', 'dragon',
  'football', 'baseball', 'sunshine', 'princess', 'abc123', 'admin', 'administrator', 'changeme', 'restock', 'restockserver', 'trustno1',
  'correcthorsebatterystaple', 'thequickbrownfoxjumpsoverthelazydog', 'ilovemyfamily', 'iloveyouforever', 'passwordpassword',
];

const squash = (s) => s.toLowerCase().replace(/[^a-z0-9@]+/g, '');

/** { ok, score (0-4), label, reason } for a passphrase. */
export function checkPassphrase(pass, user = '') {
  const p = String(pass ?? '').normalize('NFKC');
  const chars = [...p].length;
  const words = p.trim().split(/[\s\-_.,;:+/]+/).filter((w) => [...w].length >= 2);
  const unique = new Set(words.map((w) => w.toLowerCase())).size;
  const flat = squash(p);
  let reason = '';
  if (!chars) reason = 'Type a passphrase.';
  else if (flat === squash(user) || flat === 'admin' || (flat.length > 0 && flat.replace(/admin/g, '') === '')) reason = "That's too easy to guess. Don't use the user name or \"admin\".";
  else if (COMMON.includes(flat) || COMMON.some((c) => c.length >= 6 && flat === c.repeat(Math.round(flat.length / c.length)))) reason = "That's a common password. Try four random words.";
  else if (/^(.)\1*$/.test(flat) || /^(.{1,3})\1+$/.test(flat)) reason = "That's just a pattern repeated. Try four random words.";
  else if (chars < 20 && (words.length < 4 || unique < 3)) reason = 'Use at least 20 characters, or four or more words.';

  // A rough guess at how hard it is to guess, for the meter.
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/[0-9]/.test(p)) pool += 10;
  if (/[^A-Za-z0-9]/.test(p)) pool += 20;
  const bits = Math.max(Math.min(chars * Math.log2(pool || 1), chars * 3.5), unique * 11);
  let score = bits < 40 ? 0 : bits < 55 ? 1 : bits < 70 ? 2 : bits < 90 ? 3 : 4;
  if (reason) score = Math.min(score, 1);
  const label = reason ? 'Too weak' : ['Weak', 'OK', 'OK', 'Good', 'Strong'][score];
  return { ok: !reason, score, label, reason };
}
