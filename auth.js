const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { db, getSetting } = require('../db');
const { setSession, clearSession, requireAuth } = require('../auth');
const { sendMail, esc, clientCountry } = require('../utils');
const sms = require('../sms');
const google = require('../google');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../secrets');
const world = require('../world');
const rec = require('../recommend');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Please wait a few minutes and try again.' } });
const strict = rateLimit({ windowMs: 60 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please try again later.' } });

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const COMMON = new Set(['password', '12345678', '123456789', 'qwertyui', 'password1', 'iloveyou', '11111111', 'abc12345', '1234567890', 'qwerty123', 'letmein1', 'welcome1', 'admin123']);
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

function publicUser(u) {
  return {
    id: u.id, username: u.username, email: u.email || null, phone: u.phone || null, display_name: u.display_name, avatar: u.avatar, avatar_video: u.avatar_video,
    is_creator: !!u.is_creator, bio: u.bio, interests: (u.interests || '').split(',').filter(Boolean), favoured: !!u.favoured,
    dob: u.dob || null, country: u.country || null, region: u.region || null, city: u.city || null, location_privacy: u.location_privacy || 'country',
    notify_email: !!u.notify_email, notify_push: !!u.notify_push, created_at: u.created_at, google_linked: !!u.google_sub, role: u.role, permissions: (u.permissions || '').split(',').filter(Boolean)
  };
}

function checkPassword(pw, username) {
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (COMMON.has(pw.toLowerCase()) || (username && pw.toLowerCase() === String(username).toLowerCase())) return 'That password is too easy to guess. Choose a stronger one.';
  return null;
}

/** "2001-04-30" -> age in years, or null if not a real date in the past. */
function ageFrom(dob) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dob))) return null;
  const d = new Date(dob + 'T00:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== dob || d > new Date()) return null;
  const n = new Date();
  let age = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) age--;
  return age >= 0 && age < 121 ? age : null;
}

function validateLocation(b) {
  const out = {};
  if (b.country != null && b.country !== '') {
    const c = String(b.country).toUpperCase();
    if (!world.isCountry(c)) return { error: 'Choose a valid country.' };
    out.country = c;
  } else if (b.country === '') out.country = null;
  ['region', 'city'].forEach(k => { if (b[k] != null) out[k] = String(b[k]).trim().slice(0, 80) || null; });
  if (b.location_privacy != null) out.location_privacy = ['public', 'country', 'private'].includes(b.location_privacy) ? b.location_privacy : 'country';
  return out;
}

