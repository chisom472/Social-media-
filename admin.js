// Owner / staff control dashboard API.
// The owner (role 'admin') can do everything. Staff (role 'staff') can only use the sections the owner ticked for them
// in Admin > Team. Every route below says which permission it needs.
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, getSetting, setSetting, allSettings, notify, DEFAULT_SETTINGS, SECRET_SETTINGS } = require('../db');
const { requireStaff, requirePerm, hasPerm, PERMISSIONS, RESTRICTION_KEYS } = require('../auth');
const { slugify, sanitizeHtml, safeUrl, assertPublicUrl } = require('../utils');
const secrets = require('../secrets');
const world = require('../world');
const providers = require('../providers');
const payments = require('./payments');
const fx = require('../fx');
const ownerfees = require('../ownerfees');
const announce = require('../announce');
const ai = require('../ai');

const router = express.Router();
router.use(requireStaff);

const MASK = '********';
const jparse = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };
const base = req => process.env.SITE_URL || (req.protocol + '://' + req.get('host'));
const owner = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Only the owner can do this.' }));

function audit(req, action, detail) {
  db.prepare('INSERT INTO audit_log(admin_id,action,detail) VALUES(?,?,?)').run(req.user.id, action, String(detail || '').slice(0, 500));
}

/** Staff may never touch the owner or other staff accounts. */
function targetUser(req, res) {
  const u = db.prepare('SELECT id,username,role,status FROM users WHERE id=?').get(req.params.id);
  if (!u) { res.status(404).json({ error: 'User not found.' }); return null; }
  if (u.role !== 'user' && req.user.role !== 'admin') { res.status(403).json({ error: 'Only the owner can change admin accounts.' }); return null; }
  if (u.id === req.user.id) { res.status(400).json({ error: 'You cannot do this to your own account.' }); return null; }
  return u;
}

// ---------- Who am I ----------
router.get('/me', (req, res) => {
  const all = Object.keys(PERMISSIONS);
  res.json({ id: req.user.id, username: req.user.username, role: req.user.role, owner: req.user.role === 'admin',
    permissions: req.user.role === 'admin' ? all : String(req.user.permissions || '').split(',').filter(Boolean), catalogue: PERMISSIONS });
});

router.get('/stats', requirePerm('users_view', 'payments_view', 'content', 'site'), (req, res) => {
  const c = sql => db.prepare(sql).get().c;
  const money = hasPerm(req.user, 'payments_view');
  res.json({
    users: c('SELECT COUNT(*) c FROM users'),
    active_users: c("SELECT COUNT(*) c FROM users WHERE status='active'"),
    suspended: c("SELECT COUNT(*) c FROM users WHERE status!='active'"),
    new_week: c("SELECT COUNT(*) c FROM users WHERE created_at > datetime('now','-7 days')"),
    online_now: c("SELECT COUNT(*) c FROM users WHERE last_seen > datetime('now','-5 minutes')"),
    creators: c('SELECT COUNT(*) c FROM pages'),
    posts: c('SELECT COUNT(*) c FROM posts'),
    reels: c("SELECT COUNT(*) c FROM posts WHERE type='reel'"),
    groups: c('SELECT COUNT(*) c FROM groups_'),
    classes: c('SELECT COUNT(*) c FROM classes'),
    stores: c('SELECT COUNT(*) c FROM stores'),
    open_reports: c("SELECT COUNT(*) c FROM reports WHERE status='open'"),
    dropship_attention: c("SELECT COUNT(*) c FROM dropship_orders WHERE status IN ('needs_attention','refund_needed')"),
    ...(money ? {
      orders_paid: c("SELECT COUNT(*) c FROM orders WHERE status='paid'"),
      gross_volume: db.prepare("SELECT currency, SUM(amount) AS total FROM orders WHERE status='paid' AND purpose!='fund' GROUP BY currency").all(),
      owner_earnings: db.prepare("SELECT currency, SUM(amount) AS total FROM wallet_tx WHERE user_id=? AND type IN ('commission','creator_fee','class_fee','ad','dropship_capital') GROUP BY currency").all(payments.adminId()),
      pending_withdrawals: c("SELECT COUNT(*) c FROM withdrawals WHERE status='pending'"),
      manual_review: c("SELECT COUNT(*) c FROM orders WHERE status='review'"),
      invoices_due: c("SELECT COUNT(*) c FROM owner_invoices WHERE status='due'")
    } : {}),
    default_currency: getSetting('default_currency')
  });
});

// =====================================================================================
// Team (owner only): create staff and choose exactly what each can do
// =====================================================================================
router.get('/team', owner, (req, res) => {
  res.json({ catalogue: PERMISSIONS, staff: db.prepare("SELECT id,username,display_name,email,role,permissions,status,last_seen FROM users WHERE role='staff' ORDER BY id").all() });
});
const cleanPerms = list => (Array.isArray(list) ? list : String(list || '').split(',')).map(s => String(s).trim()).filter(k => PERMISSIONS[k]).join(',');
router.post('/team', owner, (req, res) => {
  const who = String((req.body || {}).user || '').trim().replace(/^@/, '').toLowerCase();
  const u = db.prepare('SELECT id,username,role FROM users WHERE lower(username)=? OR lower(email)=?').get(who, who);
  if (!u) return res.status(404).json({ error: 'No user with that username or email. Ask them to sign up first.' });
  if (u.role === 'admin') return res.status(400).json({ error: 'That is the owner account.' });
  db.prepare("UPDATE users SET role='staff', permissions=?, token_version=token_version WHERE id=?").run(cleanPerms((req.body || {}).permissions), u.id);
  notify(u.id, 'staff', 'You were added to the admin team. Open the Admin dashboard.', '/admin');
  audit(req, 'team-add', '@' + u.username + ' [' + cleanPerms((req.body || {}).permissions) + ']');
  res.json({ ok: true });
});
router.put('/team/:id', owner, (req, res) => {
  const u = db.prepare("SELECT id,username FROM users WHERE id=? AND role='staff'").get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Staff member not found.' });
  db.prepare('UPDATE users SET permissions=? WHERE id=?').run(cleanPerms((req.body || {}).permissions), u.id);
  audit(req, 'team-permissions', '@' + u.username + ' [' + cleanPerms((req.body || {}).permissions) + ']');
  res.json({ ok: true });
});
router.delete('/team/:id', owner, (req, res) => {
  const u = db.prepare("SELECT id,username FROM users WHERE id=? AND role='staff'").get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Staff member not found.' });
  db.prepare("UPDATE users SET role='user', permissions='', token_version=token_version+1 WHERE id=?").run(u.id);
  audit(req, 'team-remove', '@' + u.username);
  res.json({ ok: true });
});

