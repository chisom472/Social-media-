// Background work: automatic renewals, reminders, class fees, dropship retries, exchange rates, clean-up and nightly backups.
const fs = require('fs');
const path = require('path');
const { db, getSetting, notify } = require('./db');
const world = require('./world');
const ownerfees = require('./ownerfees');

let running = {};
async function guard(name, fn) {
  if (running[name]) return;
  running[name] = true;
  try { await fn(); } catch (e) { console.error('[job:' + name + ']', e.message); } finally { running[name] = false; }
}

// ---- community memberships that renew from the member's wallet (Stripe subscriptions renew by themselves) ----
function renewMemberships() {
  const P = require('./routes/payments');
  const rows = db.prepare(`SELECT gm.*, g.billing, g.price, g.currency, g.owner_id, g.name FROM group_members gm JOIN groups_ g ON g.id=gm.group_id
    WHERE gm.expires_at IS NOT NULL AND g.billing!='one_time' AND g.price>0`).all();
  const soon = Date.now() + 3 * 24 * 3600 * 1000;
  rows.forEach(m => {
    const exp = Date.parse(m.expires_at.replace(' ', 'T') + 'Z');
    if (m.sub_ref) return; // renewed by the card provider
    const grace = (parseInt(getSetting('renewal_grace_days'), 10) || 0) * 24 * 3600 * 1000;
    if (m.auto_renew && exp <= Date.now() + 3600 * 1000 && exp > Date.now() - grace) {
      try {
        db.transaction(() => {
          P.debit(m.user_id, m.price, m.currency, 'membership', 'renew-' + m.group_id, 'Renewal: ' + m.name);
          P.settleToSeller(m.owner_id, m.price, m.currency, 'renew-' + m.group_id + '-' + Date.now(), 'Community renewal: ' + m.name);
          P.grantMembership(m.group_id, m.user_id, m.billing, true, null);
        })();
        notify(m.user_id, 'group', 'Your ' + m.name + ' membership was renewed from your wallet.', '/community/' + m.group_id);
        return;
      } catch (e) { /* not enough money - remind below */ }
    }
    if (exp < soon && exp > Date.now() - grace && !m.renew_notified) {
      db.prepare('UPDATE group_members SET renew_notified=CURRENT_TIMESTAMP WHERE group_id=? AND user_id=?').run(m.group_id, m.user_id);
      notify(m.user_id, 'group', 'Your ' + m.name + ' membership ends soon.' + (m.auto_renew ? ' Add money to your wallet so it can renew automatically.' : ' Renew it to keep access.'), '/community/' + m.group_id);
    }
  });
}

// ---- classes: reminders, and fees once a class has finished ----
function classes() {
  db.prepare(`SELECT c.*, g.name AS group_name FROM classes c JOIN groups_ g ON g.id=c.group_id WHERE c.active=1 AND c.kind!='recorded' AND c.reminded<2 AND c.starts_at BETWEEN datetime('now') AND datetime('now','+24 hours')`).all().forEach(c => {
    const mins = (Date.parse(c.starts_at.replace(' ', 'T') + 'Z') - Date.now()) / 60000;
    const stage = mins <= 60 ? 2 : 1;
    if (c.reminded >= stage) return;
    db.prepare('UPDATE classes SET reminded=? WHERE id=?').run(stage, c.id);
    const text = '"' + c.title + '" starts ' + (stage === 2 ? 'in about an hour' : 'within 24 hours');
    db.prepare('SELECT user_id FROM class_enrollments WHERE class_id=?').all(c.id).forEach(e => notify(e.user_id, 'class', 'Reminder: ' + text, '/class/' + c.id));
    notify(c.owner_id, 'class', 'Reminder: ' + text, '/class/' + c.id);
  });
  // finished classes -> fees (live: when the class time is over; recorded courses: a day after publishing)
  db.prepare(`SELECT * FROM classes WHERE ended=0 AND active=1 AND ((kind!='recorded' AND datetime(starts_at,'+'||duration_min||' minutes') < datetime('now'))
    OR (kind='recorded' AND created_at < datetime('now','-1 day')))`).all().forEach(c => {
    db.prepare('UPDATE classes SET ended=1 WHERE id=?').run(c.id);
    try { ownerfees.onClassEnded(c); } catch (e) { console.error('[class end]', e.message); }
    try { require('./access').onClassEnded(Object.assign({}, c, { group_name: (db.prepare('SELECT name FROM groups_ WHERE id=?').get(c.group_id) || {}).name })); } catch (e) { console.error('[class access]', e.message); }
  });
}

