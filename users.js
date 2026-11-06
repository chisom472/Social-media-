const express = require('express');
const { db, notify } = require('../db');
const { requireAuth, optionalAuth, restrict } = require('../auth');
const { isBlocked, hiddenIds } = require('../social');
const { uploadMedia, claimMedia, removeFile } = require('../upload');
const rec = require('../recommend');
const world = require('../world');
const { ageFrom, validateLocation } = require('./auth');
const { getSetting } = require('../db');

const router = express.Router();

function withFollowState(rows, viewerId) {
  if (!viewerId) return rows;
  const f = new Set(db.prepare('SELECT target_id FROM follows WHERE follower_id=?').all(viewerId).map(r => r.target_id));
  rows.forEach(r => (r.following = f.has(r.id)));
  return rows;
}

router.get('/suggestions', requireAuth, (req, res) => {
  res.json({
    people: withFollowState(rec.suggestPeople(req.user.id, 12), req.user.id),
    groups: rec.suggestGroups(req.user.id, 6),
    pages: db.prepare(`SELECT p.id,p.slug,p.name,p.category,p.description,p.cover,u.username FROM pages p JOIN users u ON u.id=p.owner_id
      WHERE p.owner_id!=? ORDER BY p.id DESC LIMIT 8`).all(req.user.id)
  });
});

router.get('/search', optionalAuth, (req, res) => {
  const q = '%' + String(req.query.q || '').trim().replace(/[%_]/g, '') + '%';
  if (q.length < 3) return res.json({ users: [], pages: [], posts: [], groups: [], products: [] });
  const hide = new Set(hiddenIds(req.user && req.user.id));
  const users = db.prepare("SELECT id,username,display_name,avatar,bio,is_creator,favoured FROM users WHERE status='active' AND (username LIKE ? OR display_name LIKE ?) LIMIT 15").all(q, q).filter(u => !hide.has(u.id));
  res.json({
    users: withFollowState(users, req.user && req.user.id),
    pages: db.prepare('SELECT id,slug,name,category,description FROM pages WHERE name LIKE ? OR description LIKE ? OR category LIKE ? LIMIT 15').all(q, q, q),
    posts: db.prepare("SELECT p.id,p.title,p.body,p.type,p.category,u.username FROM posts p JOIN users u ON u.id=p.user_id WHERE p.group_id IS NULL AND p.type!='story' AND (p.title LIKE ? OR p.body LIKE ? OR p.tags LIKE ?) ORDER BY p.id DESC LIMIT 15").all(q, q, q),
    groups: db.prepare('SELECT id,name,description,category,price,currency FROM groups_ WHERE name LIKE ? OR description LIKE ? LIMIT 15').all(q, q),
    products: db.prepare('SELECT id,title,price,currency,kind,category FROM products WHERE active=1 AND (title LIKE ? OR description LIKE ?) LIMIT 15').all(q, q)
  });
});

router.get('/directory/all', optionalAuth, (req, res) => {
  const hide = new Set(hiddenIds(req.user && req.user.id));
  const cc = world.isCountry(req.query.country) ? String(req.query.country).toUpperCase() : null;
  const rows = db.prepare(`SELECT u.id,u.username,u.display_name,u.avatar,u.bio,u.is_creator,u.favoured,
    (SELECT COUNT(*) FROM follows WHERE target_id=u.id) followers FROM users u WHERE u.status='active' AND u.role!='admin'
    ${cc ? "AND u.country=? AND u.location_privacy!='private'" : ''}
    ORDER BY u.favoured DESC, followers DESC, u.id DESC LIMIT 60`).all(...(cc ? [cc] : [])).filter(u => !hide.has(u.id));
  res.json(withFollowState(rows, req.user && req.user.id));
});