// ---------- Paying the team (owner only, any time, any currency) ----------
// "wallet": taken from the owner's own wallet balance. "external": the owner is paying from money held outside the app
// (a provider balance, a bank, crypto) - the staff member's wallet is credited and the owner settles it when approving
// that staff member's withdrawal. Either way the staff member withdraws like anyone: any currency (naira included), any
// Nigerian bank or fintech app, or crypto.
router.post('/team/:id/pay', owner, (req, res) => {
  const u = db.prepare("SELECT id,username FROM users WHERE id=? AND role='staff'").get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Staff member not found.' });
  const b = req.body || {};
  const cur = world.normCurrency(b.currency, null);
  const amount = cur ? world.toMinor(b.amount, cur) : 0;
  if (!cur || amount <= 0) return res.status(400).json({ error: 'Enter an amount and choose a currency.' });
  const source = b.source === 'external' ? 'external' : 'wallet';
  const note = String(b.note || 'Payment from the owner').slice(0, 200);
  try {
    db.transaction(() => {
      if (source === 'wallet') payments.debit(req.user.id, amount, cur, 'staff_pay', 'staff' + u.id, 'Paid @' + u.username + ': ' + note);
      payments.credit(u.id, amount, cur, 'staff_pay', 'staff' + req.user.id, note);
      db.prepare('INSERT INTO staff_payments(staff_id,amount,currency,source,note,created_by) VALUES(?,?,?,?,?,?)').run(u.id, amount, cur, source, note, req.user.id);
    })();
  } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  notify(u.id, 'payment', 'You received ' + world.format(amount, cur) + ' from the owner. Withdraw it from your wallet.', '/wallet');
  audit(req, 'staff-pay', '@' + u.username + ' ' + world.format(amount, cur) + ' (' + source + ')');
  res.json({ ok: true });
});
router.get('/team/:id/payments', owner, (req, res) => {
  res.json(db.prepare('SELECT id,amount,currency,source,note,created_at FROM staff_payments WHERE staff_id=? ORDER BY id DESC LIMIT 100').all(req.params.id));
});
router.get('/my-pay', (req, res) => { // a team member sees what they were paid
  res.json({ payments: db.prepare('SELECT id,amount,currency,source,note,created_at FROM staff_payments WHERE staff_id=? ORDER BY id DESC LIMIT 100').all(req.user.id),
    wallets: db.prepare('SELECT currency,balance FROM wallets WHERE user_id=? AND balance>0').all(req.user.id) });
});

// =====================================================================================
// Settings. Each setting needs the permission for its area. The owner can change all of them.
// =====================================================================================
const OWNER_ONLY = /^(smtp_|sms_|google_|vapid_|printful_api_token|printful_webhook_token|printify_api_token|printify_webhook_secret|cj_api_key|min_age$|dropship_user_suppliers$)/;
function settingPerm(k) {
  if (OWNER_ONLY.test(k)) return 'owner';
  if (/^(paystack|flutterwave|stripe|paypal|tap_|wise_|nowpayments|btcpay|manual_|owner_(country|bank|account|swift)|accepted_currencies|fx_|ng_)/.test(k)) return 'settings_payments';
  if (/fee|commission|owner_payments|^pay_.*_enabled|owner_fee|^class_|^creator_/.test(k)) return 'fees';  // includes dropship_fee_*
  if (/^ads_/.test(k)) return 'ads';
  if (/^ai_/.test(k)) return 'ai';
  if (/^(printful|printify|cj_|pod_|dropship|pay_dropship|store_domain)/.test(k)) return 'dropship';
  if (/^(policy|terms|privacy)/.test(k)) return 'writeups';
  return 'site';
}
router.get('/settings', (req, res) => {
  const s = allSettings();
  const out = {};
  Object.keys(s).forEach(k => {
    const p = settingPerm(k);
    if (p === 'owner' ? req.user.role !== 'admin' : !hasPerm(req.user, p)) return;
    out[k] = SECRET_SETTINGS.has(k) ? (s[k] ? MASK : '') : s[k];
  });
  out._perm = Object.fromEntries(Object.keys(out).map(k => [k, settingPerm(k)]));
  res.json(out);
});
router.put('/settings', (req, res) => {
  const body = req.body || {};
  const changed = [], denied = [];
  Object.keys(body).forEach(k => {
    if (!(k in DEFAULT_SETTINGS)) return;
    const p = settingPerm(k);
    if (p === 'owner' ? req.user.role !== 'admin' : !hasPerm(req.user, p)) { denied.push(k); return; }
    let v = body[k];
    if (SECRET_SETTINGS.has(k) && v === MASK) return;
    if (typeof v === 'boolean') v = v ? '1' : '0';
    v = String(v == null ? '' : v);
    if (/^(policy_html|terms_html|privacy_html)$/.test(k)) v = sanitizeHtml(v);
    setSetting(k, v);
    changed.push(SECRET_SETTINGS.has(k) ? k + ' (secret)' : k);
  });
  if (changed.length) audit(req, 'settings', changed.join(', '));
  res.json({ ok: true, changed, denied });
});

// =====================================================================================
// Users
// =====================================================================================
router.get('/users', requirePerm('users_view'), (req, res) => {
  const priv = hasPerm(req.user, 'users_private');
  const q = '%' + String(req.query.q || '').replace(/[%_]/g, '') + '%';
  const cc = /^[A-Za-z]{2}$/.test(req.query.country || '') ? String(req.query.country).toUpperCase() : null;
  const rows = db.prepare(`SELECT u.id,u.username,u.display_name,u.role,u.status,u.is_creator,u.favoured,u.restrictions,u.owner_fee_waived,u.country,u.signup_country,u.last_country,u.created_at,u.last_seen,
      ${priv ? 'u.email,u.phone,u.dob,u.city,u.region,' : ''}
      (SELECT COUNT(*) FROM posts WHERE user_id=u.id) AS posts
    FROM users u WHERE (u.username LIKE ? OR u.display_name LIKE ? ${priv ? 'OR u.email LIKE ? OR u.phone LIKE ?' : ''}) ${cc ? 'AND (u.country=? OR (u.country IS NULL AND u.last_country=?))' : ''}
    ORDER BY u.id DESC LIMIT 300`).all(...[q, q, ...(priv ? [q, q] : []), ...(cc ? [cc, cc] : [])]);
  res.json(rows);
});

router.get('/users/countries', requirePerm('users_view'), (req, res) => {
  res.json(db.prepare(`SELECT COALESCE(country, last_country, signup_country) AS country, COUNT(*) AS users FROM users GROUP BY 1 ORDER BY users DESC`).all()
    .map(r => ({ ...r, name: (world.countries.find(c => c.code === r.country) || {}).name || (r.country ? r.country : 'Unknown') })));
});

router.get('/users/export.csv', requirePerm('users_private'), (req, res) => {
  const rows = db.prepare('SELECT id,username,display_name,email,phone,dob,country,region,city,signup_country,last_country,status,role,created_at,last_seen FROM users ORDER BY id').all();
  const cols = Object.keys(rows[0] || { id: 1 });
  const cell = v => { v = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; }; // stops spreadsheet formula injection
  audit(req, 'export-users', rows.length + ' rows');
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="users.csv"').send([cols.join(',')].concat(rows.map(r => cols.map(c => cell(r[c])).join(','))).join('\n'));
});