// ---- reminders for fees that are due ----
function invoiceReminders() {
  db.prepare("SELECT * FROM owner_invoices WHERE status='due' AND (reminded_at IS NULL OR reminded_at < datetime('now','-1 day'))").all().forEach(i => {
    if (!ownerfees.paymentsOn(i.kind) || ownerfees.waived(i.user_id)) return;
    if (i.due_at && i.due_at > new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')) return;
    db.prepare('UPDATE owner_invoices SET reminded_at=CURRENT_TIMESTAMP WHERE id=?').run(i.id);
    const late = i.due_at && i.due_at < new Date().toISOString().slice(0, 19).replace('T', ' ');
    notify(i.user_id, 'payment', (late ? 'Overdue: ' : 'Reminder: ') + world.format(i.amount, i.currency) + ' - ' + (i.note || i.kind), '/creator/fees');
  });
  // automatic collection from the wallet when the owner has that switched on
  if (getSetting('owner_fee_autodebit') === '1') {
    db.prepare("SELECT * FROM owner_invoices WHERE status='due'").all().forEach(i => {
      try { if (ownerfees.paymentsOn(i.kind) && !ownerfees.waived(i.user_id)) { ownerfees.payFromWallet(i, { allowConvert: false }); notify(i.user_id, 'payment', 'A fee of ' + world.format(i.amount, i.currency) + ' was paid automatically from your wallet.', '/creator/fees'); } }
      catch (e) { /* wallet too low */ }
    });
  }
}

async function hourly() {
  await require('./fx').refresh().catch(e => console.error('[fx]', e.message));
  db.prepare("DELETE FROM posts WHERE type='story' AND expires_at < datetime('now','-1 day')").run();
  db.prepare("DELETE FROM password_resets WHERE expires_at < datetime('now')").run();
  db.prepare("DELETE FROM login_events WHERE created_at < datetime('now','-90 days')").run();
  db.prepare("DELETE FROM processed_events WHERE created_at < datetime('now','-60 days')").run();
  db.prepare("UPDATE ads SET status='ended' WHERE status='active' AND ends_at IS NOT NULL AND ends_at < datetime('now')").run();
  db.prepare("UPDATE ads SET status='ended' WHERE status='active' AND max_impressions IS NOT NULL AND impressions >= max_impressions").run();
}

let lastBackupDay = '';
async function backup() {
  const day = new Date().toISOString().slice(0, 10);
  if (day === lastBackupDay || typeof db.backup !== 'function') return;
  const dir = path.join(__dirname, '..', 'data', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'digital-enviro-' + day + '.db');
  if (!fs.existsSync(file)) await db.backup(file);
  lastBackupDay = day;
  fs.readdirSync(dir).filter(f => /^digital-enviro-.*\.db$/.test(f)).sort().slice(0, -7).forEach(f => fs.unlinkSync(path.join(dir, f))); // keep the last 7
}

function start() {
  const every = (ms, name, fn) => { const t = setInterval(() => guard(name, fn), ms); t.unref(); setTimeout(() => guard(name, fn), 15000).unref(); };
  every(5 * 60 * 1000, 'memberships', async () => renewMemberships());
  every(2 * 60 * 1000, 'classes', async () => classes());
  every(15 * 60 * 1000, 'invoices', async () => invoiceReminders());
  every(5 * 60 * 1000, 'dropship', async () => { await require('./routes/dropship').retryPending(); await require('./routes/pod').retryPending(); });
  every(20 * 60 * 1000, 'dropship-sync', () => require('./routes/pod').syncAll());
  every(10 * 60 * 1000, 'payout-sync', () => require('./routes/payments').pollPayouts());
  every(60 * 60 * 1000, 'hourly', hourly);
  every(6 * 60 * 60 * 1000, 'backup', backup);
}

module.exports = { start, renewMemberships, classes, invoiceReminders, hourly, backup };
