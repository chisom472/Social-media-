// Automatic dropshipping across several trusted worldwide platforms (see src/dropship/).
//
//   Seller  : picks a product from any enabled platform (or lets the app use all of them), adds their brand/design, sets THEIR price
//   Buyer   : pays on the seller's store. The app chooses the best platform for the product + the buyer's country,
//             places the order automatically (the seller does nothing) and the platform ships straight to the buyer.
//   Money   : "capital" (production + shipping) stays with the platform owner, who pays the platform;
//             the seller's profit (price paid - capital) goes to the seller's wallet when the parcel ships.
const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getSetting, setSetting, notify, notifyStaff } = require('../db');
const { requireAuth, featureOn, restrict } = require('../auth');
const { uploadMedia, claimMedia, removeFile } = require('../upload');
const { UPLOAD_DIR, safeFetch, ref } = require('../utils');
const { safeEqual } = require('../secrets');
const providers = require('../providers');
const world = require('../world');
const fx = require('../fx');
const pf = require('../printful');
const platforms = require('../dropship');
const { variantKey } = require('../dropship/util');

const router = express.Router();          // /api/pod            (logged-in sellers)
const storeApi = express.Router();        // /api/store/:slug/pod (customers, no account needed)
const webhookApi = express.Router();      // /api/pod/webhook/:provider/:token (platforms -> us)
router.use(featureOn('dropshipping'));
storeApi.use(featureOn('dropshipping'));

const SITE = () => (process.env.SITE_URL || '').replace(/\/+$/, '');
const abs = u => (u ? (/^https?:/.test(u) ? u : SITE() + u) : null);
const dropship = () => require('./dropship');
const pay = () => require('./payments');
const major = (m, cur) => world.toMajor(m, cur).toFixed(world.decimals(cur));
const publicSite = () => /^https:\/\/(?!localhost|127\.|10\.|192\.168\.)/.test(SITE());
const jparse = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };
const err = (res, e) => res.status(e.status || 500).json({ error: e.message });
const myStore = uid => db.prepare('SELECT * FROM stores WHERE owner_id=?').get(uid);
const conv = (minor, from, to) => (from === to ? minor : fx.convertMinor(minor, from, to, 0).out);
const allowed = (store, id) => { const a = platforms.get(id); return !!a && a.enabled() && (store.dropship_mode === 'all' || store.dropship_mode === id); };

// ---------------------------------------------------------------------------------------------
// Seller: platforms, catalogue, design, previews
// ---------------------------------------------------------------------------------------------
router.get('/status', requireAuth, (req, res) => {
  const s = myStore(req.user.id);
  res.json({
    platforms: platforms.describe().filter(p => p.enabled), public_site: publicSite(), default_markup: parseFloat(getSetting('pod_default_markup')) || 60,
    user_suppliers: getSetting('dropship_user_suppliers') === '1', mode: s ? s.dropship_mode : 'all', routing: s ? s.routing : 'cheapest',
    fee: { every: parseInt(getSetting('dropship_fee_every'), 10) || 2, enabled: getSetting('owner_payments_enabled') === '1' && getSetting('pay_dropship_fee_enabled') === '1' }
  });
});

// Which platform(s) this store uses: one of them, or "all" (the app picks per product and delivery country).
router.put('/settings', requireAuth, restrict('sell'), (req, res) => {
  const s = myStore(req.user.id);
  if (!s) return res.status(400).json({ error: 'Create your store first.' });
  const b = req.body || {};
  const mode = b.mode === 'all' || platforms.get(b.mode) ? b.mode : s.dropship_mode;
  const routing = ['cheapest', 'fastest'].includes(b.routing) ? b.routing : s.routing;
  db.prepare('UPDATE stores SET dropship_mode=?, routing=? WHERE id=?').run(mode, routing, s.id);
  res.json({ ok: true, mode, routing });
});

const adapterFor = (req, res) => {
  const s = myStore(req.user.id);
  const a = platforms.get(req.params.prov);
  if (!a || !a.enabled()) { res.status(404).json({ error: 'That platform is not available.' }); return null; }
  if (s && !allowed(s, a.id)) { res.status(400).json({ error: 'Your store is set to use a different platform. Change it in your dropshipping settings.' }); return null; }
  return a;
};
router.get('/catalog/:prov/categories', requireAuth, async (req, res) => { const a = adapterFor(req, res); if (a) try { res.json(await a.categories()); } catch (e) { err(res, e); } });
router.get('/catalog/:prov/products', requireAuth, async (req, res) => {
  const a = adapterFor(req, res); if (!a) return;
  try { res.json(await a.browse({ category: req.query.category, q: String(req.query.q || '').slice(0, 80), page: req.query.page })); } catch (e) { err(res, e); }
});
router.get('/catalog/:prov/products/:id', requireAuth, async (req, res) => {
  const a = adapterFor(req, res); if (!a) return;
  try {
    const option = req.query.option ? { print_provider: String(req.query.option).replace(/\D/g, '') } : undefined;
    res.json({ ...(await a.product(String(req.params.id).slice(0, 60), option)), platform: { id: a.id, label: a.label, kind: a.kind, branding: a.branding } });
  } catch (e) { err(res, e); }
});

