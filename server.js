require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const { db, getSetting, ensureAdmin } = require('./src/db');
const { esc } = require('./src/utils');
const { csrfGuard, optionalAuth, isStaff } = require('./src/auth');
const world = require('./src/world');
const google = require('./src/google');
const sockets = require('./src/sockets');

ensureAdmin();

const app = express();
const server = http.createServer(app);
app.set('trust proxy', 1);
const PROD = process.env.NODE_ENV === 'production';

// ---------- HTTPS (set FORCE_HTTPS=1 behind a proxy / on a real domain) ----------
if (process.env.FORCE_HTTPS === '1') {
  app.use((req, res, next) => (req.secure ? next() : res.redirect(301, 'https://' + req.headers.host + req.originalUrl)));
  app.use(helmet.hsts({ maxAge: 31536000, includeSubDomains: true }));
}

// ---------- Security headers. The policy follows what the owner has switched on (Google sign-in, video classes) ----------
const cspHandlers = new Map();
function cspFor() {
  const g = google.enabled();
  const jitsi = (getSetting('jitsi_domain') || 'meet.jit.si').replace(/[^a-z0-9.-]/gi, '');
  const key = (g ? 'g' : '-') + jitsi;
  if (!cspHandlers.has(key)) {
    cspHandlers.set(key, helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", ...(g ? ['https://accounts.google.com/gsi/client'] : [])],
          'style-src': ["'self'", "'unsafe-inline'", ...(g ? ['https://accounts.google.com/gsi/style'] : [])],
          'img-src': ["'self'", 'data:', 'blob:', 'https:'],
          'media-src': ["'self'", 'blob:'],
          'font-src': ["'self'", 'data:'],
          'connect-src': ["'self'", 'ws:', 'wss:', ...(g ? ['https://accounts.google.com/gsi/'] : [])],
          'frame-src': ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://player.vimeo.com', 'https://' + jitsi, ...(g ? ['https://accounts.google.com/gsi/'] : [])],
          'worker-src': ["'self'"], 'manifest-src': ["'self'"], 'object-src': ["'none'"], 'base-uri': ["'self'"], 'form-action': ["'self'"], 'frame-ancestors': ["'self'"],
          'upgrade-insecure-requests': process.env.FORCE_HTTPS === '1' ? [] : null
        }
      },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // lets the Google sign-in pop-up talk back
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: false
    }));
  }
  return cspHandlers.get(key);
}
app.use((req, res, next) => {
  const jitsi = (getSetting('jitsi_domain') || 'meet.jit.si').replace(/[^a-z0-9.-]/gi, '');
  res.setHeader('Permissions-Policy', `camera=(self "https://${jitsi}"), microphone=(self "https://${jitsi}"), display-capture=(self "https://${jitsi}"), geolocation=(self), payment=(self), interest-cohort=()`);
  cspFor()(req, res, next);
});
app.use(compression());
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/pay/webhook')) req.rawBody = buf; } }));

// ---------- Memorable store addresses: https://<name>.<store domain> shows the same store as /s/<name> ----------
app.use((req, res, next) => {
  const dom = String(getSetting('store_domain') || '').toLowerCase();
  const host = String(req.headers.host || '').toLowerCase().split(':')[0];
  if (dom && host.endsWith('.' + dom) && !req.path.startsWith('/api') && !req.path.startsWith('/uploads') && !path.extname(req.path)) {
    const slug = host.slice(0, -(dom.length + 1));
    if (/^[a-z0-9-]{3,30}$/.test(slug) && slug !== 'www') req.url = '/s/' + slug + (req.url === '/' ? '' : req.url);
  }
  next();
});

// ---------- Maintenance mode: visitors see a notice; the owner and staff can still get in ----------
app.use(optionalAuth, (req, res, next) => {
  if (getSetting('maintenance_mode') !== '1' || isStaff(req.user)) return next();
  if (/^\/(api\/(auth|admin|public|pay\/webhook|pod\/webhook)|admin|login|uploads|css|js|img|sw\.js|manifest)/.test(req.path) || path.extname(req.path)) return next();
  if (req.path.startsWith('/api')) return res.status(503).json({ error: getSetting('maintenance_message') });
  res.status(503).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(getSetting('site_name') || 'Digital Enviro')}</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b1512;color:#e8f5ef;text-align:center;padding:24px}h1{font-size:28px}p{opacity:.8;max-width:420px}</style></head><body><div><h1>${esc(getSetting('site_name') || 'Digital Enviro')}</h1><p>${esc(getSetting('maintenance_message'))}</p></div></body></html>`);
});

