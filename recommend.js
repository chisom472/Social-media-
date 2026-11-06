// Recommendation engine: learns what each user loves from their signup interests
// and from their actions (likes, comments, views, follows) and ranks content/people.
const { db } = require('./db');
const { hiddenIds } = require('./social');

const WEIGHTS = { signup: 3, view: 0.5, like: 2, comment: 3, follow: 4, product: 2 };

function tagsOf(row) {
  const t = [];
  if (row.category) t.push(row.category.toLowerCase());
  (row.tags || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).forEach(x => t.push(x));
  return t;
}

function bump(userId, tags, weight) {
  const st = db.prepare(`INSERT INTO interests_score(user_id,tag,score) VALUES(?,?,?)
    ON CONFLICT(user_id,tag) DO UPDATE SET score=score+excluded.score`);
  const run = db.transaction(list => list.forEach(t => st.run(userId, t, weight)));
  run([...new Set(tags)]);
}

function learnFromPost(userId, postId, action) {
  const p = db.prepare('SELECT category,tags FROM posts WHERE id=?').get(postId);
  if (p) bump(userId, tagsOf(p), WEIGHTS[action] || 1);
}

function learnSignup(userId, interests) {
  bump(userId, (interests || []).map(s => s.toLowerCase()), WEIGHTS.signup);
}

function learnFromCreator(userId, creatorId) {
  const rows = db.prepare('SELECT category,tags FROM posts WHERE user_id=? ORDER BY id DESC LIMIT 15').all(creatorId);
  const tags = [];
  rows.forEach(r => tags.push(...tagsOf(r)));
  const page = db.prepare('SELECT category FROM pages WHERE owner_id=?').all(creatorId);
  page.forEach(p => p.category && tags.push(p.category.toLowerCase()));
  if (tags.length) bump(userId, tags, WEIGHTS.follow);
}

function profile(userId) {
  const map = {};
  db.prepare('SELECT tag,score FROM interests_score WHERE user_id=?').all(userId).forEach(r => (map[r.tag] = r.score));
  return map;
}

function hoursSince(ts) {
  return Math.max(0, (Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 3600000);
}

/** Ranked feed for a user (for-you). */
function feedFor(userId, limit = 30, offset = 0) {
  const prof = userId ? profile(userId) : {};
  const following = new Set(userId ? db.prepare('SELECT target_id FROM follows WHERE follower_id=?').all(userId).map(r => r.target_id) : []);
  const rows = db.prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar, u.favoured,
      (SELECT COUNT(*) FROM likes WHERE post_id=p.id) AS likes,
      (SELECT COUNT(*) FROM comments WHERE post_id=p.id) AS comments,
      (SELECT COUNT(*) FROM post_views WHERE post_id=p.id) AS views
    FROM posts p JOIN users u ON u.id=p.user_id
    WHERE p.group_id IS NULL AND p.type != 'story' AND u.status='active'
    ORDER BY p.id DESC LIMIT 400`).all();
  const hide = new Set(hiddenIds(userId));
  const scored = rows.filter(p => !hide.has(p.user_id)).map(p => {
    let s = p.favoured ? 1.5 : 0; // owner-favoured creators get a small boost
    tagsOf(p).forEach(t => { if (prof[t]) s += Math.log2(1 + prof[t]) * 2; });
    if (following.has(p.user_id)) s += 4;
    s += Math.log2(1 + p.likes * 2 + p.comments * 3 + p.views * 0.3);
    s -= hoursSince(p.created_at) / 24 * 0.8; // recency decay
    if (userId && p.user_id === userId) s -= 1;
    return { p, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(offset, offset + limit).map(x => x.p);
}

/** People and pages to suggest. */
function suggestPeople(userId, limit = 10) {
  const prof = profile(userId);
  const already = new Set(db.prepare('SELECT target_id FROM follows WHERE follower_id=?').all(userId).map(r => r.target_id));
  already.add(userId);
  const users = db.prepare(`
    SELECT u.id,u.username,u.display_name,u.avatar,u.bio,u.is_creator,u.favoured,u.interests,
      (SELECT COUNT(*) FROM follows WHERE target_id=u.id) AS followers,
      (SELECT name FROM pages WHERE owner_id=u.id LIMIT 1) AS page_name,
      (SELECT slug FROM pages WHERE owner_id=u.id LIMIT 1) AS page_slug,
      (SELECT category FROM pages WHERE owner_id=u.id LIMIT 1) AS page_category
    FROM users u WHERE u.status='active' AND u.role!='admin' ORDER BY u.id DESC LIMIT 300`).all();
  const mutual = db.prepare(`SELECT f2.target_id AS id, COUNT(*) AS c FROM follows f1 JOIN follows f2 ON f2.follower_id=f1.target_id
    WHERE f1.follower_id=? GROUP BY f2.target_id`).all(userId);
  const mutualMap = {}; mutual.forEach(m => (mutualMap[m.id] = m.c));
  const hide = new Set(hiddenIds(userId));
  const scored = users.filter(u => !already.has(u.id) && !hide.has(u.id)).map(u => {
    let s = u.favoured ? 2 : 0;
    const tags = (u.interests || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    if (u.page_category) tags.push(u.page_category.toLowerCase());
    tags.forEach(t => { if (prof[t]) s += Math.log2(1 + prof[t]) * 2; });
    if (u.is_creator) s += 2;
    s += (mutualMap[u.id] || 0) * 1.5;
    s += Math.log2(1 + u.followers);
    return { u, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map(x => { delete x.u.interests; return x.u; });
}

function suggestGroups(userId, limit = 6) {
  const prof = profile(userId);
  const joined = new Set(db.prepare('SELECT group_id FROM active_members WHERE user_id=?').all(userId).map(r => r.group_id));
  const groups = db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM active_members WHERE group_id=g.id) AS members FROM groups_ g ORDER BY g.id DESC LIMIT 100`).all();
  return groups.filter(g => !joined.has(g.id)).map(g => {
    let s = Math.log2(1 + g.members);
    if (g.category && prof[g.category.toLowerCase()]) s += Math.log2(1 + prof[g.category.toLowerCase()]) * 2;
    return { g, s };
  }).sort((a, b) => b.s - a.s).slice(0, limit).map(x => x.g);
}

module.exports = { learnFromPost, learnSignup, learnFromCreator, feedFor, suggestPeople, suggestGroups, tagsOf };
