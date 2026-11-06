/**
 * Community access tied to paid classes.
 * A class host (who owns the paid community) can end students' community subscription when the class is over,
 * and can extend it again whenever they choose.
 */
const { db, notify } = require('./db');

const SQL_NOW = "datetime('now')";

function classRow(id) { return db.prepare('SELECT c.*, g.name AS group_name, g.price AS group_price, g.owner_id AS group_owner FROM classes c JOIN groups_ g ON g.id=c.group_id WHERE c.id=?').get(id); }

/** Students of a class that hold a paid, running membership in its community (never the owner). */
function students(c, onlyUser) {
  const rows = db.prepare(`SELECT e.user_id, m.expires_at FROM class_enrollments e
    JOIN group_members m ON m.group_id=? AND m.user_id=e.user_id
    WHERE e.class_id=? AND m.role!='owner' ${onlyUser ? 'AND e.user_id=?' : ''}`).all(...[c.group_id, c.id].concat(onlyUser ? [onlyUser] : []));
  return rows;
}

/** Another class in the same community that this student still has coming up (do not cut them off in the middle of a course). */
function hasUpcoming(c, userId) {
  return !!db.prepare(`SELECT 1 FROM class_enrollments e JOIN classes k ON k.id=e.class_id
    WHERE e.user_id=? AND k.group_id=? AND k.id!=? AND k.active=1 AND k.ended=0`).get(userId, c.group_id, c.id);
}

/**
 * End subscription access for the students of a class.
 * opts.graceDays: keep access for this many more days (default 0 = ends now)
 * opts.userId: only this student
 * opts.force: also cut students who still have another upcoming class in the community
 */
function endAccess(classId, opts = {}) {
  const c = classRow(classId);
  if (!c || !(c.group_price > 0)) return { ended: 0, skipped: 0 };
  const grace = Math.max(0, Math.min(365, parseInt(opts.graceDays, 10) || 0));
  let ended = 0, skipped = 0;
  db.transaction(() => {
    students(c, opts.userId).forEach(s => {
      if (!opts.force && hasUpcoming(c, s.user_id)) { skipped++; return; }
      // never lengthen access: keep whichever end date is sooner
      const r = db.prepare(`UPDATE group_members SET expires_at = CASE WHEN expires_at IS NOT NULL AND expires_at < datetime('now', ?) THEN expires_at ELSE datetime('now', ?) END,
        auto_renew=0, sub_ref=NULL, renew_notified=CURRENT_TIMESTAMP WHERE group_id=? AND user_id=?`).run('+' + grace + ' days', '+' + grace + ' days', c.group_id, s.user_id);
      if (r.changes) {
        ended++;
        notify(s.user_id, 'group', grace
          ? 'Your access to ' + c.group_name + ' ends in ' + grace + ' day' + (grace === 1 ? '' : 's') + ' because "' + c.title + '" has finished.'
          : 'Your access to ' + c.group_name + ' has ended because "' + c.title + '" has finished.', '/community/' + c.group_id);
      }
    });
  })();
  return { ended, skipped };
}

/** Extend subscription access by N days (or to a date). Works for running and already-expired memberships. */
function extendAccess(groupId, userIds, opts = {}) {
  const days = Math.max(0, Math.min(3650, parseInt(opts.days, 10) || 0));
  if (!days) return { extended: 0 };
  const g = db.prepare('SELECT name, price FROM groups_ WHERE id=?').get(groupId);
  if (!g) return { extended: 0 };
  let extended = 0;
  db.transaction(() => {
    userIds.forEach(uid => {
      const m = db.prepare("SELECT expires_at, role FROM group_members WHERE group_id=? AND user_id=?").get(groupId, uid);
      if (!m || m.role === 'owner') return;
      if (m.expires_at === null) return; // lifetime access already
      const r = db.prepare(`UPDATE group_members SET expires_at=datetime(CASE WHEN expires_at > ${SQL_NOW} THEN expires_at ELSE ${SQL_NOW} END, ?), renew_notified=NULL WHERE group_id=? AND user_id=?`).run('+' + days + ' days', groupId, uid);
      if (r.changes) { extended++; notify(uid, 'group', 'Your access to ' + g.name + ' was extended by ' + days + ' day' + (days === 1 ? '' : 's') + '.', '/community/' + groupId); }
    });
  })();
  return { extended };
}

/** Called by the scheduler when a class has finished. */
function onClassEnded(c) {
  if (c.access_policy !== 'end') return;
  const r = endAccess(c.id, { graceDays: c.access_grace_days });
  db.prepare('UPDATE classes SET access_applied=1 WHERE id=?').run(c.id);
  if (r.ended) notify(c.owner_id, 'class', 'Access to ' + (c.group_name || 'your community') + ' ended for ' + r.ended + ' student' + (r.ended === 1 ? '' : 's') + ' after "' + c.title + '".', '/class/' + c.id);
  return r;
}

module.exports = { endAccess, extendAccess, onClassEnded, students, classRow };
