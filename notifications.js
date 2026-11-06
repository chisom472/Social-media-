const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, getSetting, notify } = require('../db');
const { requireAuth } = require('../auth');
const push = require('../push');
const { assertPublicUrl } = require('../utils');

const router = express.Router();

// the public key is needed before login so the browser can register
router.get('/push/key', (req, res) => res.json({ key: push.publicKey() }));

router.use(requireAuth);

router.get('/', (req, res) => {
  const before = parseInt(req.query.before, 10) || 9e15;
  const only = req.query.unread === '1' ? 'AND is_read=0' : '';
  const items = db.prepare(`SELECT id,type,text,link,is_read,created_at FROM notifications WHERE user_id=? AND id<? ${only} ORDER BY id DESC LIMIT 40`).all(req.user.id, before);
  const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0').get(req.user.id).c;
  res.json({ items, unread });
});

router.get('/unread-count', (req, res) => res.json({ unread: db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0').get(req.user.id).c }));

router.post('/read', (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(n => parseInt(n, 10)).filter(Boolean).slice(0, 100) : null;
  if (ids && ids.length) db.prepare(`UPDATE notifications SET is_read=1 WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')})`).run(req.user.id, ...ids);
  else db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});

router.delete('/', (req, res) => {
  db.prepare('DELETE FROM notifications WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});

router.get('/prefs', (req, res) => {
  const u = db.prepare('SELECT notify_email,notify_push,email FROM users WHERE id=?').get(req.user.id);
  res.json({ email: !!u.notify_email, push: !!u.notify_push, has_email: !!u.email, push_available: !!push.publicKey(), devices: db.prepare('SELECT COUNT(*) c FROM push_subscriptions WHERE user_id=?').get(req.user.id).c });
});
router.put('/prefs', (req, res) => {
  const b = req.body || {};
  db.prepare('UPDATE users SET notify_email=COALESCE(?,notify_email), notify_push=COALESCE(?,notify_push) WHERE id=?')
    .run(b.email != null ? (b.email ? 1 : 0) : null, b.push != null ? (b.push ? 1 : 0) : null, req.user.id);
  res.json({ ok: true });
});

const subLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
router.post('/push/subscribe', subLimiter, async (req, res) => {
  const s = (req.body || {}).subscription || {};
  const endpoint = String(s.endpoint || '');
  const k = s.keys || {};
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 600 || !k.p256dh || !k.auth) return res.status(400).json({ error: 'Invalid subscription.' });
  try { await assertPublicUrl(endpoint); } catch (e) { return res.status(400).json({ error: 'Invalid push endpoint.' }); } // never let a user make the server call a private address
  db.prepare(`INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,ua) VALUES(?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`)
    .run(req.user.id, endpoint, String(k.p256dh).slice(0, 200), String(k.auth).slice(0, 100), String(req.headers['user-agent'] || '').slice(0, 120));
  db.prepare('UPDATE users SET notify_push=1 WHERE id=?').run(req.user.id);
  res.json({ ok: true });
});
router.post('/push/unsubscribe', (req, res) => {
  const endpoint = String((req.body || {}).endpoint || '');
  db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(req.user.id, endpoint);
  res.json({ ok: true });
});
router.post('/test', (req, res) => {
  notify(req.user.id, 'test', 'This is a test notification from ' + (getSetting('site_name') || 'Digital Enviro') + '.', '/notifications');
  res.json({ ok: true });
});

module.exports = router;
