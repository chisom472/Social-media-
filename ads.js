const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, getSetting, notify, notifyStaff } = require('../db');
const { requireAuth, optionalAuth, featureOn, restrict } = require('../auth');
const { uploadMedia, claimMedia, removeFile } = require('../upload');
const { safeUrl, clientCountry } = require('../utils');
const ownerfees = require('../ownerfees');
const world = require('../world');

const router = express.Router();
router.use(featureOn('ads'));

const PLACEMENTS = ['feed', 'reels', 'sidebar', 'banner'];
const adCurrency = () => world.normCurrency(getSetting('ad_currency'), 'USD');
const pricePerDay = () => world.toMinor(getSetting('ad_price_per_day'), adCurrency());

function pricing() {
  return {
    enabled: getSetting('ads_enabled') === '1',
    self_serve: getSetting('ads_self_serve') === '1',
    price_per_day: pricePerDay(), currency: adCurrency(), max_days: parseInt(getSetting('ad_max_days'), 10) || 30,
    auto_approve: getSetting('ad_auto_approve') === '1', placements: PLACEMENTS, payments_on: ownerfees.paymentsOn('ad')
  };
}
router.get('/pricing', (req, res) => res.json(pricing()));

/** Starts an approved advert: runs for its booked number of days from now. */
function activate(adId) {
  const ad = db.prepare('SELECT * FROM ads WHERE id=?').get(adId);
  if (!ad) return;
  db.prepare("UPDATE ads SET status='active', starts_at=COALESCE(starts_at, datetime('now')), ends_at=COALESCE(ends_at, datetime('now', ?)), reject_reason=NULL WHERE id=?")
    .run('+' + (ad.days || 7) + ' days', ad.id);
  if (ad.owner_id) notify(ad.owner_id, 'ads', 'Your advert "' + ad.title + '" is now live.', '/creator/ads');
}

/** Called by payments.finalize when an advert has been paid for. */
function onPaid(order) {
  const ad = db.prepare('SELECT * FROM ads WHERE id=?').get(order.target_id);
  if (!ad) return;
  db.prepare("UPDATE ads SET status='pending', order_ref=? WHERE id=?").run(order.ref, ad.id);
  if (getSetting('ad_auto_approve') === '1') activate(ad.id);
  else {
    notify(ad.owner_id, 'ads', 'Payment received. Your advert is waiting for approval.', '/creator/ads');
    notifyStaff('ads', 'ads', 'New advert waiting for review: "' + ad.title + '"', '/admin');
  }
}

/** Gives the money back (to the advertiser's wallet) when an advert is rejected. */
function refund(ad) {
  if (!ad.owner_id || !ad.order_ref || !(ad.price > 0)) return false;
  const P = require('./payments');
  db.transaction(() => {
    P.credit(ad.owner_id, ad.price, ad.currency, 'refund', ad.order_ref, 'Advert rejected - refund');
    const a = P.adminId();
    if (a) {
      db.prepare('INSERT OR IGNORE INTO wallets(user_id,currency,balance) VALUES(?,?,0)').run(a, ad.currency);
      db.prepare('UPDATE wallets SET balance=balance-? WHERE user_id=? AND currency=?').run(ad.price, a, ad.currency);
      db.prepare("INSERT INTO wallet_tx(user_id,type,amount,currency,ref,note) VALUES(?, 'ad_refund', ?, ?, ?, ?)").run(a, -ad.price, ad.currency, ad.order_ref, 'Advert refunded');
    }
    db.prepare("UPDATE ads SET order_ref=NULL WHERE id=?").run(ad.id);
  })();
  return true;
}

// ---------- Serving ----------
router.get('/serve', optionalAuth, (req, res) => {
  if (getSetting('ads_enabled') !== '1') return res.json([]);
  const placement = PLACEMENTS.includes(req.query.placement) ? req.query.placement : 'feed';
  const n = Math.min(3, Math.max(1, parseInt(req.query.n, 10) || 1));
  const country = (req.user && req.user.country) || clientCountry(req);
  const rows = db.prepare(`SELECT a.*, u.username FROM ads a LEFT JOIN users u ON u.id=a.owner_id
    WHERE a.status='active' AND a.placement=? AND (a.starts_at IS NULL OR a.starts_at<=datetime('now')) AND (a.ends_at IS NULL OR a.ends_at>datetime('now'))
    AND (a.max_impressions IS NULL OR a.impressions<a.max_impressions)`).all(placement)
    .filter(a => !a.countries || !a.countries.trim() || (country && a.countries.split(',').includes(country)));
  const picked = [];
  while (picked.length < n && rows.length) picked.push(rows.splice(Math.floor(Math.random() * rows.length), 1)[0]);
  const bump = db.prepare('UPDATE ads SET impressions=impressions+1 WHERE id=?');
  picked.forEach(a => bump.run(a.id));
  res.json(picked.map(a => ({ id: a.id, title: a.title, body: a.body, media: a.media, media_kind: a.media_kind, cta: a.cta, placement: a.placement, advertiser: a.username || null })));
});

const clickLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
router.get('/:id/click', clickLimiter, (req, res) => {
  const ad = db.prepare("SELECT id,link_url FROM ads WHERE id=? AND status='active'").get(req.params.id);
  const url = ad && safeUrl(ad.link_url);
  if (!url) return res.redirect('/');
  db.prepare('UPDATE ads SET clicks=clicks+1 WHERE id=?').run(ad.id);
  res.set('Referrer-Policy', 'no-referrer').redirect(url);
});

// ---------- Advertiser (any user, when the owner allows it) ----------
router.get('/mine', requireAuth, (req, res) => {
  res.json({ pricing: pricing(), ads: db.prepare('SELECT * FROM ads WHERE owner_id=? ORDER BY id DESC').all(req.user.id) });
});

router.post('/', requireAuth, restrict('ads'), uploadMedia.single('media'), async (req, res) => {
  try {
    const p = pricing();
    if (!p.enabled || getSetting('ads_self_serve') !== '1') throw Object.assign(new Error('Advertising by members is not open right now.'), { status: 403 });
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 80);
    const link = safeUrl(b.link_url);
    if (title.length < 3) throw Object.assign(new Error('Give your advert a title.'), { status: 400 });
    if (!link) throw Object.assign(new Error('Enter the full web address people should be sent to (starting with https://).'), { status: 400 });
    const days = Math.min(p.max_days, Math.max(1, parseInt(b.days, 10) || 7));
    const placement = PLACEMENTS.includes(b.placement) ? b.placement : 'feed';
    const countries = String(b.countries || '').split(',').map(c => c.trim().toUpperCase()).filter(c => world.isCountry(c)).slice(0, 30).join(',');
    let media = null, kind = null;
    if (req.file) { const c = await claimMedia(req.file, req.user.id); media = c.url; kind = c.kind; }
    const free = ownerfees.waived(req.user.id) || !ownerfees.paymentsOn('ad') || p.price_per_day <= 0;
    const price = free ? 0 : p.price_per_day * days;
    const info = db.prepare(`INSERT INTO ads(owner_id,title,body,media,media_kind,link_url,cta,placement,countries,category,status,days,price,currency)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(req.user.id, title, String(b.body || '').slice(0, 300), media, kind, link, String(b.cta || 'Learn more').slice(0, 24), placement, countries, b.category || null, free ? 'pending' : 'pending_payment', days, price, p.currency);
    if (free) notifyStaff('ads', 'ads', 'New advert waiting for review: "' + title + '"', '/admin');
    res.json({ id: info.lastInsertRowid, needs_payment: !free, amount: price, currency: p.currency });
  } catch (e) {
    if (req.file) removeFile(req.file);
    res.status(e.status || 400).json({ error: e.message, owner: e.owner });
  }
});

router.put('/:id', requireAuth, (req, res) => {
  const ad = db.prepare('SELECT * FROM ads WHERE id=? AND owner_id=?').get(req.params.id, req.user.id);
  if (!ad) return res.status(404).json({ error: 'Advert not found.' });
  const st = (req.body || {}).status;
  if (st === 'paused' && ad.status === 'active') db.prepare("UPDATE ads SET status='paused' WHERE id=?").run(ad.id);
  else if (st === 'active' && ad.status === 'paused') db.prepare("UPDATE ads SET status='active' WHERE id=?").run(ad.id);
  else return res.status(400).json({ error: 'Nothing to change.' });
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  const ad = db.prepare('SELECT * FROM ads WHERE id=? AND owner_id=?').get(req.params.id, req.user.id);
  if (!ad) return res.status(404).json({ error: 'Advert not found.' });
  if (ad.status === 'active') return res.status(400).json({ error: 'Pause the advert before removing it.' });
  db.prepare('DELETE FROM ads WHERE id=?').run(ad.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.onPaid = onPaid;
module.exports.activate = activate;
module.exports.refund = refund;
module.exports.PLACEMENTS = PLACEMENTS;