router.get('/users/:id', requirePerm('users_view'), (req, res) => {
  const priv = hasPerm(req.user, 'users_private');
  const u = db.prepare(`SELECT id,username,display_name,bio,avatar,role,permissions,status,is_creator,favoured,restrictions,restriction_note,owner_fee_waived,commission_override,class_fee_override,creator_fee_override,
      country,signup_country,last_country,location_privacy,interests,google_sub IS NOT NULL AS has_google,created_at,last_seen,failed_logins,locked_until
      ${priv ? ',email,phone,dob,region,city' : ''} FROM users WHERE id=?`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  if (priv) audit(req, 'view-private', '@' + u.username);
  const one = sql => db.prepare(sql).get(u.id);
  res.json({
    user: u,
    stats: { posts: one('SELECT COUNT(*) c FROM posts WHERE user_id=?').c, followers: one('SELECT COUNT(*) c FROM follows WHERE target_id=?').c, following: one('SELECT COUNT(*) c FROM follows WHERE follower_id=?').c,
      pages: one('SELECT COUNT(*) c FROM pages WHERE owner_id=?').c, communities: one('SELECT COUNT(*) c FROM groups_ WHERE owner_id=?').c, classes: one('SELECT COUNT(*) c FROM classes WHERE owner_id=?').c, store: !!one('SELECT id FROM stores WHERE owner_id=?') },
    wallets: hasPerm(req.user, 'payments_view') ? db.prepare('SELECT currency,balance FROM wallets WHERE user_id=?').all(u.id) : undefined,
    invoices: hasPerm(req.user, 'payments_view') ? db.prepare('SELECT id,kind,amount,currency,status,due_at,note FROM owner_invoices WHERE user_id=? ORDER BY id DESC LIMIT 20').all(u.id) : undefined,
    logins: priv ? db.prepare('SELECT ok,country,ua,created_at FROM login_events WHERE user_id=? ORDER BY id DESC LIMIT 15').all(u.id) : undefined
  });
});

router.post('/users/:id/status', requirePerm('users_manage'), (req, res) => {
  const status = (req.body || {}).status;
  if (!['active', 'suspended', 'banned'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const u = targetUser(req, res); if (!u) return;
  db.prepare('UPDATE users SET status=?, token_version=token_version+1 WHERE id=?').run(status, u.id);
  audit(req, 'user-status', '@' + u.username + ' -> ' + status);
  res.json({ ok: true });
});

router.put('/users/:id/flags', requirePerm('users_manage'), (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  const b = req.body || {};
  const sets = [], vals = [];
  const add = (c, v) => { sets.push(c + '=?'); vals.push(v); };
  if (b.favoured != null) add('favoured', b.favoured ? 1 : 0);
  if (b.restrictions != null) {
    const list = (Array.isArray(b.restrictions) ? b.restrictions : String(b.restrictions).split(',')).map(s => s.trim()).filter(k => k === 'all' || RESTRICTION_KEYS[k]);
    add('restrictions', [...new Set(list)].join(','));
    add('restriction_note', String(b.restriction_note || '').slice(0, 200) || null);
  }
  const num = (v, min, max) => (v === '' || v == null ? null : Math.min(max, Math.max(min, Number(v))));
  if ('commission_override' in b && hasPerm(req.user, 'fees')) add('commission_override', num(b.commission_override, 0, 100));
  if ('class_fee_override' in b && hasPerm(req.user, 'fees')) add('class_fee_override', b.class_fee_override === '' || b.class_fee_override == null ? null : Math.max(0, parseInt(b.class_fee_override, 10) || 0));
  if ('creator_fee_override' in b && hasPerm(req.user, 'fees')) add('creator_fee_override', b.creator_fee_override === '' || b.creator_fee_override == null ? null : Math.max(0, parseInt(b.creator_fee_override, 10) || 0));
  if (b.owner_fee_waived != null && hasPerm(req.user, 'fees')) add('owner_fee_waived', b.owner_fee_waived ? 1 : 0);
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
  db.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...vals, u.id);
  audit(req, 'user-flags', '@' + u.username + ' ' + JSON.stringify(b).slice(0, 200));
  res.json({ ok: true });
});

router.post('/users/:id/grant-creator', requirePerm('payments_manage', 'fees'), (req, res) => {
  const days = Math.min(3650, Math.max(1, parseInt((req.body || {}).days, 10) || 30));
  const u = targetUser(req, res); if (!u) return;
  db.prepare(`INSERT INTO creator_subscriptions(user_id,paid_until) VALUES(?, datetime('now', ?))
    ON CONFLICT(user_id) DO UPDATE SET paid_until=excluded.paid_until, updated_at=CURRENT_TIMESTAMP`).run(u.id, '+' + days + ' days');
  notify(u.id, 'creator', 'The owner granted you ' + days + ' days of creator access', '/creator');
  audit(req, 'grant-creator', '@' + u.username + ' ' + days + 'd');
  res.json({ ok: true });
});

// The owner never sees a user's password. They can set a temporary one or create a one-time reset link to send.
router.post('/users/:id/reset-link', requirePerm('users_manage'), (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('DELETE FROM password_resets WHERE user_id=?').run(u.id);
  db.prepare("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,datetime('now','+1 hour'))").run(crypto.createHash('sha256').update(token).digest('hex'), u.id);
  audit(req, 'reset-link', '@' + u.username);
  res.json({ link: base(req) + '/reset/' + token, expires: '1 hour' });
});
router.post('/users/:id/reset-password', requirePerm('users_manage'), (req, res) => {
  const pw = String((req.body || {}).password || '');
  if (pw.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
  const u = targetUser(req, res); if (!u) return;
  db.prepare('UPDATE users SET password_hash=?, token_version=token_version+1, failed_logins=0, locked_until=NULL WHERE id=?').run(bcrypt.hashSync(pw, 12), u.id);
  audit(req, 'reset-password', '@' + u.username);
  res.json({ ok: true });
});
router.post('/users/:id/unlock', requirePerm('users_manage'), (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  db.prepare('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=?').run(u.id);
  audit(req, 'unlock', '@' + u.username);
  res.json({ ok: true });
});
router.delete('/users/:id', requirePerm('users_delete'), (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  if (u.role !== 'user') return res.status(400).json({ error: 'Remove them from the team first.' });
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  audit(req, 'delete-user', '@' + u.username);
  res.json({ ok: true });
});

// =====================================================================================
// Content moderation and reports
// =====================================================================================
const KINDS = {
  posts: { tbl: 'posts', sql: `SELECT p.id,p.type,p.title,substr(p.body,1,120) AS body,p.created_at,u.username FROM posts p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 150` },
  pages: { tbl: 'pages', sql: `SELECT p.id,p.slug,p.name,p.category,p.created_at,u.username FROM pages p JOIN users u ON u.id=p.owner_id ORDER BY p.id DESC LIMIT 150` },
  groups: { tbl: 'groups_', sql: `SELECT g.id,g.name,g.focus,g.price,g.currency,g.created_at,u.username FROM groups_ g JOIN users u ON u.id=g.owner_id ORDER BY g.id DESC LIMIT 150` },
  products: { tbl: 'products', sql: `SELECT p.id,p.title,p.kind,p.price,p.currency,p.active,u.username FROM products p JOIN users u ON u.id=p.seller_id ORDER BY p.id DESC LIMIT 150` },
  classes: { tbl: 'classes', sql: `SELECT c.id,c.title,c.price,c.currency,c.starts_at,c.kind,u.username FROM classes c JOIN users u ON u.id=c.owner_id ORDER BY c.id DESC LIMIT 150` }
};
router.get('/content/:kind', requirePerm('content'), (req, res) => {
  const k = KINDS[req.params.kind];
  if (!k) return res.status(404).json({ error: 'Unknown content type.' });
  res.json(db.prepare(k.sql).all());
});
router.delete('/content/:kind/:id', requirePerm('content'), (req, res) => {
  const k = KINDS[req.params.kind];
  if (!k) return res.status(404).json({ error: 'Unknown content type.' });
  if (req.params.kind === 'classes' && db.prepare("SELECT 1 FROM orders WHERE class_id=? AND status='paid'").get(req.params.id)) return res.status(400).json({ error: 'This class has paid students. Cancel and refund them first.' });
  db.prepare(`DELETE FROM ${k.tbl} WHERE id=?`).run(req.params.id);
  audit(req, 'delete-' + req.params.kind, '#' + req.params.id);
  res.json({ ok: true });
});
router.get('/reports', requirePerm('reports'), (req, res) => {
  res.json(db.prepare(`SELECT r.*, u.username AS reporter FROM reports r LEFT JOIN users u ON u.id=r.reporter_id ORDER BY r.status='open' DESC, r.id DESC LIMIT 200`).all());
});
router.post('/reports/:id/resolve', requirePerm('reports'), (req, res) => {
  db.prepare("UPDATE reports SET status='resolved' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// =====================================================================================
// Money: transactions, manual approvals, withdrawals
// =====================================================================================
router.get('/transactions', requirePerm('payments_view'), (req, res) => {
  res.json(db.prepare(`SELECT o.id,o.ref,o.purpose,o.amount,o.currency,o.provider,o.status,o.created_at,COALESCE(u.username, o.buyer_email, 'guest') AS buyer FROM orders o LEFT JOIN users u ON u.id=o.buyer_id ORDER BY o.id DESC LIMIT 300`).all());
});

router.get('/manual-payments', requirePerm('payments_view'), (req, res) => {
  res.json(db.prepare(`SELECT o.id,o.ref,o.purpose,o.amount,o.currency,o.provider,o.proof,o.proof_note,o.created_at,COALESCE(u.username, o.buyer_email) AS buyer FROM orders o LEFT JOIN users u ON u.id=o.buyer_id
    WHERE o.status='review' ORDER BY o.id DESC LIMIT 100`).all());
});
router.post('/manual-payments/:id/approve', requirePerm('payments_manage'), (req, res) => {
  const o = db.prepare("SELECT * FROM orders WHERE id=? AND status='review'").get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Nothing to approve.' });
  const r = payments.finalize(o.ref, o.amount, o.currency);
  audit(req, 'manual-approve', o.ref + ' ' + o.amount + ' ' + o.currency);
  res.json(r.ok ? { ok: true } : { error: r.error || 'Could not approve.' });
});
router.post('/manual-payments/:id/reject', requirePerm('payments_manage'), (req, res) => {
  const o = db.prepare("SELECT * FROM orders WHERE id=? AND status='review'").get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Nothing to reject.' });
  db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(o.id);
  if (o.buyer_id) notify(o.buyer_id, 'payment', 'We could not confirm your payment ' + o.ref + '. ' + String((req.body || {}).note || ''), '/wallet');
  audit(req, 'manual-reject', o.ref);
  res.json({ ok: true });
});

router.get('/withdrawals', requirePerm('payments_view'), (req, res) => {
  const rows = db.prepare(`SELECT w.*, u.username FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.status='pending' DESC, w.id DESC LIMIT 200`).all();
  rows.forEach(r => { r.bank = jparse(r.bank_snapshot, {}); delete r.bank_snapshot; });
  res.json(rows);
});
router.post('/withdrawals/:id/approve', requirePerm('payments_manage'), (req, res) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id=?').get(req.params.id);
  if (!w || w.status !== 'pending') return res.status(400).json({ error: 'Not pending.' });
  const note = String((req.body || {}).txid || (req.body || {}).note || 'Paid by the owner').slice(0, 200);
  db.prepare("UPDATE withdrawals SET status='paid', note=? WHERE id=?").run(note, w.id);
  notify(w.user_id, 'withdrawal', 'Your withdrawal of ' + world.format(w.amount, w.currency) + ' has been paid.', '/wallet');
  audit(req, 'withdrawal-paid', '#' + w.id);
  res.json({ ok: true });
});
router.post('/withdrawals/:id/reject', requirePerm('payments_manage'), (req, res) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id=?').get(req.params.id);
  if (!w || w.status !== 'pending') return res.status(400).json({ error: 'Not pending.' });
  db.transaction(() => {
    db.prepare("UPDATE withdrawals SET status='rejected', note=? WHERE id=?").run(String((req.body || {}).note || 'Rejected by the owner').slice(0, 200), w.id);
    payments.credit(w.user_id, w.amount, w.currency, 'refund', 'wd' + w.id, 'Withdrawal rejected');
  })();
  notify(w.user_id, 'withdrawal', 'Your withdrawal was rejected and the money returned to your wallet.', '/wallet');
  audit(req, 'withdrawal-rejected', '#' + w.id);
  res.json({ ok: true });
});

// ---------- Payment providers, receiving accounts, exchange rates ----------
router.get('/payments/status', requirePerm('settings_payments', 'payments_view'), (req, res) => {
  const b = base(req);
  res.json({ providers: Object.values(providers.all).map(p => ({ id: p.id, label: p.label, enabled: p.enabled(), webhook: p.manual ? null : b + '/api/pay/webhook/' + p.id })),
    platforms: require('../dropship').describe().map(p => ({ id: p.id, label: p.label, enabled: p.enabled, webhook: b + '/api/pod/webhook/' + p.id + '/(secret)' })), public_https: /^https:\/\//.test(process.env.SITE_URL || '') });
});

router.get('/receiving-accounts', requirePerm('settings_payments'), (req, res) => res.json(db.prepare('SELECT * FROM receiving_accounts ORDER BY id DESC').all()));
router.post('/receiving-accounts', requirePerm('settings_payments'), (req, res) => {
  const b = req.body || {};
  const type = b.type === 'crypto' ? 'crypto' : 'bank';
  const cur = String(b.currency || '').toUpperCase();
  if (type === 'bank' && !world.isCurrency(cur)) return res.status(400).json({ error: 'Choose the currency this account receives (for example KWD).' });
  if (type === 'bank' && (!b.bank_name || !b.account_number || !b.account_name)) return res.status(400).json({ error: 'Bank name, account number and account name are required.' });
  if (type === 'crypto' && (!b.coin || !b.address)) return res.status(400).json({ error: 'Coin and wallet address are required.' });
  const t = (v, n) => String(v || '').trim().slice(0, n) || null;
  const info = db.prepare(`INSERT INTO receiving_accounts(type,label,currency,country,bank_name,account_number,account_name,swift_bic,routing,coin,network,address,memo,instructions)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(type, t(b.label, 60), type === 'bank' ? cur : (cur || null), t(b.country, 2) && String(b.country).toUpperCase(), t(b.bank_name, 100), t(b.account_number, 60), t(b.account_name, 100),
    t(b.swift_bic, 11) && String(b.swift_bic).toUpperCase(), t(b.routing, 30), t(b.coin, 12) && String(b.coin).toUpperCase(), t(b.network, 30), t(b.address, 200), t(b.memo, 60), t(b.instructions, 500));
  audit(req, 'receiving-account-add', type + ' ' + (cur || b.coin));
  res.json({ ok: true, id: info.lastInsertRowid });
});
router.put('/receiving-accounts/:id', requirePerm('settings_payments'), (req, res) => {
  db.prepare('UPDATE receiving_accounts SET active=? WHERE id=?').run((req.body || {}).active ? 1 : 0, req.params.id);
  audit(req, 'receiving-account-toggle', '#' + req.params.id);
  res.json({ ok: true });
});
router.delete('/receiving-accounts/:id', requirePerm('settings_payments'), (req, res) => {
  db.prepare('DELETE FROM receiving_accounts WHERE id=?').run(req.params.id);
  audit(req, 'receiving-account-delete', '#' + req.params.id);
  res.json({ ok: true });
});

router.get('/fx', requirePerm('settings_payments', 'fees'), (req, res) => res.json({ margin: fx.marginPercent(), rates: db.prepare('SELECT currency,per_usd,source,updated_at FROM fx_rates ORDER BY currency').all() }));
router.post('/fx/refresh', requirePerm('settings_payments'), async (req, res) => {
  try { res.json(await fx.refresh(true)); } catch (e) { res.status(502).json({ error: 'Could not reach the exchange-rate feed: ' + e.message }); }
});
router.put('/fx/:cur', requirePerm('settings_payments'), (req, res) => {
  try {
    if ((req.body || {}).auto) fx.clearManual(req.params.cur); else fx.setManual(req.params.cur, (req.body || {}).per_usd);
    audit(req, 'fx', req.params.cur + ' ' + JSON.stringify(req.body || {}));
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// ---------- Fees the owner charges (class hosting, creator subscription) ----------
router.get('/invoices', requirePerm('payments_view', 'fees'), (req, res) => {
  res.json(db.prepare(`SELECT i.*, u.username FROM owner_invoices i JOIN users u ON u.id=i.user_id ORDER BY i.status='due' DESC, i.id DESC LIMIT 300`).all());
});
router.post('/invoices', requirePerm('fees', 'payments_manage'), (req, res) => {
  const b = req.body || {};
  const u = db.prepare('SELECT id,username FROM users WHERE lower(username)=?').get(String(b.username || '').replace(/^@/, '').toLowerCase());
  const cur = String(b.currency || getSetting('default_currency')).toUpperCase();
  const amount = world.toMinor(b.amount, cur);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  if (amount <= 0 || !world.isCurrency(cur)) return res.status(400).json({ error: 'Enter an amount and currency.' });
  const id = ownerfees.createInvoice({ userId: u.id, kind: b.kind === 'class_fee' ? 'class_fee' : 'creator_fee', amount, currency: cur, graceDays: Math.max(0, parseInt(b.grace_days, 10) || 7), note: String(b.note || 'Platform fee').slice(0, 200) });
  audit(req, 'invoice-create', '@' + u.username + ' ' + world.format(amount, cur));
  res.json({ ok: true, id });
});
router.post('/invoices/:id/:action(waive|void)', requirePerm('fees', 'payments_manage'), (req, res) => {
  const inv = db.prepare("SELECT * FROM owner_invoices WHERE id=? AND status='due'").get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'No open invoice.' });
  db.prepare('UPDATE owner_invoices SET status=? WHERE id=?').run(req.params.action === 'waive' ? 'waived' : 'void', inv.id);
  notify(inv.user_id, 'payment', 'A platform payment of ' + world.format(inv.amount, inv.currency) + ' was ' + (req.params.action === 'waive' ? 'waived' : 'cancelled') + '.', '/creator/fees');
  audit(req, 'invoice-' + req.params.action, '#' + inv.id);
  res.json({ ok: true });
});

// =====================================================================================
// Announcements, ads, write-ups, custom pages, categories, feature switches
// =====================================================================================
router.get('/announce/segments', requirePerm('announcements'), (req, res) => res.json(Object.entries(announce.SEGMENTS).map(([k, v]) => ({ key: k, label: v.label }))));
router.get('/announce/count', requirePerm('announcements'), (req, res) => res.json({ count: announce.audienceCount(String(req.query.audience || 'all'), String(req.query.value || '')) }));
router.get('/announcements', requirePerm('announcements'), (req, res) => res.json(db.prepare('SELECT * FROM announcements ORDER BY id DESC LIMIT 100').all()));
router.post('/announcements', requirePerm('announcements'), async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: 'Write a title.' });
  const audience = ['all', 'users', 'segment'].includes(b.audience) ? b.audience : 'all';
  const value = String(b.audience_value || '').slice(0, 2000);
  const link = b.link ? (String(b.link).startsWith('/') && !String(b.link).startsWith('//') ? String(b.link).slice(0, 300) : safeUrl(b.link)) : null;
  const info = db.prepare(`INSERT INTO announcements(title,body,style,audience,audience_value,guests,starts_at,ends_at,dismissible,link,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(title, String(b.body || '').slice(0, 2000), ['info', 'success', 'warning'].includes(b.style) ? b.style : 'info', audience, value,
    audience === 'all' && b.guests ? 1 : 0, b.starts_at || null, b.ends_at || null, b.dismissible === false ? 0 : 1, link, req.user.id);
  let sent = 0;
  if (b.notify !== false) sent = await announce.fanOut({ audience, audience_value: value, link }, title + (b.body ? ' - ' + String(b.body).slice(0, 120) : ''));
  audit(req, 'announcement', title + ' -> ' + audience + (value ? ':' + value.slice(0, 60) : '') + ' (' + sent + ')');
  res.json({ ok: true, id: info.lastInsertRowid, notified: sent });
});
router.put('/announcements/:id', requirePerm('announcements'), (req, res) => {
  db.prepare('UPDATE announcements SET active=? WHERE id=?').run((req.body || {}).active ? 1 : 0, req.params.id);
  res.json({ ok: true });
});
router.delete('/announcements/:id', requirePerm('announcements'), (req, res) => {
  db.prepare('DELETE FROM announcements WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/ads', requirePerm('ads'), (req, res) => {
  res.json(db.prepare(`SELECT a.*, u.username FROM ads a LEFT JOIN users u ON u.id=a.owner_id ORDER BY a.status='pending' DESC, a.id DESC LIMIT 200`).all());
});
router.post('/ads', requirePerm('ads'), (req, res) => { // the owner's own ads: free, instant, any placement
  const b = req.body || {};
  const url = safeUrl(b.link_url);
  if (!b.title || !url) return res.status(400).json({ error: 'Add a title and a link.' });
  const days = Math.min(365, Math.max(1, parseInt(b.days, 10) || 30));
  const media = /^\/uploads\/[\w.-]+$/.test(b.media || '') ? b.media : null;
  const info = db.prepare("INSERT INTO ads(owner_id,title,body,media,media_kind,link_url,cta,placement,countries,status,days,starts_at,ends_at) VALUES(?,?,?,?,?,?,?,?,?, 'active', ?, datetime('now'), datetime('now', ?))")
    .run(req.user.id, String(b.title).slice(0, 80), String(b.body || '').slice(0, 300), media, media ? (/\.(mp4|webm)$/i.test(media) ? 'video' : 'image') : null, url, String(b.cta || 'Learn more').slice(0, 24),
      ['feed', 'reels', 'sidebar', 'banner'].includes(b.placement) ? b.placement : 'feed', String(b.countries || '').toUpperCase().replace(/[^A-Z,]/g, '').slice(0, 200), days, '+' + days + ' days');
  audit(req, 'ad-create', String(b.title).slice(0, 60));
  res.json({ ok: true, id: info.lastInsertRowid });
});
router.post('/ads/:id/approve', requirePerm('ads'), (req, res) => {
  const a = db.prepare("SELECT * FROM ads WHERE id=? AND status='pending'").get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Nothing to approve.' });
  require('./ads').activate(a.id);
  audit(req, 'ad-approve', '#' + a.id);
  res.json({ ok: true });
});
router.post('/ads/:id/reject', requirePerm('ads'), (req, res) => {
  const a = db.prepare("SELECT * FROM ads WHERE id=? AND status IN ('pending','active')").get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Nothing to reject.' });
  require('./ads').refund(a.id, String((req.body || {}).reason || 'Not approved').slice(0, 200));
  audit(req, 'ad-reject', '#' + a.id);
  res.json({ ok: true });
});
router.post('/ads/:id/pause', requirePerm('ads'), (req, res) => {
  db.prepare("UPDATE ads SET status=CASE status WHEN 'active' THEN 'paused' WHEN 'paused' THEN 'active' ELSE status END WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

router.get('/writeups', requirePerm('writeups'), (req, res) => res.json(db.prepare('SELECT * FROM writeups ORDER BY placement, sort, id').all()));
router.post('/writeups', requirePerm('writeups'), (req, res) => {
  const b = req.body || {};
  if (!String(b.title || '').trim()) return res.status(400).json({ error: 'Add a title.' });
  const info = db.prepare('INSERT INTO writeups(title,body,placement,audience,sort,active) VALUES(?,?,?,?,?,?)')
    .run(String(b.title).slice(0, 120), sanitizeHtml(b.body), String(b.placement || 'home_top').replace(/[^a-z_]/g, '').slice(0, 30), ['all', 'guests', 'members'].includes(b.audience) ? b.audience : 'all', parseInt(b.sort, 10) || 0, b.active === false ? 0 : 1);
  audit(req, 'writeup-add', String(b.title).slice(0, 60));
  res.json({ ok: true, id: info.lastInsertRowid });
});
router.put('/writeups/:id', requirePerm('writeups'), (req, res) => {
  const b = req.body || {};
  db.prepare('UPDATE writeups SET title=COALESCE(?,title), body=COALESCE(?,body), placement=COALESCE(?,placement), audience=COALESCE(?,audience), sort=COALESCE(?,sort), active=COALESCE(?,active) WHERE id=?')
    .run(b.title ? String(b.title).slice(0, 120) : null, b.body != null ? sanitizeHtml(b.body) : null, b.placement ? String(b.placement).replace(/[^a-z_]/g, '').slice(0, 30) : null,
      ['all', 'guests', 'members'].includes(b.audience) ? b.audience : null, b.sort != null ? parseInt(b.sort, 10) || 0 : null, b.active != null ? (b.active ? 1 : 0) : null, req.params.id);
  audit(req, 'writeup-edit', '#' + req.params.id);
  res.json({ ok: true });
});
router.delete('/writeups/:id', requirePerm('writeups'), (req, res) => {
  db.prepare('DELETE FROM writeups WHERE id=?').run(req.params.id);
  audit(req, 'writeup-delete', '#' + req.params.id);
  res.json({ ok: true });
});

router.get('/custom-pages', requirePerm('writeups', 'site'), (req, res) => res.json(db.prepare('SELECT * FROM custom_pages ORDER BY id DESC').all()));
router.post('/custom-pages', requirePerm('writeups', 'site'), (req, res) => {
  const { title, content, in_menu } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title required.' });
  let slug = slugify(title), n = 1;
  while (db.prepare('SELECT 1 FROM custom_pages WHERE slug=?').get(slug)) slug = slugify(title) + '-' + (++n);
  db.prepare('INSERT INTO custom_pages(slug,title,content,in_menu) VALUES(?,?,?,?)').run(slug, String(title).slice(0, 100), sanitizeHtml(content), in_menu ? 1 : 0);
  audit(req, 'add-custom-page', slug);
  res.json({ ok: true, slug });
});
router.put('/custom-pages/:id', requirePerm('writeups', 'site'), (req, res) => {
  const { title, content, in_menu, enabled } = req.body || {};
  db.prepare('UPDATE custom_pages SET title=COALESCE(?,title), content=COALESCE(?,content), in_menu=COALESCE(?,in_menu), enabled=COALESCE(?,enabled) WHERE id=?')
    .run(title ? String(title).slice(0, 100) : null, content != null ? sanitizeHtml(content) : null, in_menu != null ? (in_menu ? 1 : 0) : null, enabled != null ? (enabled ? 1 : 0) : null, req.params.id);
  audit(req, 'edit-custom-page', '#' + req.params.id);
  res.json({ ok: true });
});
router.delete('/custom-pages/:id', requirePerm('writeups', 'site'), (req, res) => {
  db.prepare('DELETE FROM custom_pages WHERE id=?').run(req.params.id);
  audit(req, 'delete-custom-page', '#' + req.params.id);
  res.json({ ok: true });
});

router.get('/categories', requirePerm('site', 'content'), (req, res) => res.json(db.prepare('SELECT * FROM categories ORDER BY name').all()));
router.post('/categories', requirePerm('site'), (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Name required.' });
  db.prepare('INSERT OR IGNORE INTO categories(name) VALUES(?)').run(name);
  audit(req, 'add-category', name);
  res.json({ ok: true });
});
router.put('/categories/:id', requirePerm('site'), (req, res) => {
  db.prepare('UPDATE categories SET enabled=? WHERE id=?').run((req.body || {}).enabled ? 1 : 0, req.params.id);
  res.json({ ok: true });
});
router.delete('/categories/:id', requirePerm('site'), (req, res) => {
  db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
router.get('/flags', requirePerm('site'), (req, res) => res.json(db.prepare('SELECT * FROM feature_flags').all()));
router.put('/flags/:key', requirePerm('site'), (req, res) => {
  db.prepare('UPDATE feature_flags SET enabled=? WHERE key=?').run((req.body || {}).enabled ? 1 : 0, req.params.key);
  audit(req, 'flag', req.params.key + '=' + !!(req.body || {}).enabled);
  res.json({ ok: true });
});

// =====================================================================================
// AI assistant providers (keys are stored encrypted and never sent back)
// =====================================================================================
router.get('/ai', requirePerm('ai'), (req, res) => {
  res.json({ types: ai.TYPES, ready: ai.ready(), providers: db.prepare('SELECT id,name,type,base_url,model,priority,enabled,api_key IS NOT NULL AND api_key!=\'\' AS has_key FROM ai_providers ORDER BY priority,id').all() });
});
router.post('/ai', requirePerm('ai'), async (req, res) => {
  const b = req.body || {};
  if (!ai.TYPES[b.type]) return res.status(400).json({ error: 'Choose a provider type.' });
  if (!b.model || !b.api_key) return res.status(400).json({ error: 'Model and API key are required.' });
  let baseUrl = null;
  if (b.type === 'openai') {
    try { baseUrl = (await assertPublicUrl(b.base_url || 'https://api.openai.com/v1')).toString().replace(/\/+$/, ''); } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  const info = db.prepare('INSERT INTO ai_providers(name,type,base_url,api_key,model,priority,enabled) VALUES(?,?,?,?,?,?,1)')
    .run(String(b.name || ai.TYPES[b.type].label).slice(0, 60), b.type, baseUrl, secrets.encrypt(String(b.api_key).trim()), String(b.model).slice(0, 80), parseInt(b.priority, 10) || 10);
  audit(req, 'ai-add', b.type + ' ' + b.model);
  res.json({ ok: true, id: info.lastInsertRowid });
});
router.put('/ai/:id', requirePerm('ai'), (req, res) => {
  const b = req.body || {};
  db.prepare('UPDATE ai_providers SET enabled=COALESCE(?,enabled), priority=COALESCE(?,priority), model=COALESCE(?,model) WHERE id=?')
    .run(b.enabled != null ? (b.enabled ? 1 : 0) : null, b.priority != null ? parseInt(b.priority, 10) || 10 : null, b.model ? String(b.model).slice(0, 80) : null, req.params.id);
  if (b.api_key && b.api_key !== MASK) db.prepare('UPDATE ai_providers SET api_key=? WHERE id=?').run(secrets.encrypt(String(b.api_key).trim()), req.params.id);
  audit(req, 'ai-edit', '#' + req.params.id);
  res.json({ ok: true });
});
router.delete('/ai/:id', requirePerm('ai'), (req, res) => {
  db.prepare('DELETE FROM ai_providers WHERE id=?').run(req.params.id);
  audit(req, 'ai-delete', '#' + req.params.id);
  res.json({ ok: true });
});
router.post('/ai/test', requirePerm('ai'), async (req, res) => {
  try { const r = await ai.ask([{ role: 'user', content: 'Reply with the single word: ready' }]); res.json({ ok: true, reply: r.reply.slice(0, 80), provider: r.provider }); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// =====================================================================================
// Dropshipping oversight (Printful orders and, if switched on, user suppliers)
// =====================================================================================
router.get('/dropship/orders', requirePerm('dropship'), (req, res) => {
  const st = String(req.query.status || '');
  res.json(db.prepare(`SELECT o.id,o.ref,o.provider,o.status,o.total,o.capital,o.currency,o.country,o.customer_name,o.note,o.provider_order_id,o.tracking_number,o.settled,o.attempts,o.created_at,
      s.brand_name, COALESCE(p.title, pl.title) AS product FROM dropship_orders o JOIN stores s ON s.id=o.store_id LEFT JOIN supplier_products p ON p.id=o.product_id LEFT JOIN pf_listings pl ON pl.id=o.pf_listing_id
      WHERE o.status!='awaiting_payment' ${st ? 'AND o.status=?' : ''} ORDER BY o.status IN ('needs_attention','refund_needed','awaiting_supplier') DESC, o.id DESC LIMIT 200`).all(...(st ? [st] : [])));
});
router.post('/dropship/orders/:id/approve', requirePerm('dropship'), async (req, res) => {
  try { await require('./pod').approve(req.params.id); audit(req, 'dropship-approve', '#' + req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
router.post('/dropship/orders/:id/retry', requirePerm('dropship'), async (req, res) => {
  const o = db.prepare("SELECT * FROM dropship_orders WHERE id=? AND status IN ('needs_attention','awaiting_supplier','paid')").get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order cannot be retried.' });
  db.prepare("UPDATE dropship_orders SET attempts=0, last_attempt=NULL, status='paid' WHERE id=?").run(o.id);
  await require('./pod').retryPending();
  audit(req, 'dropship-retry', o.ref);
  res.json({ ok: true });
});
router.post('/dropship/orders/:id/refunded', requirePerm('payments_manage'), (req, res) => { // after refunding the customer in the payment provider's dashboard
  const o = db.prepare("SELECT * FROM dropship_orders WHERE id=? AND status='refund_needed'").get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Nothing to mark.' });
  db.prepare("UPDATE dropship_orders SET status='refunded', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(o.id);
  audit(req, 'dropship-refunded', o.ref);
  res.json({ ok: true });
});
router.post('/dropship/orders/:id/cancel', requirePerm('dropship'), async (req, res) => {
  const o = db.prepare("SELECT * FROM dropship_orders WHERE id=? AND provider='printful' AND status IN ('needs_attention','awaiting_supplier','paid','processing')").get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order cannot be cancelled.' });
  try {
    if (o.provider_order_id) await require('../printful').cancelOrder(o.provider_order_id);
    require('./pod').failOrder(o, 'Cancelled by the owner');
    audit(req, 'dropship-cancel', o.ref);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 502).json({ error: 'Printful would not cancel it: ' + e.message }); }
});
router.post('/dropship/connect/:provider', owner, async (req, res) => {
  try {
    const a = require('../dropship').get(req.params.provider);
    if (!a) return res.status(404).json({ error: 'Unknown platform.' });
    if (!a.enabled()) return res.status(400).json({ error: 'Save the ' + a.label + ' key and switch it on first.' });
    if (!a.setupWebhooks) return res.json({ ok: true, note: a.label + ' has no webhooks; orders are checked every few minutes automatically.' });
    if (!/^https:\/\//.test(process.env.SITE_URL || '')) return res.status(400).json({ error: 'Set SITE_URL to your public https address first; the platform must be able to reach it.' });
    const url = await require('./pod').connectWebhooks(a.id, process.env.SITE_URL);
    audit(req, 'dropship-connect', a.id + ' ' + url);
    res.json({ ok: true, webhook: url });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
router.get('/dropship/platforms', requirePerm('dropship'), (req, res) => res.json(require('../dropship').describe()));
router.get('/stores', requirePerm('dropship', 'content'), (req, res) => {
  res.json(db.prepare(`SELECT s.id,s.slug,s.brand_name,s.active,s.created_at,u.username,(SELECT COUNT(*) FROM pf_listings WHERE store_id=s.id AND active=1) AS products FROM stores s JOIN users u ON u.id=s.owner_id ORDER BY s.id DESC LIMIT 200`).all());
});
router.put('/stores/:id', requirePerm('dropship', 'content'), (req, res) => {
  db.prepare('UPDATE stores SET active=? WHERE id=?').run((req.body || {}).active ? 1 : 0, req.params.id);
  audit(req, 'store-toggle', '#' + req.params.id);
  res.json({ ok: true });
});

// =====================================================================================
// Audit log, database browser, backups
// =====================================================================================
router.get('/audit', requirePerm('audit'), (req, res) => {
  res.json(db.prepare('SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id=a.admin_id ORDER BY a.id DESC LIMIT 300').all());
});

const HIDDEN_COLS = /password_hash|api_key|^value$|token|secret|proof|private|bank_snapshot|account_number|^address$/i;
const tableNames = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(t => t.name);
const SENSITIVE_TABLES = new Set(['settings', 'password_resets', 'push_subscriptions', 'ai_providers']);
router.get('/db/tables', requirePerm('db_read'), (req, res) => {
  res.json(tableNames().map(n => ({ name: n, rows: db.prepare(`SELECT COUNT(*) c FROM "${n}"`).get().c, restricted: SENSITIVE_TABLES.has(n) && req.user.role !== 'admin' })));
});
router.get('/db/table/:name', requirePerm('db_read'), (req, res) => {
  const name = req.params.name;
  if (!tableNames().includes(name)) return res.status(404).json({ error: 'No such table.' });
  if (SENSITIVE_TABLES.has(name) && req.user.role !== 'admin') return res.status(403).json({ error: 'Only the owner can open this table.' });
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const cols = db.prepare(`PRAGMA table_info("${name}")`).all().map(c => ({ name: c.name, pk: c.pk }));
  const rows = db.prepare(`SELECT rowid AS _rowid_, * FROM "${name}" ORDER BY rowid DESC LIMIT 50 OFFSET ?`).all(offset);
  const hide = !(req.user.role === 'admin' && req.query.reveal === '1') && true;
  const priv = hasPerm(req.user, 'users_private');
  rows.forEach(r => Object.keys(r).forEach(k => {
    if (hide && HIDDEN_COLS.test(k)) r[k] = '[hidden]';
    else if (!priv && name === 'users' && /^(email|phone|dob)$/.test(k)) r[k] = '[hidden]';
  }));
  if (req.query.reveal === '1') audit(req, 'db-reveal', name);
  res.json({ cols, rows, total: db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get().c });
});
// Editing data directly is owner-only, and asks for the owner's password again.
const stepUp = (req, res, next) => {
  const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(String((req.body || {}).password || ''), row.password_hash)) return res.status(403).json({ error: 'Enter your password to confirm.', needs_password: true });
  next();
};
router.put('/db/table/:name/:rowid', owner, stepUp, (req, res) => {
  const name = req.params.name;
  if (!tableNames().includes(name)) return res.status(404).json({ error: 'No such table.' });
  const cols = db.prepare(`PRAGMA table_info("${name}")`).all().map(c => c.name);
  const sets = [], vals = [];
  Object.entries((req.body || {}).values || {}).forEach(([k, v]) => { if (cols.includes(k) && !/password_hash/.test(k)) { sets.push(`"${k}"=?`); vals.push(v); } });
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  db.prepare(`UPDATE "${name}" SET ${sets.join(',')} WHERE rowid=?`).run(...vals, req.params.rowid);
  audit(req, 'db-edit', name + '#' + req.params.rowid);
  res.json({ ok: true });
});
router.delete('/db/table/:name/:rowid', owner, stepUp, (req, res) => {
  const name = req.params.name;
  if (!tableNames().includes(name)) return res.status(404).json({ error: 'No such table.' });
  db.prepare(`DELETE FROM "${name}" WHERE rowid=?`).run(req.params.rowid);
  audit(req, 'db-delete', name + '#' + req.params.rowid);
  res.json({ ok: true });
});
router.post('/db/sql', owner, (req, res) => {
  const sql = String((req.body || {}).sql || '').trim();
  if (!sql) return res.status(400).json({ error: 'Enter a query.' });
  if (/;\s*\S/.test(sql)) return res.status(400).json({ error: 'Run one statement at a time.' });
  try {
    const st = db.prepare(sql);
    if (st.reader) {
      const rows = st.all().slice(0, 500);
      rows.forEach(r => Object.keys(r).forEach(k => { if (HIDDEN_COLS.test(k)) r[k] = '[hidden]'; }));
      return res.json({ rows });
    }
    if (!(req.body || {}).confirm) return res.status(400).json({ error: 'This query changes data. Tick "I understand" to run it.', needs_confirm: true });
    return stepUp(req, res, () => { const info = st.run(); audit(req, 'sql', sql); res.json({ changes: info.changes }); });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/backups', owner, (req, res) => {
  const dir = path.join(__dirname, '..', '..', 'data', 'backups');
  try { res.json(fs.readdirSync(dir).filter(f => /^backup-[\w.-]+\.db$/.test(f)).sort().reverse().map(f => ({ file: f, size: fs.statSync(path.join(dir, f)).size }))); } catch (e) { res.json([]); }
});
router.post('/backups', owner, async (req, res) => {
  try { const f = await require('../jobs').backup(); audit(req, 'backup', f || ''); res.json({ ok: true, file: f }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/backups/:file', owner, stepUp.bind(null), (req, res) => res.status(405).end()); // downloads use POST so the password is not in the URL
router.post('/backups/:file/download', owner, stepUp, (req, res) => {
  if (!/^backup-[\w.-]+\.db$/.test(req.params.file)) return res.status(400).json({ error: 'Bad file name.' });
  const f = path.join(__dirname, '..', '..', 'data', 'backups', req.params.file);
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'Not found.' });
  audit(req, 'backup-download', req.params.file);
  res.download(f);
});

module.exports = router;
