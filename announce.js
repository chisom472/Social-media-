// Who sees an announcement: everyone, chosen users, a category of users, or a single user.
const { db, notify } = require('./db');
const world = require('./world');

const SEGMENTS = {
  creators: { label: 'Creators (have a creator page)', sql: 'EXISTS (SELECT 1 FROM pages WHERE owner_id=u.id)' },
  sellers: { label: 'Sellers (have products)', sql: 'EXISTS (SELECT 1 FROM products WHERE seller_id=u.id)' },
  suppliers: { label: 'Dropshipping suppliers', sql: 'EXISTS (SELECT 1 FROM supplier_profiles WHERE user_id=u.id)' },
  store_owners: { label: 'Dropshipping store owners', sql: 'EXISTS (SELECT 1 FROM stores WHERE owner_id=u.id)' },
  community_owners: { label: 'Community owners', sql: 'EXISTS (SELECT 1 FROM groups_ WHERE owner_id=u.id)' },
  class_hosts: { label: 'Class hosts', sql: 'EXISTS (SELECT 1 FROM classes WHERE owner_id=u.id)' },
  new_users: { label: 'New users (joined in the last 7 days)', sql: "u.created_at > datetime('now','-7 days')" },
  favoured: { label: 'Favoured users', sql: 'u.favoured=1' },
  restricted: { label: 'Restricted users', sql: "u.restrictions!=''" },
  fee_due: { label: 'Users with an unpaid fee', sql: "EXISTS (SELECT 1 FROM owner_invoices WHERE user_id=u.id AND status='due')" },
  no_posts: { label: 'Users who never posted', sql: 'NOT EXISTS (SELECT 1 FROM posts WHERE user_id=u.id)' }
};

/** Builds "AND ..." SQL + args selecting the users an announcement is meant for. */
function audienceWhere(audience, value) {
  value = String(value || '').trim();
  if (audience === 'all') return { sql: '', args: [] };
  if (audience === 'user' || audience === 'users') {
    const names = value.split(',').map(s => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean).slice(0, 500);
    if (!names.length) return { sql: 'AND 0', args: [] };
    return { sql: `AND (lower(u.username) IN (${names.map(() => '?').join(',')}) OR lower(u.email) IN (${names.map(() => '?').join(',')}))`, args: [...names, ...names] };
  }
  if (audience === 'segment') {
    if (SEGMENTS[value]) return { sql: 'AND ' + SEGMENTS[value].sql, args: [] };
    if (/^country:[A-Za-z]{2}$/.test(value) && world.isCountry(value.slice(8))) return { sql: 'AND u.country=?', args: [value.slice(8).toUpperCase()] };
    if (/^interest:/.test(value)) return { sql: "AND (',' || u.interests || ',') LIKE ?", args: ['%,' + value.slice(9).replace(/[%_,]/g, '') + ',%'] };
  }
  return { sql: 'AND 0', args: [] };
}

function applies(ann, user) {
  if (ann.audience === 'all') return true;
  if (!user) return false;
  const w = audienceWhere(ann.audience, ann.audience_value);
  return !!db.prepare(`SELECT 1 FROM users u WHERE u.id=? ${w.sql}`).get(user.id, ...w.args);
}

function audienceCount(audience, value) {
  const w = audienceWhere(audience, value);
  return db.prepare(`SELECT COUNT(*) c FROM users u WHERE u.status='active' ${w.sql}`).get(...w.args).c;
}

/** Sends a notification (and push/email via the notifier) to everyone in the audience, in small batches so the site stays responsive. */
async function fanOut(ann, text) {
  const w = audienceWhere(ann.audience, ann.audience_value);
  const ids = db.prepare(`SELECT u.id FROM users u WHERE u.status='active' ${w.sql}`).all(...w.args).map(r => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    ids.slice(i, i + 200).forEach(id => notify(id, 'announcement', text, ann.link || '/notifications'));
    await new Promise(r => setTimeout(r, 50));
  }
  return ids.length;
}

module.exports = { SEGMENTS, audienceWhere, applies, audienceCount, fanOut };
