const express = require('express');
const { db, notify, getSetting } = require('../db');
const { requireAuth, optionalAuth, featureOn, restrict, hasPerm } = require('../auth');
const { notBlockedSQL, isBlocked, hiddenIds } = require('../social');
const { uploadMedia, claimMedia, removeFile } = require('../upload');
const rec = require('../recommend');

const router = express.Router();

const REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🔥', '👏', '🙏'];

function decorate(posts, viewerId) {
  const mine = new Map(viewerId ? db.prepare('SELECT post_id,emoji FROM likes WHERE user_id=?').all(viewerId).map(r => [r.post_id, r.emoji]) : []);
  const breakdown = db.prepare('SELECT emoji, COUNT(*) AS n FROM likes WHERE post_id=? GROUP BY emoji ORDER BY n DESC LIMIT 4');
  const reg = db.prepare('SELECT u.username FROM media_registry r JOIN users u ON u.id=r.owner_id WHERE r.hash=?');
  return posts.map(p => {
    const o = {
      id: p.id, user_id: p.user_id, username: p.username, display_name: p.display_name, avatar: p.avatar,
      type: p.type, title: p.title, body: p.body, media: p.media, category: p.category,
      tags: (p.tags || '').split(',').filter(Boolean), created_at: p.created_at, expires_at: p.expires_at,
      group_id: p.group_id, page_id: p.page_id,
      likes: p.likes != null ? p.likes : db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id=?').get(p.id).c,
      comments: p.comments != null ? p.comments : db.prepare('SELECT COUNT(*) c FROM comments WHERE post_id=?').get(p.id).c,
      views: p.views != null ? p.views : db.prepare('SELECT COUNT(*) c FROM post_views WHERE post_id=?').get(p.id).c,
      liked: mine.has(p.id),
      my_reaction: mine.get(p.id) || null,
      reactions: breakdown.all(p.id).map(r => ({ emoji: r.emoji, count: r.n })),
      duration: p.duration || null,
      favoured: !!p.favoured
    };
    if (p.media_hash) {
      const r = reg.get(p.media_hash);
      o.original_owner = r ? r.username : null;
    }
    return o;
  });
}

const BASE = `SELECT p.*, u.username, u.display_name, u.avatar, u.favoured,
  (SELECT COUNT(*) FROM likes WHERE post_id=p.id) AS likes,
  (SELECT COUNT(*) FROM comments WHERE post_id=p.id) AS comments,
  (SELECT COUNT(*) FROM post_views WHERE post_id=p.id) AS views
  FROM posts p JOIN users u ON u.id=p.user_id`;

// For-you feed (ranked by the recommendation engine)
router.get('/feed', optionalAuth, (req, res) => {
  const offset = parseInt(req.query.offset, 10) || 0;
  const mode = req.query.mode || 'foryou';
  let rows;
  const nb = notBlockedSQL(req.user && req.user.id, 'p.user_id');
  if (mode === 'following' && req.user) {
    rows = db.prepare(BASE + ` WHERE p.group_id IS NULL AND p.type!='story' AND p.user_id IN (SELECT target_id FROM follows WHERE follower_id=?)${nb} ORDER BY p.id DESC LIMIT 30 OFFSET ?`).all(req.user.id, offset);
  } else if (mode === 'latest' || !req.user) {
    rows = db.prepare(BASE + ` WHERE p.group_id IS NULL AND p.type!='story' AND u.status='active'${nb} ORDER BY p.id DESC LIMIT 30 OFFSET ?`).all(offset);
  } else {
    rows = rec.feedFor(req.user.id, 30, offset);
  }
  res.json(decorate(rows, req.user && req.user.id));
});

router.get('/stories', optionalAuth, featureOn('stories'), (req, res) => {
  const rows = db.prepare(BASE + ` WHERE p.type='story' AND p.expires_at > datetime('now') AND u.status='active'${notBlockedSQL(req.user && req.user.id, 'p.user_id')} ORDER BY p.id DESC LIMIT 60`).all();
  res.json(decorate(rows, req.user && req.user.id));
});

