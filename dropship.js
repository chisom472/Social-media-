// Automated dropshipping.
//  - Suppliers list products (with a cost price) and get orders by webhook / API / dashboard.
//  - Store owners open a BRANDED store (their own name + logo) and list supplier products with their own markup.
//  - Customers buy from the store (guest checkout, any payment method the owner has enabled). Everything the customer sees
//    - page, emails, packing slip - carries the store's brand, never the supplier's.
//  - When the customer's payment is confirmed the order goes to the supplier automatically; when the supplier ships it
//    (or instantly, for digital items) the supplier is paid their cost and the store owner is paid the margin.
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { db, getSetting, notify, notifyStaff } = require('../db');
const { requireAuth, featureOn, restrict } = require('../auth');
const { uploadMedia, uploadProduct, claimMedia, removeFile, PRIVATE_DIR } = require('../upload');
const { esc, slugify, ref, safeUrl, assertPublicUrl, safeFetch, sendMail } = require('../utils');
const secrets = require('../secrets');
const providers = require('../providers');
const world = require('../world');
const path = require('path');
const fs = require('fs');

const router = express.Router();
const storeApi = express.Router();
const supplierApi = express.Router();
router.use(featureOn('dropshipping'));
storeApi.use(featureOn('dropshipping'));
supplierApi.use(featureOn('dropshipping'));
// The automatic Printful path is the default. User-run suppliers only exist when the owner switches them on.
const supplierGate = (req, res, next) => getSetting('dropship_user_suppliers') === '1' ? next() : res.status(404).json({ error: 'Not available.' });
router.use(['/supplier', '/catalog', '/listings'], supplierGate);
supplierApi.use(supplierGate);

const baseUrl = req => process.env.SITE_URL || (req.protocol + '://' + req.get('host'));
const pay = () => require('./payments');
const hmac = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

const myStore = uid => db.prepare('SELECT * FROM stores WHERE owner_id=?').get(uid);
const unitPrice = (listing, product, store) => {
  if (listing.retail_price > 0) return listing.retail_price;
  const m = listing.markup_percent != null ? listing.markup_percent : store.default_markup;
  return Math.max(product.cost + 1, Math.round(product.cost * (1 + m / 100)));
};
const shipsTo = (product, country) => !product.ships_to || product.ships_to === 'ALL' || product.ships_to.split(',').includes(country);

// =====================================================================================
// Store owner
// =====================================================================================
router.get('/store', requireAuth, (req, res) => {
  const s = myStore(req.user.id);
  res.json({ store: s || null, links: s ? storeLinks(s.slug, req) : null, supplier: !!db.prepare('SELECT 1 FROM supplier_profiles WHERE user_id=?').get(req.user.id) });
});