// ---------- API ----------
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false, skip: req => /^\/(pay|pod)\/webhook\//.test(req.path), message: { error: 'Too many requests. Please slow down.' } });
app.use('/api', apiLimiter, csrfGuard);

const dropship = require('./src/routes/dropship');
const pod = require('./src/routes/pod');
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/users', require('./src/routes/users'));
app.use('/api/posts', require('./src/routes/posts'));
app.use('/api/pages', require('./src/routes/pages'));
app.use('/api/groups', require('./src/routes/groups'));
app.use('/api/market', require('./src/routes/market'));
app.use('/api/pay', require('./src/routes/payments'));
app.use('/api/chat', require('./src/routes/chat'));
app.use('/api/notifications', require('./src/routes/notifications'));
app.use('/api/classes', require('./src/routes/classes'));
app.use('/api/ads', require('./src/routes/ads'));
app.use('/api/announcements', require('./src/routes/announcements'));
app.use('/api/ai', require('./src/routes/ai'));
app.use('/api/creator', require('./src/routes/creator'));
app.use('/api/dropship/api', dropship.supplierApi);   // supplier API first: it uses API keys, not logins
app.use('/api/dropship', dropship);
app.use('/api/pod', pod.webhookApi);                  // platform webhooks (secret in the URL)
app.use('/api/pod', pod);
app.use('/api/store', pod.storeApi);                  // public storefronts (no account needed)
app.use('/api/store', dropship.storeApi);
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/public', require('./src/routes/public'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------- Uploaded media (private product files are never served here) ----------
app.use('/uploads/private', (req, res) => res.sendStatus(404));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '7d', dotfiles: 'deny',
  setHeaders: (res, fp) => { if (!/\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|ogg|mp3|wav|m4a|aac)$/i.test(fp)) res.setHeader('Content-Disposition', 'attachment'); res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; sandbox"); res.setHeader('X-Content-Type-Options', 'nosniff'); }
}));

// ---------- Static frontend ----------
const PUBLIC = path.join(__dirname, 'public');
app.get('/sw.js', (req, res) => { res.set({ 'Cache-Control': 'no-cache', 'Content-Type': 'application/javascript; charset=utf-8', 'Service-Worker-Allowed': '/' }); res.sendFile(path.join(PUBLIC, 'sw.js')); });
app.use(express.static(PUBLIC, { index: false, maxAge: '1h', dotfiles: 'deny' }));

