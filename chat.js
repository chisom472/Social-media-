const express = require('express');
const { db, bus } = require('../db');
const { requireAuth, featureOn, restrict } = require('../auth');
const { isBlocked, hiddenIds } = require('../social');
const { uploadChat, removeFile } = require('../upload');
const { mediaKind } = require('../utils');

const router = express.Router();
router.use(featureOn('chat'));
router.use(requireAuth);

let io = null;
function setIO(server) { io = server; }
function emitToConv(convId, event, payload) {
  if (io) io.to('conv:' + convId).emit(event, payload);
}

function memberOf(convId, userId) {
  return db.prepare('SELECT * FROM conversation_members WHERE conversation_id=? AND user_id=?').get(convId, userId);
}

function shapeMessage(m, viewerId) {
  const s = db.prepare('SELECT username,display_name,avatar FROM users WHERE id=?').get(m.sender_id) || {};
  const reactions = db.prepare('SELECT emoji, COUNT(*) c FROM message_reactions WHERE message_id=? GROUP BY emoji').all(m.id);
  const mine = viewerId ? db.prepare('SELECT emoji FROM message_reactions WHERE message_id=? AND user_id=?').get(m.id, viewerId) : null;
  const reply = m.reply_to ? db.prepare('SELECT m.id,m.body,m.type,m.deleted,u.username FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?').get(m.reply_to) : null;
  // read status: seen by everyone else in conversation?
  const others = db.prepare('SELECT last_read_id FROM conversation_members WHERE conversation_id=? AND user_id!=?').all(m.conversation_id, m.sender_id);
  const read = others.length > 0 && others.every(o => o.last_read_id >= m.id);
  const starred = viewerId ? !!db.prepare('SELECT 1 FROM message_stars WHERE message_id=? AND user_id=?').get(m.id, viewerId) : false;
  return {
    id: m.id, conversation_id: m.conversation_id, sender_id: m.sender_id, username: s.username, display_name: s.display_name, avatar: s.avatar,
    type: m.type, body: m.deleted ? '' : m.body, media: m.deleted ? null : m.media, deleted: !!m.deleted, edited: !!m.edited,
    reply_to: reply ? { id: reply.id, username: reply.username, body: reply.deleted ? 'Message deleted' : (reply.body || '[' + reply.type + ']') } : null,
    reactions, my_reaction: mine ? mine.emoji : null, read, starred, created_at: m.created_at
  };
}

function convSummary(c, userId) {
  const members = db.prepare(`SELECT u.id,u.username,u.display_name,u.avatar,cm.role FROM conversation_members cm JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=?`).all(c.id);
  let title = c.name, avatar = c.avatar;
  if (c.type === 'dm') {
    const other = members.find(m => m.id !== userId) || members[0];
    title = other ? (other.display_name || other.username) : 'Chat';
    avatar = other ? other.avatar : null;
  }
  const last = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1').get(c.id);
  const me = memberOf(c.id, userId);
  const unread = db.prepare('SELECT COUNT(*) c FROM messages WHERE conversation_id=? AND id>? AND sender_id!=? AND deleted=0').get(c.id, me ? me.last_read_id : 0, userId).c;
  return {
    id: c.id, type: c.type, title, avatar, members, unread, muted: me ? !!me.muted : false,
    last: last ? { body: last.deleted ? 'Message deleted' : (last.body || '[' + last.type + ']'), created_at: last.created_at, mine: last.sender_id === userId } : null,
    updated: last ? last.created_at : c.created_at
  };
}

router.get('/conversations', (req, res) => {
  const rows = db.prepare(`SELECT c.* FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id WHERE m.user_id=?`).all(req.user.id);
  const list = rows.map(c => convSummary(c, req.user.id)).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  res.json(list);
});

