// Everything users owe the site owner: class-hosting fees and creator subscriptions.
// The owner controls amounts, timing and on/off switches (globally, per kind and per user) in Admin > Fees.
const { db, getSetting, notify } = require('./db');
const world = require('./world');

const pay = () => require('./routes/payments'); // loaded lazily (payments.js also needs this module)

const KIND_FLAG = { creator_fee: 'pay_creator_fee_enabled', class_fee: 'pay_class_fee_enabled', ad: 'pay_ads_enabled', dropship_fee: 'pay_dropship_fee_enabled' };

/** Are payments to the owner switched on (master switch + the one for this kind)? */
function paymentsOn(kind) {
  if (getSetting('owner_payments_enabled') !== '1') return false;
  return !KIND_FLAG[kind] || getSetting(KIND_FLAG[kind]) === '1';
}

/** Individual switch: the owner can excuse a particular user (admins/staff never pay). */
function waived(userId) {
  const u = db.prepare('SELECT role,owner_fee_waived FROM users WHERE id=?').get(userId);
  return !u || u.role === 'admin' || u.role === 'staff' || !!u.owner_fee_waived;
}

const feeCurrency = k => world.normCurrency(getSetting(k), world.normCurrency(getSetting('default_currency'), 'USD'));

/** Fee this host owes for a class right now, or null. */
function classFee(userId, cls) {
  if (getSetting('class_fee_mode') !== 'fixed' || !paymentsOn('class_fee') || waived(userId)) return null;
  if (getSetting('class_fee_applies') !== 'all' && !(cls.price > 0)) return null;
  const u = db.prepare('SELECT favoured,class_fee_override FROM users WHERE id=?').get(userId);
  if (u.favoured && getSetting('class_fee_exempt_favoured') === '1') return null;
  const currency = feeCurrency('class_fee_currency');
  const amount = u.class_fee_override != null ? u.class_fee_override : world.toMinor(getSetting('class_fee_amount'), currency);
  return amount > 0 ? { amount, currency, when: ['create', 'before_start', 'after'].includes(getSetting('class_fee_when')) ? getSetting('class_fee_when') : 'create' } : null;
}

function creatorFee(userId) {
  if (getSetting('creator_fee_required') !== '1' || !paymentsOn('creator_fee') || waived(userId)) return null;
  const u = db.prepare('SELECT creator_fee_override FROM users WHERE id=?').get(userId);
  const currency = feeCurrency('creator_fee_currency');
  const amount = u.creator_fee_override != null ? u.creator_fee_override : world.toMinor(getSetting('creator_fee_amount'), currency);
  return amount > 0 ? { amount, currency, days: parseInt(getSetting('creator_fee_days'), 10) || 30 } : null;
}

function createInvoice({ userId, kind, classId, amount, currency, graceDays, note }) {
  if (classId && db.prepare("SELECT 1 FROM owner_invoices WHERE user_id=? AND kind=? AND class_id=? AND status IN ('due','paid')").get(userId, kind, classId)) return null;
  const info = db.prepare("INSERT INTO owner_invoices(user_id,kind,class_id,amount,currency,due_at,note) VALUES(?,?,?,?,?, datetime('now', ?), ?)")
    .run(userId, kind, classId || null, amount, currency, '+' + (graceDays || 0) + ' days', note || '');
  notify(userId, 'payment', 'You have a payment due to ' + (getSetting('site_name') || 'the platform') + ': ' + world.format(amount, currency) + ' - ' + (note || kind), '/creator/fees');
  return info.lastInsertRowid;
}

/** Invoices that really count right now (nothing is owed while the owner has switched that payment off). */
function dueInvoices(userId) {
  if (waived(userId)) return [];
  return db.prepare("SELECT * FROM owner_invoices WHERE user_id=? AND status='due' ORDER BY id").all(userId).filter(i => paymentsOn(i.kind));
}
const overdueInvoices = userId => dueInvoices(userId).filter(i => i.due_at && db.prepare("SELECT ? < datetime('now') AS o").get(i.due_at).o);

/** Should we stop this user from `what` ('classes' | 'withdrawals') because of unpaid, overdue fees? */
function blocked(userId, what) {
  const action = getSetting('owner_fee_overdue_action');
  if (!(action === what || action === 'both' || (action === 'block_classes' && what === 'classes') || (action === 'block_withdrawals' && what === 'withdrawals'))) return null;
  const o = overdueInvoices(userId);
  return o.length ? o[0] : null;
}

