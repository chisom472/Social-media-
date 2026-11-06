const express = require('express');
const { db, getSetting } = require('../db');
const { requireAuth, optionalAuth, featureOn, restrict, hasPerm } = require('../auth');
const ownerfees = require('../ownerfees');
const { uploadMedia, claimMedia, removeFile } = require('../upload');
const { slugify } = require('../utils');
const world = require('../world');

const router = express.Router();
router.use(featureOn('creator_pages'));

const BLOCK_TYPES = ['heading', 'text', 'image', 'video', 'audio', 'link', 'button', 'divider', 'quote', 'code', 'embed'];

function cleanBlocks(input) {
  let arr = input;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = []; } }
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 80).map(b => {
    if (!b || !BLOCK_TYPES.includes(b.type)) return null;
    const o = { type: b.type };
    ['text', 'url', 'label', 'caption', 'lang'].forEach(k => { if (b[k] != null) o[k] = String(b[k]).slice(0, 4000); });
    if (o.url && !/^(https?:\/\/|\/uploads\/)/i.test(o.url)) delete o.url; // block javascript: etc.
    if (b.level) o.level = b.level === 3 ? 3 : 2;
    return o;
  }).filter(Boolean);
}

/**
 * Can this creator use their page? Depends on the owner's settings (Admin > Fees):
 *  - fee off, owner/staff, or this user excused by the owner -> yes
 *  - fee "upfront"        -> only while the subscription is paid
 *  - fee "after classes"  -> free to use; only blocked while a creator-fee invoice is overdue
 */
function subscriptionActive(userId) {
  if (getSetting('creator_fee_required') !== '1' || !ownerfees.paymentsOn('creator_fee')) return true;
  if (ownerfees.waived(userId)) return true;
  if (getSetting('creator_fee_timing') === 'after_classes') {
    return !ownerfees.overdueInvoices(userId).some(i => i.kind === 'creator_fee');
  }
  return !!db.prepare("SELECT 1 FROM creator_subscriptions WHERE user_id=? AND paid_until > datetime('now')").get(userId);
}

router.get('/', optionalAuth, (req, res) => {
  const cat = req.query.category;
  const rows = db.prepare(`SELECT p.id,p.slug,p.name,p.category,p.description,p.cover,u.username,u.display_name,u.avatar,
      (SELECT COUNT(*) FROM follows WHERE target_id=p.owner_id) AS followers
    FROM pages p JOIN users u ON u.id=p.owner_id WHERE u.status='active' ${cat ? 'AND p.category=?' : ''} ORDER BY followers DESC, p.id DESC LIMIT 60`)
    .all(...(cat ? [cat] : []));
  res.json(rows);
});

router.get('/mine/info', requireAuth, (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE owner_id=?').get(req.user.id);
  if (page) page.blocks = JSON.parse(page.blocks || '[]');
  const sub = db.prepare('SELECT paid_until FROM creator_subscriptions WHERE user_id=?').get(req.user.id);
  res.json({
    page,
    fee_required: getSetting('creator_fee_required') === '1' && ownerfees.paymentsOn('creator_fee') && !ownerfees.waived(req.user.id),
    fee_timing: getSetting('creator_fee_timing'),
    fee_currency: world.normCurrency(getSetting('creator_fee_currency'), 'USD'),
    fee_amount: world.toMinor(getSetting('creator_fee_amount'), world.normCurrency(getSetting('creator_fee_currency'), 'USD')),
    fee_days: parseInt(getSetting('creator_fee_days'), 10) || 30,
    paid_until: sub ? sub.paid_until : null,
    active: subscriptionActive(req.user.id)
  });
});