// start (or reuse) a direct chat
router.post('/dm/:username', restrict('chat'), (req, res) => {
  const other = db.prepare("SELECT id FROM users WHERE username=? AND status='active'").get(String(req.params.username).toLowerCase());
  if (!other) return res.status(404).json({ error: 'User not found.' });
  if (other.id === req.user.id) return res.status(400).json({ error: "You can't message yourself." });
  if (isBlocked(req.user.id, other.id)) return res.status(403).json({ error: 'You cannot message this user.' });
  const existing = db.prepare(`SELECT c.id FROM conversations c
    JOIN conversation_members a ON a.conversation_id=c.id AND a.user_id=?
    JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id=?
    WHERE c.type='dm'`).get(req.user.id, other.id);
  if (existing) return res.json({ id: existing.id });
  const info = db.prepare("INSERT INTO conversations(type,created_by) VALUES('dm',?)").run(req.user.id);
  db.prepare('INSERT INTO conversation_members(conversation_id,user_id) VALUES(?,?)').run(info.lastInsertRowid, req.user.id);
  db.prepare('INSERT INTO conversation_members(conversation_id,user_id) VALUES(?,?)').run(info.lastInsertRowid, other.id);
  res.json({ id: info.lastInsertRowid });
});

// create a chat group
router.post('/groups', restrict('chat'), (req, res) => {
  const { name, usernames } = req.body || {};
  if (!name || String(name).trim().length < 1) return res.status(400).json({ error: 'Give the group a name.' });
  const info = db.prepare("INSERT INTO conversations(type,name,created_by) VALUES('group',?,?)").run(String(name).slice(0, 60), req.user.id);
  const cid = info.lastInsertRowid;
  db.prepare("INSERT INTO conversation_members(conversation_id,user_id,role) VALUES(?,?, 'admin')").run(cid, req.user.id);
  (Array.isArray(usernames) ? usernames : []).slice(0, 256).forEach(un => {
    const u = db.prepare("SELECT id FROM users WHERE username=? AND status='active'").get(String(un).toLowerCase());
    if (u && u.id !== req.user.id && !isBlocked(req.user.id, u.id)) db.prepare('INSERT OR IGNORE INTO conversation_members(conversation_id,user_id) VALUES(?,?)').run(cid, u.id);
  });
  const sys = db.prepare("INSERT INTO messages(conversation_id,sender_id,type,body) VALUES(?,?, 'system', ?)").run(cid, req.user.id, 'Group created by @' + req.user.username);
  if (io) db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id=?').all(cid).forEach(m => io.to('user:' + m.user_id).emit('conversation:new', { id: cid }));
  res.json({ id: cid, first: sys.lastInsertRowid });
});

