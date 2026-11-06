const express = require('express');
const crypto = require('crypto');
const { db, getSetting, notify } = require('../db');
const { requireAuth, optionalAuth, featureOn, restrict, hasPerm } = require('../auth');
const { uploadMedia, claimMedia, removeFile } = require('../upload');
const { safeUrl } = require('../utils');
const ownerfees = require('../ownerfees');
const world = require('../world');
const access = require('../access');
const policyOf = b => (b.access_policy === 'end' ? 'end' : 'keep');
const graceOf = b => Math.max(0, Math.min(365, parseInt(b.access_grace_days, 10) || 0));

const router = express.Router();
router.use(featureOn('classes'));

const toSql = v => { const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0, 19).replace('T', ' '); };
const isMember = (gid, uid) => !!(uid && db.prepare('SELECT 1 FROM active_members WHERE group_id=? AND user_id=?').get(gid, uid));
const enrolled = (cid, uid) => !!(uid && db.prepare('SELECT 1 FROM class_enrollments WHERE class_id=? AND user_id=?').get(cid, uid));

const LIST_SQL = `SELECT c.id,c.group_id,c.owner_id,c.title,c.description,c.kind,c.starts_at,c.duration_min,c.capacity,c.price,c.currency,c.open_to,c.cover,c.active,c.fee_status,c.access_policy,c.access_grace_days,
  g.name AS group_name, u.username AS host, u.display_name AS host_name, u.avatar AS host_avatar,
  (SELECT COUNT(*) FROM class_enrollments WHERE class_id=c.id) AS enrolled
  FROM classes c JOIN groups_ g ON g.id=c.group_id JOIN users u ON u.id=c.owner_id`;

function shape(rows, uid) {
  return rows.map(c => ({ ...c, is_host: c.owner_id === uid, joined: enrolled(c.id, uid), free: c.price === 0, full: !!(c.capacity && c.enrolled >= c.capacity) }));
}

router.get('/', optionalAuth, (req, res) => {
  const w = ["c.active=1"], a = [];
  if (req.query.group_id) { w.push('c.group_id=?'); a.push(parseInt(req.query.group_id, 10)); }
  if (req.query.price === 'free') w.push('c.price=0');
  if (req.query.price === 'paid') w.push('c.price>0');
  if (req.query.when === 'past') w.push("c.kind='live' AND datetime(c.starts_at,'+'||c.duration_min||' minutes') < datetime('now')");
  else w.push("(c.kind!='live' OR datetime(c.starts_at,'+'||c.duration_min||' minutes') >= datetime('now'))");
  const rows = db.prepare(LIST_SQL + ' WHERE ' + w.join(' AND ') + " ORDER BY c.kind='live' DESC, c.starts_at ASC LIMIT 60").all(...a);
  res.json(shape(rows, req.user && req.user.id));
});

router.get('/mine', requireAuth, (req, res) => {
  res.json({
    hosting: shape(db.prepare(LIST_SQL + ' WHERE c.owner_id=? ORDER BY c.id DESC').all(req.user.id), req.user.id),
    attending: shape(db.prepare(LIST_SQL + ' JOIN class_enrollments e ON e.class_id=c.id WHERE e.user_id=? AND c.active=1 ORDER BY c.starts_at DESC').all(req.user.id), req.user.id)
  });
});

router.get('/:id', optionalAuth, (req, res) => {
  const c = db.prepare(LIST_SQL + ' WHERE c.id=?').get(req.params.id);
  if (!c || (!c.active && !(req.user && (req.user.id === c.owner_id || hasPerm(req.user, 'content'))))) return res.status(404).json({ error: 'Class not found.' });
  const uid = req.user && req.user.id;
  const host = uid === c.owner_id;
  const inv = host ? db.prepare("SELECT id,amount,currency,due_at,status FROM owner_invoices WHERE class_id=? AND kind='class_fee' ORDER BY id DESC LIMIT 1").get(c.id) : null;
  const out = shape([c], uid)[0];
  out.member = isMember(c.group_id, uid);
  out.can_enroll = c.active && !out.joined && !out.full && (c.open_to === 'anyone' || out.member || host);
  out.lessons_count = db.prepare('SELECT COUNT(*) n FROM class_lessons WHERE class_id=?').get(c.id).n;
  out.fee_invoice = inv && inv.status === 'due' && ownerfees.paymentsOn('class_fee') && !ownerfees.waived(uid) ? inv : null;
  out.replay_url = out.joined || host ? db.prepare('SELECT replay_url FROM classes WHERE id=?').get(c.id).replay_url : null;
  out.meeting_ready = !(db.prepare("SELECT 1 FROM owner_invoices WHERE class_id=? AND kind='class_fee' AND status='due' AND ?='before_start'").get(c.id, getSetting('class_fee_when')) && ownerfees.paymentsOn('class_fee'));
  res.json(out);
});