/** Marks an invoice paid and applies its effect. Call inside a transaction. */
function markPaid(invoiceId, orderRef) {
  const inv = db.prepare('SELECT * FROM owner_invoices WHERE id=?').get(invoiceId);
  if (!inv || inv.status === 'paid') return null;
  db.prepare("UPDATE owner_invoices SET status='paid', paid_at=CURRENT_TIMESTAMP, order_ref=COALESCE(?,order_ref) WHERE id=?").run(orderRef || null, inv.id);
  if (inv.kind === 'class_fee' && inv.class_id) db.prepare("UPDATE classes SET fee_status='paid', active=1 WHERE id=?").run(inv.class_id);
  if (inv.kind === 'creator_fee') {
    const days = parseInt(getSetting('creator_fee_days'), 10) || 30;
    const cur = db.prepare("SELECT paid_until FROM creator_subscriptions WHERE user_id=? AND paid_until > datetime('now')").get(inv.user_id);
    db.prepare(`INSERT INTO creator_subscriptions(user_id,paid_until) VALUES(?, datetime(?, ?))
      ON CONFLICT(user_id) DO UPDATE SET paid_until=excluded.paid_until, updated_at=CURRENT_TIMESTAMP`).run(inv.user_id, cur ? cur.paid_until : 'now', '+' + days + ' days');
  }
  return inv;
}

/** Pays an invoice straight from the user's wallet (same currency; any other currency is converted at the current rate). */
function payFromWallet(inv, { allowConvert = true } = {}) {
  const P = pay();
  const fx = require('./fx');
  const admin = P.adminId();
  return db.transaction(() => {
    const fresh = db.prepare('SELECT * FROM owner_invoices WHERE id=?').get(inv.id);
    if (!fresh || fresh.status !== 'due') throw Object.assign(new Error('This invoice is not due.'), { status: 400 });
    if (!paymentsOn(fresh.kind) || waived(fresh.user_id)) throw Object.assign(new Error('Payments to the owner are switched off for this.'), { status: 400 });
    if (P.balanceOf(fresh.user_id, fresh.currency) < fresh.amount) {
      if (!allowConvert) throw Object.assign(new Error('Not enough ' + fresh.currency + ' in your wallet.'), { status: 400 });
      // pull the shortfall from another currency
      const need = fresh.amount - P.balanceOf(fresh.user_id, fresh.currency);
      const others = db.prepare('SELECT currency,balance FROM wallets WHERE user_id=? AND currency!=? AND balance>0 ORDER BY balance DESC').all(fresh.user_id, fresh.currency);
      let done = false;
      for (const w of others) {
        let r;
        try { r = fx.rate(w.currency, fresh.currency); } catch (e) { r = null; }
        if (!r) continue;
        const pct = fx.marginPercent();
        const want = Math.ceil(need / ((r * (1 - pct / 100)) * world.factor(fresh.currency) / world.factor(w.currency)) * 1.002) + 2;
        const take = Math.min(w.balance, want);
        const c = fx.convertMinor(take, w.currency, fresh.currency);
        if (c.out >= need) {
          P.debit(fresh.user_id, take, w.currency, 'convert_out', 'inv' + fresh.id, 'Converted to ' + fresh.currency + ' to pay a fee');
          P.credit(fresh.user_id, c.out, fresh.currency, 'convert_in', 'inv' + fresh.id, 'Converted from ' + w.currency + ' to pay a fee');
          if (c.margin > 0 && admin) P.credit(admin, c.margin, fresh.currency, 'fx_margin', 'inv' + fresh.id, 'Conversion margin');
          done = true; break;
        }
      }
      if (!done) throw Object.assign(new Error('Not enough money in your wallet to pay ' + world.format(fresh.amount, fresh.currency) + '.'), { status: 400 });
    }
    P.debit(fresh.user_id, fresh.amount, fresh.currency, 'owner_fee', 'inv' + fresh.id, fresh.note || fresh.kind);
    if (admin) P.credit(admin, fresh.amount, fresh.currency, fresh.kind, 'inv' + fresh.id, fresh.note || fresh.kind);
    markPaid(fresh.id, null);
    return fresh;
  })();
}

