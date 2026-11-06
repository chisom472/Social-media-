// Key management.
// - The login-token secret and the settings-encryption key are generated once and kept in data/.keys.json (mode 600).
//   Set JWT_SECRET / ENCRYPTION_KEY in .env to supply your own instead (recommended for production).
// - Payment-provider keys, SMTP/SMS passwords and AI API keys are stored AES-256-GCM encrypted in the database,
//   so a leaked database file or backup does not expose them.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, '.keys.json');

function load() {
  let k = {};
  try { k = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first run */ }
  let changed = false;
  if (!k.jwt) { k.jwt = crypto.randomBytes(48).toString('hex'); changed = true; }
  if (!k.enc) { k.enc = crypto.randomBytes(32).toString('hex'); changed = true; }
  if (changed) fs.writeFileSync(file, JSON.stringify(k), { mode: 0o600 });
  return k;
}
const keys = load();

const weak = v => !v || v.length < 32 || /change-this|dev-insecure|your-secret/i.test(v);
if (process.env.JWT_SECRET && weak(process.env.JWT_SECRET)) console.warn('[security] JWT_SECRET in .env is too short or a placeholder - ignoring it and using a generated key.');
const jwtSecret = !weak(process.env.JWT_SECRET) ? process.env.JWT_SECRET : keys.jwt;
const encKey = process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length >= 32
  ? crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest()
  : Buffer.from(keys.enc, 'hex');

const PREFIX = 'enc:v1:';

function encrypt(text) {
  text = String(text == null ? '' : text);
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return PREFIX + iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + ct.toString('base64');
}

function decrypt(value) {
  value = String(value == null ? '' : value);
  if (!value.startsWith(PREFIX)) return value; // plaintext (older value)
  try {
    const [iv, tag, ct] = value.slice(PREFIX.length).split(':').map(s => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (e) {
    console.error('[security] could not decrypt a stored secret (was ENCRYPTION_KEY or data/.keys.json changed?)');
    return '';
  }
}

/** Constant-time string compare. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { jwtSecret, encrypt, decrypt, safeEqual, PREFIX };