router.get('/:username', optionalAuth, (req, res) => {
  const u = db.prepare("SELECT id,username,display_name,bio,avatar,avatar_video,is_creator,favoured,created_at,status,country,region,city,location_privacy FROM users WHERE username=?").get(String(req.params.username).toLowerCase());
  if (!u || u.status !== 'active') return res.status(404).json({ error: 'User not found.' });
  if (req.user && isBlocked(req.user.id, u.id) && req.user.id !== u.id) {
    const iBlocked = !!db.prepare('SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?').get(req.user.id, u.id);
    if (!iBlocked) return res.status(404).json({ error: 'User not found.' });
    return res.json({ id: u.id, username: u.username, display_name: u.display_name, avatar: u.avatar, blocked_by_me: true, followers: 0, following: 0, posts: 0 });
  }
  const followers = db.prepare('SELECT COUNT(*) c FROM follows WHERE target_id=?').get(u.id).c;
  const following = db.prepare('SELECT COUNT(*) c FROM follows WHERE follower_id=?').get(u.id).c;
  const posts = db.prepare("SELECT COUNT(*) c FROM posts WHERE user_id=? AND type!='story'").get(u.id).c;
  const page = db.prepare('SELECT id,slug,name FROM pages WHERE owner_id=?').get(u.id);
  const isFollowing = req.user ? !!db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND target_id=?').get(req.user.id, u.id) : false;
  const me = !!(req.user && req.user.id === u.id);
  const loc = { country: null, country_name: null, region: null, city: null };
  if (u.country && (me || u.location_privacy !== 'private')) {
    loc.country = u.country;
    loc.country_name = (world.countries.find(c => c.code === u.country) || {}).name || u.country;
    if (me || u.location_privacy === 'public') { loc.region = u.region; loc.city = u.city; }
  }
  const reels = db.prepare("SELECT COUNT(*) c FROM posts WHERE user_id=? AND type='reel' AND group_id IS NULL").get(u.id).c;
  ['status', 'country', 'region', 'city', 'location_privacy'].forEach(k => delete u[k]);
  res.json({ ...u, ...loc, followers, following, posts, reels, page, is_following: isFollowing, is_me: me });
});

router.get('/:username/followers', (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username=?').get(String(req.params.username).toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found.' });
  res.json(db.prepare(`SELECT x.id,x.username,x.display_name,x.avatar FROM follows f JOIN users x ON x.id=f.follower_id
    WHERE f.target_id=? AND x.status='active' ORDER BY f.created_at DESC LIMIT 200`).all(u.id));
});

router.post('/:username/follow', requireAuth, restrict('follow'), (req, res) => {
  const u = db.prepare('SELECT id,username FROM users WHERE username=?').get(String(req.params.username).toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found.' });
  if (isBlocked(req.user.id, u.id)) return res.status(403).json({ error: 'You cannot follow this user.' });
  if (u.id === req.user.id) return res.status(400).json({ error: "You can't follow yourself." });
  const r = db.prepare('INSERT OR IGNORE INTO follows(follower_id,target_id) VALUES(?,?)').run(req.user.id, u.id);
  if (r.changes) {
    notify(u.id, 'follow', '@' + req.user.username + ' started following you', '/u/' + req.user.username);
    rec.learnFromCreator(req.user.id, u.id);
  }
  res.json({ following: true });
});
router.delete('/:username/follow', requireAuth, (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username=?').get(String(req.params.username).toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found.' });
  db.prepare('DELETE FROM follows WHERE follower_id=? AND target_id=?').run(req.user.id, u.id);
  res.json({ following: false });
});

router.put('/me/profile', requireAuth, (req, res) => {
  const b = req.body || {};
  const list = Array.isArray(b.interests) ? b.interests.map(x => String(x).trim()).filter(Boolean).slice(0, 12) : null;
  db.prepare('UPDATE users SET display_name=COALESCE(?,display_name), bio=COALESCE(?,bio), interests=COALESCE(?,interests) WHERE id=?')
    .run(b.display_name ? String(b.display_name).trim().slice(0, 50) : null, b.bio != null ? String(b.bio).slice(0, 400) : null, list ? list.join(',') : null, req.user.id);
  if (b.dob) {
    const age = ageFrom(String(b.dob));
    if (age == null) return res.status(400).json({ error: 'Enter a valid date of birth.' });
    if (age < (parseInt(getSetting('min_age'), 10) || 13)) return res.status(400).json({ error: 'That date of birth is below the minimum age to use this site.' });
    db.prepare('UPDATE users SET dob=? WHERE id=?').run(b.dob, req.user.id);
  }
  if (list) rec.learnSignup(req.user.id, list);
  res.json({ ok: true });
});