router.post('/signup', limiter, (req, res) => {
  if (getSetting('allow_signups') !== '1') return res.status(403).json({ error: 'Sign-ups are currently closed.' });
  const b = req.body || {};
  const username = String(b.username || '').toLowerCase().trim();
  const email = String(b.email || '').toLowerCase().trim() || null;
  const phoneRaw = String(b.phone || '').trim();
  const phone = phoneRaw ? world.normPhone(phoneRaw) : null;
  const password = String(b.password || '');

  if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores.' });
  if (['admin', 'administrator', 'owner', 'support', 'root', 'system', 'digitalenviro', 'moderator'].includes(username) ) return res.status(400).json({ error: 'That username is reserved.' });
  if (!email && !phone) return res.status(400).json({ error: 'Add an email address or a phone number. You can add the other one later.' });
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (phoneRaw && !phone) return res.status(400).json({ error: 'Enter a valid phone number with your country code, e.g. +2348012345678.' });
  const pwErr = checkPassword(password, username);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (!b.accepted_policy) return res.status(400).json({ error: 'Please accept the community policy to join.' });

  const age = ageFrom(String(b.dob || ''));
  if (age == null) return res.status(400).json({ error: 'Enter your date of birth.' });
  const minAge = parseInt(getSetting('min_age'), 10) || 13;
  if (age < minAge) return res.status(403).json({ error: 'You must be at least ' + minAge + ' years old to join.' });

  const loc = validateLocation(b);
  if (loc.error) return res.status(400).json({ error: loc.error });
  const signupCountry = clientCountry(req);

  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return res.status(409).json({ error: 'That username is taken.' });
  if (email && db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'That email is already registered. Try logging in.' });
  if (phone && db.prepare('SELECT 1 FROM users WHERE phone=?').get(phone)) return res.status(409).json({ error: 'That phone number is already registered. Try logging in.' });

  const list = (Array.isArray(b.interests) ? b.interests : []).map(s => String(s).trim()).filter(Boolean).slice(0, 12);
  const info = db.prepare(`INSERT INTO users(username,email,phone,password_hash,display_name,interests,dob,country,region,city,location_privacy,signup_country,last_country)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(username, email, phone, bcrypt.hashSync(password, 12), String(b.display_name || username).trim().slice(0, 50) || username, list.join(','), b.dob,
      loc.country || signupCountry || null, loc.region || null, loc.city || null, loc.location_privacy || 'country', signupCountry, signupCountry);
  rec.learnSignup(info.lastInsertRowid, list);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  setSession(req, res, user);
  res.json({ user: publicUser(user), onboarding: true });
});

router.post('/login', limiter, (req, res) => {
  const raw = String((req.body || {}).identifier || '').trim();
  const password = String((req.body || {}).password || '');
  const id = raw.toLowerCase();
  const phone = world.normPhone(raw);
  const u = id && password ? db.prepare('SELECT * FROM users WHERE username=? OR email=? OR (phone IS NOT NULL AND phone=?)').get(id, id, phone || '-') : null;
  const log = (uid, ok) => db.prepare('INSERT INTO login_events(user_id,identifier,ok,country,ua) VALUES(?,?,?,?,?)').run(uid, id.slice(0, 60), ok ? 1 : 0, clientCountry(req), String(req.headers['user-agent'] || '').slice(0, 120));

  if (u && u.locked_until && db.prepare("SELECT ? > datetime('now') AS l").get(u.locked_until).l) {
    return res.status(429).json({ error: 'Too many wrong passwords. This account is locked for a few minutes - try again later or reset your password.' });
  }
  const ok = bcrypt.compareSync(password, u ? u.password_hash : DUMMY_HASH) && !!u; // same work whether or not the account exists
  if (!ok) {
    if (u) {
      const fails = (u.failed_logins || 0) + 1;
      if (fails >= 8) db.prepare("UPDATE users SET failed_logins=0, locked_until=datetime('now','+15 minutes') WHERE id=?").run(u.id);
      else db.prepare('UPDATE users SET failed_logins=? WHERE id=?').run(fails, u.id);
      log(u.id, false);
    }
    return res.status(401).json({ error: 'Wrong email, phone, username or password.' });
  }
  if (u.status !== 'active') return res.status(403).json({ error: 'This account has been ' + u.status + ' by the site owner for breaking the policy.' });
  db.prepare("UPDATE users SET failed_logins=0, locked_until=NULL, last_seen=CURRENT_TIMESTAMP, last_country=COALESCE(?,last_country) WHERE id=?").run(clientCountry(req), u.id);
  log(u.id, true);
  setSession(req, res, u);
  res.json({ user: publicUser(u) });
});

router.post('/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

/** Signs the account out on every device. */
router.post('/logout-all', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=?').run(req.user.id);
  clearSession(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({ user: publicUser(u), unread: db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0').get(u.id).c });
});

// ---------- Forgot / reset password (email OR phone) ----------
router.post('/forgot', strict, async (req, res) => {
  const raw = String((req.body || {}).email || (req.body || {}).identifier || '').trim();
  const phone = world.normPhone(raw);
  const u = raw.includes('@')
    ? db.prepare('SELECT id,username,email,phone FROM users WHERE email=?').get(raw.toLowerCase())
    : (phone ? db.prepare('SELECT id,username,email,phone FROM users WHERE phone=?').get(phone) : null);
  let channel = null;
  if (u) {
    const token = crypto.randomBytes(24).toString('hex');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    db.prepare('DELETE FROM password_resets WHERE user_id=?').run(u.id);
    db.prepare("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,datetime('now','+1 hour'))").run(hash, u.id);
    const base = process.env.SITE_URL || (req.protocol + '://' + req.get('host'));
    const link = base + '/reset/' + token;
    try {
      if (raw.includes('@')) {
        await sendMail(u.email, 'Reset your ' + (getSetting('site_name') || 'Digital Enviro') + ' password',
          '<p>Hi ' + esc(u.username) + ',</p><p>Click the link below to choose a new password. It expires in 1 hour.</p><p><a href="' + esc(link) + '">' + esc(link) + '</a></p><p>If you did not ask for this, ignore this email.</p>');
        channel = 'email';
      } else if (await sms.configured()) {
        await sms.send(u.phone, (getSetting('site_name') || 'Digital Enviro') + ' password reset (valid 1 hour): ' + link);
        channel = 'sms';
      }
    } catch (e) { console.error('[reset] delivery failed:', e.message); }
  }
  // identical answer whether or not the account exists (prevents account enumeration)
  res.json({ ok: true, message: 'If we have that email or phone number, a reset link has been sent.' });
});

router.post('/reset', limiter, (req, res) => {
  const { token, password } = req.body || {};
  const pwErr = checkPassword(String(password || ''), null);
  if (!token || pwErr) return res.status(400).json({ error: pwErr || 'Reset link is missing.' });
  const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const row = db.prepare("SELECT * FROM password_resets WHERE token_hash=? AND expires_at > datetime('now')").get(hash);
  if (!row) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  db.prepare('UPDATE users SET password_hash=?, token_version=token_version+1, failed_logins=0, locked_until=NULL WHERE id=?').run(bcrypt.hashSync(String(password), 12), row.user_id);
  db.prepare('DELETE FROM password_resets WHERE user_id=?').run(row.user_id);
  res.json({ ok: true });
});

router.post('/change-password', requireAuth, limiter, (req, res) => {
  const { current, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(String(current || ''), u.password_hash)) return res.status(400).json({ error: 'Current password is wrong.' });
  const pwErr = checkPassword(String(password || ''), u.username);
  if (pwErr) return res.status(400).json({ error: pwErr });
  db.prepare('UPDATE users SET password_hash=?, token_version=token_version+1 WHERE id=?').run(bcrypt.hashSync(password, 12), u.id);
  setSession(req, res, db.prepare('SELECT * FROM users WHERE id=?').get(u.id)); // keep this device signed in, sign out the rest
  res.json({ ok: true });
});

// ---------- Contact details: add / change email or phone later (needs your password) ----------
router.put('/contact', requireAuth, limiter, (req, res) => {
  const b = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(String(b.password || ''), u.password_hash)) return res.status(400).json({ error: 'Enter your current password to change contact details.' });
  let email = u.email, phone = u.phone;
  if (b.email !== undefined) {
    const e = String(b.email || '').toLowerCase().trim();
    if (e && !EMAIL_RE.test(e)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (e && db.prepare('SELECT 1 FROM users WHERE email=? AND id!=?').get(e, u.id)) return res.status(409).json({ error: 'That email is already used by another account.' });
    email = e || null;
  }
  if (b.phone !== undefined) {
    const raw = String(b.phone || '').trim();
    const p = raw ? world.normPhone(raw) : null;
    if (raw && !p) return res.status(400).json({ error: 'Enter a valid phone number with your country code, e.g. +2348012345678.' });
    if (p && db.prepare('SELECT 1 FROM users WHERE phone=? AND id!=?').get(p, u.id)) return res.status(409).json({ error: 'That phone number is already used by another account.' });
    phone = p;
  }
  if (!email && !phone) return res.status(400).json({ error: 'You must keep at least an email or a phone number.' });
  db.prepare('UPDATE users SET email=?, phone=? WHERE id=?').run(email, phone, u.id);
  res.json({ ok: true, email, phone });
});

/** Delete my account and everything attached to it. */
router.post('/delete-account', requireAuth, strict, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (u.role === 'admin') return res.status(400).json({ error: 'The owner account cannot be deleted here.' });
  if (!bcrypt.compareSync(String((req.body || {}).password || ''), u.password_hash)) return res.status(400).json({ error: 'Password is wrong.' });
  const bal = db.prepare('SELECT COALESCE(SUM(balance),0) AS b FROM wallets WHERE user_id=?').get(u.id).b;
  if (bal > 0 && !(req.body || {}).confirm_lose_balance) return res.status(409).json({ error: 'Your wallet still has money in it. Withdraw it first, or confirm that you want to lose it.', has_balance: true });
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  clearSession(res);
  res.json({ ok: true });
});


// ---------- Sign in with Google (optional - the owner turns it on in Admin > Settings) ----------
router.get('/providers', (req, res) => res.json({ google: { enabled: google.enabled(), client_id: google.enabled() ? getSetting('google_client_id') : null } }));

const ticketFor = (data) => jwt.sign(Object.assign({ gt: 1 }, data), jwtSecret, { expiresIn: '15m' });
function readTicket(t) {
  try { const d = jwt.verify(String(t || ''), jwtSecret); return d && d.gt === 1 ? d : null; } catch (e) { return null; }
}

router.post('/google', limiter, async (req, res) => {
  try {
    const g = await google.verify((req.body || {}).credential);
    let u = db.prepare('SELECT * FROM users WHERE google_sub=?').get(g.sub);
    if (u) {
      if (u.status !== 'active') return res.status(403).json({ error: 'This account has been ' + u.status + ' by the site owner.' });
      db.prepare('UPDATE users SET last_seen=CURRENT_TIMESTAMP, last_country=COALESCE(?,last_country) WHERE id=?').run(clientCountry(req), u.id);
      setSession(req, res, u);
      return res.json({ user: publicUser(u) });
    }
    const same = db.prepare('SELECT id,username FROM users WHERE email=?').get(g.email);
    // An account with this email already exists. We never merge silently (someone could have registered it first): ask for that account's password.
    if (same) return res.json({ needs_link: true, ticket: ticketFor({ type: 'link', uid: same.id, sub: g.sub }), username: same.username, email: g.email });
    if (getSetting('allow_signups') !== '1') return res.status(403).json({ error: 'Sign-ups are currently closed.' });
    res.json({ needs_profile: true, ticket: ticketFor({ type: 'new', sub: g.sub, email: g.email, name: g.name }), email: g.email, name: g.name, suggested_username: g.email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 20) });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

router.post('/google/complete', limiter, (req, res) => {
  const t = readTicket((req.body || {}).ticket);
  if (!t || t.type !== 'new') return res.status(400).json({ error: 'This sign-in has expired. Please start again.' });
  const b = req.body || {};
  const username = String(b.username || '').toLowerCase().trim();
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores.' });
  if (!b.accepted_policy) return res.status(400).json({ error: 'Please accept the community policy to join.' });
  const age = ageFrom(String(b.dob || ''));
  if (age == null) return res.status(400).json({ error: 'Enter your date of birth.' });
  const minAge = parseInt(getSetting('min_age'), 10) || 13;
  if (age < minAge) return res.status(403).json({ error: 'You must be at least ' + minAge + ' years old to join.' });
  const loc = validateLocation(b);
  if (loc.error) return res.status(400).json({ error: loc.error });
  const phoneRaw = String(b.phone || '').trim();
  const phone = phoneRaw ? world.normPhone(phoneRaw) : null;
  if (phoneRaw && !phone) return res.status(400).json({ error: 'Enter a valid phone number with your country code, or leave it empty.' });
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return res.status(409).json({ error: 'That username is taken.' });
  if (db.prepare('SELECT 1 FROM users WHERE email=? OR google_sub=?').get(t.email, t.sub)) return res.status(409).json({ error: 'This Google account is already registered. Try signing in.' });
  if (phone && db.prepare('SELECT 1 FROM users WHERE phone=?').get(phone)) return res.status(409).json({ error: 'That phone number is already registered.' });
  const list = (Array.isArray(b.interests) ? b.interests : []).map(x => String(x).trim()).filter(Boolean).slice(0, 12);
  const signupCountry = clientCountry(req);
  const info = db.prepare(`INSERT INTO users(username,email,phone,password_hash,display_name,interests,dob,country,region,city,location_privacy,signup_country,last_country,google_sub)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(username, t.email, phone, bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12), String(b.display_name || t.name || username).trim().slice(0, 50), list.join(','), b.dob,
      loc.country || signupCountry || null, loc.region || null, loc.city || null, loc.location_privacy || 'country', signupCountry, signupCountry, t.sub);
  rec.learnSignup(info.lastInsertRowid, list);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  setSession(req, res, user);
  res.json({ user: publicUser(user), onboarding: true });
});