// The brand logo / design printed on print-on-demand products (PNG with a transparent background works best)
router.post('/design', requireAuth, restrict('sell'), uploadMedia.single('design'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose your logo or design file.' });
    const buf = fs.readFileSync(req.file.path);
    const size = pf.imageSize(buf);
    if (!size) { removeFile(req.file); return res.status(400).json({ error: 'Upload a PNG or JPG image.' }); }
    if (Math.max(size.width, size.height) < 800) { removeFile(req.file); return res.status(400).json({ error: 'The image is too small to print well. Use at least 800 pixels on the longest side (2000+ is best).' }); }
    const m = await claimMedia(req.file, req.user.id);
    res.json({ url: m.url, width: size.width, height: size.height });
  } catch (e) {
    if (req.file) removeFile(req.file);
    res.status(e.status || 400).json({ error: e.message, owner: e.owner });
  }
});
function ownedDesign(url, uid) {
  const f = path.basename(String(url || ''));
  return db.prepare('SELECT 1 FROM media_registry WHERE file=? AND owner_id=?').get(f, uid) ? '/uploads/' + f : null;
}

/** Saves a picture from another site into our own uploads so pages never depend on someone else's images. */
async function keepImage(url) {
  const r = await safeFetch(url, {}, { timeoutMs: 20000 });
  const type = String(r.headers.get('content-type') || '');
  if (!r.ok || !/^image\/(jpeg|png|webp)/.test(type)) throw new Error('Image could not be saved.');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new Error('Image is too large.');
  const name = crypto.randomBytes(16).toString('hex') + (type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : '.jpg');
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return '/uploads/' + name;
}

// Previews (Printful mock-ups: the design on the product)
const mockLimiter = rateLimit({ windowMs: 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false, message: { error: 'Preview limit reached. Wait a minute and try again.' } });
router.post('/mockup', requireAuth, mockLimiter, async (req, res) => {
  try {
    if (!platforms.get('printful').enabled()) return res.status(400).json({ error: 'Previews are not available right now.' });
    if (!publicSite()) return res.status(400).json({ error: 'Previews need the site to be online at a public https address (set SITE_URL).' });
    const b = req.body || {};
    const productId = parseInt(b.product_id, 10);
    const design = ownedDesign(b.design_url, req.user.id);
    if (!design) return res.status(400).json({ error: 'Upload your design first.' });
    const variantIds = (Array.isArray(b.variant_ids) ? b.variant_ids : []).map(n => parseInt(n, 10)).filter(Boolean).slice(0, 3);
    if (!variantIds.length) return res.status(400).json({ error: 'Choose a size/colour to preview.' });
    const placement = String(b.placement || 'front').replace(/[^a-z0-9_]/gi, '').slice(0, 30);
    const area = await pf.printfileFor(productId, variantIds[0], placement);
    if (!area) return res.status(400).json({ error: 'That print position is not available for this product.' });
    const aspect = (parseInt(b.design_w, 10) || 1) / (parseInt(b.design_h, 10) || 1);
    const task = await pf.mockupTask(productId, { variant_ids: variantIds, format: 'jpg', files: [{ placement, image_url: abs(design), position: pf.position(area, aspect, parseInt(b.scale, 10) || 60) }] });
    res.json({ task_key: task.task_key, status: task.status });
  } catch (e) { err(res, e); }
});
const mockDone = new Map();
router.get('/mockup/:key', requireAuth, async (req, res) => {
  try {
    const key = String(req.params.key).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    if (mockDone.has(key)) return res.json(mockDone.get(key));
    const r = await pf.mockupResult(key);
    if (r.status !== 'completed') return res.json({ status: r.status === 'failed' ? 'failed' : 'pending', error: r.error || null });
    const urls = [];
    for (const m of (r.mockups || []).slice(0, 2)) {
      urls.push(await keepImage(m.mockup_url));
      for (const x of (m.extra || []).slice(0, 3)) urls.push(await keepImage(x.url));
    }
    const out = { status: 'completed', mockups: urls };
    mockDone.set(key, out);
    if (mockDone.size > 200) mockDone.delete(mockDone.keys().next().value);
    res.json(out);
  } catch (e) { err(res, e); }
});

// ---------------------------------------------------------------------------------------------
// Seller: listings. One listing can have several "sources" (platforms that can make/ship it).
// ---------------------------------------------------------------------------------------------
const shapeListing = l => ({ ...l, variants: jparse(l.variants, []), mockups: jparse(l.mockups, []), images: jparse(l.images, []),
  sources: jparse(l.sources, []).map(s => ({ id: s.id, provider: s.provider, label: (platforms.get(s.provider) || {}).label || s.provider, product_name: s.product_name, placement: s.placement, matched: Object.keys(s.variants || {}).length })) });

router.get('/listings', requireAuth, (req, res) => {
  const s = myStore(req.user.id);
  res.json(s ? db.prepare('SELECT * FROM pf_listings WHERE store_id=? AND active=1 ORDER BY id DESC').all(s.id).map(shapeListing) : []);
});