// Memorable store address: https://yoursite/s/<name>  (and <name>.yourdomain.com when the owner has set a store domain)
const RESERVED_SLUGS = new Set(['api', 'new', 'admin', 'www', 'app', 'static', 'uploads', 'login', 'signup', 'reels', 'store', 'shop', 'support', 'help', 'mail', 'cdn', 'assets', 'sitemap', 'robots']);
function cleanSlug(raw) {
  const s = String(raw || '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return s;
}
function slugProblem(slug, ownStoreId) {
  if (slug.length < 3 || slug.length > 30) return 'Use 3 to 30 letters, numbers or dashes.';
  if (RESERVED_SLUGS.has(slug)) return 'That name is reserved. Try another.';
  const t = db.prepare('SELECT id FROM stores WHERE slug=?').get(slug);
  if (t && t.id !== ownStoreId) return 'That name is already taken.';
  return null;
}
const storeLinks = (slug, req) => {
  const dom = String(getSetting('store_domain') || '').trim().toLowerCase();
  return { url: baseUrl(req) + '/s/' + slug, short_url: dom ? 'https://' + slug + '.' + dom : null };
};
router.get('/store/slug-check', requireAuth, (req, res) => {
  const slug = cleanSlug(req.query.slug);
  const own = myStore(req.user.id);
  const problem = slugProblem(slug, own && own.id);
  const suggestions = [];
  if (problem) for (const suffix of ['', '-store', '-shop', '-official', String(new Date().getFullYear())]) {
    const c = cleanSlug(slug + (suffix.startsWith('-') ? suffix : suffix ? '-' + suffix : '')); if (c && c !== slug && !slugProblem(c, own && own.id)) suggestions.push(c);
  }
  res.json({ slug, available: !problem, problem, suggestions: suggestions.slice(0, 4), ...storeLinks(slug, req) });
});

router.put('/store', requireAuth, restrict('sell'), (req, res) => {
  const b = req.body || {};
  const brand = String(b.brand_name || '').trim().slice(0, 60);
  if (brand.length < 2) return res.status(400).json({ error: 'Enter your brand name - it appears on everything your customers see.' });
  const color = /^#[0-9a-fA-F]{6}$/.test(b.color || '') ? b.color : '#2fd89a';
  const markup = Math.min(1000, Math.max(0, parseFloat(b.default_markup) || 40));
  const support = String(b.support_email || '').trim().toLowerCase().slice(0, 120);
  if (support && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(support)) return res.status(400).json({ error: 'Enter a valid support email.' });
  const s = myStore(req.user.id);
  let slug = b.slug ? cleanSlug(b.slug) : null;
  if (slug) { const p = slugProblem(slug, s && s.id); if (p) return res.status(400).json({ error: p }); }
  if (s) {
    // changing the address is allowed, but not more than once every 30 days so shared links are not broken constantly
    if (slug && slug !== s.slug) {
      if (s.slug_changed_at && db.prepare("SELECT ? > datetime('now','-30 days') AS r").get(s.slug_changed_at).r) return res.status(400).json({ error: 'You can change your store address once every 30 days.' });
      db.prepare('INSERT OR REPLACE INTO store_slug_history(slug,store_id) VALUES(?,?)').run(s.slug, s.id); // the old link keeps working (redirects)
      db.prepare("UPDATE stores SET slug=?, slug_changed_at=CURRENT_TIMESTAMP WHERE id=?").run(slug, s.id);
    }
    db.prepare('UPDATE stores SET brand_name=?, tagline=?, color=?, support_email=?, default_markup=?, active=COALESCE(?,active) WHERE id=?')
      .run(brand, String(b.tagline || '').slice(0, 140), color, support || null, markup, b.active != null ? (b.active ? 1 : 0) : null, s.id);
    const now = slug || s.slug;
    return res.json({ ok: true, slug: now, ...storeLinks(now, req) });
  }
  if (!slug) { slug = cleanSlug(brand); let n = 1; const base = slug.length >= 3 ? slug : 'store'; slug = base; while (slugProblem(slug)) slug = base + '-' + (++n); }
  const mode = b.dropship_mode === 'all' || require('../dropship').get(b.dropship_mode) ? b.dropship_mode : 'all';
  db.prepare('INSERT INTO stores(owner_id,slug,brand_name,tagline,color,support_email,default_markup,dropship_mode) VALUES(?,?,?,?,?,?,?,?)')
    .run(req.user.id, slug, brand, String(b.tagline || '').slice(0, 140), color, support || null, markup, mode);
  res.json({ ok: true, slug, ...storeLinks(slug, req) });
});

router.post('/store/logo', requireAuth, uploadMedia.single('logo'), async (req, res) => {
  try {
    const s = myStore(req.user.id);
    if (!s) { if (req.file) removeFile(req.file); return res.status(400).json({ error: 'Create your store first.' }); }
    if (!req.file || !/^image\//.test(req.file.mimetype)) { if (req.file) removeFile(req.file); return res.status(400).json({ error: 'Upload your logo as a picture.' }); }
    const m = await claimMedia(req.file, req.user.id);
    db.prepare('UPDATE stores SET logo=? WHERE id=?').run(m.url, s.id);
    res.json({ url: m.url });
  } catch (e) {
    if (req.file) removeFile(req.file);
    res.status(e.status || 400).json({ error: e.message, owner: e.owner });
  }
});

// Supplier products a store owner can sell
router.get('/catalog', requireAuth, (req, res) => {
  const w = ['p.active=1', "(p.stock IS NULL OR p.stock>0)"], a = [];
  if (req.query.category) { w.push('p.category=?'); a.push(req.query.category); }
  if (req.query.kind) { w.push('p.kind=?'); a.push(req.query.kind); }
  if (req.query.q) { w.push('(p.title LIKE ? OR p.description LIKE ?)'); const q = '%' + String(req.query.q).replace(/[%_]/g, '') + '%'; a.push(q, q); }
  const rows = db.prepare(`SELECT p.id,p.title,p.description,p.images,p.kind,p.cost,p.currency,p.stock,p.ships_to,p.shipping_fee,p.processing_days,p.category,sp.business_name AS supplier
    FROM supplier_products p JOIN supplier_profiles sp ON sp.user_id=p.supplier_id WHERE ${w.join(' AND ')} ORDER BY p.id DESC LIMIT 80`).all(...a);
  rows.forEach(r => { try { r.images = JSON.parse(r.images); } catch (e) { r.images = []; } });
  res.json(rows);
});

router.get('/listings', requireAuth, (req, res) => {
  const s = myStore(req.user.id);
  if (!s) return res.json([]);
  const rows = db.prepare(`SELECT l.*, p.title AS product_title, p.images, p.cost, p.currency, p.kind, p.stock, p.active AS product_active
    FROM store_listings l JOIN supplier_products p ON p.id=l.product_id WHERE l.store_id=? ORDER BY l.id DESC`).all(s.id);
  rows.forEach(r => { try { r.images = JSON.parse(r.images); } catch (e) { r.images = []; } r.price = unitPrice(r, { cost: r.cost }, s); });
  res.json(rows);
});

router.post('/listings', requireAuth, restrict('sell'), (req, res) => {
  const s = myStore(req.user.id);
  if (!s) return res.status(400).json({ error: 'Create your store (brand name + logo) first.' });
  const b = req.body || {};
  const p = db.prepare('SELECT * FROM supplier_products WHERE id=? AND active=1').get(b.product_id);
  if (!p) return res.status(404).json({ error: 'Product not found.' });
  if (p.supplier_id === req.user.id) return res.status(400).json({ error: 'This is your own supplier product.' });
  const retail = b.retail_price ? world.toMinor(b.retail_price, p.currency) : null;
  if (retail != null && retail <= p.cost) return res.status(400).json({ error: 'Your price must be higher than the supplier cost (' + world.format(p.cost, p.currency) + ').' });
  const info = db.prepare(`INSERT INTO store_listings(store_id,product_id,markup_percent,retail_price,title,description) VALUES(?,?,?,?,?,?)
    ON CONFLICT(store_id,product_id) DO UPDATE SET markup_percent=excluded.markup_percent, retail_price=excluded.retail_price, title=excluded.title, description=excluded.description, active=1`)
    .run(s.id, p.id, b.markup_percent != null && b.markup_percent !== '' ? Math.max(0, parseFloat(b.markup_percent)) : null, retail, b.title ? String(b.title).slice(0, 120) : null, b.description ? String(b.description).slice(0, 3000) : null);
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.put('/listings/:id', requireAuth, (req, res) => {
  const s = myStore(req.user.id);
  const l = s && db.prepare('SELECT l.*, p.cost, p.currency FROM store_listings l JOIN supplier_products p ON p.id=l.product_id WHERE l.id=? AND l.store_id=?').get(req.params.id, s.id);
  if (!l) return res.status(404).json({ error: 'Listing not found.' });
  const b = req.body || {};
  const retail = b.retail_price ? world.toMinor(b.retail_price, l.currency) : (b.retail_price === '' ? null : undefined);
  if (retail && retail <= l.cost) return res.status(400).json({ error: 'Your price must be higher than the supplier cost.' });
  db.prepare('UPDATE store_listings SET markup_percent=?, retail_price=?, title=COALESCE(?,title), description=COALESCE(?,description), active=COALESCE(?,active) WHERE id=?')
    .run(b.markup_percent != null && b.markup_percent !== '' ? Math.max(0, parseFloat(b.markup_percent)) : l.markup_percent, retail === undefined ? l.retail_price : retail,
      b.title ? String(b.title).slice(0, 120) : null, b.description != null ? String(b.description).slice(0, 3000) : null, b.active != null ? (b.active ? 1 : 0) : null, l.id);
  res.json({ ok: true });
});
router.delete('/listings/:id', requireAuth, (req, res) => {
  const s = myStore(req.user.id);
  if (s) db.prepare('DELETE FROM store_listings WHERE id=? AND store_id=?').run(req.params.id, s.id);
  res.json({ ok: true });
});

router.get('/orders', requireAuth, (req, res) => {
  const s = myStore(req.user.id);
  if (!s) return res.json([]);
  res.json(db.prepare(`SELECT o.ref,o.qty,o.customer_name,o.customer_email,o.country,o.unit_price,o.unit_cost,o.shipping,o.total,o.currency,o.status,o.tracking_number,o.tracking_url,o.carrier,o.note,o.settled,o.created_at,
    o.provider,o.capital,COALESCE(p.title, pl.title) AS product FROM dropship_orders o LEFT JOIN supplier_products p ON p.id=o.product_id LEFT JOIN pf_listings pl ON pl.id=o.pf_listing_id WHERE o.store_id=? AND o.status!='awaiting_payment' ORDER BY o.id DESC LIMIT 200`).all(s.id));
});

// =====================================================================================
// Supplier
// =====================================================================================
const supplierOf = uid => db.prepare('SELECT user_id,business_name,contact_email,webhook_url,(api_key_hash IS NOT NULL) AS has_key,(webhook_secret IS NOT NULL) AS has_secret FROM supplier_profiles WHERE user_id=?').get(uid);

router.get('/supplier', requireAuth, (req, res) => res.json({ supplier: supplierOf(req.user.id) || null }));

router.put('/supplier', requireAuth, restrict('sell'), async (req, res) => {
  const b = req.body || {};
  const name = String(b.business_name || '').trim().slice(0, 80);
  if (name.length < 2) return res.status(400).json({ error: 'Enter your business name.' });
  let hook = null;
  if (b.webhook_url) {
    try { hook = (await assertPublicUrl(String(b.webhook_url).trim())).toString(); } catch (e) { return res.status(400).json({ error: 'Webhook address: ' + e.message }); }
  }
  const exists = db.prepare('SELECT 1 FROM supplier_profiles WHERE user_id=?').get(req.user.id);
  if (exists) db.prepare('UPDATE supplier_profiles SET business_name=?, contact_email=?, webhook_url=? WHERE user_id=?').run(name, String(b.contact_email || '').slice(0, 120) || null, hook, req.user.id);
  else db.prepare('INSERT INTO supplier_profiles(user_id,business_name,contact_email,webhook_url,webhook_secret) VALUES(?,?,?,?,?)')
    .run(req.user.id, name, String(b.contact_email || '').slice(0, 120) || null, hook, secrets.encrypt(crypto.randomBytes(24).toString('hex')));
  res.json({ ok: true });
});

/** Shows the signing secret once; use it to check the X-DE-Signature header on order webhooks. */
router.post('/supplier/webhook-secret', requireAuth, (req, res) => {
  if (!supplierOf(req.user.id)) return res.status(400).json({ error: 'Create your supplier profile first.' });
  const secret = crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE supplier_profiles SET webhook_secret=? WHERE user_id=?').run(secrets.encrypt(secret), req.user.id);
  res.json({ secret });
});
router.post('/supplier/api-key', requireAuth, (req, res) => {
  if (!supplierOf(req.user.id)) return res.status(400).json({ error: 'Create your supplier profile first.' });
  const key = 'dek_' + req.user.id + '_' + crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE supplier_profiles SET api_key_hash=? WHERE user_id=?').run(crypto.createHash('sha256').update(key).digest('hex'), req.user.id);
  res.json({ api_key: key, note: 'Copy it now - it is shown only once.' });
});

router.get('/supplier/products', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM supplier_products WHERE supplier_id=? ORDER BY id DESC').all(req.user.id);
  rows.forEach(r => { try { r.images = JSON.parse(r.images); } catch (e) { r.images = []; } r.has_file = !!r.file; delete r.file; });
  res.json(rows);
});

function readProduct(b, cur) {
  const currency = world.normCurrency(b.currency, cur ? cur.currency : null);
  if (!currency) throw Object.assign(new Error('Choose the currency of your cost price.'), { status: 400 });
  const cost = b.cost != null ? world.toMinor(b.cost, currency) : (cur ? cur.cost : 0);
  if (!(cost > 0)) throw Object.assign(new Error('Enter your cost price (what the store owner pays you).'), { status: 400 });
  const ships = String(b.ships_to || 'ALL').toUpperCase().split(',').map(s => s.trim()).filter(c => c === 'ALL' || world.isCountry(c));
  return {
    title: String(b.title || '').trim().slice(0, 120), description: String(b.description || '').slice(0, 3000), sku: b.sku ? String(b.sku).slice(0, 60) : null,
    kind: b.kind === 'digital' ? 'digital' : 'physical', cost, currency, stock: b.stock === '' || b.stock == null ? null : Math.max(0, parseInt(b.stock, 10) || 0),
    ships_to: ships.includes('ALL') || !ships.length ? 'ALL' : ships.join(','), shipping_fee: Math.max(0, world.toMinor(b.shipping_fee || 0, currency)),
    processing_days: Math.min(60, Math.max(0, parseInt(b.processing_days, 10) || 3)), category: b.category || null
  };
}

router.post('/supplier/products', requireAuth, restrict('sell'), (req, res) => {
  if (!supplierOf(req.user.id)) return res.status(400).json({ error: 'Create your supplier profile first.' });
  try {
    const p = readProduct(req.body || {});
    if (p.title.length < 3) return res.status(400).json({ error: 'Give the product a title.' });
    const info = db.prepare('INSERT INTO supplier_products(supplier_id,sku,title,description,kind,cost,currency,stock,ships_to,shipping_fee,processing_days,category) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(req.user.id, p.sku, p.title, p.description, p.kind, p.cost, p.currency, p.stock, p.ships_to, p.shipping_fee, p.processing_days, p.category);
    res.json({ id: info.lastInsertRowid });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
router.put('/supplier/products/:id', requireAuth, (req, res) => {
  const cur = db.prepare('SELECT * FROM supplier_products WHERE id=? AND supplier_id=?').get(req.params.id, req.user.id);
  if (!cur) return res.status(404).json({ error: 'Product not found.' });
  try {
    const b = { ...cur, ...(req.body || {}), cost: req.body && req.body.cost != null ? req.body.cost : world.toMajor(cur.cost, cur.currency), shipping_fee: req.body && req.body.shipping_fee != null ? req.body.shipping_fee : world.toMajor(cur.shipping_fee, cur.currency) };
    const p = readProduct(b, cur);
    db.prepare('UPDATE supplier_products SET sku=?,title=?,description=?,kind=?,cost=?,currency=?,stock=?,ships_to=?,shipping_fee=?,processing_days=?,category=?,active=COALESCE(?,active) WHERE id=?')
      .run(p.sku, p.title || cur.title, p.description, p.kind, p.cost, p.currency, p.stock, p.ships_to, p.shipping_fee, p.processing_days, p.category, req.body && req.body.active != null ? (req.body.active ? 1 : 0) : null, cur.id);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
router.delete('/supplier/products/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE supplier_products SET active=0 WHERE id=? AND supplier_id=?').run(req.params.id, req.user.id); // keep history for existing orders
  res.json({ ok: true });
});
router.post('/supplier/products/:id/image', requireAuth, uploadMedia.single('media'), async (req, res) => {
  try {
    const p = db.prepare('SELECT * FROM supplier_products WHERE id=? AND supplier_id=?').get(req.params.id, req.user.id);
    if (!p) { if (req.file) removeFile(req.file); return res.status(404).json({ error: 'Product not found.' }); }
    if (!req.file || !/^image\//.test(req.file.mimetype)) { if (req.file) removeFile(req.file); return res.status(400).json({ error: 'Upload a picture.' }); }
    const imgs = JSON.parse(p.images || '[]');
    if (imgs.length >= 6) { removeFile(req.file); return res.status(400).json({ error: 'Up to 6 pictures per product.' }); }
    imgs.push((await claimMedia(req.file, req.user.id)).url);
    db.prepare('UPDATE supplier_products SET images=? WHERE id=?').run(JSON.stringify(imgs), p.id);
    res.json({ images: imgs });
  } catch (e) {
    if (req.file) removeFile(req.file);
    res.status(e.status || 400).json({ error: e.message, owner: e.owner });
  }
});
router.delete('/supplier/products/:id/image', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM supplier_products WHERE id=? AND supplier_id=?').get(req.params.id, req.user.id);
  if (!p) return res.status(404).json({ error: 'Product not found.' });
  const imgs = JSON.parse(p.images || '[]').filter(u => u !== (req.body || {}).url);
  db.prepare('UPDATE supplier_products SET images=? WHERE id=?').run(JSON.stringify(imgs), p.id);
  res.json({ images: imgs });
});
// the downloadable file for a digital product (private - only paying customers can get it)
router.post('/supplier/products/:id/file', requireAuth, uploadProduct.single('file'), (req, res) => {
  const p = db.prepare('SELECT id FROM supplier_products WHERE id=? AND supplier_id=?').get(req.params.id, req.user.id);
  if (!p || !req.file) { if (req.file) removeFile(req.file); return res.status(404).json({ error: 'Product not found.' }); }
  db.prepare("UPDATE supplier_products SET file=?, kind='digital' WHERE id=?").run(req.file.filename, p.id);
  res.json({ ok: true });
});

const SUPPLIER_ORDER_SQL = `SELECT o.id,o.ref,o.qty,o.customer_name,o.customer_phone,o.ship_to,o.country,o.unit_cost,o.shipping,o.currency,o.status,o.tracking_number,o.carrier,o.note,o.created_at,
  p.title AS product,p.sku,s.brand_name AS store FROM dropship_orders o JOIN supplier_products p ON p.id=o.product_id JOIN stores s ON s.id=o.store_id WHERE o.supplier_id=?`;
router.get('/supplier/orders', requireAuth, (req, res) => {
  res.json(db.prepare(SUPPLIER_ORDER_SQL + " AND o.status NOT IN ('awaiting_payment') ORDER BY o.id DESC LIMIT 200").all(req.user.id));
});

router.post('/supplier/orders/:ref/ship', requireAuth, async (req, res) => {
  const o = db.prepare('SELECT * FROM dropship_orders WHERE ref=? AND supplier_id=?').get(req.params.ref, req.user.id);
  const r = await markShipped(o, req.body || {});
  res.status(r.ok ? 200 : (r.status || 400)).json(r);
});
router.post('/supplier/orders/:ref/cannot-fulfil', requireAuth, (req, res) => {
  const o = db.prepare('SELECT * FROM dropship_orders WHERE ref=? AND supplier_id=?').get(req.params.ref, req.user.id);
  const r = cannotFulfil(o, String((req.body || {}).note || '').slice(0, 300));
  res.status(r.ok ? 200 : 400).json(r);
});

// A printable packing slip that carries the STORE's brand (never the supplier's or the platform's)
router.get('/supplier/orders/:ref/packing-slip', requireAuth, (req, res) => {
  const o = db.prepare(`SELECT o.*, p.title AS product, p.sku, s.brand_name, s.logo, s.support_email, s.color FROM dropship_orders o JOIN supplier_products p ON p.id=o.product_id JOIN stores s ON s.id=o.store_id
    WHERE o.ref=? AND o.supplier_id=?`).get(req.params.ref, req.user.id);
  if (!o) return res.status(404).send('Not found');
  let addr = {}; try { addr = JSON.parse(o.ship_to || '{}'); } catch (e) { /* ignore */ }
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Packing slip ${esc(o.ref)}</title>
<style>body{font-family:Arial,sans-serif;max-width:720px;margin:30px auto;color:#111}.h{display:flex;align-items:center;gap:14px;border-bottom:3px solid ${/^#[0-9a-f]{6}$/i.test(o.color) ? o.color : '#2fd89a'};padding-bottom:12px}
.h img{height:56px}table{width:100%;border-collapse:collapse;margin-top:18px}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left}.muted{color:#666;font-size:13px}@media print{button{display:none}}</style></head><body>
<div class="h">${o.logo ? `<img src="${esc(o.logo)}" alt="">` : ''}<div><h2 style="margin:0">${esc(o.brand_name)}</h2><div class="muted">${esc(o.support_email || '')}</div></div></div>
<h3>Order ${esc(o.ref)}</h3><p class="muted">${esc(o.created_at)}</p>
<p><b>Ship to</b><br>${esc(o.customer_name)}<br>${esc(addr.line1 || '')}<br>${esc(addr.line2 || '')}${addr.line2 ? '<br>' : ''}${esc([addr.city, addr.state, addr.postal].filter(Boolean).join(', '))}<br>${esc(o.country || '')}<br>${esc(o.customer_phone || '')}</p>
<table><tr><th>Item</th><th>SKU</th><th>Qty</th></tr><tr><td>${esc(o.product)}</td><td>${esc(o.sku || '')}</td><td>${o.qty}</td></tr></table>
<p class="muted">Thank you for shopping with ${esc(o.brand_name)}.</p><button onclick="print()">Print</button></body></html>`);
});

// =====================================================================================
// Order lifecycle
// =====================================================================================
/** Pays the supplier their cost, pays the store owner the margin (minus the platform commission). Runs once per order. */
function settle(orderId) {
  const P = pay();
  db.transaction(() => {
    const o = db.prepare('SELECT * FROM dropship_orders WHERE id=?').get(orderId);
    if (!o || o.settled) return;
    const store = db.prepare('SELECT * FROM stores WHERE id=?').get(o.store_id);
    const supplierAmount = o.unit_cost * o.qty + o.shipping;
    const margin = Math.max(0, o.total - supplierAmount);
    P.credit(o.supplier_id, supplierAmount, o.currency, 'dropship_supply', o.ref, 'Supplied order ' + o.ref + ' for ' + store.brand_name);
    if (margin > 0) P.settleToSeller(store.owner_id, margin, o.currency, o.ref, 'Dropship profit: order ' + o.ref);
    db.prepare("UPDATE dropship_orders SET settled=1, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(o.id);
    setImmediate(() => { try { require('../ownerfees').onDropshipSale(store, o, margin); } catch (e) { console.error('[dropship fee]', e.message); } });
    notify(o.supplier_id, 'sale', 'You were paid ' + world.format(supplierAmount, o.currency) + ' for order ' + o.ref, '/wallet');
    notify(store.owner_id, 'sale', 'Order ' + o.ref + ' completed - profit ' + world.format(margin, o.currency), '/dropship');
  })();
}

async function markShipped(o, b) {
  if (!o) return { ok: false, status: 404, error: 'Order not found.' };
  if (!['paid', 'processing', 'awaiting_supplier', 'needs_attention'].includes(o.status)) return { ok: false, error: 'This order cannot be marked as shipped (status: ' + o.status + ').' };
  const tracking = String(b.tracking_number || '').trim().slice(0, 80);
  const carrier = String(b.carrier || '').trim().slice(0, 60);
  const url = b.tracking_url ? safeUrl(b.tracking_url) : null;
  if (!tracking) return { ok: false, error: 'Enter the tracking number.' };
  db.prepare("UPDATE dropship_orders SET status='shipped', tracking_number=?, carrier=?, tracking_url=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(tracking, carrier || null, url, o.id);
  settle(o.id);
  emailCustomer(o.ref, 'shipped').catch(e => console.error('[dropship mail]', e.message));
  return { ok: true };
}

function cannotFulfil(o, note) {
  if (!o || !['paid', 'processing', 'awaiting_supplier', 'needs_attention'].includes(o.status)) return { ok: false, error: 'Order not found or already handled.' };
  db.prepare("UPDATE dropship_orders SET status='refund_needed', note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(note || 'Supplier cannot fulfil', o.id);
  const store = db.prepare('SELECT owner_id,brand_name FROM stores WHERE id=?').get(o.store_id);
  notify(store.owner_id, 'order', 'Supplier cannot fulfil order ' + o.ref + '. The customer must be refunded.', '/dropship');
  notifyStaff('payments_manage', 'order', 'Dropship order ' + o.ref + ' needs a refund to the customer (' + world.format(o.total, o.currency) + ').', '/admin');
  return { ok: true };
}

/** Sends the order to the supplier (signed webhook) - retried by the background job until it works. */
async function fulfill(orderId) {
  const o = db.prepare('SELECT * FROM dropship_orders WHERE id=?').get(orderId);
  if (!o || !['paid', 'awaiting_supplier', 'needs_attention'].includes(o.status)) return;
  if (o.provider !== 'supplier') return require('./pod').submit(o.id);
  const sup = db.prepare('SELECT * FROM supplier_profiles WHERE user_id=?').get(o.supplier_id);
  const prod = db.prepare('SELECT * FROM supplier_products WHERE id=?').get(o.product_id);
  const store = db.prepare('SELECT * FROM stores WHERE id=?').get(o.store_id);
  db.prepare("UPDATE dropship_orders SET attempts=attempts+1, last_attempt=CURRENT_TIMESTAMP WHERE id=?").run(o.id);
  if (!sup || !sup.webhook_url) {
    // no automatic channel: the supplier fulfils from their dashboard
    db.prepare("UPDATE dropship_orders SET status='awaiting_supplier', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(o.id);
    notify(o.supplier_id, 'order', 'New order ' + o.ref + ' to ship: ' + prod.title + ' x' + o.qty, '/dropship');
    return;
  }
  let addr = {}; try { addr = JSON.parse(o.ship_to || '{}'); } catch (e) { /* ignore */ }
  const body = JSON.stringify({
    event: 'order.created', order_ref: o.ref, sku: prod.sku, product_id: prod.id, title: prod.title, quantity: o.qty,
    brand: { name: store.brand_name, logo: store.logo ? (process.env.SITE_URL || '') + store.logo : null, support_email: store.support_email }, // ship in the STORE's branding
    ship_to: { name: o.customer_name, phone: o.customer_phone, email: o.customer_email, country: o.country, ...addr },
    unit_cost: o.unit_cost, shipping: o.shipping, currency: o.currency
  });
  try {
    const r = await safeFetch(sup.webhook_url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-de-signature': hmac(secrets.decrypt(sup.webhook_secret), body), 'x-de-event': 'order.created' }, body
    }, { timeoutMs: 15000 });
    if (!r.ok) throw new Error('Supplier endpoint answered ' + r.status);
    db.prepare("UPDATE dropship_orders SET status='processing', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(o.id);
  } catch (e) {
    const tries = db.prepare('SELECT attempts FROM dropship_orders WHERE id=?').get(o.id).attempts;
    if (tries >= 6) {
      db.prepare("UPDATE dropship_orders SET status='needs_attention', note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run('Could not reach supplier: ' + e.message.slice(0, 150), o.id);
      notify(o.supplier_id, 'order', 'We could not deliver order ' + o.ref + ' to your system. Please open your dashboard to ship it.', '/dropship');
      notify(store.owner_id, 'order', 'Order ' + o.ref + ' needs attention - the supplier could not be reached automatically.', '/dropship');
    } else db.prepare("UPDATE dropship_orders SET status='awaiting_supplier', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(o.id);
  }
}

/** Branded emails: the customer only ever sees the store's name and logo. */
async function emailCustomer(orderRef, kind) {
  const o = db.prepare(`SELECT o.*, COALESCE(p.title, pl.title) AS product, s.brand_name, s.logo, s.color, s.support_email, s.slug FROM dropship_orders o LEFT JOIN supplier_products p ON p.id=o.product_id LEFT JOIN pf_listings pl ON pl.id=o.pf_listing_id JOIN stores s ON s.id=o.store_id WHERE o.ref=?`).get(orderRef);
  if (!o || !o.customer_email) return;
  const base = process.env.SITE_URL || '';
  const link = base + '/s/' + o.slug + '/order/' + o.ref;
  const head = `<div style="border-bottom:3px solid ${/^#[0-9a-f]{6}$/i.test(o.color) ? o.color : '#2fd89a'};padding-bottom:10px;margin-bottom:14px">${o.logo && base ? `<img src="${esc(base + o.logo)}" height="48" alt="">` : ''}<h2 style="margin:6px 0">${esc(o.brand_name)}</h2></div>`;
  const foot = `<p style="color:#888;font-size:12px">Questions? ${o.support_email ? 'Contact ' + esc(o.support_email) : 'Reply to this email.'}</p>`;
  const body = kind === 'shipped'
    ? `<p>Good news, ${esc(o.customer_name)} - your order <b>${esc(o.ref)}</b> (${esc(o.product)} x${o.qty}) is on its way.</p>${o.tracking_number ? `<p>Tracking: <b>${esc(o.tracking_number)}</b>${o.carrier ? ' (' + esc(o.carrier) + ')' : ''}</p>` : ''}${o.tracking_url ? `<p><a href="${esc(o.tracking_url)}">Track your parcel</a></p>` : ''}`
    : `<p>Thank you for your order, ${esc(o.customer_name)}!</p><p><b>${esc(o.product)}</b> x${o.qty}<br>Total paid: <b>${esc(world.format(o.total, o.currency))}</b><br>Order number: <b>${esc(o.ref)}</b></p>${o.download_token ? `<p><a href="${esc(link)}">Download your purchase</a></p>` : `<p>We will email you when it ships.</p>`}`;
  await sendMail(o.customer_email, (kind === 'shipped' ? 'Your order has shipped - ' : 'Order confirmed - ') + o.brand_name, head + body + `<p><a href="${esc(link)}">View your order</a></p>` + foot, o.brand_name);
}

/** Inside the payment transaction (synchronous): mark the dropship order as paid. */
function onPaid(order) {
  const o = db.prepare('SELECT * FROM dropship_orders WHERE id=?').get(order.target_id);
  if (!o) return;
  if (o.provider !== 'supplier') { db.prepare("UPDATE dropship_orders SET status='paid', pay_ref=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(order.ref, o.id); return; }
  const prod = db.prepare('SELECT kind,stock FROM supplier_products WHERE id=?').get(o.product_id);
  if (prod.stock != null) db.prepare('UPDATE supplier_products SET stock=MAX(0,stock-?) WHERE id=?').run(o.qty, o.product_id);
  if (prod.kind === 'digital') db.prepare("UPDATE dropship_orders SET status='paid', pay_ref=?, download_token=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(order.ref, crypto.randomBytes(20).toString('hex'), o.id);
  else db.prepare("UPDATE dropship_orders SET status='paid', pay_ref=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(order.ref, o.id);
}

/** After the payment transaction: deliver / forward the order. */
async function afterPaid(payRef) {
  const o = db.prepare('SELECT d.* FROM dropship_orders d WHERE d.pay_ref=?').get(payRef);
  if (!o) return;
  const store = db.prepare('SELECT owner_id,brand_name FROM stores WHERE id=?').get(o.store_id);
  notify(store.owner_id, 'sale', 'New order ' + o.ref + ' on ' + store.brand_name + ' - ' + world.format(o.total, o.currency), '/dropship');
  if (o.download_token) { // digital goods: instant delivery, instant settlement
    db.prepare("UPDATE dropship_orders SET status='delivered' WHERE id=?").run(o.id);
    settle(o.id);
  } else await fulfill(o.id);
  emailCustomer(o.ref, 'confirmed').catch(e => console.error('[dropship mail]', e.message));
}

// =====================================================================================
// Public storefront API  (/api/store/...) - customers do not need an account
// =====================================================================================
const guestLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Please try again later.' } });

function storeBySlug(slug) {
  slug = String(slug || '').toLowerCase();
  const s = db.prepare("SELECT id,owner_id,slug,brand_name,logo,tagline,color,support_email FROM stores WHERE slug=? AND active=1").get(slug);
  if (s) return s;
  const old = db.prepare('SELECT s.id,s.owner_id,s.slug,s.brand_name,s.logo,s.tagline,s.color,s.support_email FROM store_slug_history h JOIN stores s ON s.id=h.store_id WHERE h.slug=? AND s.active=1').get(slug);
  return old || undefined; // an old address still opens the store (the page shows the new address)
}
function publicListing(l, store) {
  let images = []; try { images = JSON.parse(l.images || '[]'); } catch (e) { /* ignore */ }
  const full = db.prepare('SELECT * FROM store_listings WHERE id=?').get(l.id);
  return { id: l.id, title: l.title || l.product_title, description: l.description || l.product_description, images, kind: l.kind, currency: l.currency, price: unitPrice(full, { cost: l.cost }, db.prepare('SELECT default_markup FROM stores WHERE id=?').get(store.id)), shipping: l.shipping_fee, ships_to: l.ships_to, in_stock: l.stock == null || l.stock > 0, processing_days: l.processing_days };
}
const LISTING_SQL = `SELECT l.id,l.title,l.description,p.title AS product_title,p.description AS product_description,p.images,p.kind,p.currency,p.cost,p.shipping_fee,p.ships_to,p.stock,p.processing_days
  FROM store_listings l JOIN supplier_products p ON p.id=l.product_id WHERE l.store_id=? AND l.active=1 AND p.active=1`;

const ORDER_VIEW_SQL = `SELECT o.ref,o.qty,o.status,o.total,o.currency,o.tracking_number,o.tracking_url,o.carrier,o.customer_email,o.download_token,o.created_at,COALESCE(p.title, pl.title) AS product,s.slug,s.brand_name,s.logo,s.color
    FROM dropship_orders o LEFT JOIN supplier_products p ON p.id=o.product_id LEFT JOIN pf_listings pl ON pl.id=o.pf_listing_id JOIN stores s ON s.id=o.store_id WHERE o.ref=?`;
storeApi.get('/order/:ref', guestLimiter, async (req, res) => {
  let o = db.prepare(ORDER_VIEW_SQL).get(req.params.ref);
  if (!o || String(req.query.email || '').trim().toLowerCase() !== String(o.customer_email || '').toLowerCase()) return res.status(404).json({ error: 'Order not found. Check the email address you used.' });
  if (o.status === 'awaiting_payment') { // customer just came back from the payment page: confirm with the provider right away
    const po = db.prepare("SELECT ref FROM orders WHERE purpose='dropship' AND target_id=(SELECT id FROM dropship_orders WHERE ref=?) ORDER BY id DESC").get(req.params.ref);
    if (po) { const r = await pay().verifyAndFinalize(po.ref).catch(() => null); if (r && r.ok) o = db.prepare(ORDER_VIEW_SQL).get(req.params.ref); }
  }
  const out = { ...o, can_download: !!(o.download_token && ['delivered', 'shipped'].includes(o.status)) };
  delete out.download_token; delete out.customer_email;
  res.json(out);
});
storeApi.get('/order/:ref/download', guestLimiter, (req, res) => {
  const o = db.prepare(`SELECT o.customer_email,o.download_token,o.status,p.file,p.title FROM dropship_orders o JOIN supplier_products p ON p.id=o.product_id WHERE o.ref=?`).get(req.params.ref);
  if (!o || !o.download_token || String(req.query.email || '').toLowerCase() !== String(o.customer_email || '').toLowerCase() || !['delivered', 'shipped'].includes(o.status)) return res.status(404).json({ error: 'Not available.' });
  if (!o.file) return res.status(404).json({ error: 'The supplier has not uploaded this file yet.' });
  const full = path.join(PRIVATE_DIR, path.basename(o.file));
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'File missing.' });
  res.download(full, o.title.replace(/[^\w.\- ]+/g, '_') + path.extname(o.file));
});

storeApi.get('/:slug', (req, res) => {
  const s = storeBySlug(req.params.slug);
  if (!s) return res.status(404).json({ error: 'Store not found.' });
  const listings = db.prepare(LISTING_SQL + ' ORDER BY l.id DESC LIMIT 100').all(s.id).map(l => publicListing(l, s));
  const pod = require('./pod');
  const printed = db.prepare('SELECT * FROM pf_listings WHERE store_id=? AND active=1 ORDER BY id DESC LIMIT 100').all(s.id).map(pod.shapePublic);
  delete s.owner_id;
  res.json({ store: s, listings, printed });
});
storeApi.get('/:slug/product/:id', (req, res) => {
  const s = storeBySlug(req.params.slug);
  const l = s && db.prepare(LISTING_SQL + ' AND l.id=?').get(s.id, req.params.id);
  if (!l) return res.status(404).json({ error: 'Product not found.' });
  delete s.owner_id;
  res.json({ store: s, product: publicListing(l, s), payment_methods: providers.forCurrency(l.currency, 'dropship').filter(p => !p.manual).map(p => ({ id: p.id, label: p.label, kind: p.kind })) });
});

storeApi.post('/:slug/checkout', guestLimiter, async (req, res) => {
  try {
    const s = storeBySlug(req.params.slug);
    const b = req.body || {};
    const l = s && db.prepare(LISTING_SQL + ' AND l.id=?').get(s.id, b.listing_id);
    if (!l) return res.status(404).json({ error: 'Product not found.' });
    const qty = Math.min(20, Math.max(1, parseInt(b.qty, 10) || 1));
    const name = String(b.name || '').trim().slice(0, 80), email = String(b.email || '').trim().toLowerCase().slice(0, 120);
    const country = String(b.country || '').toUpperCase();
    if (name.length < 2) return res.status(400).json({ error: 'Enter your name.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address - your receipt and tracking are sent there.' });
    if (!world.isCountry(country)) return res.status(400).json({ error: 'Choose your country.' });
    if (l.stock != null && l.stock < qty) return res.status(400).json({ error: 'Sorry, only ' + l.stock + ' left in stock.' });
    if (!shipsTo(l, country)) return res.status(400).json({ error: 'Sorry, this item does not ship to your country.' });
    const a = b.address || {};
    const addr = l.kind === 'physical' ? { line1: String(a.line1 || '').trim().slice(0, 120), line2: String(a.line2 || '').trim().slice(0, 120), city: String(a.city || '').trim().slice(0, 60), state: String(a.state || '').trim().slice(0, 60), postal: String(a.postal || '').trim().slice(0, 20) } : {};
    if (l.kind === 'physical' && (!addr.line1 || !addr.city)) return res.status(400).json({ error: 'Enter your delivery address.' });

    const full = db.prepare('SELECT * FROM store_listings WHERE id=?').get(l.id);
    const unit = unitPrice(full, { cost: l.cost }, db.prepare('SELECT default_markup FROM stores WHERE id=?').get(s.id));
    const shipping = l.kind === 'physical' ? l.shipping_fee : 0;
    const total = unit * qty + shipping;
    const options = providers.forCurrency(l.currency, 'dropship').filter(p => !p.manual);
    if (!options.length) return res.status(503).json({ error: 'This store cannot take ' + l.currency + ' payments right now. Please try later.' });
    const provider = options.find(p => p.id === b.provider) || options[0];
    const supplierProd = db.prepare('SELECT id,supplier_id FROM supplier_products WHERE id=(SELECT product_id FROM store_listings WHERE id=?)').get(l.id);

    const dRef = ref('do'), payRef = ref('de');
    const dId = db.prepare(`INSERT INTO dropship_orders(ref,store_id,listing_id,product_id,supplier_id,qty,customer_name,customer_email,customer_phone,ship_to,country,unit_price,unit_cost,shipping,total,currency)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(dRef, s.id, l.id, supplierProd.id, supplierProd.supplier_id, qty, name, email, String(b.phone || '').slice(0, 30) || null, JSON.stringify(addr), country, unit, l.cost, shipping, total, l.currency).lastInsertRowid;
    db.prepare("INSERT INTO orders(ref,buyer_id,buyer_email,target_id,purpose,seller_id,amount,currency,provider) VALUES(?,NULL,?,?, 'dropship', ?, ?, ?, ?)")
      .run(payRef, email, dId, s.owner_id, total, l.currency, provider.id);
    const base = baseUrl(req);
    const callback = base + '/s/' + s.slug + '/order/' + dRef + '?email=' + encodeURIComponent(email);
    const init = await provider.init({
      email, minor: total, currency: l.currency, reference: payRef, callback, successUrl: callback, cancelUrl: base + '/s/' + s.slug,
      webhookUrl: base + '/api/pay/webhook/' + provider.id, title: s.brand_name + ': ' + (l.title || l.product_title), metadata: { purpose: 'dropship', store: s.slug }, recurring: null
    });
    if (init.providerRef) db.prepare('UPDATE orders SET provider_ref=? WHERE ref=?').run(init.providerRef, payRef);
    res.json({ authorization_url: init.url, order_ref: dRef });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// =====================================================================================
// Supplier API (server-to-server, Authorization: Bearer <api key>)  - /api/dropship/api/...
// =====================================================================================
supplierApi.use(rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false }));
supplierApi.use((req, res, next) => {
  const m = String(req.headers.authorization || '').match(/^Bearer (dek_(\d+)_[0-9a-f]+)$/);
  const sup = m && db.prepare('SELECT user_id,api_key_hash FROM supplier_profiles WHERE user_id=?').get(parseInt(m[2], 10));
  if (!sup || !sup.api_key_hash || !require('../secrets').safeEqual(sup.api_key_hash, crypto.createHash('sha256').update(m[1]).digest('hex'))) return res.status(401).json({ error: 'Invalid API key.' });
  req.supplierId = sup.user_id;
  next();
});
supplierApi.get('/orders', (req, res) => {
  const st = String(req.query.status || '');
  res.json(db.prepare(SUPPLIER_ORDER_SQL + (st ? ' AND o.status=?' : " AND o.status IN ('processing','awaiting_supplier','paid')") + ' ORDER BY o.id DESC LIMIT 200').all(...(st ? [req.supplierId, st] : [req.supplierId])));
});
supplierApi.post('/orders/:ref/ship', async (req, res) => {
  const o = db.prepare('SELECT * FROM dropship_orders WHERE ref=? AND supplier_id=?').get(req.params.ref, req.supplierId);
  const r = await markShipped(o, req.body || {});
  res.status(r.ok ? 200 : (r.status || 400)).json(r);
});
supplierApi.post('/orders/:ref/cannot-fulfil', (req, res) => {
  const o = db.prepare('SELECT * FROM dropship_orders WHERE ref=? AND supplier_id=?').get(req.params.ref, req.supplierId);
  const r = cannotFulfil(o, String((req.body || {}).note || '').slice(0, 300));
  res.status(r.ok ? 200 : 400).json(r);
});
supplierApi.put('/products/:sku/stock', (req, res) => {
  const stock = req.body && req.body.stock != null ? Math.max(0, parseInt(req.body.stock, 10) || 0) : null;
  const r = db.prepare('UPDATE supplier_products SET stock=? WHERE supplier_id=? AND sku=?').run(stock, req.supplierId, req.params.sku);
  res.status(r.changes ? 200 : 404).json(r.changes ? { ok: true } : { error: 'SKU not found.' });
});

/** Creates the payment record and the provider checkout for a dropship order already saved as awaiting_payment. */
async function beginPayment(req, s, dId, { title, providerId }) {
  const o = db.prepare('SELECT * FROM dropship_orders WHERE id=?').get(dId);
  const options = providers.forCurrency(o.currency, 'dropship').filter(p => !p.manual);
  if (!options.length) { db.prepare("DELETE FROM dropship_orders WHERE id=? AND status='awaiting_payment'").run(dId); throw Object.assign(new Error('This store cannot take ' + o.currency + ' payments right now. Please try later.'), { status: 503 }); }
  const provider = options.find(p => p.id === providerId) || options[0];
  const payRef = ref('de');
  db.prepare("INSERT INTO orders(ref,buyer_id,buyer_email,target_id,purpose,seller_id,amount,currency,provider) VALUES(?,NULL,?,?, 'dropship', ?, ?, ?, ?)")
    .run(payRef, o.customer_email, dId, s.owner_id, o.total, o.currency, provider.id);
  const base = baseUrl(req);
  const callback = base + '/s/' + s.slug + '/order/' + o.ref + '?email=' + encodeURIComponent(o.customer_email);
  const init = await provider.init({
    email: o.customer_email, minor: o.total, currency: o.currency, reference: payRef, callback, successUrl: callback, cancelUrl: base + '/s/' + s.slug,
    webhookUrl: base + '/api/pay/webhook/' + provider.id, title: s.brand_name + ': ' + title, metadata: { purpose: 'dropship', store: s.slug }, recurring: null
  });
  if (init.providerRef) db.prepare('UPDATE orders SET provider_ref=? WHERE ref=?').run(init.providerRef, payRef);
  return { authorization_url: init.url, order_ref: o.ref };
}

/** Background job: forward orders that have not reached the supplier yet (with growing delays). */
async function retryPending() {
  const rows = db.prepare(`SELECT id FROM dropship_orders WHERE provider='supplier' AND status IN ('paid','awaiting_supplier') AND attempts<6
    AND (last_attempt IS NULL OR last_attempt < datetime('now', '-' || (attempts*attempts*2) || ' minutes')) LIMIT 20`).all();
  for (const r of rows) await fulfill(r.id);
}

module.exports = router;
module.exports.storeApi = storeApi;
module.exports.supplierApi = supplierApi;
module.exports.onPaid = onPaid;
module.exports.afterPaid = afterPaid;
module.exports.retryPending = retryPending;
module.exports.beginPayment = beginPayment;
module.exports.emailCustomer = emailCustomer;