/** Called when a user's class has finished (by the background job): raises and (optionally) auto-collects fees. */
function onClassEnded(cls) {
  const host = cls.owner_id;
  const made = [];
  const fee = classFee(host, cls);
  if (fee && fee.when === 'after') {
    const id = createInvoice({ userId: host, kind: 'class_fee', classId: cls.id, amount: fee.amount, currency: fee.currency, graceDays: parseInt(getSetting('class_fee_grace_days'), 10) || 0, note: 'Hosting fee for class "' + cls.title + '"' });
    if (id) made.push(id);
  }
  if (cls.price > 0 && getSetting('creator_fee_timing') === 'after_classes') {
    const cf = creatorFee(host);
    const active = db.prepare("SELECT 1 FROM creator_subscriptions WHERE user_id=? AND paid_until > datetime('now')").get(host);
    const hadBefore = db.prepare("SELECT 1 FROM owner_invoices WHERE user_id=? AND kind='creator_fee'").get(host);
    const open = db.prepare("SELECT 1 FROM owner_invoices WHERE user_id=? AND kind='creator_fee' AND status='due'").get(host);
    if (cf && !active && !open && (getSetting('creator_fee_trigger') !== 'first_class_end' || !hadBefore)) {
      const id = createInvoice({ userId: host, kind: 'creator_fee', amount: cf.amount, currency: cf.currency, graceDays: parseInt(getSetting('creator_fee_grace_days'), 10) || 0, note: 'Creator subscription (' + cf.days + ' days)' });
      if (id) made.push(id);
    }
  }
  if (getSetting('owner_fee_autodebit') === '1') {
    made.forEach(id => {
      try { payFromWallet(db.prepare('SELECT * FROM owner_invoices WHERE id=?').get(id)); notify(host, 'payment', 'A fee was paid automatically from your wallet.', '/creator/fees'); }
      catch (e) { /* not enough money - the invoice stays due and the creator is reminded */ }
    });
  }
  return made;
}


/**
 * Dropshipping sellers pay the owner only after every N sales (Admin > Fees: N, fixed amount or a percentage of the profit).
 * Called each time a dropship order ships and the seller's profit is paid.
 */
function onDropshipSale(store, order, profit) {
  if (!paymentsOn('dropship_fee') || waived(store.owner_id)) return null;
  const every = Math.max(1, parseInt(getSetting('dropship_fee_every'), 10) || 2);
  db.prepare('UPDATE stores SET fee_counter=fee_counter+1 WHERE id=?').run(store.id);
  if (db.prepare('SELECT fee_counter FROM stores WHERE id=?').get(store.id).fee_counter < every) return null;
  db.prepare('UPDATE stores SET fee_counter=fee_counter-? WHERE id=?').run(every, store.id);
  let amount, currency;
  if (getSetting('dropship_fee_mode') === 'percent') {
    currency = order.currency;
    const fx = require('./fx');
    const rows = db.prepare('SELECT total,capital,currency FROM dropship_orders WHERE store_id=? AND settled=1 ORDER BY updated_at DESC, id DESC LIMIT ?').all(store.id, every);
    let sum = 0;
    for (const r of rows) { const p = Math.max(0, r.total - (r.capital || 0)); try { sum += r.currency === currency ? p : fx.convertMinor(p, r.currency, currency, 0).out; } catch (e) { /* skip */ } }
    amount = Math.round(sum * (parseFloat(getSetting('dropship_fee_percent')) || 0) / 100);
  } else {
    currency = feeCurrency('dropship_fee_currency');
    amount = world.toMinor(getSetting('dropship_fee_amount'), currency);
  }
  if (!(amount > 0)) return null;
  const id = createInvoice({ userId: store.owner_id, kind: 'dropship_fee', amount, currency, graceDays: parseInt(getSetting('dropship_fee_grace_days'), 10) || 0, note: 'Platform fee for your last ' + every + ' dropship sales' });
  if (id && getSetting('owner_fee_autodebit') === '1') {
    try { payFromWallet(db.prepare('SELECT * FROM owner_invoices WHERE id=?').get(id)); notify(store.owner_id, 'payment', 'The platform fee for your last ' + every + ' sales was paid from your wallet.', '/creator/fees'); }
    catch (e) { /* not enough money yet: stays due and is reminded */ }
  }
  return id;
}

module.exports = { onDropshipSale, paymentsOn, waived, classFee, creatorFee, createInvoice, dueInvoices, overdueInvoices, blocked, markPaid, payFromWallet, onClassEnded };