router.post('/:id/members', (req, res) => {
  const me = memberOf(req.params.id, req.user.id);
  const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(req.params.id);
  if (!c || c.type !== 'group' || !me || me.role !== 'admin') return res.status(403).json({ error: 'Only group admins can add people.' });
  const u = db.prepare("SELECT id,username FROM users WHERE username=? AND status='active'").get(String((req.body || {}).username || '').toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found.' });
  db.prepare('INSERT OR IGNORE INTO conversation_members(conversation_id,user_id) VALUES(?,?)').run(c.id, u.id);
  db.prepare("INSERT INTO messages(conversation_id,sender_id,type,body) VALUES(?,?, 'system', ?)").run(c.id, req.user.id, '@' + req.user.username + ' added @' + u.username);
  if (io) { io.to('user:' + u.id).emit('conversation:new', { id: c.id }); io.to('conv:' + c.id).emit('conversation:update', { id: c.id }); }
  res.json({ ok: true });
});

router.post('/:id/members/:uid/remove', (req, res) => {
  const me = memberOf(req.params.id, req.user.id);
  const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(req.params.id);
  if (!c || c.type !== 'group' || !me || me.role !== 'admin') return res.status(403).json({ error: 'Only group admins can remove people.' });
  db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND user_id=?').run(c.id, req.params.uid);
  emitToConv(c.id, 'conversation:update', { id: c.id });
  res.json({ ok: true });
});

router.post('/:id/leave', (req, res) => {
  const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(req.params.id);
  if (!c || !memberOf(c.id, req.user.id)) return res.status(404).json({ error: 'Chat not found.' });
  db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND user_id=?').run(c.id, req.user.id);
  if (c.type === 'group') {
    db.prepare("INSERT INTO messages(conversation_id,sender_id,type,body) VALUES(?,?, 'system', ?)").run(c.id, req.user.id, '@' + req.user.username + ' left');
    const left = db.prepare('SELECT COUNT(*) c FROM conversation_members WHERE conversation_id=?').get(c.id).c;
    if (!left) db.prepare('DELETE FROM conversations WHERE id=?').run(c.id);
    else if (!db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id=? AND role='admin'").get(c.id))
      db.prepare("UPDATE conversation_members SET role='admin' WHERE rowid=(SELECT rowid FROM conversation_members WHERE conversation_id=? LIMIT 1)").run(c.id);
    emitToConv(c.id, 'conversation:update', { id: c.id });
  }
  res.json({ ok: true });
});

router.post('/:id/mute', (req, res) => {
  if (!memberOf(req.params.id, req.user.id)) return res.status(404).json({ error: 'Chat not found.' });
  db.prepare('UPDATE conversation_members SET muted=? WHERE conversation_id=? AND user_id=?').run((req.body || {}).muted ? 1 : 0, req.params.id, req.user.id);
  res.json({ ok: true });
});

router.get('/:id/messages', (req, res) => {
  const me = memberOf(req.params.id, req.user.id);
  if (!me) return res.status(403).json({ error: 'Not your chat.' });
  const before = parseInt(req.query.before, 10) || 9e15;
  const hide = new Set(hiddenIds(req.user.id));
  const rows = db.prepare('SELECT * FROM messages WHERE conversation_id=? AND id<? ORDER BY id DESC LIMIT 50').all(req.params.id, before).reverse().filter(m => !hide.has(m.sender_id));
  res.json(rows.map(m => shapeMessage(m, req.user.id)));
});

function sendMessage(convId, user, { type, body, media, reply_to }) {
  const info = db.prepare('INSERT INTO messages(conversation_id,sender_id,type,body,media,reply_to) VALUES(?,?,?,?,?,?)')
    .run(convId, user.id, type || 'text', body || '', media || null, reply_to || null);
  db.prepare('UPDATE conversation_members SET last_read_id=? WHERE conversation_id=? AND user_id=?').run(info.lastInsertRowid, convId, user.id);
  const msg = shapeMessage(db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid), user.id);
  if (io) {
    io.to('conv:' + convId).emit('message:new', msg);
    const members = db.prepare('SELECT user_id,muted FROM conversation_members WHERE conversation_id=?').all(convId);
    members.forEach(m => io.to('user:' + m.user_id).emit('conversation:bump', { id: convId, muted: !!m.muted, from: user.username }));
    const hide = new Set(hiddenIds(user.id));
    bus.emit('chat', { convId, sender: user, msg, recipients: members.filter(m => !m.muted && m.user_id !== user.id && !hide.has(m.user_id)).map(m => m.user_id) });
  }
  return msg;
}

router.post('/:id/messages', restrict('chat'), uploadChat.single('media'), (req, res) => {
  try {
    if (!memberOf(req.params.id, req.user.id)) { if (req.file) removeFile(req.file); return res.status(403).json({ error: 'Not your chat.' }); }
    const conv = db.prepare('SELECT type FROM conversations WHERE id=?').get(req.params.id);
    if (conv && conv.type === 'dm') {
      const other = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id=? AND user_id!=?').get(req.params.id, req.user.id);
      if (other && isBlocked(req.user.id, other.user_id)) { if (req.file) removeFile(req.file); return res.status(403).json({ error: 'You cannot message this user.' }); }
    }
    const body = String((req.body || {}).body || '').slice(0, 4000);
    const reply_to = parseInt((req.body || {}).reply_to, 10) || null;
    if (!req.file && !body.trim()) return res.status(400).json({ error: 'Message is empty.' });
    let type = 'text', media = null;
    if (req.file) {
      type = mediaKind(req.file.mimetype);
      if (type === 'audio' && req.body.voice === '1') type = 'voice';
      media = '/uploads/' + req.file.filename;
    }
    res.json(sendMessage(parseInt(req.params.id, 10), req.user, { type, body, media, reply_to }));
  } catch (e) {
    if (req.file) removeFile(req.file);
    res.status(400).json({ error: e.message });
  }
});

router.put('/messages/:mid', (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.mid);
  if (!m || m.sender_id !== req.user.id || m.deleted || m.type !== 'text') return res.status(403).json({ error: 'You can only edit your own text messages.' });
  db.prepare('UPDATE messages SET body=?, edited=1 WHERE id=?').run(String((req.body || {}).body || '').slice(0, 4000), m.id);
  const msg = shapeMessage(db.prepare('SELECT * FROM messages WHERE id=?').get(m.id), req.user.id);
  emitToConv(m.conversation_id, 'message:update', msg);
  res.json(msg);
});