/** Builds one source: reads the platform's product, matches variants, learns the real costs. Throws friendly errors. */
async function makeSource(sr, ctx) {
  const a = platforms.get(sr.provider);
  if (!a || !allowed(ctx.store, a.id)) throw Object.assign(new Error('Your store cannot use that platform. Check your dropshipping settings.'), { status: 400 });
  if (ctx.kind && a.kind !== ctx.kind) throw Object.assign(new Error('Print-on-demand and ready-made products cannot be mixed in one listing.'), { status: 400 });
  if (a.needsOption && !(sr.option && sr.option.print_provider)) throw Object.assign(new Error('Choose which print provider will make it.'), { status: 400 });
  const option = a.needsOption ? { print_provider: String(sr.option.print_provider).replace(/\D/g, '') } : null;
  const prod = await a.product(String(sr.product_id), option || undefined);
  const placements = prod.placements || null;
  const placement = placements ? (placements[sr.placement] ? sr.placement : Object.keys(placements)[0]) : null;
  const labelFee = ctx.inside_label && prod.label_inside ? prod.label_inside.price : 0;
  const withKey = (prod.variants || []).map(v => ({ ...v, key: variantKey(v) }));
  let chosen;
  if (ctx.keys) chosen = ctx.keys.map(k => withKey.find(v => v.key === k)).filter(Boolean);
  else chosen = (Array.isArray(sr.variant_ids) ? sr.variant_ids : []).map(id => withKey.find(v => String(v.id) === String(id))).filter(Boolean);
  const seen = new Set();
  chosen = chosen.filter(v => !seen.has(v.key) && seen.add(v.key)).slice(0, 80);
  if (!chosen.length) throw Object.assign(new Error(ctx.keys ? 'None of your sizes/colours exist on that product.' : 'Choose at least one size/colour to sell.'), { status: 400 });
  const src = { id: crypto.randomBytes(4).toString('hex'), provider: a.id, product_id: String(prod.id), product_name: prod.title, placement, option, extra: null, label: !!labelFee,
    variants: Object.fromEntries(chosen.map(v => [v.key, { id: v.id, cost: v.cost == null ? null : v.cost + labelFee, currency: prod.currency }])) };
  await a.prepare(src, { listing: ctx.listing, chosen, designUrl: ctx.designUrl });
  return { src, prod, chosen: chosen.map(v => ({ ...v, cost: src.variants[v.key].cost })) };
}

