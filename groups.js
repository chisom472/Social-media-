const express = require('express');
const { db, notify } = require('../db');
const { requireAuth, optionalAuth, featureOn, restrict, hasPerm } = require('../auth');
const { uploadMedia, claimMedia, removeFile } = require('../upload');
const { decorate, BASE } = require('./posts');
const world = require('../world');
const { getSetting } = require('../db');

const FOCUS = ['knowledge', 'products', 'services', 'mixed'];
const BILLING = ['one_time', 'weekly', 'monthly', 'yearly'];

const router = express.Router();
router.use(featureOn('groups'));

function isMember(gid, uid) {
  return !!(uid && db.prepare('SELECT 1 FROM active_members WHERE group_id=? AND user_id=?').get(gid, uid));
}

router.get('/', optionalAuth, (req, res) => {
  const w = [], a = [];
  if (req.query.category) { w.push('g.category=?'); a.push(req.query.category); }
  if (FOCUS.includes(req.query.focus)) { w.push('g.focus=?'); a.push(req.query.focus); }
  const rows = db.prepare(`SELECT g.*, u.username AS owner_username,
    (SELECT COUNT(*) FROM active_members WHERE group_id=g.id) AS members FROM groups_ g JOIN users u ON u.id=g.owner_id
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY members DESC, g.id DESC LIMIT 60`).all(...a);
  rows.forEach(g => (g.joined = isMember(g.id, req.user && req.user.id)));
  res.json(rows);
});