// delete for everyone
router.delete('/messages/:mid', (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.mid);
  if (!m) return res.status(404).json({ error: 'Message not found.' });
  const me = memberOf(m.conversation_id, req.user.id);
  if (!me || (m.sender_id !== req.user.id && me.role !== 'admin')) return res.status(403).json({ error: 'Not allowed.' });
  db.prepare("UPDATE messages SET deleted=1, body='', media=NULL WHERE id=?").run(m.id);
  emitToConv(m.conversation_id, 'message:update', shapeMessage(db.prepare('SELECT * FROM messages WHERE id=?').get(m.id), req.user.id));
  res.json({ ok: true });
});

router.post('/messages/:mid/react', (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.mid);
  if (!m || !memberOf(m.conversation_id, req.user.id)) return res.status(403).json({ error: 'Not allowed.' });
  const emoji = String((req.body || {}).emoji || '').slice(0, 8);
  const cur = db.prepare('SELECT emoji FROM message_reactions WHERE message_id=? AND user_id=?').get(m.id, req.user.id);
  if (!emoji || (cur && cur.emoji === emoji)) db.prepare('DELETE FROM message_reactions WHERE message_id=? AND user_id=?').run(m.id, req.user.id);
  else db.prepare('INSERT INTO message_reactions(message_id,user_id,emoji) VALUES(?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET emoji=excluded.emoji').run(m.id, req.user.id, emoji);
  emitToConv(m.conversation_id, 'message:update', shapeMessage(db.prepare('SELECT * FROM messages WHERE id=?').get(m.id), req.user.id));
  res.json({ ok: true });
});

router.post('/messages/:mid/star', (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.mid);
  if (!m || !memberOf(m.conversation_id, req.user.id)) return res.status(403).json({ error: 'Not allowed.' });
  const had = db.prepare('SELECT 1 FROM message_stars WHERE message_id=? AND user_id=?').get(m.id, req.user.id);
  if (had) db.prepare('DELETE FROM message_stars WHERE message_id=? AND user_id=?').run(m.id, req.user.id);
  else db.prepare('INSERT INTO message_stars(message_id,user_id) VALUES(?,?)').run(m.id, req.user.id);
  res.json({ starred: !had });
});

router.post('/:id/read', (req, res) => {
  if (!memberOf(req.params.id, req.user.id)) return res.status(403).json({ error: 'Not your chat.' });
  const last = db.prepare('SELECT MAX(id) m FROM messages WHERE conversation_id=?').get(req.params.id).m || 0;
  db.prepare('UPDATE conversation_members SET last_read_id=? WHERE conversation_id=? AND user_id=?').run(last, req.params.id, req.user.id);
  emitToConv(parseInt(req.params.id, 10), 'conversation:read', { conversation_id: parseInt(req.params.id, 10), user_id: req.user.id, last_read_id: last });
  res.json({ ok: true });
});

router.get('/messages-search', (req, res) => {
  const q = '%' + String(req.query.q || '').replace(/[%_]/g, '') + '%';
  if (q.length < 4) return res.json([]);
  res.json(db.prepare(`SELECT m.id,m.conversation_id,m.body,m.created_at FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=?
    WHERE m.deleted=0 AND m.body LIKE ? ORDER BY m.id DESC LIMIT 30`).all(req.user.id, q));
});

router.get('/starred-all', (req, res) => {
  const rows = db.prepare('SELECT m.* FROM messages m JOIN message_stars s ON s.message_id=m.id WHERE s.user_id=? ORDER BY m.id DESC LIMIT 100').all(req.user.id);
  res.json(rows.map(m => shapeMessage(m, req.user.id)));
});

module.exports = router;
module.exports.setIO = setIO;
module.exports.memberOf = memberOf;
module.exports.sendMessage = sendMessage;