const baseUrl = req => process.env.SITE_URL || (req.protocol + '://' + req.get('host'));
const trunc = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\nDisallow: /chat\nDisallow: /wallet\nDisallow: /creator\nDisallow: /notifications\nSitemap: ${baseUrl(req)}/sitemap.xml\n`);
});

app.get('/sitemap.xml', (req, res) => {
  const b = baseUrl(req);
  const urls = ['/', '/explore', '/reels', '/pages', '/communities', '/classes', '/market', '/policy'];
  db.prepare('SELECT slug FROM pages').all().forEach(p => urls.push('/p/' + p.slug));
  db.prepare('SELECT id, slug FROM groups_').all().forEach(g => urls.push(g.slug ? '/c/' + g.slug : '/community/' + g.id));
  db.prepare("SELECT id FROM products WHERE active=1 AND (group_id IS NULL OR members_only=0)").all().forEach(p => urls.push('/product/' + p.id));
  db.prepare("SELECT id FROM posts WHERE group_id IS NULL AND type!='story' ORDER BY id DESC LIMIT 2000").all().forEach(p => urls.push('/post/' + p.id));
  db.prepare("SELECT username FROM users WHERE status='active' AND role NOT IN ('admin','staff')").all().forEach(u => urls.push('/u/' + u.username));
  db.prepare('SELECT slug FROM custom_pages WHERE enabled=1').all().forEach(p => urls.push('/page/' + p.slug));
  db.prepare("SELECT id FROM classes WHERE active=1 AND (ended IS NULL OR ended=0)").all().forEach(c => urls.push('/class/' + c.id));
  db.prepare('SELECT slug FROM stores WHERE active=1').all().forEach(s => urls.push('/s/' + s.slug));
  db.prepare("SELECT l.id, s.slug FROM pf_listings l JOIN stores s ON s.id=l.store_id WHERE l.active=1 AND s.active=1 LIMIT 2000").all().forEach(l => urls.push('/s/' + l.slug + '/p/' + l.id));
  res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u => `<url><loc>${esc(b + u)}</loc></url>`).join('\n') + '\n</urlset>');
});

app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));

// Server-side SEO: per-route title, description, Open Graph, canonical, JSON-LD. Returns { head, body, redirect? }
function seoFor(req) {
  const site = getSetting('site_name') || 'Digital Enviro';
  const tag = getSetting('site_tagline');
  let url = baseUrl(req) + req.path;
  let kw = getSetting('seo_keywords') || '';
  let title = site + ' - Learn, Share & Earn from Tech Skills', desc = 'Join ' + site + ': a community to learn coding, AI, prompt engineering, web, mobile and game development, photography, video editing, graphics design and more. Follow creators, join groups, sell digital products and earn.', image = baseUrl(req) + '/icons/og-image.png', body = '', ld = null, noindex = false;
  let m;
  if ((m = req.path.match(/^\/p\/([\w-]+)$/))) {
    const p = db.prepare('SELECT p.*, u.username FROM pages p JOIN users u ON u.id=p.owner_id WHERE p.slug=?').get(m[1]);
    if (p) {
      title = p.name + ' - ' + (p.category || 'Creator') + ' on ' + site; desc = trunc(p.description || p.name + ' creator page on ' + site, 160);
      if (p.cover) image = baseUrl(req) + p.cover;
      kw = [p.name, p.category, 'creator', site].filter(Boolean).join(', ') + ', ' + kw;
      body = `<h1>${esc(p.name)}</h1><p>${esc(p.description)}</p>`;
      ld = { '@context': 'https://schema.org', '@type': 'ProfilePage', name: p.name, description: desc, url };
    }
  } else if ((m = req.path.match(/^\/post\/(\d+)$/))) {
    const p = db.prepare("SELECT p.*, u.username FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=? AND p.group_id IS NULL AND p.type!='story'").get(m[1]);
    if (p) {
      title = trunc(p.title || p.body || 'Post by @' + p.username, 60) + ' - @' + p.username + ' on ' + site; desc = trunc(p.body || title, 160);
      if (p.media && p.type === 'image') image = baseUrl(req) + p.media;
      body = `<h1>${esc(p.title || 'Post by @' + p.username)}</h1><p>${esc(trunc(p.body, 600))}</p>`;
      ld = { '@context': 'https://schema.org', '@type': 'SocialMediaPosting', headline: trunc(p.title || p.body, 100), author: { '@type': 'Person', name: p.username }, datePublished: p.created_at, url };
    }
  } else if ((m = req.path.match(/^\/u\/([\w]+)$/))) {
    const u = db.prepare("SELECT * FROM users WHERE username=? AND status='active'").get(m[1]);
    if (u) {
      title = (u.display_name || u.username) + ' (@' + u.username + ') on ' + site; desc = trunc(u.bio || 'Profile of ' + u.username + ' on ' + site, 160);
      image = u.avatar ? baseUrl(req) + u.avatar : baseUrl(req) + '/api/public/avatar/' + u.username + '.svg';
      body = `<h1>${esc(u.display_name || u.username)}</h1><p>${esc(u.bio)}</p>`;
      ld = { '@context': 'https://schema.org', '@type': 'ProfilePage', mainEntity: { '@type': 'Person', name: u.display_name || u.username, description: u.bio || '' }, url };
    }
  } else if ((m = req.path.match(/^\/(?:community\/(\d+)|c\/([\w-]+))$/))) {
    let g = m[1] ? db.prepare('SELECT * FROM groups_ WHERE id=?').get(m[1]) : db.prepare('SELECT * FROM groups_ WHERE slug=?').get(m[2].toLowerCase());
    if (!g && m[2]) { const old = db.prepare('SELECT g.slug FROM group_slug_history h JOIN groups_ g ON g.id=h.group_id WHERE h.slug=?').get(m[2].toLowerCase()); if (old) return { redirect: '/c/' + old.slug }; }
    if (g) {
      if (g.slug) url = baseUrl(req) + '/c/' + g.slug;
      const n = db.prepare('SELECT COUNT(*) c FROM active_members WHERE group_id=?').get(g.id).c;
      title = g.name + ' - ' + (g.price > 0 ? 'Paid' : 'Free') + ' community on ' + site; desc = trunc((g.description || g.name) + ' · ' + n + ' members. Join the community.', 160);
      if (g.cover) image = baseUrl(req) + g.cover;
      kw = [g.name, g.category, 'community', 'join', 'learn together'].filter(Boolean).join(', ') + ', ' + kw;
      body = `<h1>${esc(g.name)}</h1><p>${esc(g.description)}</p><p>${n} members</p>`;
      ld = { '@context': 'https://schema.org', '@type': 'Organization', name: g.name, description: desc, url, logo: g.cover ? baseUrl(req) + g.cover : undefined };
    }
  } else if ((m = req.path.match(/^\/class\/(\d+)$/))) {
    const c = db.prepare('SELECT c.*, u.username FROM classes c JOIN users u ON u.id=c.owner_id WHERE c.id=? AND c.active=1').get(m[1]);
    if (c) {
      kw = [c.title, 'online class', 'learn', 'live class'].join(', ') + ', ' + kw;
      title = c.title + ' - Class by @' + c.username + ' on ' + site; desc = trunc(c.description || c.title, 160);
      if (c.cover) image = baseUrl(req) + c.cover;
      body = `<h1>${esc(c.title)}</h1><p>${esc(c.description)}</p>`;
      ld = { '@context': 'https://schema.org', '@type': 'Course', name: c.title, description: desc, provider: { '@type': 'Person', name: c.username }, url };
    }
  } else if ((m = req.path.match(/^\/product\/(\d+)$/))) {
    const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1 AND (group_id IS NULL OR members_only=0)').get(m[1]);
    if (p) {
      kw = [p.title, p.category, 'digital product', 'download'].filter(Boolean).join(', ') + ', ' + kw;
      title = p.title + ' - ' + site + ' Marketplace'; desc = trunc(p.description || p.title, 160);
      if (p.cover) image = baseUrl(req) + p.cover;
      body = `<h1>${esc(p.title)}</h1><p>${esc(p.description)}</p>`;
      ld = { '@context': 'https://schema.org', '@type': 'Product', name: p.title, description: desc, offers: { '@type': 'Offer', price: world.toMajor(p.price, p.currency), priceCurrency: p.currency } };
    }
  } else if ((m = req.path.match(/^\/s\/([\w-]+)(?:\/(p|order)\/([\w-]+))?\/?$/))) {
    // a seller's branded store: the page is about THEIR brand, not ours
    const slug = m[1].toLowerCase();
    let s = db.prepare('SELECT * FROM stores WHERE slug=? AND active=1').get(slug);
    if (!s) {
      const old = db.prepare('SELECT s.* FROM store_slug_history h JOIN stores s ON s.id=h.store_id WHERE h.slug=? AND s.active=1').get(slug);
      if (old) return { redirect: '/s/' + old.slug + req.path.slice(slug.length + 3) };
    }
    if (s) {
      const own = '/s/' + s.slug;
      url = baseUrl(req) + own + (m[2] === 'p' ? '/p/' + m[3] : '');
      kw = [s.brand_name, s.brand_name + ' store', s.brand_name + ' shop', 'online store', 'worldwide delivery'].join(', ');
      title = s.brand_name + (s.tagline ? ' - ' + s.tagline : ' - Online store'); desc = trunc(s.tagline || 'Shop ' + s.brand_name + ' online. Delivery worldwide.', 160);
      if (s.logo) image = baseUrl(req) + s.logo;
      body = `<h1>${esc(s.brand_name)}</h1><p>${esc(s.tagline)}</p>`;
      if (m[2] === 'order') noindex = true;
      if (m[2] === 'p') {
        const l = db.prepare('SELECT * FROM pf_listings WHERE id=? AND store_id=? AND active=1').get(m[3], s.id);
        if (l) {
          let vs = []; try { vs = JSON.parse(l.variants); } catch (e) { /* ignore */ }
          let ims = []; try { ims = JSON.parse(l.mockups || '[]').concat(JSON.parse(l.images || '[]')); } catch (e) { /* ignore */ }
          const lo = vs.length ? Math.min(...vs.map(v => v.price)) : 0;
          kw = [l.title, s.brand_name, 'buy online', 'worldwide delivery', 'custom ' + (l.kind === 'pod' ? 'printed' : '') + ' product'].join(', ');
          title = l.title + ' - ' + s.brand_name; desc = trunc(l.description || l.title, 160);
          if (ims[0]) image = baseUrl(req) + ims[0];
          body = `<h1>${esc(l.title)}</h1><p>${esc(trunc(l.description, 600))}</p>`;
          ld = { '@context': 'https://schema.org', '@type': 'Product', name: l.title, description: desc, image: ims.map(i => baseUrl(req) + i), brand: { '@type': 'Brand', name: s.brand_name }, offers: { '@type': 'Offer', price: world.toMajor(lo, l.currency), priceCurrency: l.currency, availability: 'https://schema.org/InStock', url } };
        }
      } else if (!m[2]) {
        ld = { '@context': 'https://schema.org', '@type': 'Store', name: s.brand_name, description: desc, url, logo: s.logo ? baseUrl(req) + s.logo : undefined };
      }
    }
  } else if ((m = req.path.match(/^\/page\/([\w-]+)$/))) {
    const p = db.prepare('SELECT * FROM custom_pages WHERE slug=? AND enabled=1').get(m[1]);
    if (p) { title = p.title + ' - ' + site; desc = trunc(p.content.replace(/<[^>]+>/g, ' '), 160); }
  } else if (req.path === '/explore') { title = 'Explore tech topics & creators - ' + site; }
  else if (req.path === '/reels') { title = 'Reels: short videos from creators - ' + site; }
  else if (req.path === '/classes') { title = 'Free & paid online classes - ' + site; }
  else if (req.path === '/market') { title = 'Marketplace: digital products & services - ' + site; }
  else if (req.path === '/communities') { title = 'Communities for sharing & selling knowledge - ' + site; }
  else if (req.path === '/pages') { title = 'Creator pages - ' + site; }
  else if (req.path === '/policy') { title = 'Community policy - ' + site; }
  if (req.path === '/') {
    ld = { '@context': 'https://schema.org', '@type': 'WebSite', keywords: kw, name: site, url: baseUrl(req), description: desc, potentialAction: { '@type': 'SearchAction', target: baseUrl(req) + '/explore?q={search_term_string}', 'query-input': 'required name=search_term_string' } };
    body = `<h1>${esc(site)}</h1><p>${esc(tag)}</p><p>${esc(desc)}</p>`;
  }
  const head = `<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${kw ? `<meta name="keywords" content="${esc(trunc(kw, 480))}">\n` : ''}<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(site)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(image)}">` +
    (ld ? `\n<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>` : '');
  return { head, body, noindex };
}

