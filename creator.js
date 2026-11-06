// Data behind the creator dashboard (/creator): everything a creator needs in one place.
const express = require('express');
const { db } = require('../db');
const { requireAuth, featureOn } = require('../auth');
const ownerfees = require('../ownerfees');
const world = require('../world');

const router = express.Router();
router.use(featureOn('creator_dashboard'));
router.use(requireAuth);

const INCOME_TYPES = "('sale','reward_received','dropship_supply')";
const daysParam = (q, def = 30) => Math.min(365, Math.max(1, parseInt(q, 10) || def));

router.get('/overview', (req, res) => {
  const uid = req.user.id;
  const days = daysParam(req.query.days);
  const win = '-' + days + ' days';
  const one = (sql, ...a) => db.prepare(sql).get(...a).c;

  const income = db.prepare(`SELECT currency, SUM(amount) AS total, COUNT(*) AS n FROM wallet_tx WHERE user_id=? AND amount>0 AND type IN ${INCOME_TYPES} AND created_at>datetime('now',?) GROUP BY currency`).all(uid, win);
  const bySource = db.prepare(`SELECT CASE WHEN w.ref LIKE 'do_%' THEN 'dropship' WHEN o.purpose IS NOT NULL THEN o.purpose WHEN t.ref IS NOT NULL THEN 'support' ELSE w.type END AS source,
      w.currency, SUM(w.amount) AS total, COUNT(*) AS n
    FROM wallet_tx w LEFT JOIN orders o ON o.ref=w.ref LEFT JOIN tips t ON t.ref=w.ref
    WHERE w.user_id=? AND w.amount>0 AND w.type IN ${INCOME_TYPES} AND w.created_at>datetime('now',?) GROUP BY source, w.currency ORDER BY total DESC`).all(uid, win);

  const store = db.prepare('SELECT id,slug,brand_name FROM stores WHERE owner_id=?').get(uid);
  const hasSupplier = !!db.prepare('SELECT 1 FROM supplier_profiles WHERE user_id=?').get(uid);
  const dueFees = ownerfees.dueInvoices(uid);
  const todo = [];
  dueFees.forEach(i => todo.push({ kind: 'fee', text: 'Pay ' + world.format(i.amount, i.currency) + ' - ' + (i.note || i.kind), link: '/creator/fees', urgent: !!(i.due_at && i.due_at < new Date().toISOString().slice(0, 19).replace('T', ' ')) }));
  const toShip = hasSupplier ? one("SELECT COUNT(*) c FROM dropship_orders WHERE supplier_id=? AND status IN ('paid','awaiting_supplier','needs_attention','processing')", uid) : 0;
  if (toShip) todo.push({ kind: 'ship', text: toShip + ' dropship order' + (toShip > 1 ? 's' : '') + ' waiting to ship', link: '/dropship' });
  const refunds = store ? one("SELECT COUNT(*) c FROM dropship_orders WHERE store_id=? AND status='refund_needed'", store.id) : 0;
  if (refunds) todo.push({ kind: 'refund', text: refunds + ' store order' + (refunds > 1 ? 's' : '') + ' need a customer refund', link: '/dropship', urgent: true });
  const soon = db.prepare("SELECT id,title,starts_at FROM classes WHERE owner_id=? AND active=1 AND kind!='recorded' AND starts_at>datetime('now') AND starts_at<datetime('now','+2 days') ORDER BY starts_at LIMIT 3").all(uid);
  soon.forEach(c => todo.push({ kind: 'class', text: 'Class "' + c.title + '" starts soon', link: '/class/' + c.id }));
  const pendingAds = one("SELECT COUNT(*) c FROM ads WHERE owner_id=? AND status IN ('pending','pending_payment')", uid);
  if (pendingAds) todo.push({ kind: 'ad', text: pendingAds + ' advert' + (pendingAds > 1 ? 's' : '') + ' not live yet', link: '/creator/ads' });

  res.json({
    days,
    followers: { total: one('SELECT COUNT(*) c FROM follows WHERE target_id=?', uid), gained: one("SELECT COUNT(*) c FROM follows WHERE target_id=? AND created_at>datetime('now',?)", uid, win) },
    content: {
      posts: one("SELECT COUNT(*) c FROM posts WHERE user_id=? AND type!='story'", uid),
      reels: one("SELECT COUNT(*) c FROM posts WHERE user_id=? AND type='reel'", uid),
      published: one("SELECT COUNT(*) c FROM posts WHERE user_id=? AND created_at>datetime('now',?)", uid, win),
      views: one("SELECT COUNT(*) c FROM post_views v JOIN posts p ON p.id=v.post_id WHERE p.user_id=? AND v.viewed_at>datetime('now',?)", uid, win),
      reactions: one("SELECT COUNT(*) c FROM likes l JOIN posts p ON p.id=l.post_id WHERE p.user_id=? AND l.created_at>datetime('now',?)", uid, win),
      comments: one("SELECT COUNT(*) c FROM comments c JOIN posts p ON p.id=c.post_id WHERE p.user_id=? AND c.created_at>datetime('now',?) AND c.user_id!=?", uid, win, uid)
    },
    income, by_source: bySource,
    wallet: db.prepare('SELECT currency,balance FROM wallets WHERE user_id=? AND balance!=0 ORDER BY balance DESC').all(uid),
    pending_withdrawals: db.prepare("SELECT currency, SUM(amount) AS total, COUNT(*) AS n FROM withdrawals WHERE user_id=? AND status IN ('pending','processing') GROUP BY currency").all(uid),
    top_posts: db.prepare(`SELECT p.id,p.type,p.title,substr(p.body,1,80) AS body,p.created_at,
        (SELECT COUNT(*) FROM post_views WHERE post_id=p.id) AS views, (SELECT COUNT(*) FROM likes WHERE post_id=p.id) AS reactions, (SELECT COUNT(*) FROM comments WHERE post_id=p.id) AS comments
      FROM posts p WHERE p.user_id=? AND p.type!='story' ORDER BY (views + reactions*2 + comments*3) DESC LIMIT 5`).all(uid),
    classes: db.prepare(`SELECT c.id,c.title,c.starts_at,c.price,c.currency,c.kind,c.active,(SELECT COUNT(*) FROM class_enrollments WHERE class_id=c.id) AS enrolled
      FROM classes c WHERE c.owner_id=? ORDER BY c.starts_at DESC LIMIT 6`).all(uid),
    communities: db.prepare('SELECT g.id,g.name,g.price,g.currency,g.billing,(SELECT COUNT(*) FROM active_members WHERE group_id=g.id) AS members FROM groups_ g WHERE g.owner_id=? ORDER BY members DESC LIMIT 6').all(uid),
    products: { count: one('SELECT COUNT(*) c FROM products WHERE seller_id=? AND active=1', uid), sold: one("SELECT COUNT(*) c FROM orders o JOIN products p ON p.id=o.product_id WHERE p.seller_id=? AND o.status='paid'", uid) },
    store: store ? { ...store, orders: one("SELECT COUNT(*) c FROM dropship_orders WHERE store_id=? AND status NOT IN ('awaiting_payment')", store.id), to_ship: refunds } : null,
    supplier: hasSupplier ? { to_ship: toShip, products: one('SELECT COUNT(*) c FROM supplier_products WHERE supplier_id=? AND active=1', uid) } : null,
    ads: db.prepare("SELECT COALESCE(SUM(impressions),0) AS impressions, COALESCE(SUM(clicks),0) AS clicks, COUNT(*) AS n FROM ads WHERE owner_id=? AND status='active'").get(uid),
    fees_due: dueFees,
    page: db.prepare('SELECT slug,name FROM pages WHERE owner_id=?').get(uid) || null,
    todo
  });
});

