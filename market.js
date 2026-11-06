const express = require('express');
const path = require('path');
const fs = require('fs');
const { db, notify } = require('../db');
const { requireAuth, optionalAuth, featureOn, restrict, hasPerm } = require('../auth');
const { uploadProduct, uploadMedia, claimMedia, removeFile, PRIVATE_DIR } = require('../upload');
const { isMember } = require('./groups');
const world = require('../world');
const { getSetting } = require('../db');

const router = express.Router();
router.use(featureOn('marketplace'));

function hasAccess(product, userId) {
  if (!userId) return false;
  if (product.seller_id === userId) return true;
  if (product.price === 0) {
    if (product.group_id && product.members_only) return isMember(product.group_id, userId);
    return true; // free product for everyone who is logged in
  }
  return !!db.prepare("SELECT 1 FROM orders WHERE buyer_id=? AND product_id=? AND status='paid'").get(userId, product.id);
}

router.get('/', optionalAuth, (req, res) => {
  const { category, q, kind } = req.query;
  const where = ['p.active=1', '(p.group_id IS NULL OR p.members_only=0)'], args = [];
  if (category) { where.push('p.category=?'); args.push(category); }
  if (kind) { where.push('p.kind=?'); args.push(kind); }
  if (q) { where.push('(p.title LIKE ? OR p.description LIKE ?)'); args.push('%' + q + '%', '%' + q + '%'); }
  res.json(db.prepare(`SELECT p.id,p.title,p.description,p.kind,p.price,p.currency,p.cover,p.category,p.seller_id,p.group_id,u.username,u.display_name
    FROM products p JOIN users u ON u.id=p.seller_id WHERE ${where.join(' AND ')} AND u.status='active' ORDER BY p.id DESC LIMIT 80`).all(...args));
});

router.get('/mine', requireAuth, (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE seller_id=? ORDER BY id DESC').all(req.user.id);
  const purchases = db.prepare(`SELECT o.id,o.ref,o.amount,o.currency,o.created_at,p.id AS product_id,p.title,p.kind,u.username AS seller
    FROM orders o JOIN products p ON p.id=o.product_id JOIN users u ON u.id=p.seller_id WHERE o.buyer_id=? AND o.status='paid' ORDER BY o.id DESC`).all(req.user.id);
  const sales = db.prepare(`SELECT o.id,o.amount,o.currency,o.created_at,p.title,u.username AS buyer FROM orders o JOIN products p ON p.id=o.product_id JOIN users u ON u.id=o.buyer_id
    WHERE p.seller_id=? AND o.status='paid' ORDER BY o.id DESC LIMIT 100`).all(req.user.id);
  res.json({ products, purchases, sales });
});

router.get('/:id', optionalAuth, (req, res) => {
  const p = db.prepare(`SELECT p.*, u.username, u.display_name, u.avatar FROM products p JOIN users u ON u.id=p.seller_id WHERE p.id=?`).get(req.params.id);
  if (!p || (!p.active && !(req.user && req.user.id === p.seller_id))) return res.status(404).json({ error: 'Product not found.' });
  const access = hasAccess(p, req.user && req.user.id);
  delete p.file;
  res.json({ ...p, has_access: access, is_owner: !!(req.user && req.user.id === p.seller_id), downloadable: !!db.prepare('SELECT file FROM products WHERE id=? AND file IS NOT NULL').get(p.id) });
});

// create a product / service (free or paid) on your profile, page or group
router.post('/', requireAuth, restrict('sell'), uploadProduct.fields([{ name: 'file', maxCount: 1 }]), async (req, res) => {
  const f = req.files && req.files.file && req.files.file[0];
  try {
    const { title, description, kind, price, category, group_id, currency, members_only } = req.body || {};
    const cur = world.normCurrency(currency, world.normCurrency(getSetting('default_currency'), 'USD'));
    if (!title || String(title).trim().length < 2) throw Object.assign(new Error('Give your product a title.'), { status: 400 });
    const k = ['digital', 'service', 'course', 'template', 'ebook', 'software', 'media', 'other'].includes(kind) ? kind : 'digital';
    let gid = null;
    if (group_id) {
      gid = parseInt(group_id, 10);
      const g = db.prepare('SELECT owner_id FROM groups_ WHERE id=?').get(gid);
      if (!g || !isMember(gid, req.user.id)) throw Object.assign(new Error('You must be a member of that group.'), { status: 403 });
    }
    const page = db.prepare('SELECT id FROM pages WHERE owner_id=?').get(req.user.id);
    const info = db.prepare('INSERT INTO products(seller_id,page_id,group_id,title,description,kind,price,currency,members_only,file,category) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(req.user.id, gid ? null : (page ? page.id : null), gid, String(title).slice(0, 120), String(description || '').slice(0, 3000), k,
        Math.max(0, world.toMinor(price, cur)), cur, gid && (members_only === '1' || members_only === true || members_only === 'true') ? 1 : 0, f ? f.filename : null, category || null);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (f) removeFile(f);
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.post('/:id/cover', requireAuth, uploadMedia.single('media'), async (req, res) => {
  try {
    const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
    if (!p || p.seller_id !== req.user.id) { if (req.file) removeFile(req.file); return res.status(403).json({ error: 'Not allowed.' }); }
    const c = await claimMedia(req.file, req.user.id);
    db.prepare('UPDATE products SET cover=? WHERE id=?').run(c.url, p.id);
    res.json({ url: c.url });
  } catch (e) {
    if (req.file) removeFile(req.file);
    res.status(e.status || 400).json({ error: e.message, owner: e.owner });
  }
});

router.put('/:id', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p || p.seller_id !== req.user.id) return res.status(403).json({ error: 'Not allowed.' });
  const { title, description, price, active, currency } = req.body || {};
  const cur = world.normCurrency(currency, p.currency);
  db.prepare('UPDATE products SET title=COALESCE(?,title), description=COALESCE(?,description), price=COALESCE(?,price), currency=?, active=COALESCE(?,active) WHERE id=?')
    .run(title || null, description != null ? String(description).slice(0, 3000) : null, price != null ? Math.max(0, world.toMinor(price, cur)) : null, cur, active != null ? (active ? 1 : 0) : null, p.id);
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p || (p.seller_id !== req.user.id && !hasPerm(req.user, 'content'))) return res.status(403).json({ error: 'Not allowed.' });
  db.prepare('DELETE FROM products WHERE id=?').run(p.id);
  res.json({ ok: true });
});

// secure download: only the seller, buyers, or (for free items) eligible members
router.get('/:id/download', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p || !p.file) return res.status(404).json({ error: 'No file attached to this product.' });
  if (!hasAccess(p, req.user.id)) return res.status(403).json({ error: 'Buy or join to download this.' });
  const full = path.join(PRIVATE_DIR, path.basename(p.file));
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'File missing.' });
  res.download(full, p.title.replace(/[^\w.\- ]+/g, '_') + path.extname(p.file));
});

module.exports = router;
module.exports.hasAccess = hasAccess;