// Short vertical videos, best-engagement-first with a freshness boost
router.get('/reels', optionalAuth, featureOn('reels'), (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const nb = notBlockedSQL(req.user && req.user.id, 'p.user_id');
  const rows = db.prepare(BASE + ` WHERE p.type='reel' AND p.group_id IS NULL AND u.status='active'${nb} ORDER BY p.id DESC LIMIT 200`).all();
  const now = Date.now();
  rows.forEach(r => {
    const ageH = Math.max(0, (now - Date.parse(String(r.created_at).replace(' ', 'T') + 'Z')) / 3600000) || 0;
    r._score = (r.likes * 2 + r.comments * 3 + r.views * 0.5 + 3 + (r.favoured ? 5 : 0)) / Math.pow(ageH + 2, 0.8);
  });
  rows.sort((a, b) => b._score - a._score);
  res.json(decorate(rows.slice(offset, offset + 8), req.user && req.user.id));
});

router.get('/user/:username', optionalAuth, (req, res) => {
  const owner = db.prepare('SELECT id FROM users WHERE username=?').get(String(req.params.username).toLowerCase());
  if (owner && req.user && isBlocked(req.user.id, owner.id)) return res.json([]);
  const rows = db.prepare(BASE + ` WHERE u.username=? AND p.group_id IS NULL AND p.type!='story' ORDER BY p.id DESC LIMIT 60`).all(String(req.params.username).toLowerCase());
  res.json(decorate(rows, req.user && req.user.id));
});

router.get('/explore', optionalAuth, (req, res) => {
  const cat = req.query.category;
  const nb = notBlockedSQL(req.user && req.user.id, 'p.user_id');
  const rows = cat
    ? db.prepare(BASE + ` WHERE p.group_id IS NULL AND p.type!='story' AND p.category=?${nb} ORDER BY likes DESC, p.id DESC LIMIT 40`).all(cat)
    : db.prepare(BASE + ` WHERE p.group_id IS NULL AND p.type!='story'${nb} ORDER BY (likes*2+comments*3+views) DESC, p.id DESC LIMIT 40`).all();
  res.json(decorate(rows, req.user && req.user.id));
});

router.get('/:id', optionalAuth, (req, res) => {
  const p = db.prepare(BASE + ' WHERE p.id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found.' });
  if (req.user && isBlocked(req.user.id, p.user_id)) return res.status(404).json({ error: 'Post not found.' });
  if (p.group_id) {
    const m = req.user && db.prepare('SELECT 1 FROM active_members WHERE group_id=? AND user_id=?').get(p.group_id, req.user.id);
    if (!m) return res.status(403).json({ error: 'Join this group to see its posts.' });
  }
  res.json(decorate([p], req.user && req.user.id)[0]);
});

