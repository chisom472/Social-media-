const express = require('express');
const { db, getSetting } = require('../db');
const world = require('../world');
const providers = require('../providers');
const google = require('../google');
const push = require('../push');
const platforms = require('../dropship');
const { esc } = require('../utils');

const router = express.Router();

router.get('/config', (req, res) => {
  const flags = {};
  db.prepare('SELECT key,enabled FROM feature_flags').all().forEach(f => (flags[f.key] = !!f.enabled));
  res.json({
    site_name: getSetting('site_name'),
    tagline: getSetting('site_tagline'),
    announcement: getSetting('announcement'),
    default_currency: world.normCurrency(getSetting('default_currency'), 'USD'),
    providers: providers.describe(),
    flags,
    categories: db.prepare('SELECT name FROM categories WHERE enabled=1 ORDER BY name').all().map(c => c.name),
    menu_pages: db.prepare('SELECT slug,title FROM custom_pages WHERE enabled=1 AND in_menu=1 ORDER BY id').all(),
    creator_fee: {
      required: getSetting('creator_fee_required') === '1',
      currency: world.normCurrency(getSetting('creator_fee_currency'), 'USD'),
      amount: world.toMinor(getSetting('creator_fee_amount'), world.normCurrency(getSetting('creator_fee_currency'), 'USD')),
      days: parseInt(getSetting('creator_fee_days'), 10) || 30
    },
    payments_ready: providers.describe().length > 0,
    allow_signups: getSetting('allow_signups') === '1',
    theme: { brand: getSetting('theme_brand'), accent: getSetting('theme_accent'), mode: getSetting('theme_mode') || 'auto' },
    hero: { title: getSetting('hero_title'), text: getSetting('hero_text') },
    footer_html: getSetting('footer_html'),
    maintenance: getSetting('maintenance_mode') === '1' ? getSetting('maintenance_message') : null,
    accepted_currencies: getSetting('accepted_currencies'),
    min_age: parseInt(getSetting('min_age'), 10) || 13,
    reel_max_seconds: parseInt(getSetting('reel_max_seconds'), 10) || 90,
    google: { enabled: google.enabled(), client_id: google.enabled() ? getSetting('google_client_id') : null },
    push_key: push.publicKey(),
    ads_enabled: getSetting('ads_enabled') === '1',
    ads_self_serve: getSetting('ads_self_serve') === '1',
    dropship: { platforms: platforms.enabled().map(p => ({ id: p.id, label: p.label, kind: p.kind })), fee_every: parseInt(getSetting('dropship_fee_every'), 10) || 2 },
    store_domain: getSetting('store_domain') || null
  });
});

router.get('/world', (req, res) => res.json({ countries: world.countries, currencies: world.currencies, crypto: world.CRYPTO }));

router.get('/policy', (req, res) => res.json({ html: getSetting('policy') }));

router.get('/custom/:slug', (req, res) => {
  const p = db.prepare('SELECT slug,title,content FROM custom_pages WHERE slug=? AND enabled=1').get(req.params.slug);
  if (!p) return res.status(404).json({ error: 'Page not found.' });
  res.json(p);
});

router.get('/stats', (req, res) => {
  res.json({
    members: db.prepare("SELECT COUNT(*) c FROM users WHERE status='active'").get().c,
    creators: db.prepare('SELECT COUNT(*) c FROM pages').get().c,
    groups: db.prepare('SELECT COUNT(*) c FROM groups_').get().c,
    posts: db.prepare("SELECT COUNT(*) c FROM posts WHERE type!='story'").get().c
  });
});

// Write-ups the owner placed on the site (home page, sidebar, footer ...). Guests only get the ones meant for everyone.
router.get('/writeups', require('../auth').optionalAuth, (req, res) => {
  const aud = req.user ? ['all', 'members'] : ['all', 'guests'];
  res.json(db.prepare(`SELECT id,title,body,placement FROM writeups WHERE active=1 AND audience IN (${aud.map(() => '?').join(',')}) ORDER BY placement, sort, id`).all(...aud));
});

// A coloured circle with the first letter of the name: used wherever someone has not uploaded a profile picture
// (members, the owner and admins alike).
const PALETTE = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0d9488', '#0891b2', '#4f46e5', '#9333ea', '#be185d'];
router.get('/avatar/:name.svg', (req, res) => {
  const key = String(req.params.name || '').slice(0, 60);
  const u = db.prepare('SELECT username,display_name FROM users WHERE username=?').get(key.toLowerCase());
  const shown = ((u && (u.display_name || u.username)) || key || '?').trim();
  const letter = (Array.from(shown)[0] || '?').toLocaleUpperCase();
  let h = 0; for (const ch of (u ? u.username : key.toLowerCase())) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  res.set({ 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' })
    .send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="${esc(letter)}"><rect width="100" height="100" fill="${PALETTE[h % PALETTE.length]}"/><text x="50" y="50" dy=".35em" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif" font-size="52" font-weight="600" fill="#fff">${esc(letter)}</text></svg>`);
});

module.exports = router;