router.post('/google/link', limiter, (req, res) => {
  const t = readTicket((req.body || {}).ticket);
  if (!t || t.type !== 'link') return res.status(400).json({ error: 'This sign-in has expired. Please start again.' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(t.uid);
  if (!u || !bcrypt.compareSync(String((req.body || {}).password || ''), u.password_hash)) return res.status(401).json({ error: 'Wrong password for that account.' });
  if (u.status !== 'active') return res.status(403).json({ error: 'This account has been ' + u.status + ' by the site owner.' });
  if (db.prepare('SELECT 1 FROM users WHERE google_sub=? AND id!=?').get(t.sub, u.id)) return res.status(409).json({ error: 'That Google account is linked to another user.' });
  db.prepare('UPDATE users SET google_sub=? WHERE id=?').run(t.sub, u.id);
  setSession(req, res, u);
  res.json({ user: publicUser(u) });
});

/** A logged-in user links their Google account so they can sign in with it later. */
router.post('/google/connect', requireAuth, limiter, async (req, res) => {
  try {
    const g = await google.verify((req.body || {}).credential);
    if (db.prepare('SELECT 1 FROM users WHERE google_sub=? AND id!=?').get(g.sub, req.user.id)) return res.status(409).json({ error: 'That Google account is linked to another user.' });
    db.prepare('UPDATE users SET google_sub=? WHERE id=?').run(g.sub, req.user.id);
    if (!db.prepare('SELECT email FROM users WHERE id=?').get(req.user.id).email && !db.prepare('SELECT 1 FROM users WHERE email=?').get(g.email))
      db.prepare('UPDATE users SET email=? WHERE id=?').run(g.email, req.user.id); // a phone-only user gets their Google email added
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

module.exports = router;
module.exports.publicUser = publicUser;
module.exports.ageFrom = ageFrom;
module.exports.validateLocation = validateLocation;
module.exports.checkPassword = checkPassword;