// Create a post: text, picture, video, song, or story
router.post('/', requireAuth, restrict('post'), uploadMedia.single('media'), async (req, res) => {
  try {
    let { type, title, body, category, tags, page_id, group_id } = req.body || {};
    type = ['text', 'image', 'video', 'audio', 'story', 'reel'].includes(type) ? type : 'text';
    body = String(body || '').slice(0, 5000);
    if (!req.file && !body.trim()) throw Object.assign(new Error('Write something or attach a file.'), { status: 400 });
    if (type === 'reel') {
      if (db.prepare("SELECT enabled FROM feature_flags WHERE key='reels'").get().enabled === 0) throw Object.assign(new Error('Reels are turned off.'), { status: 403 });
      if (!req.file || !/^video\//.test(req.file.mimetype)) throw Object.assign(new Error('A reel must be a video.'), { status: 400 });
      const max = parseInt(getSetting('reel_max_seconds'), 10) || 90;
      if (parseFloat(req.body.duration) > max + 1) throw Object.assign(new Error('Reels can be at most ' + max + ' seconds long.'), { status: 400 });
    }
    if (type === 'story' && db.prepare("SELECT enabled FROM feature_flags WHERE key='stories'").get().enabled === 0) throw Object.assign(new Error('Stories are turned off.'), { status: 403 });

    let gid = null;
    if (group_id) {
      gid = parseInt(group_id, 10);
      if (!db.prepare('SELECT 1 FROM active_members WHERE group_id=? AND user_id=?').get(gid, req.user.id)) throw Object.assign(new Error('Join the group first.'), { status: 403 });
    }
    let pid = null;
    if (page_id) {
      pid = parseInt(page_id, 10);
      if (!db.prepare('SELECT 1 FROM pages WHERE id=? AND owner_id=?').get(pid, req.user.id)) pid = null;
    }

    let mediaUrl = null, hash = null;
    if (req.file) {
      const c = await claimMedia(req.file, req.user.id);
      mediaUrl = c.url; hash = c.hash;
      if (type === 'reel') { /* stays a reel */ }
      else if (type !== 'story') type = c.kind === 'file' ? 'text' : c.kind;
      else if (c.kind === 'audio') type = 'story';
    }
    const tagList = String(tags || '').split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean).slice(0, 8).join(',');
    const expires = type === 'story' ? "datetime('now','+" + (parseInt(getSetting('story_hours'), 10) || 24) + " hours')" : null;
    const dur = type === 'reel' ? Math.min(600, Math.max(0, parseFloat(req.body.duration) || 0)) || null : null;
    const info = db.prepare(`INSERT INTO posts(user_id,page_id,group_id,type,title,body,media,media_hash,duration,category,tags,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?, ${expires || 'NULL'})`)
      .run(req.user.id, pid, gid, type, title ? String(title).slice(0, 150) : null, body, mediaUrl, hash, dur, category || null, tagList);
    if (!gid && type !== 'story') {
      db.prepare('SELECT follower_id FROM follows WHERE target_id=?').all(req.user.id)
        .forEach(f => notify(f.follower_id, 'post', '@' + req.user.username + (type === 'reel' ? ' posted a new reel' : ' posted something new'), (type === 'reel' ? '/reels?id=' : '/post/') + info.lastInsertRowid));
    }
    const p = db.prepare(BASE + ' WHERE p.id=?').get(info.lastInsertRowid);
    res.json(decorate([p], req.user.id)[0]);
  } catch (e) {
    if (req.file) removeFile(req.file);
    res.status(e.status || 400).json({ error: e.message, owner: e.owner });
  }
});

router.put('/:id', requireAuth, restrict('post'), (req, res) => {
  const p = db.prepare('SELECT user_id,type FROM posts WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found.' });
  if (p.user_id !== req.user.id) return res.status(403).json({ error: 'Not allowed.' });
  const b = req.body || {};
  const tagList = b.tags != null ? String(b.tags).split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean).slice(0, 8).join(',') : null;
  db.prepare('UPDATE posts SET title=COALESCE(?,title), body=COALESCE(?,body), tags=COALESCE(?,tags), category=COALESCE(?,category) WHERE id=?')
    .run(b.title != null ? String(b.title).slice(0, 150) : null, b.body != null ? String(b.body).slice(0, 5000) : null, tagList, b.category || null, req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  const p = db.prepare('SELECT user_id FROM posts WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found.' });
  if (p.user_id !== req.user.id && !hasPerm(req.user, 'content')) return res.status(403).json({ error: 'Not allowed.' });
  db.prepare('DELETE FROM posts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// React to a post. A plain like is the heart; pick another emoji to switch; pick the same one again to take it back.
router.post('/:id/like', requireAuth, (req, res) => {
  const p = db.prepare('SELECT id,user_id FROM posts WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found.' });
  if (isBlocked(req.user.id, p.user_id)) return res.status(403).json({ error: 'You cannot react to this post.' });
  const emoji = REACTIONS.includes((req.body || {}).emoji) ? req.body.emoji : '❤️';
  const had = db.prepare('SELECT emoji FROM likes WHERE post_id=? AND user_id=?').get(p.id, req.user.id);
  let mineNow = null;
  if (had && had.emoji === emoji) db.prepare('DELETE FROM likes WHERE post_id=? AND user_id=?').run(p.id, req.user.id);
  else {
    mineNow = emoji;
    db.prepare(`INSERT INTO likes(post_id,user_id,emoji) VALUES(?,?,?) ON CONFLICT(post_id,user_id) DO UPDATE SET emoji=excluded.emoji`).run(p.id, req.user.id, emoji);
    if (!had) {
      rec.learnFromPost(req.user.id, p.id, 'like');
      if (p.user_id !== req.user.id) notify(p.user_id, 'like', '@' + req.user.username + ' reacted ' + emoji + ' to your post', '/post/' + p.id);
    }
  }
  res.json({
    liked: !!mineNow, my_reaction: mineNow,
    likes: db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id=?').get(p.id).c,
    reactions: db.prepare('SELECT emoji, COUNT(*) AS count FROM likes WHERE post_id=? GROUP BY emoji ORDER BY count DESC LIMIT 4').all(p.id)
  });
});