const indexHtml = () => fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
app.get('*', (req, res) => {
  if (path.extname(req.path)) return res.sendStatus(404);
  const r = seoFor(req);
  if (r.redirect) return res.redirect(301, r.redirect);
  const noindex = r.noindex || /^\/(chat|wallet|login|signup|forgot|reset|settings|pay|create|dashboard|creator|notifications)/.test(req.path);
  const html = indexHtml()
    .replace('<!--SEO_HEAD-->', () => r.head + (noindex ? '\n<meta name="robots" content="noindex,nofollow">' : ''))
    .split('<!--SEO_BODY-->').join(r.body);
  res.type('html').send(html);
});

// Error handler: people get a clear message for their own mistakes, never internal details for our faults
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'That file is too large.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' });
  const status = err.status || (err.name === 'MulterError' ? 400 : 500);
  if (status >= 500) { console.error(err); return res.status(status).json({ error: 'Something went wrong on our side. Please try again.' }); }
  res.status(status).json({ error: err.message || 'Bad request.' });
});

sockets.init(server);
require('./src/jobs').start();

const PORT = parseInt(process.env.PORT, 10) || 3000;
server.listen(PORT, () => console.log('Digital Enviro running on http://localhost:' + PORT + (PROD ? '' : ' (development)')));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e && e.message));