router.get('/:slug', optionalAuth, (req, res) => {
  const p = db.prepare(`SELECT p.*, u.username, u.display_name, u.avatar, u.avatar_video, u.bio FROM pages p JOIN users u ON u.id=p.owner_id WHERE p.slug=? AND u.status='active'`).get(req.params.slug);
  if (!p) return res.status(404).json({ error: 'Page not found.' });
  p.blocks = JSON.parse(p.blocks || '[]');
  p.followers = db.prepare('SELECT COUNT(*) c FROM follows WHERE target_id=?').get(p.owner_id).c;
  p.is_following = req.user ? !!db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND target_id=?').get(req.user.id, p.owner_id) : false;
  p.is_owner = !!(req.user && req.user.id === p.owner_id);
  p.products = db.prepare('SELECT id,title,description,kind,price,currency,cover,category FROM products WHERE active=1 AND seller_id=? AND group_id IS NULL ORDER BY id DESC').all(p.owner_id);
  p.active = subscriptionActive(p.owner_id);
  res.json(p);
});

router.post('/', requireAuth, restrict('page'), (req, res) => {
  if (db.prepare('SELECT 1 FROM pages WHERE owner_id=?').get(req.user.id)) return res.status(409).json({ error: 'You already have a creator page. Edit it instead.' });
  if (!subscriptionActive(req.user.id)) return res.status(402).json({ error: 'A creator subscription is required to open a page.', needs_payment: true });
  const { name, category, description } = req.body || {};
  if (!name || String(name).trim().length < 2) return res.status(400).json({ error: 'Give your page a name.' });
  let slug = slugify(name), n = 1;
  while (db.prepare('SELECT 1 FROM pages WHERE slug=?').get(slug)) slug = slugify(name) + '-' + (++n);
  db.prepare('INSERT INTO pages(owner_id,slug,name,category,description,blocks) VALUES(?,?,?,?,?,?)')
    .run(req.user.id, slug, String(name).slice(0, 80), category || null, String(description || '').slice(0, 500),
      JSON.stringify([{ type: 'heading', text: 'Welcome to ' + String(name).slice(0, 60), level: 2 }, { type: 'text', text: 'Tell visitors what you create and teach.' }]));
  db.prepare('UPDATE users SET is_creator=1 WHERE id=?').run(req.user.id);
  res.json({ slug });
});

router.put('/:slug', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM pages WHERE slug=?').get(req.params.slug);
  if (!p) return res.status(404).json({ error: 'Page not found.' });
  if (p.owner_id !== req.user.id) return res.status(403).json({ error: 'Not your page.' });
  if (!subscriptionActive(req.user.id)) return res.status(402).json({ error: 'Your creator subscription has expired. Renew it to edit your page.', needs_payment: true });
  const { name, category, description, blocks } = req.body || {};
  db.prepare('UPDATE pages SET name=COALESCE(?,name), category=COALESCE(?,category), description=COALESCE(?,description), blocks=COALESCE(?,blocks) WHERE id=?')
    .run(name ? String(name).slice(0, 80) : null, category || null, description != null ? String(description).slice(0, 500) : null,
      blocks != null ? JSON.stringify(cleanBlocks(blocks)) : null, p.id);
  res.json({ ok: true });
});

router.post('/:slug/media', requireAuth, uploadMedia.single('media'), async (req, res) => {
  try {
    const p = db.prepare('SELECT * FROM pages WHERE slug=?').get(req.params.slug);
    if (!p || p.owner_id !== req.user.id) { if (req.file) removeFile(req.file); return res.status(403).json({ error: 'Not your page.' }); }
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    const c = await claimMedia(req.file, req.user.id);
    if (req.body.as === 'cover') db.prepare('UPDATE pages SET cover=? WHERE id=?').run(c.url, p.id);
    res.json({ url: c.url, kind: c.kind });
  } catch (e) {
    if (req.file) removeFile(req.file);
    res.status(e.status || 400).json({ error: e.message, owner: e.owner });
  }
});

router.delete('/:slug', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM pages WHERE slug=?').get(req.params.slug);
  if (!p) return res.status(404).json({ error: 'Page not found.' });
  if (p.owner_id !== req.user.id && !hasPerm(req.user, 'content')) return res.status(403).json({ error: 'Not allowed.' });
  db.prepare('DELETE FROM pages WHERE id=?').run(p.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.subscriptionActive = subscriptionActive;