router.post('/', requireAuth, restrict('class'), (req, res) => {
  const b = req.body || {};
  const g = db.prepare('SELECT * FROM groups_ WHERE id=?').get(b.group_id);
  if (!g || g.owner_id !== req.user.id) return res.status(403).json({ error: 'Choose one of your own communities to host the class in.' });
  const overdue = ownerfees.blocked(req.user.id, 'classes');
  if (overdue) return res.status(403).json({ error: 'Please pay your overdue fee (' + world.format(overdue.amount, overdue.currency) + ') before hosting another class.', fee_due: true });
  const title = String(b.title || '').trim().slice(0, 120);
  if (title.length < 3) return res.status(400).json({ error: 'Give the class a title.' });
  const kind = ['live', 'recorded', 'external'].includes(b.kind) ? b.kind : 'live';
  let startsAt = null;
  if (kind !== 'recorded') {
    startsAt = toSql(b.starts_at);
    if (!startsAt || startsAt < new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19).replace('T', ' ')) return res.status(400).json({ error: 'Choose a start date and time in the future.' });
  }
  let meeting = null;
  if (kind === 'external') {
    meeting = safeUrl(b.meeting_url);
    if (!meeting) return res.status(400).json({ error: 'Enter the full meeting link (https://...).' });
  }
  const currency = world.normCurrency(b.currency, g.currency || 'USD');
  const price = Math.max(0, world.toMinor(b.price, currency));
  const duration = Math.min(720, Math.max(10, parseInt(b.duration_min, 10) || 60));
  const capacity = parseInt(b.capacity, 10) > 0 ? Math.min(100000, parseInt(b.capacity, 10)) : null;
  const room = kind === 'live' ? 'de-' + crypto.randomBytes(10).toString('hex') : null;
  const fee = ownerfees.classFee(req.user.id, { price });

  const id = db.transaction(() => {
    const info = db.prepare(`INSERT INTO classes(group_id,owner_id,title,description,kind,starts_at,duration_min,capacity,price,currency,open_to,room,meeting_url,active,fee_status,access_policy,access_grace_days)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(g.id, req.user.id, title, String(b.description || '').slice(0, 3000), kind, startsAt, duration, capacity, price, currency, b.open_to === 'anyone' ? 'anyone' : 'members', room, meeting,
        fee && fee.when === 'create' ? 0 : 1, fee ? (fee.when === 'after' ? 'pending_after' : 'due') : 'none', g.price > 0 ? policyOf(b) : 'keep', graceOf(b));
    if (fee && fee.when !== 'after') {
      ownerfees.createInvoice({ userId: req.user.id, kind: 'class_fee', classId: info.lastInsertRowid, amount: fee.amount, currency: fee.currency, graceDays: 0, note: 'Hosting fee for class "' + title + '"' });
      if (fee.when === 'before_start' && startsAt) db.prepare("UPDATE owner_invoices SET due_at=? WHERE class_id=? AND kind='class_fee'").run(startsAt, info.lastInsertRowid);
    }
    return info.lastInsertRowid;
  })();
  const invoice = fee && fee.when !== 'after' ? db.prepare("SELECT id,amount,currency,due_at FROM owner_invoices WHERE class_id=? AND kind='class_fee'").get(id) : null;
  // announce to community members
  if (!(fee && fee.when === 'create')) {
    db.prepare("SELECT user_id FROM active_members WHERE group_id=? AND user_id!=?").all(g.id, req.user.id)
      .forEach(m => notify(m.user_id, 'class', 'New ' + (price ? 'paid' : 'free') + ' class in ' + g.name + ': ' + title, '/class/' + id));
  }
  res.json({ id, fee: fee ? { amount: fee.amount, currency: fee.currency, when: fee.when, invoice_id: invoice ? invoice.id : null, payable_now: fee.when === 'create' } : null });
});

router.put('/:id', requireAuth, restrict('class'), (req, res) => {
  const c = db.prepare('SELECT * FROM classes WHERE id=?').get(req.params.id);
  if (!c || c.owner_id !== req.user.id) return res.status(403).json({ error: 'Not allowed.' });
  const b = req.body || {};
  const paidIn = db.prepare('SELECT COUNT(*) n FROM class_enrollments WHERE class_id=?').get(c.id).n > 0 && c.price > 0;
  let startsAt = null;
  if (b.starts_at) { startsAt = toSql(b.starts_at); if (!startsAt) return res.status(400).json({ error: 'Invalid date.' }); }
  const cur = world.normCurrency(b.currency, c.currency);
  if (b.price != null && paidIn && world.toMinor(b.price, cur) !== c.price) return res.status(400).json({ error: 'People have already paid, so the price cannot change.' });
  const meeting = b.meeting_url ? safeUrl(b.meeting_url) : null;
  if (b.meeting_url && !meeting) return res.status(400).json({ error: 'Enter a valid https:// meeting link.' });
  db.prepare(`UPDATE classes SET title=COALESCE(?,title), description=COALESCE(?,description), starts_at=COALESCE(?,starts_at), duration_min=COALESCE(?,duration_min),
    capacity=COALESCE(?,capacity), open_to=COALESCE(?,open_to), meeting_url=COALESCE(?,meeting_url), replay_url=COALESCE(?,replay_url), price=COALESCE(?,price), currency=?, reminded=CASE WHEN ? IS NULL THEN reminded ELSE 0 END WHERE id=?`)
    .run(b.title ? String(b.title).slice(0, 120) : null, b.description != null ? String(b.description).slice(0, 3000) : null, startsAt,
      b.duration_min ? Math.min(720, Math.max(10, parseInt(b.duration_min, 10) || 60)) : null, parseInt(b.capacity, 10) > 0 ? parseInt(b.capacity, 10) : null,
      ['members', 'anyone'].includes(b.open_to) ? b.open_to : null, meeting, b.replay_url ? safeUrl(b.replay_url) : null,
      b.price != null ? Math.max(0, world.toMinor(b.price, cur)) : null, cur, startsAt, c.id);
  if (b.access_policy != null) db.prepare('UPDATE classes SET access_policy=?, access_grace_days=? WHERE id=?').run(policyOf(b), graceOf(b), c.id);
  if (startsAt) db.prepare('SELECT user_id FROM class_enrollments WHERE class_id=?').all(c.id).forEach(e => notify(e.user_id, 'class', 'The time of "' + c.title + '" changed. Check the new schedule.', '/class/' + c.id));
  res.json({ ok: true });
});

/** Cancel a class. Not possible once people have paid (change the date instead). */
router.delete('/:id', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM classes WHERE id=?').get(req.params.id);
  if (!c || (c.owner_id !== req.user.id && !hasPerm(req.user, 'content'))) return res.status(403).json({ error: 'Not allowed.' });
  const n = db.prepare('SELECT COUNT(*) n FROM class_enrollments WHERE class_id=?').get(c.id).n;
  if (n && c.price > 0 && c.owner_id === req.user.id) return res.status(400).json({ error: 'People have already paid for this class, so it cannot be deleted. Change the date instead, or contact the site owner.' });
  db.prepare('SELECT user_id FROM class_enrollments WHERE class_id=?').all(c.id).forEach(e => notify(e.user_id, 'class', '"' + c.title + '" was cancelled by the host.', '/classes'));
  db.prepare('DELETE FROM classes WHERE id=?').run(c.id);
  res.json({ ok: true });
});

router.post('/:id/cover', requireAuth, uploadMedia.single('media'), async (req, res) => {
  try {
    const c = db.prepare('SELECT * FROM classes WHERE id=?').get(req.params.id);
    if (!c || c.owner_id !== req.user.id) { if (req.file) removeFile(req.file); return res.status(403).json({ error: 'Not allowed.' }); }
    if (!req.file || !/^image\//.test(req.file.mimetype)) { if (req.file) removeFile(req.file); return res.status(400).json({ error: 'Choose a picture.' }); }
    const m = await claimMedia(req.file, req.user.id);
    db.prepare('UPDATE classes SET cover=? WHERE id=?').run(m.url, c.id);
    res.json({ url: m.url });
  } catch (e) {
    if (req.file) removeFile(req.file);
    res.status(e.status || 400).json({ error: e.message, owner: e.owner });
  }
});

// ---------- Enrolment ----------
router.post('/:id/enroll', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM classes WHERE id=? AND active=1').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Class not found.' });
  if (c.price > 0) return res.status(402).json({ error: 'This is a paid class. Use checkout to enrol.', needs_payment: true, amount: c.price, currency: c.currency });
  if (c.open_to === 'members' && c.owner_id !== req.user.id && !isMember(c.group_id, req.user.id)) return res.status(403).json({ error: 'Join the community to enrol in this class.' });
  if (c.capacity && db.prepare('SELECT COUNT(*) n FROM class_enrollments WHERE class_id=?').get(c.id).n >= c.capacity) return res.status(400).json({ error: 'This class is full.' });
  const r = db.prepare('INSERT OR IGNORE INTO class_enrollments(class_id,user_id) VALUES(?,?)').run(c.id, req.user.id);
  if (r.changes) notify(c.owner_id, 'class', '@' + req.user.username + ' enrolled in "' + c.title + '"', '/class/' + c.id);
  res.json({ enrolled: true });
});
router.post('/:id/leave', requireAuth, (req, res) => {
  const c = db.prepare('SELECT price FROM classes WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Class not found.' });
  if (c.price > 0) return res.status(400).json({ error: 'Paid enrolments cannot be cancelled here. Contact the host.' });
  db.prepare('DELETE FROM class_enrollments WHERE class_id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ enrolled: false });
});

router.get('/:id/attendees', requireAuth, (req, res) => {
  const c = db.prepare('SELECT owner_id FROM classes WHERE id=?').get(req.params.id);
  if (!c || c.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the host can see who is attending.' });
  res.json(db.prepare('SELECT u.id,u.username,u.display_name,u.avatar,e.created_at FROM class_enrollments e JOIN users u ON u.id=e.user_id WHERE e.class_id=? ORDER BY e.created_at DESC').all(req.params.id));
});

// ---------- Community access for this class's students (host controls) ----------
const hostOf = (req, res) => {
  const c = db.prepare('SELECT id,owner_id,group_id FROM classes WHERE id=?').get(req.params.id);
  if (!c || c.owner_id !== req.user.id) { res.status(403).json({ error: 'Only the host can change students\' access.' }); return null; }
  return c;
};
/** Students with their current community access */
router.get('/:id/access', requireAuth, (req, res) => {
  const c = hostOf(req, res); if (!c) return;
  const rows = db.prepare(`SELECT u.id,u.username,u.display_name,u.avatar,m.expires_at,m.role FROM class_enrollments e JOIN users u ON u.id=e.user_id
    LEFT JOIN group_members m ON m.group_id=? AND m.user_id=u.id WHERE e.class_id=? ORDER BY u.username`).all(c.group_id, c.id);
  const k = db.prepare('SELECT access_policy,access_grace_days,access_applied FROM classes WHERE id=?').get(c.id);
  res.json({ policy: k.access_policy, grace_days: k.access_grace_days, applied: !!k.access_applied, students: rows.map(r => ({ ...r, active: r.role === 'owner' || (!!r.role && (!r.expires_at || r.expires_at > new Date().toISOString().slice(0, 19).replace('T', ' '))) })) });
});
/** End access now (or after N days) for all students, or one student (user_id) */
router.post('/:id/access/end', requireAuth, (req, res) => {
  const c = hostOf(req, res); if (!c) return;
  const b = req.body || {};
  const r = access.endAccess(c.id, { graceDays: graceOf({ access_grace_days: b.grace_days }), userId: parseInt(b.user_id, 10) || null, force: !!b.user_id || !!b.force });
  res.json({ ok: true, ...r });
});
/** Extend access by N days for all students, or one student (user_id) */
router.post('/:id/access/extend', requireAuth, (req, res) => {
  const c = hostOf(req, res); if (!c) return;
  const b = req.body || {};
  const days = parseInt(b.days, 10);
  if (!(days >= 1 && days <= 3650)) return res.status(400).json({ error: 'Enter the number of days to add (1 to 3650).' });
  const ids = b.user_id ? [parseInt(b.user_id, 10)] : db.prepare('SELECT user_id FROM class_enrollments WHERE class_id=?').all(c.id).map(x => x.user_id);
  res.json({ ok: true, ...access.extendAccess(c.group_id, ids, { days }) });
});

// ---------- Live room ----------
router.get('/:id/join', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM classes WHERE id=? AND active=1').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Class not found.' });
  const host = c.owner_id === req.user.id;
  if (!host && !enrolled(c.id, req.user.id)) return res.status(403).json({ error: 'Enrol in this class to join it.' });
  if (c.kind === 'recorded') return res.status(400).json({ error: 'This is a recorded course - open the lessons.' });
  if (ownerfees.paymentsOn('class_fee') && db.prepare("SELECT 1 FROM owner_invoices WHERE class_id=? AND kind='class_fee' AND status='due' AND due_at IS NOT NULL").get(c.id) && getSetting('class_fee_when') === 'before_start')
    return res.status(402).json({ error: host ? 'Pay the class hosting fee to open the room.' : 'The host still has to finish setting up this class. Please try again shortly.', fee_due: host });
  const start = Date.parse(c.starts_at.replace(' ', 'T') + 'Z');
  const now = Date.now();
  if (now < start - 15 * 60000) return res.status(425).json({ error: 'The room opens 15 minutes before the start.', starts_at: c.starts_at });
  if (now > start + (c.duration_min + 120) * 60000) return res.status(410).json({ error: 'This class has ended.' + (c.replay_url ? ' A replay is available.' : '') });
  if (c.kind === 'external') return res.json({ type: 'external', url: c.meeting_url });
  res.json({ type: 'jitsi', domain: getSetting('jitsi_domain') || 'meet.jit.si', room: c.room, name: req.user.display_name || req.user.username, host, subject: c.title });
});

// ---------- Recorded lessons ----------
router.get('/:id/lessons', requireAuth, (req, res) => {
  const c = db.prepare('SELECT owner_id FROM classes WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Class not found.' });
  if (c.owner_id !== req.user.id && !enrolled(req.params.id, req.user.id)) return res.status(403).json({ error: 'Enrol to see the lessons.' });
  res.json(db.prepare('SELECT * FROM class_lessons WHERE class_id=? ORDER BY position,id').all(req.params.id));
});
router.post('/:id/lessons', requireAuth, restrict('class'), uploadMedia.single('media'), async (req, res) => {
  try {
    const c = db.prepare('SELECT owner_id FROM classes WHERE id=?').get(req.params.id);
    if (!c || c.owner_id !== req.user.id) { if (req.file) removeFile(req.file); return res.status(403).json({ error: 'Not allowed.' }); }
    const title = String((req.body || {}).title || '').trim().slice(0, 120);
    if (!title) { if (req.file) removeFile(req.file); return res.status(400).json({ error: 'Give the lesson a title.' }); }
    let media = null;
    if (req.file) media = (await claimMedia(req.file, req.user.id)).url;
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 AS p FROM class_lessons WHERE class_id=?').get(req.params.id).p;
    const info = db.prepare('INSERT INTO class_lessons(class_id,title,content,media,position) VALUES(?,?,?,?,?)').run(req.params.id, title, String((req.body || {}).content || '').slice(0, 8000), media, pos);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (req.file) removeFile(req.file);
    res.status(e.status || 400).json({ error: e.message, owner: e.owner });
  }
});
router.delete('/lessons/:lid', requireAuth, (req, res) => {
  const l = db.prepare('SELECT l.id,c.owner_id FROM class_lessons l JOIN classes c ON c.id=l.class_id WHERE l.id=?').get(req.params.lid);
  if (!l || l.owner_id !== req.user.id) return res.status(403).json({ error: 'Not allowed.' });
  db.prepare('DELETE FROM class_lessons WHERE id=?').run(l.id);
  res.json({ ok: true });
});

module.exports = router;