router.get('/mine', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM active_members WHERE group_id=g.id) AS members
    FROM groups_ g JOIN active_members m ON m.group_id=g.id WHERE m.user_id=? ORDER BY g.id DESC`).all(req.user.id));
});

const slugs = require('../slugs');
const slugTaken = (s, exceptId) => !!(db.prepare('SELECT 1 FROM groups_ WHERE slug=? AND id!=?').get(s, exceptId || 0) || db.prepare('SELECT 1 FROM group_slug_history WHERE slug=? AND group_id!=?').get(s, exceptId || 0));
const siteBase = req => (process.env.SITE_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
const withLinks = (g, req) => { const url = siteBase(req) + '/c/' + g.slug; return Object.assign(g, { url, share_text: 'Join "' + g.name + '" on ' + (getSetting('site_name') || 'Digital Enviro') + ': ' + url }); };

/** Is this address free? Used live while typing. */
router.get('/slug-check', requireAuth, (req, res) => {
  const slug = slugs.clean(req.query.slug); const id = parseInt(req.query.id, 10) || 0;
  const bad = slugs.problem(slug);
  const taken = !bad && slugTaken(slug, id);
  res.json({ slug, available: !bad && !taken, problem: bad || (taken ? 'That address is taken.' : null), url: siteBase(req) + '/c/' + slug, suggestions: bad && bad.startsWith('Use') ? [] : (taken || bad) ? slugs.suggestions(slug, s => slugTaken(s, id)) : [] });
});

/** Public community page by its memorable address (works for visitors who are not logged in). */
router.get('/by-slug/:slug', optionalAuth, (req, res) => {
  const slug = slugs.clean(req.params.slug);
  let g = db.prepare('SELECT id FROM groups_ WHERE slug=?').get(slug);
  if (!g) { const old = db.prepare('SELECT g.slug FROM group_slug_history h JOIN groups_ g ON g.id=h.group_id WHERE h.slug=?').get(slug); if (old) return res.json({ redirect: '/c/' + old.slug }); return res.status(404).json({ error: 'Community not found.' }); }
  req.params.id = g.id;
  return getGroup(req, res);
});

router.post('/', requireAuth, restrict('community'), (req, res) => {
  const { name, description, category, price, currency, focus, billing } = req.body || {};
  if (!name || String(name).trim().length < 2) return res.status(400).json({ error: 'Give your community a name.' });
  const cur = world.normCurrency(currency, world.normCurrency(getSetting('default_currency'), 'USD'));
  const slug = slugs.unique(req.body.slug || name, s => slugTaken(s));
  const info = db.prepare('INSERT INTO groups_(owner_id,name,description,category,focus,price,currency,billing,slug) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(req.user.id, String(name).slice(0, 80), String(description || '').slice(0, 600), category || null, FOCUS.includes(focus) ? focus : 'mixed', Math.max(0, world.toMinor(price, cur)), cur, BILLING.includes(billing) ? billing : 'one_time', slug);
  db.prepare("INSERT INTO group_members(group_id,user_id,role) VALUES(?,?, 'owner')").run(info.lastInsertRowid, req.user.id);
  res.json({ id: info.lastInsertRowid, slug, url: siteBase(req) + '/c/' + slug });
});

function getGroup(req, res) {
  const g = db.prepare(`SELECT g.*, u.username AS owner_username, u.display_name AS owner_name,
    (SELECT COUNT(*) FROM active_members WHERE group_id=g.id) AS members FROM groups_ g JOIN users u ON u.id=g.owner_id WHERE g.id=?`).get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found.' });
  g.joined = isMember(g.id, req.user && req.user.id);
  g.is_owner = !!(req.user && req.user.id === g.owner_id);
  g.products = db.prepare('SELECT id,title,description,kind,price,currency,members_only,cover FROM products WHERE active=1 AND group_id=? ORDER BY id DESC').all(g.id);
  if (!g.joined) g.products = g.products.map(p => (p.members_only ? { ...p, locked: true } : p));
  res.json(withLinks(g, req));
}
router.get('/:id', optionalAuth, getGroup);

/** Change the memorable address (once every 30 days). Old links keep working. */
router.put('/:id/slug', requireAuth, (req, res) => {
  const g = db.prepare('SELECT * FROM groups_ WHERE id=?').get(req.params.id);
  if (!g || g.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the owner can change the address.' });
  const slug = slugs.clean((req.body || {}).slug);
  if (slug === g.slug) return res.json({ ok: true, slug, url: siteBase(req) + '/c/' + slug });
  const bad = slugs.problem(slug); if (bad) return res.status(400).json({ error: bad });
  if (slugTaken(slug, g.id)) return res.status(400).json({ error: 'That address is taken.' });
  if (g.slug_changed_at && Date.now() - Date.parse(g.slug_changed_at.replace(' ', 'T') + 'Z') < 30 * 24 * 3600 * 1000) return res.status(400).json({ error: 'You can change the address once every 30 days.' });
  db.transaction(() => {
    if (g.slug) db.prepare('INSERT OR REPLACE INTO group_slug_history(slug,group_id) VALUES(?,?)').run(g.slug, g.id);
    db.prepare('DELETE FROM group_slug_history WHERE slug=?').run(slug);
    db.prepare("UPDATE groups_ SET slug=?, slug_changed_at=datetime('now') WHERE id=?").run(slug, g.id);
  })();
  res.json({ ok: true, slug, url: siteBase(req) + '/c/' + slug });
});

router.post('/:id/join', requireAuth, (req, res) => {
  const g = db.prepare('SELECT * FROM groups_ WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found.' });
  if (g.price > 0) return res.status(402).json({ error: 'This is a paid community. Use checkout to join.', needs_payment: true, amount: g.price, currency: g.currency });
  db.prepare('INSERT OR IGNORE INTO group_members(group_id,user_id) VALUES(?,?)').run(g.id, req.user.id);
  notify(g.owner_id, 'group', '@' + req.user.username + ' joined ' + g.name, '/community/' + g.id);
  res.json({ joined: true });
});

router.post('/:id/leave', requireAuth, (req, res) => {
  const g = db.prepare('SELECT * FROM groups_ WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found.' });
  if (g.owner_id === req.user.id) return res.status(400).json({ error: 'Owners cannot leave. Delete the group instead.' });
  db.prepare('DELETE FROM group_members WHERE group_id=? AND user_id=?').run(g.id, req.user.id);
  res.json({ joined: false });
});

router.get('/:id/posts', requireAuth, (req, res) => {
  if (!isMember(req.params.id, req.user.id)) return res.status(403).json({ error: 'Join this group to see its posts.' });
  const rows = db.prepare(BASE + ' WHERE p.group_id=? ORDER BY p.id DESC LIMIT 60').all(req.params.id);
  res.json(decorate(rows, req.user.id));
});

router.get('/:id/members', requireAuth, (req, res) => {
  if (!isMember(req.params.id, req.user.id)) return res.status(403).json({ error: 'Join this group first.' });
  res.json(db.prepare(`SELECT u.id,u.username,u.display_name,u.avatar,m.role FROM active_members m JOIN users u ON u.id=m.user_id WHERE m.group_id=? ORDER BY m.role='owner' DESC, m.joined_at LIMIT 300`).all(req.params.id));
});

router.post('/:id/members/:uid/remove', requireAuth, (req, res) => {
  const g = db.prepare('SELECT * FROM groups_ WHERE id=?').get(req.params.id);
  if (!g || (g.owner_id !== req.user.id && !hasPerm(req.user, 'content'))) return res.status(403).json({ error: 'Not allowed.' });
  if (parseInt(req.params.uid, 10) === g.owner_id) return res.status(400).json({ error: 'Cannot remove the owner.' });
  db.prepare('DELETE FROM group_members WHERE group_id=? AND user_id=?').run(g.id, req.params.uid);
  res.json({ ok: true });
});

router.put('/:id', requireAuth, (req, res) => {
  const g = db.prepare('SELECT * FROM groups_ WHERE id=?').get(req.params.id);
  if (!g || g.owner_id !== req.user.id) return res.status(403).json({ error: 'Not allowed.' });
  const { name, description, category, price, currency, focus, billing } = req.body || {};
  const cur = world.normCurrency(currency, g.currency);
  db.prepare('UPDATE groups_ SET name=COALESCE(?,name), description=COALESCE(?,description), category=COALESCE(?,category), focus=COALESCE(?,focus), price=COALESCE(?,price), currency=?, billing=COALESCE(?,billing) WHERE id=?')
    .run(name || null, description != null ? String(description).slice(0, 600) : null, category || null, FOCUS.includes(focus) ? focus : null, price != null ? Math.max(0, world.toMinor(price, cur)) : null, cur, BILLING.includes(billing) ? billing : null, g.id);
  res.json({ ok: true });
});

router.post('/:id/cover', requireAuth, uploadMedia.single('media'), async (req, res) => {
  try {
    const g = db.prepare('SELECT * FROM groups_ WHERE id=?').get(req.params.id);
    if (!g || g.owner_id !== req.user.id) { if (req.file) removeFile(req.file); return res.status(403).json({ error: 'Not allowed.' }); }
    const c = await claimMedia(req.file, req.user.id);
    db.prepare('UPDATE groups_ SET cover=? WHERE id=?').run(c.url, g.id);
    res.json({ url: c.url });
  } catch (e) {
    if (req.file) removeFile(req.file);
    res.status(e.status || 400).json({ error: e.message, owner: e.owner });
  }
});

router.delete('/:id', requireAuth, (req, res) => {
  const g = db.prepare('SELECT * FROM groups_ WHERE id=?').get(req.params.id);
  if (!g || (g.owner_id !== req.user.id && !hasPerm(req.user, 'content'))) return res.status(403).json({ error: 'Not allowed.' });
  db.prepare('DELETE FROM groups_ WHERE id=?').run(g.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.isMember = isMember;