router.post('/listings', requireAuth, restrict('sell'), async (req, res) => {
  const made = [];
  try {
    const s = myStore(req.user.id);
    if (!s) return res.status(400).json({ error: 'Create your store first - add your brand name and logo.' });
    if (!s.logo) return res.status(400).json({ error: 'Upload your store logo first. It is used on your store, emails and (where the platform allows) the parcel.' });
    const b = req.body || {};
    const reqSources = (Array.isArray(b.sources) ? b.sources : []).slice(0, 4);
    if (!reqSources.length) return res.status(400).json({ error: 'Choose a product.' });
    const first = platforms.get(reqSources[0].provider);
    if (!first) return res.status(400).json({ error: 'Unknown platform.' });
    const kind = first.kind;
    let design = null;
    if (kind === 'pod') {
      if (!publicSite()) return res.status(400).json({ error: 'The printing platform must be able to download your design, so the site needs a public https address (SITE_URL).' });
      design = ownedDesign(b.design_url, req.user.id);
      if (!design) return res.status(400).json({ error: 'Upload your design or logo first.' });
    }
    const scale = Math.min(100, Math.max(10, parseInt(b.scale, 10) || 60));
    const insideLabel = !!b.inside_label;
    const listing = { title: String(b.title || '').trim().slice(0, 120), design_w: parseInt(b.design_w, 10) || null, design_h: parseInt(b.design_h, 10) || null, design_scale: scale, inside_label: insideLabel ? 1 : 0 };
    const ctx = { store: s, kind, inside_label: insideLabel, listing, designUrl: design ? abs(design) : null };

    const primary = await makeSource(reqSources[0], ctx); made.push(primary.src);
    if (!listing.title) listing.title = String(primary.prod.title).slice(0, 120);
    const cur = primary.prod.currency;
    const markup = Math.min(1000, Math.max(0, parseFloat(b.markup_percent) || parseFloat(getSetting('pod_default_markup')) || 60));
    const custom = Object.fromEntries((Array.isArray(b.variants) ? b.variants : []).map(v => [String(v.id), v.price]));
    const variants = [];
    for (const v of primary.chosen) {
      const price = custom[String(v.id)] ? world.toMinor(custom[String(v.id)], cur) : Math.round(v.cost * (1 + markup / 100));
      if (price <= v.cost) throw Object.assign(new Error('The price of "' + v.name + '" must be higher than its production cost of ' + world.format(v.cost, cur) + '.'), { status: 400 });
      variants.push({ key: v.key, name: v.name, size: v.size, color: v.color, color_code: v.color_code, image: v.image, price });
    }
    const sources = [primary.src];
    for (const sr of reqSources.slice(1)) { // extra platforms for automatic routing; skipped quietly if they do not match
      try { const m = await makeSource(sr, { ...ctx, keys: variants.map(v => v.key) }); made.push(m.src); sources.push(m.src); } catch (e) { /* not a match: ignore */ }
    }
    const mockups = (Array.isArray(b.mockups) ? b.mockups : []).filter(u => /^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(u)).slice(0, 6);
    let images = [];
    if (kind === 'general') for (const u of (primary.prod.images || [primary.prod.image]).filter(Boolean).slice(0, 4)) { try { images.push(await keepImage(u)); } catch (e) { /* skip */ } }
    const info = db.prepare(`INSERT INTO pf_listings(store_id,kind,title,description,currency,design_url,design_w,design_h,design_scale,inside_label,variants,sources,mockups,images)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(s.id, kind, listing.title, String(b.description || primary.prod.description || '').slice(0, 3000), cur, design, listing.design_w, listing.design_h, scale, insideLabel ? 1 : 0,
        JSON.stringify(variants), JSON.stringify(sources), JSON.stringify(mockups), JSON.stringify(images));
    res.json({ id: info.lastInsertRowid, sources: sources.length });
  } catch (e) {
    for (const src of made) { const a = platforms.get(src.provider); if (a && a.cleanup) await a.cleanup(src).catch(() => {}); }
    err(res, e);
  }
});

router.post('/listings/:id/sources', requireAuth, restrict('sell'), async (req, res) => { // add another platform to an existing listing
  try {
    const s = myStore(req.user.id);
    const l = s && db.prepare('SELECT * FROM pf_listings WHERE id=? AND store_id=? AND active=1').get(req.params.id, s.id);
    if (!l) return res.status(404).json({ error: 'Listing not found.' });
    const sources = jparse(l.sources, []);
    if (sources.length >= 4) return res.status(400).json({ error: 'A listing can use up to 4 platforms.' });
    const vs = jparse(l.variants, []);
    const m = await makeSource(req.body || {}, { store: s, kind: l.kind, inside_label: !!l.inside_label, keys: vs.map(v => v.key), listing: l, designUrl: l.design_url ? abs(l.design_url) : null });
    sources.push(m.src);
    db.prepare('UPDATE pf_listings SET sources=? WHERE id=?').run(JSON.stringify(sources), l.id);
    res.json({ ok: true, matched: Object.keys(m.src.variants).length, of: vs.length });
  } catch (e) { err(res, e); }
});
router.delete('/listings/:id/sources/:sid', requireAuth, async (req, res) => {
  const s = myStore(req.user.id);
  const l = s && db.prepare('SELECT * FROM pf_listings WHERE id=? AND store_id=?').get(req.params.id, s.id);
  if (!l) return res.status(404).json({ error: 'Listing not found.' });
  const sources = jparse(l.sources, []);
  if (sources.length <= 1) return res.status(400).json({ error: 'A listing needs at least one platform.' });
  db.prepare('UPDATE pf_listings SET sources=? WHERE id=?').run(JSON.stringify(sources.filter(x => x.id !== req.params.sid)), l.id); // old orders keep working: they only need the source until shipped
  res.json({ ok: true });
});

router.put('/listings/:id', requireAuth, (req, res) => {
  const s = myStore(req.user.id);
  const l = s && db.prepare('SELECT * FROM pf_listings WHERE id=? AND store_id=?').get(req.params.id, s.id);
  if (!l) return res.status(404).json({ error: 'Listing not found.' });
  const b = req.body || {};
  const sources = jparse(l.sources, []);
  let variants = jparse(l.variants, []);
  const costOf = key => Math.max(...sources.map(src => { const m = src.variants[key]; try { return m && m.cost != null ? conv(m.cost, m.currency, l.currency) : 0; } catch (e) { return 0; } }));
  if (Array.isArray(b.prices)) {
    for (const p of b.prices) {
      const v = variants.find(x => x.key === p.key);
      if (!v) continue;
      const price = world.toMinor(p.price, l.currency);
      if (price <= costOf(v.key)) return res.status(400).json({ error: 'Price of "' + v.name + '" must be higher than its cost of ' + world.format(costOf(v.key), l.currency) + '.' });
      v.price = price;
    }
  }
  if (Array.isArray(b.remove_variants)) variants = variants.filter(v => !b.remove_variants.includes(v.key));
  if (!variants.length) return res.status(400).json({ error: 'Keep at least one size/colour.' });
  db.prepare('UPDATE pf_listings SET title=COALESCE(?,title), description=COALESCE(?,description), variants=?, active=COALESCE(?,active) WHERE id=?')
    .run(b.title ? String(b.title).slice(0, 120) : null, b.description != null ? String(b.description).slice(0, 3000) : null, JSON.stringify(variants), b.active != null ? (b.active ? 1 : 0) : null, l.id);
  res.json({ ok: true });
});
router.delete('/listings/:id', requireAuth, (req, res) => {
  const s = myStore(req.user.id);
  if (s) db.prepare('UPDATE pf_listings SET active=0 WHERE id=? AND store_id=?').run(req.params.id, s.id); // kept for old orders
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------
// Customer (public storefront)
// ---------------------------------------------------------------------------------------------
const guestLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Please try again later.' } });
const quoteLimiter = rateLimit({ windowMs: 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false, message: { error: 'Slow down a little.' } });

const storeBySlug = slug => db.prepare('SELECT id,owner_id,slug,brand_name,logo,tagline,color,support_email,dropship_mode,routing FROM stores WHERE slug=? AND active=1').get(slug);
const listingOf = (storeId, id) => db.prepare('SELECT * FROM pf_listings WHERE id=? AND store_id=? AND active=1').get(id, storeId);

function shapePublic(l) {
  const mock = jparse(l.mockups, []), imgs = jparse(l.images, []);
  return { id: l.id, kind: l.kind === 'general' ? 'general' : 'pod', title: l.title, description: l.description, currency: l.currency, images: [...mock, ...imgs], design: l.design_url,
    variants: jparse(l.variants, []).map(v => ({ key: v.key, name: v.name, size: v.size, color: v.color, color_code: v.color_code, image: v.image, price: v.price })) };
}

storeApi.get('/:slug/pod/:id', (req, res) => {
  const s = storeBySlug(req.params.slug);
  const l = s && listingOf(s.id, req.params.id);
  if (!l) return res.status(404).json({ error: 'Product not found.' });
  delete s.owner_id; delete s.dropship_mode; delete s.routing;
  res.json({ store: s, product: shapePublic(l), payment_methods: providers.forCurrency(l.currency, 'dropship').filter(p => !p.manual).map(p => ({ id: p.id, label: p.label, kind: p.kind })) });
});

const NEEDS_STATE = new Set(['US', 'CA', 'AU']);
function recipientFrom(b, country) {
  const a = b.address || {};
  const r = { name: String(b.name || '').trim().slice(0, 80), address1: String(a.line1 || '').trim().slice(0, 120), address2: String(a.line2 || '').trim().slice(0, 120) || undefined,
    city: String(a.city || '').trim().slice(0, 60), state_code: String(a.state || '').trim().toUpperCase().slice(0, 10) || undefined, country_code: country, zip: String(a.postal || '').trim().slice(0, 20),
    phone: String(b.phone || '').trim().slice(0, 30) || undefined, email: String(b.email || '').trim().toLowerCase().slice(0, 120) };
  if (r.name.length < 2) throw Object.assign(new Error('Enter your name.'), { status: 400 });
  if (!r.address1 || !r.city) throw Object.assign(new Error('Enter your delivery address and city.'), { status: 400 });
  if (!r.zip && !['AE', 'HK', 'IE', 'QA', 'SA'].includes(country)) throw Object.assign(new Error('Enter your postal / ZIP code.'), { status: 400 });
  if (NEEDS_STATE.has(country) && !r.state_code) throw Object.assign(new Error('Choose your state / province.'), { status: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) throw Object.assign(new Error('Enter a valid email address - your receipt and tracking are sent there.'), { status: 400 });
  return r;
}

/**
 * Chooses the platform for this product and destination.
 * Every platform that can make the product is asked for a delivery quote to the buyer's country; the ones that cannot deliver
 * there (or would lose money) drop out. Then the store's rule decides: cheapest (default) or fastest.
 */
async function route(l, store, key, qty, rec) {
  const variant = jparse(l.variants, []).find(v => v.key === key);
  if (!variant) throw Object.assign(new Error('Choose a size/colour.'), { status: 400 });
  const sources = jparse(l.sources, []).filter(src => src.variants[key] && allowed(store, src.provider));
  const results = await Promise.allSettled(sources.map(async src => {
    const a = platforms.get(src.provider), m = src.variants[key];
    const opts = (await a.rates({ src, variantId: m.id, qty, recipient: rec, currency: l.currency })).map(o => ({ ...o, minor: conv(o.minor, o.currency, l.currency), currency: l.currency }));
    if (!opts.length) throw new Error('no delivery');
    const cost = conv(m.cost, m.currency, l.currency);
    if (cost >= variant.price) throw new Error('not profitable');
    opts.sort((x, y) => x.minor - y.minor);
    return { src, variant, cost, options: opts };
  }));
  const cands = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  results.filter(r => r.status === 'rejected' && !/no delivery|not profitable/.test(r.reason.message)).forEach(r => console.error('[dropship route]', r.reason.message));
  if (!cands.length) throw Object.assign(new Error('Sorry, we cannot deliver this to that address right now.'), { status: 400 });
  const days = c => Math.min(...c.options.map(o => o.max_days || 99));
  const capital = c => c.cost * qty + c.options[0].minor;
  cands.sort(store.routing === 'fastest' ? (x, y) => days(x) - days(y) || capital(x) - capital(y) : (x, y) => capital(x) - capital(y) || days(x) - days(y));
  return cands[0];
}

storeApi.post('/:slug/pod/:id/quote', quoteLimiter, async (req, res) => {
  try {
    const s = storeBySlug(req.params.slug);
    const l = s && listingOf(s.id, req.params.id);
    if (!l) return res.status(404).json({ error: 'Product not found.' });
    const b = req.body || {};
    const country = String(b.country || '').toUpperCase();
    if (!world.isCountry(country)) return res.status(400).json({ error: 'Choose your country.' });
    const qty = Math.min(20, Math.max(1, parseInt(b.qty, 10) || 1));
    const a = b.address || {};
    const rec = { name: 'Customer', email: 'customer@example.com', address1: String(a.line1 || 'Address').slice(0, 120), city: String(a.city || 'City').slice(0, 60), country_code: country, state_code: String(a.state || '').toUpperCase().slice(0, 10) || undefined, zip: String(a.postal || '').slice(0, 20) };
    const win = await route(l, s, String(b.variant_key || ''), qty, rec);
    // the customer only sees delivery choices and prices - never which platform will do it
    res.json({ options: win.options.map(o => ({ id: o.id, name: o.name, minor: o.minor, min_days: o.min_days, max_days: o.max_days })), item_total: win.variant.price * qty, currency: l.currency });
  } catch (e) { err(res, e); }
});

storeApi.post('/:slug/pod/:id/checkout', guestLimiter, async (req, res) => {
  try {
    const s = storeBySlug(req.params.slug);
    const l = s && listingOf(s.id, req.params.id);
    if (!l) return res.status(404).json({ error: 'Product not found.' });
    const b = req.body || {};
    const country = String(b.country || '').toUpperCase();
    if (!world.isCountry(country)) return res.status(400).json({ error: 'Choose your country.' });
    const qty = Math.min(20, Math.max(1, parseInt(b.qty, 10) || 1));
    const recipient = recipientFrom(b, country);
    const win = await route(l, s, String(b.variant_key || ''), qty, recipient); // always re-quoted here: never trust a price sent by the browser
    const ship = win.options.find(o => o.id === b.shipping_id) || win.options[0];
    const total = win.variant.price * qty + ship.minor;
    const dId = db.prepare(`INSERT INTO dropship_orders(ref,store_id,provider,source_id,pf_listing_id,pf_variant_id,qty,customer_name,customer_email,customer_phone,ship_to,country,unit_price,unit_cost,shipping,shipping_method,shipping_name,total,currency)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(ref('do'), s.id, win.src.provider, win.src.id, l.id, win.variant.key, qty, recipient.name, recipient.email, recipient.phone || null,
        JSON.stringify({ line1: recipient.address1, line2: recipient.address2, city: recipient.city, state: recipient.state_code, postal: recipient.zip }), country, win.variant.price, win.cost, ship.minor, ship.id, ship.name, total, l.currency).lastInsertRowid;
    res.json(await dropship().beginPayment(req, s, dId, { title: l.title + ' (' + win.variant.name + ')', providerId: b.provider }));
  } catch (e) { err(res, e); }
});

// ---------------------------------------------------------------------------------------------
// Order handling (runs automatically after the customer's payment is confirmed)
// ---------------------------------------------------------------------------------------------
const OPEN = ['paid', 'awaiting_supplier', 'needs_attention'];
const recipientOf = o => { const a = jparse(o.ship_to, {}); return { name: o.customer_name, address1: a.line1, address2: a.line2 || undefined, city: a.city, state_code: a.state || undefined, country_code: o.country, zip: a.postal, phone: o.customer_phone || undefined, email: o.customer_email }; };

function hold(o, note) {
  db.prepare("UPDATE dropship_orders SET status='needs_attention', note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(String(note).slice(0, 300), o.id);
  const store = db.prepare('SELECT owner_id FROM stores WHERE id=?').get(o.store_id);
  notifyStaff('dropship', 'order', 'Dropship order ' + o.ref + ' needs attention: ' + String(note).slice(0, 120), '/admin');
  notify(store.owner_id, 'order', 'Order ' + o.ref + ' is being checked by our team.', '/dropship');
}

/** Books the order as in production: capital goes to the platform owner's ledger. */
function book(o, remoteId, capital) {
  db.transaction(() => {
    db.prepare("UPDATE dropship_orders SET status='processing', provider_order_id=?, capital=?, note=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(String(remoteId), capital, o.id);
    const a = pay().adminId();
    if (a) pay().credit(a, capital, o.currency, 'dropship_capital', o.ref, 'Production + shipping cost for dropship order ' + o.ref);
  })();
  const store = db.prepare('SELECT owner_id FROM stores WHERE id=?').get(o.store_id);
  notify(store.owner_id, 'order', 'Order ' + o.ref + ' is in production. It ships straight to your customer.', '/dropship');
}

/** Places an order with the chosen platform. Safe to call again after a failure (it never creates a second remote order). */
async function submit(orderId, { force = false } = {}) {
  let o = db.prepare("SELECT * FROM dropship_orders WHERE id=? AND provider!='supplier'").get(orderId);
  if (!o || !OPEN.includes(o.status)) return;
  db.prepare('UPDATE dropship_orders SET attempts=attempts+1, last_attempt=CURRENT_TIMESTAMP WHERE id=?').run(o.id);
  try {
    const l = db.prepare('SELECT * FROM pf_listings WHERE id=?').get(o.pf_listing_id);
    const store = db.prepare('SELECT * FROM stores WHERE id=?').get(o.store_id);
    const src = l && jparse(l.sources, []).find(x => x.id === o.source_id);
    const m = src && src.variants[o.pf_variant_id];
    const a = platforms.get(o.provider);
    if (!l || !store || !src || !m || !a || !a.enabled()) return hold(o, 'Product, store or platform is no longer available');
    const auto = getSetting('dropship_auto_confirm') === '1';
    const estimate = o.unit_cost * o.qty + o.shipping;
    const place = async () => {
      const r = await a.place({ order: o, src, variantId: m.id, qty: o.qty, recipient: recipientOf(o), listing: l, store, designUrl: abs(l.design_url), labelUrl: abs(store.logo), shipping: o.shipping_method, retailPrice: major(o.unit_price, o.currency) });
      return r;
    };
    const toOrderCur = c => (c.currency === o.currency ? c.minor : conv(c.minor, c.currency, o.currency));

    if (!a.draft) { // ready-made platforms (CJ): no draft stage, the order is paid when placed, so check the money first
      if (!force && estimate > o.total) return hold(o, 'Cost (' + world.format(estimate, o.currency) + ') is higher than the customer paid (' + world.format(o.total, o.currency) + ')');
      if (!force && !auto) { db.prepare("UPDATE dropship_orders SET status='awaiting_supplier', capital=?, note='Waiting for the owner to approve', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(estimate, o.id); notifyStaff('dropship', 'order', 'Dropship order ' + o.ref + ' is waiting for your approval.', '/admin'); return; }
      const r = o.provider_order_id ? { id: o.provider_order_id, capital: null } : await place();
      return book(o, r.id, r.capital ? toOrderCur(r.capital) : estimate);
    }

    // print-on-demand platforms: create a draft first so the platform tells us the real cost, then confirm
    let remoteId = o.provider_order_id;
    if (!remoteId) {
      const r = await place();
      remoteId = r.id;
      db.prepare('UPDATE dropship_orders SET provider_order_id=?, capital=? WHERE id=?').run(remoteId, r.capital ? toOrderCur(r.capital) : null, o.id);
      o = db.prepare('SELECT * FROM dropship_orders WHERE id=?').get(o.id);
    }
    const capital = o.capital;
    if (!capital) return hold(o, a.label + ' did not return a cost for this order');
    if (!force && capital > o.total) return hold(o, 'Production + shipping cost (' + world.format(capital, o.currency) + ') is higher than the customer paid (' + world.format(o.total, o.currency) + ')');
    if (!force && !auto) { db.prepare("UPDATE dropship_orders SET status='awaiting_supplier', note='Waiting for the owner to approve production', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(o.id); notifyStaff('dropship', 'order', 'Dropship order ' + o.ref + ' is waiting for your approval.', '/admin'); return; }
    await a.confirm(remoteId);
    book(o, remoteId, capital);
  } catch (e) {
    const tries = db.prepare('SELECT attempts FROM dropship_orders WHERE id=?').get(o.id).attempts;
    if (e.retry && tries < 6) return; // temporary problem: the background job tries again
    const a = platforms.get(o.provider);
    hold(o, (a ? a.label : 'Platform') + ': ' + e.message);
  }
}
/** Owner approves a held / waiting order (accepting any loss on it). */
const approve = async orderId => {
  const o = db.prepare("SELECT * FROM dropship_orders WHERE id=? AND provider!='supplier'").get(orderId);
  if (!o || !OPEN.includes(o.status)) throw Object.assign(new Error('This order cannot be approved.'), { status: 400 });
  await submit(orderId, { force: true });
  const n = db.prepare('SELECT status,note FROM dropship_orders WHERE id=?').get(orderId);
  if (n.status === 'needs_attention') throw Object.assign(new Error(n.note || 'The platform did not accept it.'), { status: 502 });
};

/** Seller's profit is paid when the platform has shipped the parcel: customer paid - capital. */
function settle(orderId) {
  const P = pay();
  let profit = 0, store = null, o = null;
  db.transaction(() => {
    o = db.prepare('SELECT * FROM dropship_orders WHERE id=?').get(orderId);
    if (!o || o.settled) { o = null; return; }
    store = db.prepare('SELECT * FROM stores WHERE id=?').get(o.store_id);
    profit = Math.max(0, o.total - (o.capital || 0));
    if (profit > 0) P.settleToSeller(store.owner_id, profit, o.currency, o.ref, 'Dropship profit: order ' + o.ref);
    db.prepare('UPDATE dropship_orders SET settled=1, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(o.id);
    notify(store.owner_id, 'sale', 'Order ' + o.ref + ' shipped - your profit ' + world.format(profit, o.currency) + ' is in your wallet.', '/wallet');
  })();
  if (o) { try { require('../ownerfees').onDropshipSale(store, o, profit); } catch (e) { console.error('[dropship fee]', e.message); } } // "pay the owner after every N sales"
}

/** Order failed / cancelled at the platform: take the capital back off the books and flag the customer refund. */
function failOrder(o, note) {
  db.transaction(() => {
    if (o.status === 'processing' && o.capital) {
      const a = pay().adminId();
      if (a) {
        db.prepare('INSERT OR IGNORE INTO wallets(user_id,currency,balance) VALUES(?,?,0)').run(a, o.currency);
        db.prepare('UPDATE wallets SET balance=balance-? WHERE user_id=? AND currency=?').run(o.capital, a, o.currency);
        db.prepare("INSERT INTO wallet_tx(user_id,type,amount,currency,ref,note) VALUES(?, 'dropship_capital_reversal', ?, ?, ?, ?)").run(a, -o.capital, o.currency, o.ref, 'Order ' + o.ref + ' did not go ahead');
      }
    }
    db.prepare("UPDATE dropship_orders SET status='refund_needed', note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(String(note).slice(0, 300), o.id);
  })();
  const store = db.prepare('SELECT owner_id FROM stores WHERE id=?').get(o.store_id);
  notify(store.owner_id, 'order', 'Order ' + o.ref + ' could not be fulfilled. The customer will be refunded.', '/dropship');
  notifyStaff('payments_manage', 'order', 'Refund the customer for dropship order ' + o.ref + ' (' + world.format(o.total, o.currency) + ').', '/admin');
}

/** Asks the platform where an order stands and acts on it. The platform's API answer is trusted, never a webhook body. */
async function syncOrder(o) {
  const a = platforms.get(o.provider);
  if (!a || !o.provider_order_id) return;
  const g = await a.get(o.provider_order_id);
  if (g.state === 'shipped' && o.status !== 'shipped' && o.status !== 'delivered') {
    db.prepare("UPDATE dropship_orders SET status='shipped', tracking_number=?, tracking_url=?, carrier=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(String(g.tracking_number || '').slice(0, 80) || null, /^https?:\/\//.test(g.tracking_url || '') ? g.tracking_url : null, String(g.carrier || '').slice(0, 60) || null, o.id);
    settle(o.id);
    dropship().emailCustomer(o.ref, 'shipped').catch(e => console.error('[pod mail]', e.message));
  } else if ((g.state === 'canceled' || g.state === 'failed') && !['shipped', 'delivered', 'refunded', 'refund_needed'].includes(o.status)) {
    failOrder(o, a.label + ': ' + (g.reason || g.state));
  }
}
/** Background safety net: checks every order in production (webhooks are only a shortcut). */
async function syncAll() {
  const rows = db.prepare("SELECT * FROM dropship_orders WHERE provider!='supplier' AND status='processing' AND provider_order_id IS NOT NULL ORDER BY updated_at LIMIT 40").all();
  for (const o of rows) { try { await syncOrder(o); } catch (e) { console.error('[dropship sync ' + o.ref + ']', e.message); } }
}
/** Orders that were paid but not yet sent (temporary platform errors) are retried with growing delays. */
async function retryPending() {
  const rows = db.prepare(`SELECT id FROM dropship_orders WHERE provider!='supplier' AND status IN ('paid','awaiting_supplier') AND note IS NULL AND attempts<6
    AND (last_attempt IS NULL OR last_attempt < datetime('now', '-' || (attempts*attempts*2) || ' minutes')) LIMIT 20`).all();
  for (const r of rows) await submit(r.id);
}

// Platforms ping this when something changes. The secret in the URL authenticates it, and we then ask the platform's API for the truth.
webhookApi.post('/webhook/:provider/:token', (req, res) => {
  const a = platforms.get(req.params.provider);
  const expected = a && a.webhookToken();
  if (!expected || !safeEqual(String(req.params.token), expected)) return res.sendStatus(401);
  res.sendStatus(200);
  (async () => {
    const p = a.parseWebhook(req);
    const o = p.provider_order_id ? db.prepare('SELECT * FROM dropship_orders WHERE provider=? AND provider_order_id=?').get(a.id, p.provider_order_id)
      : p.order_ref ? db.prepare('SELECT * FROM dropship_orders WHERE provider=? AND ref=?').get(a.id, p.order_ref) : null;
    if (o) await syncOrder(o);
  })().catch(e => console.error('[dropship webhook]', e.message));
});

/** Admin: creates the webhook secret and registers the URL with the platform (CJ has no webhooks: it is checked by polling). */
async function connectWebhooks(id, baseUrl) {
  const a = platforms.get(id);
  if (!a || !a.setupWebhooks) return null;
  const key = id === 'printify' ? 'printify_webhook_secret' : id + '_webhook_token';
  let token = a.webhookToken();
  if (!token) { token = crypto.randomBytes(24).toString('hex'); setSetting(key, token); }
  const url = baseUrl.replace(/\/+$/, '') + '/api/pod/webhook/' + id + '/' + token;
  await a.setupWebhooks(url, token);
  return url.replace(token, '••••••••');
}

module.exports = router;
module.exports.storeApi = storeApi;
module.exports.webhookApi = webhookApi;
module.exports.submit = submit;
module.exports.approve = approve;
module.exports.failOrder = failOrder;
module.exports.settle = settle;
module.exports.syncOrder = syncOrder;
module.exports.syncAll = syncAll;
module.exports.retryPending = retryPending;
module.exports.connectWebhooks = connectWebhooks;
module.exports.shapePublic = shapePublic;
