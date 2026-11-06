// Block / unblock helpers. A block hides both users from each other everywhere.
const { db } = require('./db');

/** Ids of everyone who has blocked me or whom I have blocked (both directions). */
function hiddenIds(userId) {
  if (!userId) return [];
  const rows = db.prepare('SELECT blocked_id AS id FROM blocks WHERE blocker_id=? UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id=?').all(userId, userId);
  return rows.map(r => r.id);
}

function isBlocked(a, b) {
  if (!a || !b) return false;
  return !!db.prepare('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(a, b, b, a);
}

/** SQL fragment (ints only, safe to inline) excluding blocked authors. */
function notBlockedSQL(userId, column) {
  const ids = hiddenIds(userId);
  return ids.length ? ` AND ${column} NOT IN (${ids.map(Number).join(',')})` : '';
}

module.exports = { hiddenIds, isBlocked, notBlockedSQL };