// Where you live (optional, and you choose who can see it). The site owner can always see your country.
router.put('/me/location', requireAuth, (req, res) => {
  const loc = validateLocation(req.body || {});
  if (loc.error) return res.status(400).json({ error: loc.error });
  const keys = Object.keys(loc);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to update.' });
  db.prepare('UPDATE users SET ' + keys.map(k => k + '=?').join(',') + ' WHERE id=?').run(...keys.map(k => loc[k]), req.user.id);
  res.json({ ok: true, ...loc });
});

// Profile picture + optional profile video (ownership-checked)
router.post('/me/avatar', requireAuth, uploadMedia.fields([{ name: 'avatar', maxCount: 1 }, { name: 'video', maxCount: 1 }]), async (req, res) => {
  try {
    const out = {};
    const a = req.files && req.files.avatar && req.files.avatar[0];
    const v = req.files && req.files.video && req.files.video[0];
    if (a) {
      if (!a.mimetype.startsWith('image/')) { removeFile(a); throw Object.assign(new Error('Profile picture must be an image.'), { status: 400 }); }
      const c = await claimMedia(a, req.user.id);
      db.prepare('UPDATE users SET avatar=? WHERE id=?').run(c.url, req.user.id);
      out.avatar = c.url;
    }
    if (v) {
      if (!v.mimetype.startsWith('video/')) { removeFile(v); throw Object.assign(new Error('Profile video must be a video file.'), { status: 400 }); }
      const c = await claimMedia(v, req.user.id);
      db.prepare('UPDATE users SET avatar_video=? WHERE id=?').run(c.url, req.user.id);
      out.avatar_video = c.url;
    }
    res.json(out);
  } catch (e) {
    (req.files ? Object.values(req.files).flat() : []).forEach(f => removeFile(f));
    res.status(e.status || 400).json({ error: e.message, owner: e.owner });
  }
});

router.delete('/me/avatar-video', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET avatar_video=NULL WHERE id=?').run(req.user.id);
  res.json({ ok: true });
});

router.post('/report', requireAuth, (req, res) => {
  const { target_type, target_id, reason } = req.body || {};
  if (!['user', 'post', 'comment', 'page', 'group'].includes(target_type)) return res.status(400).json({ error: 'Invalid report.' });
  db.prepare('INSERT INTO reports(reporter_id,target_type,target_id,reason) VALUES(?,?,?,?)').run(req.user.id, target_type, parseInt(target_id, 10) || 0, String(reason || '').slice(0, 500));
  res.json({ ok: true });
});

// ---------- Block / unblock ----------
router.post('/:username/block', requireAuth, (req, res) => {
  const u = db.prepare('SELECT id,username,role FROM users WHERE username=?').get(String(req.params.username).toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found.' });
  if (u.id === req.user.id) return res.status(400).json({ error: "You can't block yourself." });
  if (u.role === 'admin') return res.status(400).json({ error: 'The site owner cannot be blocked. Use Report instead.' });
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO blocks(blocker_id,blocked_id) VALUES(?,?)').run(req.user.id, u.id);
    db.prepare('DELETE FROM follows WHERE (follower_id=? AND target_id=?) OR (follower_id=? AND target_id=?)').run(req.user.id, u.id, u.id, req.user.id);
  })();
  res.json({ blocked: true });
});

router.delete('/:username/block', requireAuth, (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username=?').get(String(req.params.username).toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found.' });
  db.prepare('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?').run(req.user.id, u.id);
  res.json({ blocked: false });
});

router.get('/me/blocked', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT u.id,u.username,u.display_name,u.avatar FROM blocks b JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=? ORDER BY b.created_at DESC`).all(req.user.id));
});

module.exports = router;
