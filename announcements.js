const express = require('express');
const { db } = require('../db');
const { requireAuth, optionalAuth } = require('../auth');
const { applies } = require('../announce');

const router = express.Router();

// Announcements the current visitor should see (banner / popup)
router.get('/', optionalAuth, (req, res) => {
  const rows = db.prepare(`SELECT id,title,body,style,audience,audience_value,guests,dismissible,link FROM announcements
    WHERE active=1 AND (starts_at IS NULL OR starts_at<=datetime('now')) AND (ends_at IS NULL OR ends_at>datetime('now')) ORDER BY id DESC LIMIT 50`).all();
  const gone = new Set(req.user ? db.prepare('SELECT announcement_id FROM announcement_dismissals WHERE user_id=?').all(req.user.id).map(r => r.announcement_id) : []);
  res.json(rows
    .filter(a => !gone.has(a.id))
    .filter(a => (req.user ? applies(a, req.user) : a.audience === 'all' && a.guests))
    .slice(0, 5)
    .map(a => ({ id: a.id, title: a.title, body: a.body, style: a.style, dismissible: !!a.dismissible, link: a.link })));
});

router.post('/:id/dismiss', requireAuth, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO announcement_dismissals(announcement_id,user_id) VALUES(?,?)').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