router.get('/:id/reactions', requireAuth, (req, res) => {
  const hide = new Set(hiddenIds(req.user.id));
  res.json(db.prepare(`SELECT u.id,u.username,u.display_name,u.avatar,l.emoji FROM likes l JOIN users u ON u.id=l.user_id WHERE l.post_id=? ORDER BY l.created_at DESC LIMIT 200`).all(req.params.id).filter(r => !hide.has(r.id)));
});

// Record a view (viewer list is visible only to the post owner)
router.post('/:id/view', requireAuth, (req, res) => {
  const p = db.prepare('SELECT id,user_id FROM posts WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found.' });
  if (p.user_id !== req.user.id) {
    const r = db.prepare('INSERT OR IGNORE INTO post_views(post_id,viewer_id) VALUES(?,?)').run(p.id, req.user.id);
    if (r.changes) rec.learnFromPost(req.user.id, p.id, 'view');
  }
  res.json({ ok: true });
});

router.get('/:id/viewers', requireAuth, (req, res) => {
  const p = db.prepare('SELECT user_id FROM posts WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found.' });
  if (p.user_id !== req.user.id) return res.status(403).json({ error: 'Only the owner of a post can see who viewed it.' });
  const rows = db.prepare(`SELECT u.id,u.username,u.display_name,u.avatar,v.viewed_at FROM post_views v JOIN users u ON u.id=v.viewer_id
    WHERE v.post_id=? ORDER BY v.viewed_at DESC LIMIT 300`).all(req.params.id);
  res.json(rows);
});

router.get('/:id/comments', optionalAuth, (req, res) => {
  const rows = db.prepare(`SELECT c.*, u.username, u.display_name, u.avatar FROM comments c JOIN users u ON u.id=c.user_id
    WHERE c.post_id=? ORDER BY c.id ASC LIMIT 500`).all(req.params.id);
  const hide = new Set(hiddenIds(req.user && req.user.id));
  res.json(rows.filter(c => !hide.has(c.user_id)));
});

router.post('/:id/comments', requireAuth, restrict('comment'), (req, res) => {
  const p = db.prepare('SELECT id,user_id FROM posts WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found.' });
  if (isBlocked(req.user.id, p.user_id)) return res.status(403).json({ error: 'You cannot comment on this post.' });
  const body = String((req.body || {}).body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
  const parent = parseInt((req.body || {}).parent_id, 10) || null;
  const info = db.prepare('INSERT INTO comments(post_id,user_id,parent_id,body) VALUES(?,?,?,?)').run(p.id, req.user.id, parent, body);
  rec.learnFromPost(req.user.id, p.id, 'comment');
  if (p.user_id !== req.user.id) notify(p.user_id, 'comment', '@' + req.user.username + ' commented on your post', '/post/' + p.id);
  res.json(db.prepare(`SELECT c.*, u.username, u.display_name, u.avatar FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=?`).get(info.lastInsertRowid));
});

router.delete('/comments/:cid', requireAuth, (req, res) => {
  const c = db.prepare('SELECT c.user_id, p.user_id AS owner FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.id=?').get(req.params.cid);
  if (!c) return res.status(404).json({ error: 'Comment not found.' });
  if (c.user_id !== req.user.id && c.owner !== req.user.id && !hasPerm(req.user, 'content')) return res.status(403).json({ error: 'Not allowed.' });
  db.prepare('DELETE FROM comments WHERE id=?').run(req.params.cid);
  res.json({ ok: true });
});

module.exports = router;
module.exports.decorate = decorate;
module.exports.BASE = BASE;
module.exports.REACTIONS = REACTIONS;