router.get('/earnings', (req, res) => {
  const days = daysParam(req.query.days, 90);
  res.json({
    days,
    daily: db.prepare(`SELECT date(created_at) AS day, currency, SUM(amount) AS total FROM wallet_tx WHERE user_id=? AND amount>0 AND type IN ${INCOME_TYPES} AND created_at>datetime('now',?) GROUP BY day, currency ORDER BY day`).all(req.user.id, '-' + days + ' days'),
    recent: db.prepare(`SELECT w.id,w.type,w.amount,w.currency,w.note,w.created_at, CASE WHEN w.ref LIKE 'do_%' THEN 'dropship' WHEN o.purpose IS NOT NULL THEN o.purpose WHEN t.ref IS NOT NULL THEN 'support' ELSE w.type END AS source
      FROM wallet_tx w LEFT JOIN orders o ON o.ref=w.ref LEFT JOIN tips t ON t.ref=w.ref WHERE w.user_id=? AND w.amount>0 AND w.type IN ${INCOME_TYPES} ORDER BY w.id DESC LIMIT 30`).all(req.user.id)
  });
});

router.get('/content', (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const type = ['text', 'image', 'video', 'audio', 'reel', 'story'].includes(req.query.type) ? req.query.type : null;
  res.json(db.prepare(`SELECT p.id,p.type,p.title,substr(p.body,1,140) AS body,p.media,p.category,p.created_at,p.group_id,
      (SELECT COUNT(*) FROM post_views WHERE post_id=p.id) AS views, (SELECT COUNT(*) FROM likes WHERE post_id=p.id) AS reactions, (SELECT COUNT(*) FROM comments WHERE post_id=p.id) AS comments
    FROM posts p WHERE p.user_id=? ${type ? 'AND p.type=?' : ''} ORDER BY p.id DESC LIMIT 20 OFFSET ?`).all(...(type ? [req.user.id, type, offset] : [req.user.id, offset])));
});

router.get('/audience', (req, res) => {
  const uid = req.user.id;
  res.json({
    recent: db.prepare(`SELECT u.id,u.username,u.display_name,u.avatar,f.created_at FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.target_id=? AND u.status='active' ORDER BY f.created_at DESC LIMIT 20`).all(uid),
    growth: db.prepare("SELECT date(created_at) AS day, COUNT(*) AS n FROM follows WHERE target_id=? AND created_at>datetime('now','-30 days') GROUP BY day ORDER BY day").all(uid),
    countries: db.prepare(`SELECT u.country AS code, COUNT(*) AS n FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.target_id=? AND u.country IS NOT NULL GROUP BY u.country ORDER BY n DESC LIMIT 10`).all(uid)
      .map(c => ({ ...c, name: (world.countries.find(x => x.code === c.code) || {}).name || c.code })),
    supporters: db.prepare(`SELECT u.username,u.avatar,t.currency,SUM(t.amount) AS total,COUNT(*) AS times FROM tips t JOIN users u ON u.id=t.from_id WHERE t.to_id=? AND t.status='paid' GROUP BY t.from_id,t.currency ORDER BY total DESC LIMIT 10`).all(uid),
    top_viewers: db.prepare(`SELECT u.username,u.avatar,COUNT(*) AS views FROM post_views v JOIN posts p ON p.id=v.post_id JOIN users u ON u.id=v.viewer_id WHERE p.user_id=? GROUP BY v.viewer_id ORDER BY views DESC LIMIT 10`).all(uid)
  });
});

module.exports = router;
