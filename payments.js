const express = require('express');
const crypto = require('crypto');
const { db, getSetting, notify } = require('../db');
const { requireAuth, featureOn, restrict } = require('../auth');
const { ref } = require('../utils');
const world = require('../world');
const providers = require('../providers');
const ownerfees = require('../ownerfees');
const fx = require('../fx');
const { notifyStaff } = require('../db');

const router = express.Router();

/** Payment providers need an email address; phone-only users get a private placeholder one. */
const payerEmail = (user, host) => user.email || ('user' + user.id + '@' + String(host || 'digitalenviro.local').replace(/^https?:\/\//, '').replace(/[:/].*$/, ''));

const defaultCurrency = () => world.normCurrency(getSetting('default_currency'), 'USD');
const baseUrl = req => process.env.SITE_URL || (req.protocol + '://' + req.get('host'));
const PERIOD = { weekly: '+7 days', monthly: '+1 month', yearly: '+1 year' };
const STRIPE_INTERVAL = { weekly: 'week', monthly: 'month', yearly: 'year' };

function adminId() {
  const a = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  return a ? a.id : null;
}

/** Platform commission for a seller: the owner can give a favoured user a custom rate (Admin > Users). */
function commissionFor(userId) {
  const u = userId ? db.prepare('SELECT commission_override FROM users WHERE id=?').get(userId) : null;
  const pct = u && u.commission_override != null ? u.commission_override : parseFloat(getSetting('platform_commission_percent'));
  return Math.min(100, Math.max(0, Number(pct) || 0));
}

/** Adds money (minor units) to a user's wallet in one currency, with a ledger line. */
function credit(userId, minor, currency, type, reference, note) {
  db.prepare('INSERT OR IGNORE INTO wallets(user_id,currency,balance) VALUES(?,?,0)').run(userId, currency);
  db.prepare('UPDATE wallets SET balance=balance+? WHERE user_id=? AND currency=?').run(minor, userId, currency);
  db.prepare('INSERT INTO wallet_tx(user_id,type,amount,currency,ref,note) VALUES(?,?,?,?,?,?)').run(userId, type, minor, currency, reference, note || '');
}

function balanceOf(userId, currency) {
  const w = db.prepare('SELECT balance FROM wallets WHERE user_id=? AND currency=?').get(userId, currency);
  return w ? w.balance : 0;
}

/** Takes money out of a wallet. Throws if the balance is too low. */
function debit(userId, minor, currency, type, reference, note) {
  if (balanceOf(userId, currency) < minor) throw Object.assign(new Error('Not enough ' + currency + ' in your wallet.'), { status: 400 });
  db.prepare('UPDATE wallets SET balance=balance-? WHERE user_id=? AND currency=?').run(minor, userId, currency);
  db.prepare('INSERT INTO wallet_tx(user_id,type,amount,currency,ref,note) VALUES(?,?,?,?,?,?)').run(userId, type, -minor, currency, reference, note || '');
}

/** Pays the seller automatically (minus platform commission, which goes to the owner ledger). */
function settleToSeller(sellerId, gross, currency, reference, note) {
  const fee = Math.floor(gross * commissionFor(sellerId) / 100);
  credit(sellerId, gross - fee, currency, 'sale', reference, note);
  const a = adminId();
  if (fee > 0 && a && a !== sellerId) credit(a, fee, currency, 'commission', reference, 'Platform commission: ' + note);
}

/** Grants (or extends) a community membership. Recurring communities get an expiry date. */
function grantMembership(groupId, userId, billing, autoRenew, subRef) {
  const exists = db.prepare('SELECT expires_at, role FROM group_members WHERE group_id=? AND user_id=?').get(groupId, userId);
  if (exists && exists.role === 'owner') return;
  if (!PERIOD[billing]) { // one-time: lifetime access
    db.prepare(`INSERT INTO group_members(group_id,user_id,expires_at,auto_renew) VALUES(?,?,NULL,0)
      ON CONFLICT(group_id,user_id) DO UPDATE SET expires_at=NULL, auto_renew=0`).run(groupId, userId);
    return;
  }
  const stillActive = exists && exists.expires_at && db.prepare("SELECT ? > datetime('now') AS ok").get(exists.expires_at).ok;
  db.prepare(`INSERT INTO group_members(group_id,user_id,expires_at,auto_renew,sub_ref,renew_notified) VALUES(?,?, datetime(?, ?), ?, ?, NULL)
    ON CONFLICT(group_id,user_id) DO UPDATE SET expires_at=excluded.expires_at, auto_renew=excluded.auto_renew, sub_ref=COALESCE(excluded.sub_ref, group_members.sub_ref), renew_notified=NULL`)
    .run(groupId, userId, stillActive ? exists.expires_at : 'now', PERIOD[billing], autoRenew ? 1 : 0, subRef || null);
}

// Which payment providers can take this currency right now (used by checkout screens)
router.get('/providers', (req, res) => {
  const cur = world.normCurrency(req.query.currency, defaultCurrency());
  const purpose = String(req.query.purpose || '');
  res.json({ currency: cur, providers: providers.forCurrency(cur, purpose).filter(p => !(p.manual && purpose === 'support')).map(p => ({ id: p.id, label: p.label, kind: p.kind })) });
});

/** Creates a hosted checkout (or manual-transfer instructions) for whatever the user wants to pay for. */
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const purpose = b.purpose;
    const user = db.prepare('SELECT id,email FROM users WHERE id=?').get(req.user.id);
    let targetId = null;
    let minor = 0, currency = defaultCurrency(), sellerId = null, productId = null, groupId = null, classId = null, title = 'Digital Enviro', recurring = null, autoRenew = 0;
    const reference = ref('de');

    if (purpose === 'product') {
      const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(b.product_id);
      if (!p) return res.status(404).json({ error: 'Product not found.' });
      if (p.price <= 0) return res.status(400).json({ error: 'This one is free - just download it.' });
      if (p.seller_id === req.user.id) return res.status(400).json({ error: 'This is your own product.' });
      if (p.group_id && p.members_only && !db.prepare('SELECT 1 FROM active_members WHERE group_id=? AND user_id=?').get(p.group_id, req.user.id))
        return res.status(403).json({ error: 'This product is for community members. Join the community first.' });
      minor = p.price; currency = p.currency; sellerId = p.seller_id; productId = p.id; title = p.title;
    } else if (purpose === 'group') {
      const g = db.prepare('SELECT * FROM groups_ WHERE id=?').get(b.group_id);
      if (!g || g.price <= 0) return res.status(404).json({ error: 'Paid community not found.' });
      const m = db.prepare('SELECT role FROM active_members WHERE group_id=? AND user_id=?').get(g.id, req.user.id);
      if (m && (g.billing === 'one_time' || m.role === 'owner')) return res.status(400).json({ error: 'You already belong to this community.' });
      minor = g.price; currency = g.currency; sellerId = g.owner_id; groupId = g.id; title = 'Join ' + g.name + (PERIOD[g.billing] ? ' (' + g.billing + ')' : '');
      if (PERIOD[g.billing]) { recurring = STRIPE_INTERVAL[g.billing]; autoRenew = b.auto_renew === false || b.auto_renew === 'false' ? 0 : 1; }
    } else if (purpose === 'class') {
      const c = db.prepare('SELECT * FROM classes WHERE id=? AND active=1').get(b.class_id);
      if (!c || c.price <= 0) return res.status(404).json({ error: 'Paid class not found.' });
      if (db.prepare('SELECT 1 FROM class_enrollments WHERE class_id=? AND user_id=?').get(c.id, req.user.id)) return res.status(400).json({ error: 'You are already enrolled.' });
      if (c.open_to === 'members' && !db.prepare('SELECT 1 FROM active_members WHERE group_id=? AND user_id=?').get(c.group_id, req.user.id)) return res.status(403).json({ error: 'Join the community to enrol in this class.' });
      if (c.capacity && db.prepare('SELECT COUNT(*) n FROM class_enrollments WHERE class_id=?').get(c.id).n >= c.capacity) return res.status(400).json({ error: 'This class is full.' });
      minor = c.price; currency = c.currency; sellerId = c.owner_id; classId = c.id; title = 'Class: ' + c.title;
    } else if (purpose === 'creator_fee') {
      if (!ownerfees.paymentsOn('creator_fee')) return res.status(400).json({ error: 'Creator payments are switched off at the moment - you do not need to pay.' });
      const cf = ownerfees.creatorFee(req.user.id);
      if (!cf) return res.status(400).json({ error: 'No creator fee applies to your account.' });
      minor = cf.amount; currency = cf.currency;
      sellerId = adminId(); title = 'Creator access';
    } else if (purpose === 'owner_invoice') {
      const inv = db.prepare("SELECT * FROM owner_invoices WHERE id=? AND user_id=? AND status='due'").get(b.invoice_id, req.user.id);
      if (!inv) return res.status(404).json({ error: 'That invoice was not found or is already paid.' });
      if (!ownerfees.paymentsOn(inv.kind) || ownerfees.waived(req.user.id)) return res.status(400).json({ error: 'The owner has switched this payment off for you - nothing to pay.' });
      minor = inv.amount; currency = inv.currency; sellerId = adminId(); targetId = inv.id; title = inv.note || 'Platform fee';
    } else if (purpose === 'ad') {
      const ad = db.prepare("SELECT * FROM ads WHERE id=? AND owner_id=? AND status='pending_payment'").get(b.ad_id, req.user.id);
      if (!ad) return res.status(404).json({ error: 'Advert not found or already paid.' });
      if (!ownerfees.paymentsOn('ad')) return res.status(400).json({ error: 'Paid adverts are switched off at the moment.' });
      minor = ad.price; currency = ad.currency; sellerId = adminId(); targetId = ad.id; title = 'Advert: ' + ad.title;
    } else if (purpose === 'support' || purpose === 'fund') {
      currency = world.normCurrency(b.currency, defaultCurrency());
      minor = world.toMinor(b.amount, currency);
      if (minor < world.factor(currency)) return res.status(400).json({ error: 'Enter an amount of at least 1 ' + currency + '.' });
      if (purpose === 'support') {
        const to = db.prepare("SELECT id FROM users WHERE username=? AND status='active'").get(String(b.to_username || '').toLowerCase());
        if (!to) return res.status(400).json({ error: 'Creator not found.' });
        if (to.id === req.user.id) return res.status(400).json({ error: "You can't support yourself." });
        sellerId = to.id; title = 'Support for @' + b.to_username;
      } else { sellerId = req.user.id; title = 'Wallet funding'; }
    } else {
      return res.status(400).json({ error: 'Unknown payment type.' });
    }

    let options = providers.forCurrency(currency, purpose);
    if (purpose === 'support') options = options.filter(p => !p.manual);
    if (!options.length) return res.status(503).json({ error: providers.accepts(currency) ? 'No payment method is available for ' + currency + ' right now. Try another currency, or ask the site owner to enable a provider.' : currency + ' is not accepted on this site.' });
    const provider = options.find(p => p.id === b.provider) || options[0];
    const useSubscription = !!(recurring && provider.id === 'stripe' && autoRenew);

    if (purpose === 'support') {
      db.prepare('INSERT INTO tips(ref,from_id,to_id,amount,currency,provider,kind,message) VALUES(?,?,?,?,?,?,?,?)')
        .run(reference, req.user.id, sellerId, minor, currency, provider.id, 'support', String(b.message || '').slice(0, 200));
    } else {
      db.prepare('INSERT INTO orders(ref,buyer_id,buyer_email,product_id,group_id,class_id,target_id,purpose,seller_id,amount,currency,provider,auto_renew) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(reference, req.user.id, payerEmail(user, baseUrl(req)), productId, groupId, classId, targetId, purpose, sellerId, minor, currency, provider.id, autoRenew);
    }

    // Direct payment to the site owner: show the owner's bank / crypto details, confirmed later in the dashboard
    if (provider.manual) {
      return res.json({ manual: true, reference, provider: provider.id, amount: minor, currency, title, accounts: provider.accounts(currency) });
    }

    const base = baseUrl(req);
    const callback = base + '/pay/verify/' + reference;
    const init = await provider.init({
      email: payerEmail(user, baseUrl(req)), minor, currency, reference, callback, successUrl: callback, cancelUrl: base + '/wallet', title,
      webhookUrl: base + '/api/pay/webhook/' + provider.id, metadata: { purpose, user_id: req.user.id },
      recurring: useSubscription ? recurring : null
    });
    if (init.providerRef) {
      db.prepare('UPDATE orders SET provider_ref=? WHERE ref=?').run(init.providerRef, reference);
      db.prepare('UPDATE tips SET provider_ref=? WHERE ref=?').run(init.providerRef, reference);
    }
    res.json({ authorization_url: init.url, reference, provider: provider.id });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Buyer tells us they paid the owner directly (bank transfer reference or crypto transaction hash)
router.post('/manual/:reference/proof', requireAuth, (req, res) => {
  const o = db.prepare("SELECT * FROM orders WHERE ref=? AND buyer_id=?").get(req.params.reference, req.user.id);
  if (!o || !String(o.provider).startsWith('manual_')) return res.status(404).json({ error: 'Payment not found.' });
  if (o.status === 'paid') return res.json({ ok: true, already: true });
  const proof = String((req.body || {}).proof || '').trim().slice(0, 300);
  if (proof.length < 4) return res.status(400).json({ error: 'Enter your transfer reference or the transaction hash.' });
  db.prepare("UPDATE orders SET status='review', proof=?, proof_note=? WHERE id=?").run(proof, String((req.body || {}).note || '').slice(0, 500), o.id);
  notifyStaff('payments_manage', 'payment', 'A payment of ' + world.format(o.amount, o.currency) + ' is waiting for your confirmation', '/admin');
  res.json({ ok: true });
});

/** Idempotent finalisation - called by the verify endpoint, the webhooks and manual approval. */
function finalize(reference, paidMinor, paidCurrency) {
  const order = db.prepare('SELECT * FROM orders WHERE ref=?').get(reference);
  const tip = !order ? db.prepare('SELECT * FROM tips WHERE ref=?').get(reference) : null;
  if (!order && !tip) return { ok: false, error: 'Unknown reference' };
  const rec = order || tip;
  const purpose = order ? order.purpose : 'support';
  if (rec.status === 'paid') return { ok: true, already: true, purpose };
  if (paidCurrency !== rec.currency || paidMinor < rec.amount) return { ok: false, error: 'Amount or currency mismatch' };

  db.transaction(() => {
    if (order) {
      db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(order.id);
      if (order.purpose === 'product') {
        const p = db.prepare('SELECT title FROM products WHERE id=?').get(order.product_id);
        settleToSeller(order.seller_id, order.amount, order.currency, reference, 'Sale: ' + (p ? p.title : 'product'));
        const buyer = db.prepare('SELECT username FROM users WHERE id=?').get(order.buyer_id);
        notify(order.seller_id, 'sale', 'New sale ' + world.format(order.amount, order.currency) + ' - @' + buyer.username + ' bought "' + (p ? p.title : '') + '"', '/wallet');
      } else if (order.purpose === 'group') {
        const g = db.prepare('SELECT billing, owner_id, name FROM groups_ WHERE id=?').get(order.group_id);
        grantMembership(order.group_id, order.buyer_id, g ? g.billing : 'one_time', !!order.auto_renew, null);
        settleToSeller(order.seller_id, order.amount, order.currency, reference, 'Community membership');
        notify(order.seller_id, 'sale', 'Someone paid ' + world.format(order.amount, order.currency) + ' to join ' + (g ? g.name : 'your community'), '/community/' + order.group_id);
        notify(order.buyer_id, 'group', 'Welcome! Your membership is active.', '/community/' + order.group_id);
      } else if (order.purpose === 'class') {
        const c = db.prepare('SELECT title FROM classes WHERE id=?').get(order.class_id);
        db.prepare('INSERT OR IGNORE INTO class_enrollments(class_id,user_id,order_ref) VALUES(?,?,?)').run(order.class_id, order.buyer_id, reference);
        settleToSeller(order.seller_id, order.amount, order.currency, reference, 'Class: ' + (c ? c.title : ''));
        notify(order.seller_id, 'sale', 'New class enrolment ' + world.format(order.amount, order.currency), '/class/' + order.class_id);
        notify(order.buyer_id, 'class', 'You are enrolled in "' + (c ? c.title : 'the class') + '"', '/class/' + order.class_id);
      } else if (order.purpose === 'creator_fee') {
        const days = parseInt(getSetting('creator_fee_days'), 10) || 30;
        const cur = db.prepare("SELECT paid_until FROM creator_subscriptions WHERE user_id=? AND paid_until > datetime('now')").get(order.buyer_id);
        db.prepare(`INSERT INTO creator_subscriptions(user_id,paid_until) VALUES(?, datetime(?, ?))
          ON CONFLICT(user_id) DO UPDATE SET paid_until=excluded.paid_until, updated_at=CURRENT_TIMESTAMP`).run(order.buyer_id, cur ? cur.paid_until : 'now', '+' + days + ' days');
        const a = adminId();
        if (a) credit(a, order.amount, order.currency, 'creator_fee', reference, 'Creator subscription');
      } else if (order.purpose === 'owner_invoice') {
        const inv = ownerfees.markPaid(order.target_id, reference);
        const a = adminId();
        if (a && inv) credit(a, order.amount, order.currency, inv.kind, reference, inv.note || inv.kind);
        notify(order.buyer_id, 'payment', 'Payment received - thank you!', '/creator/fees');
      } else if (order.purpose === 'ad') {
        require('./ads').onPaid(order);
        const a = adminId();
        if (a) credit(a, order.amount, order.currency, 'ad_revenue', reference, 'Advert payment');
      } else if (order.purpose === 'fund') {
        credit(order.buyer_id, order.amount, order.currency, 'funding', reference, 'Wallet funding');
      } else if (order.purpose === 'dropship') {
        require('./dropship').onPaid(order);
      }
    } else {
      db.prepare("UPDATE tips SET status='paid' WHERE id=?").run(tip.id);
      settleToSeller(tip.to_id, tip.amount, tip.currency, reference, 'Support from a fan');
      const from = db.prepare('SELECT username FROM users WHERE id=?').get(tip.from_id);
      notify(tip.to_id, 'support', '@' + from.username + ' supported you with ' + world.format(tip.amount, tip.currency) + (tip.message ? ': "' + tip.message + '"' : ''), '/wallet');
    }
  })();
  if (purpose === 'dropship') setImmediate(() => { try { require('./dropship').afterPaid(reference); } catch (e) { console.error('[dropship]', e.message); } });
  return { ok: true, purpose };
}

async function verifyAndFinalize(reference) {
  const rec = db.prepare('SELECT provider, provider_ref, status, purpose, group_id FROM orders WHERE ref=? UNION ALL SELECT provider, provider_ref, status, \'support\' AS purpose, NULL AS group_id FROM tips WHERE ref=?').get(reference, reference);
  if (!rec) return { ok: false, error: 'Unknown reference' };
  if (rec.status === 'paid') return { ok: true, already: true, purpose: rec.purpose };
  const provider = providers.all[rec.provider];
  if (!provider) return { ok: false, error: 'Unknown provider' };
  if (provider.manual) return { ok: false, status: rec.status === 'review' ? 'review' : 'awaiting_transfer' };
  let v;
  try { v = await provider.verify(reference, rec.provider_ref); } catch (e) { return { ok: false, status: 'pending', error: e.message }; }
  if (!v.paid) return { ok: false, status: 'unpaid' };
  const r = finalize(reference, v.minor, v.currency);
  if (r.ok && v.subscriptionId && rec.group_id) {
    const o = db.prepare('SELECT buyer_id FROM orders WHERE ref=?').get(reference);
    if (o) db.prepare('UPDATE group_members SET sub_ref=?, auto_renew=1 WHERE group_id=? AND user_id=?').run(v.subscriptionId, rec.group_id, o.buyer_id);
  }
  return r;
}

router.get('/verify/:reference', requireAuth, async (req, res) => {
  try {
    const own = db.prepare('SELECT 1 AS x FROM orders WHERE ref=? AND buyer_id=? UNION SELECT 1 FROM tips WHERE ref=? AND from_id=?').get(req.params.reference, req.user.id, req.params.reference, req.user.id);
    if (!own) return res.status(404).json({ error: 'Payment not found.' });
    res.json(await verifyAndFinalize(req.params.reference));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------- Automatic membership renewal ----------
/** Handles a Stripe subscription invoice: extends the membership and pays the community owner. */
function renewFromInvoice(inv) {
  if (!inv || !inv.id || db.prepare('SELECT 1 FROM processed_events WHERE id=?').get('inv:' + inv.id)) return;
  const m = db.prepare('SELECT gm.*, g.billing, g.owner_id, g.name FROM group_members gm JOIN groups_ g ON g.id=gm.group_id WHERE gm.sub_ref=?').get(inv.subscription);
  if (!m) return;
  const cur = String(inv.currency || '').toUpperCase();
  db.transaction(() => {
    db.prepare('INSERT INTO processed_events(id) VALUES(?)').run('inv:' + inv.id);
    grantMembership(m.group_id, m.user_id, m.billing, true, inv.subscription);
    settleToSeller(m.owner_id, inv.amount_paid, cur, 'sub-' + inv.id, 'Community renewal: ' + m.name);
  })();
  notify(m.user_id, 'group', 'Your ' + m.name + ' membership was renewed automatically.', '/community/' + m.group_id);
}

router.post('/membership/:gid/auto-renew', requireAuth, async (req, res) => {
  const m = db.prepare('SELECT * FROM group_members WHERE group_id=? AND user_id=?').get(req.params.gid, req.user.id);
  const g = db.prepare('SELECT billing FROM groups_ WHERE id=?').get(req.params.gid);
  if (!m || !g || !PERIOD[g.billing]) return res.status(400).json({ error: 'This membership does not renew.' });
  const on = !!(req.body || {}).enabled;
  try {
    if (!on && m.sub_ref && providers.all.stripe.enabled()) await providers.all.stripe.cancelSubscription(m.sub_ref);
  } catch (e) { /* subscription may already be cancelled */ }
  db.prepare('UPDATE group_members SET auto_renew=?, sub_ref=? WHERE group_id=? AND user_id=?').run(on ? 1 : 0, on ? m.sub_ref : null, m.group_id, m.user_id);
  res.json({ auto_renew: on });
});

// ---------- Webhooks (set these URLs in each provider dashboard) ----------
//   https://YOUR-DOMAIN/api/pay/webhook/paystack | flutterwave | stripe | nowpayments | btcpay
function refundFailedWithdrawal(wid, reason) {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id=?').get(wid);
  if (!w || ['rejected', 'failed', 'paid'].includes(w.status)) return;
  db.transaction(() => {
    db.prepare("UPDATE withdrawals SET status='failed', note=? WHERE id=?").run(reason, wid);
    credit(w.user_id, w.amount, w.currency, 'refund', 'wd' + wid, 'Withdrawal failed - returned to wallet');
  })();
}
function wdIdFrom(reference) { const m = String(reference || '').match(/^wd-(\d+)-/); return m ? parseInt(m[1], 10) : null; }

router.post('/webhook/:provider', async (req, res) => {
  const provider = providers.all[req.params.provider];
  if (!provider || provider.manual || !(await provider.verifyWebhook(req.rawBody, req.headers, req.body))) return res.sendStatus(401);
  try {
    const ev = req.body || {};
    let paymentRef = null, transfer = null;
    if (provider.id === 'paystack') {
      if (ev.event === 'charge.success') paymentRef = ev.data.reference;
      if (/^transfer\./.test(ev.event || '')) transfer = { wid: wdIdFrom(ev.data.reference), ok: ev.event === 'transfer.success', failed: ev.event === 'transfer.failed' || ev.event === 'transfer.reversed' };
    } else if (provider.id === 'flutterwave') {
      if (ev.event === 'charge.completed' && ev.data) paymentRef = ev.data.tx_ref;
      if (ev.event === 'transfer.completed' && ev.data) transfer = { wid: wdIdFrom(ev.data.reference), ok: ev.data.status === 'SUCCESSFUL', failed: ev.data.status === 'FAILED' };
    } else if (provider.id === 'stripe') {
      if (ev.type === 'checkout.session.completed') paymentRef = ev.data.object.client_reference_id;
      if (ev.type === 'invoice.paid' && ev.data.object.billing_reason === 'subscription_cycle') renewFromInvoice(ev.data.object);
      if (ev.type === 'customer.subscription.deleted') db.prepare('UPDATE group_members SET auto_renew=0, sub_ref=NULL WHERE sub_ref=?').run(ev.data.object.id);
    } else if (provider.id === 'paypal') {
      const r = ev.resource || {};
      if (ev.event_type === 'PAYMENT.CAPTURE.COMPLETED' && r.custom_id) paymentRef = r.custom_id;
      if (ev.event_type === 'CHECKOUT.ORDER.APPROVED' && r.purchase_units && r.purchase_units[0]) paymentRef = r.purchase_units[0].custom_id;
      const item = r.payout_item || {};
      if (/^PAYMENT\.PAYOUTS-ITEM\./.test(ev.event_type || '') && item.sender_item_id) {
        const bad = /FAILED|BLOCKED|DENIED|RETURNED|REFUNDED|CANCELED|UNCLAIMED/.test(ev.event_type);
        transfer = { wid: wdIdFrom(item.sender_item_id), ok: /SUCCEEDED/.test(ev.event_type), failed: bad };
      }
    } else if (provider.id === 'tap') {
      const o = db.prepare('SELECT ref FROM orders WHERE provider_ref=? UNION ALL SELECT ref FROM tips WHERE provider_ref=?').get(String(ev.id), String(ev.id));
      if (o) paymentRef = o.ref;
    } else if (provider.id === 'nowpayments') {
      // signed IPN: finalise once the crypto payment is fully confirmed ("finished")
      if (ev.payment_status === 'finished' && ev.order_id) {
        const r = finalize(String(ev.order_id), world.toMinor(ev.price_amount, String(ev.price_currency).toUpperCase()), String(ev.price_currency).toUpperCase());
        if (!r.ok) console.warn('[nowpayments] could not finalise', ev.order_id, r.error);
      }
    } else if (provider.id === 'btcpay') {
      if (ev.type === 'InvoiceSettled' && ev.invoiceId) {
        const o = db.prepare('SELECT ref FROM orders WHERE provider_ref=?').get(ev.invoiceId);
        if (o) paymentRef = o.ref;
      }
    }
    // never trust the payload alone: re-check the payment with the provider API
    if (paymentRef) await verifyAndFinalize(paymentRef);
    if (transfer && transfer.wid) {
      if (transfer.ok) db.prepare("UPDATE withdrawals SET status='paid' WHERE id=? AND status IN ('processing','pending')").run(transfer.wid);
      else if (transfer.failed) refundFailedWithdrawal(transfer.wid, 'Automatic transfer failed - returned to wallet');
    }
  } catch (e) { console.error('[webhook ' + provider.id + ']', e.message); }
  res.sendStatus(200);
});

// ---------- Wallet ----------
router.get('/wallet', requireAuth, (req, res) => {
  const me = db.prepare('SELECT country FROM users WHERE id=?').get(req.user.id);
  res.json({
    balances: db.prepare('SELECT currency,balance FROM wallets WHERE user_id=? ORDER BY balance DESC').all(req.user.id),
    default_currency: defaultCurrency(),
    min_withdrawal: parseFloat(getSetting('min_withdrawal')) || 0,
    commission: commissionFor(req.user.id),
    auto_payout: getSetting('auto_payout') === '1',
    banks: db.prepare('SELECT id,label,country,bank_name,bank_code,account_number,account_name,swift_bic,routing,extra,provider,is_default FROM bank_accounts WHERE user_id=? ORDER BY is_default DESC, id').all(req.user.id),
    user_country: me ? me.country : null,
    ng_auto_convert: getSetting('ng_auto_convert') === '1',
    fx_margin: fx.marginPercent(),
    fees_due: ownerfees.dueInvoices(req.user.id),
    paypal: (db.prepare('SELECT email FROM paypal_accounts WHERE user_id=?').get(req.user.id) || {}).email || null,
    paypal_payouts: providers.all.paypal.payoutsOn(),
    crypto_wallets: db.prepare('SELECT coin,network,address,memo FROM crypto_wallets WHERE user_id=? ORDER BY coin').all(req.user.id),
    transactions: db.prepare('SELECT * FROM wallet_tx WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id),
    withdrawals: db.prepare('SELECT id,amount,currency,status,note,created_at FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id),
    supporters: db.prepare(`SELECT u.username, t.currency, SUM(t.amount) AS total, COUNT(*) AS times FROM tips t JOIN users u ON u.id=t.from_id
      WHERE t.to_id=? AND t.status='paid' GROUP BY t.from_id, t.currency ORDER BY total DESC LIMIT 20`).all(req.user.id)
  });
});

// Bank list for a country, from whichever provider offers one. Empty list = enter the bank by hand (manual payout).
const bankCache = {};
const PAYSTACK_COUNTRIES = { NG: 'nigeria', GH: 'ghana', ZA: 'south africa', KE: 'kenya' };
router.get('/banks', requireAuth, async (req, res) => {
  const cc = String(req.query.country || '').toUpperCase();
  if (!world.countries.find(c => c.code === cc)) return res.status(400).json({ error: 'Pick a country.' });
  const hit = bankCache[cc];
  if (hit && Date.now() - hit.at < 12 * 3600 * 1000) return res.json(hit.data);
  let data = { banks: [], provider: null };
  try {
    if (PAYSTACK_COUNTRIES[cc] && providers.all.paystack.enabled()) {
      const list = await providers.all.paystack.api('GET', '/bank?perPage=300&country=' + encodeURIComponent(PAYSTACK_COUNTRIES[cc]));
      data = { banks: list.map(b => ({ name: b.name, code: b.code })), provider: 'paystack' };
    }
  } catch (e) { /* fall through */ }
  if (!data.banks.length) {
    try {
      if (providers.all.flutterwave.enabled()) {
        const list = await providers.all.flutterwave.api('GET', '/banks/' + cc);
        data = { banks: list.map(b => ({ name: b.name, code: b.code })), provider: 'flutterwave' };
      }
    } catch (e) { /* no list for this country */ }
  }
  if (!data.banks.length && cc === 'KW') data = { banks: world.KW_BANKS, provider: null, fallback: true };
  if (!data.banks.length && cc === 'NG') data = { banks: world.NG_BANKS, provider: null, fallback: true }; // built-in list; the owner then pays these out manually
  if (data.banks.length) bankCache[cc] = { at: Date.now(), data };
  res.json(data);
});

async function tryResolve(country, bank_code, account_number, providerId) {
  try {
    if (providerId === 'paystack' && providers.all.paystack.enabled())
      return (await providers.all.paystack.api('GET', '/bank/resolve?account_number=' + encodeURIComponent(account_number) + '&bank_code=' + encodeURIComponent(bank_code))).account_name;
    if (providerId === 'flutterwave' && providers.all.flutterwave.enabled())
      return (await providers.all.flutterwave.api('POST', '/accounts/resolve', { account_number, account_bank: bank_code })).account_name;
  } catch (e) { /* cannot verify automatically */ }
  return null;
}

router.post('/bank/resolve', requireAuth, async (req, res) => {
  const { country, bank_code, account_number, provider } = req.body || {};
  const name = bank_code ? await tryResolve(country, bank_code, String(account_number || ''), provider) : null;
  res.json({ account_name: name });
});

// Save a bank account (you can keep up to 5, in any country)
router.post('/bank', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const country = String(b.country || '').toUpperCase();
    if (!world.countries.find(c => c.code === country)) return res.status(400).json({ error: 'Choose the country of your bank.' });
    const bank_name = String(b.bank_name || '').trim().slice(0, 100);
    const account_number = String(b.account_number || '').replace(/\s+/g, '').slice(0, 40);
    let account_name = String(b.account_name || '').trim().slice(0, 100);
    if (!bank_name) return res.status(400).json({ error: 'Enter or choose your bank.' });
    if (!/^[A-Za-z0-9-]{4,40}$/.test(account_number)) return res.status(400).json({ error: 'Enter a valid account number or IBAN.' });
    if (country === 'KW' && !world.validIban(account_number)) return res.status(400).json({ error: 'Kuwaiti accounts use an IBAN (KW + 28 characters). Check it and try again.' });
    if (country === 'NG' && !/^\d{10}$/.test(account_number)) return res.status(400).json({ error: 'Nigerian account numbers have 10 digits.' });
    const swift_bic = String(b.swift_bic || '').trim().toUpperCase().slice(0, 11);
    if (swift_bic && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(swift_bic)) return res.status(400).json({ error: 'SWIFT/BIC must be 8 or 11 letters/numbers.' });
    const bank_code = b.bank_code ? String(b.bank_code).slice(0, 20) : null;
    let provider = bank_code && ['paystack', 'flutterwave'].includes(b.provider) ? b.provider : null;
    if (db.prepare('SELECT COUNT(*) n FROM bank_accounts WHERE user_id=?').get(req.user.id).n >= 5) return res.status(400).json({ error: 'You can save up to 5 bank accounts. Remove one first.' });

    const resolved = bank_code ? await tryResolve(country, bank_code, account_number, provider) : null;
    if (resolved) account_name = resolved;
    if (!account_name) return res.status(400).json({ error: 'Enter the account holder name exactly as the bank has it.' });

    let recipient = null;
    if (provider === 'paystack' && country === 'NG') {
      try { recipient = (await providers.all.paystack.api('POST', '/transferrecipient', { type: 'nuban', name: account_name, account_number, bank_code, currency: 'NGN' })).recipient_code; } catch (e) { /* manual payout still works */ }
    }
    const first = !db.prepare('SELECT 1 FROM bank_accounts WHERE user_id=?').get(req.user.id);
    const info = db.prepare(`INSERT INTO bank_accounts(user_id,label,country,bank_name,bank_code,account_number,account_name,swift_bic,routing,extra,provider,recipient_code,is_default)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,country,bank_name,account_number) DO UPDATE SET account_name=excluded.account_name, bank_code=excluded.bank_code, provider=excluded.provider, recipient_code=excluded.recipient_code, label=excluded.label`)
      .run(req.user.id, String(b.label || '').slice(0, 40) || null, country, bank_name, bank_code, account_number, account_name, swift_bic || null, String(b.routing || '').slice(0, 30) || null, String(b.extra || '').slice(0, 200) || null, provider, recipient, first ? 1 : 0);
    res.json({ ok: true, id: info.lastInsertRowid, account_name, verified: !!resolved, automatic: !!(recipient || (provider === 'flutterwave' && bank_code)) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
router.put('/bank/:id/default', requireAuth, (req, res) => {
  if (!db.prepare('SELECT 1 FROM bank_accounts WHERE id=? AND user_id=?').get(req.params.id, req.user.id)) return res.status(404).json({ error: 'Account not found.' });
  db.transaction(() => {
    db.prepare('UPDATE bank_accounts SET is_default=0 WHERE user_id=?').run(req.user.id);
    db.prepare('UPDATE bank_accounts SET is_default=1 WHERE id=?').run(req.params.id);
  })();
  res.json({ ok: true });
});
router.delete('/bank/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM bank_accounts WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  const left = db.prepare('SELECT id FROM bank_accounts WHERE user_id=? ORDER BY id LIMIT 1').get(req.user.id);
  if (left && !db.prepare('SELECT 1 FROM bank_accounts WHERE user_id=? AND is_default=1').get(req.user.id)) db.prepare('UPDATE bank_accounts SET is_default=1 WHERE id=?').run(left.id);
  res.json({ ok: true });
});

// ---------- Crypto payout addresses (receive earnings in any coin) ----------
router.put('/crypto-wallet', requireAuth, (req, res) => {
  const b = req.body || {};
  const coin = String(b.coin || '').trim().toUpperCase().slice(0, 12);
  const network = String(b.network || '').trim().slice(0, 40);
  const address = String(b.address || '').trim();
  if (!/^[A-Z0-9]{2,12}$/.test(coin)) return res.status(400).json({ error: 'Enter the coin symbol, e.g. BTC, ETH, USDT.' });
  if (!network) return res.status(400).json({ error: 'Choose or enter the network (e.g. Tron TRC-20).' });
  if (!/^[A-Za-z0-9:._-]{15,120}$/.test(address)) return res.status(400).json({ error: 'That wallet address does not look right. Copy it again carefully.' });
  db.prepare(`INSERT INTO crypto_wallets(user_id,coin,network,address,memo) VALUES(?,?,?,?,?)
    ON CONFLICT(user_id,coin,network) DO UPDATE SET address=excluded.address, memo=excluded.memo`)
    .run(req.user.id, coin, network, address, String(b.memo || '').slice(0, 60) || null);
  res.json({ ok: true });
});
router.put('/paypal', requireAuth, (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,200}\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Enter the email address of your PayPal account.' });
  db.prepare('INSERT INTO paypal_accounts(user_id,email) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email').run(req.user.id, email);
  res.json({ ok: true });
});
router.delete('/paypal', requireAuth, (req, res) => { db.prepare('DELETE FROM paypal_accounts WHERE user_id=?').run(req.user.id); res.json({ ok: true }); });
router.delete('/crypto-wallet', requireAuth, (req, res) => {
  db.prepare('DELETE FROM crypto_wallets WHERE user_id=? AND coin=? AND network=?').run(req.user.id, String(req.body.coin || '').toUpperCase(), String(req.body.network || ''));
  res.json({ ok: true });
});

// ---------- Currency conversion (any currency -> any currency, e.g. USD earnings -> Naira) ----------
router.get('/fx', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT currency,per_usd,source,updated_at FROM fx_rates ORDER BY currency').all();
  res.json({ rates: rows, margin_percent: fx.marginPercent(), ready: rows.length > 0 });
});
router.get('/convert/quote', requireAuth, (req, res) => {
  const from = world.normCurrency(req.query.from, null), to = world.normCurrency(req.query.to, null);
  if (!from || !to) return res.status(400).json({ error: 'Choose both currencies.' });
  try {
    const minor = world.toMinor(req.query.amount, from);
    const c = fx.convertMinor(minor, from, to);
    res.json({ from, to, amount: minor, out: c.out, rate: c.rate, margin_percent: from === to ? 0 : fx.marginPercent(), margin: c.margin });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
router.post('/convert', requireAuth, (req, res) => {
  const b = req.body || {};
  const from = world.normCurrency(b.from, null), to = world.normCurrency(b.to, null);
  if (!from || !to || from === to) return res.status(400).json({ error: 'Choose two different currencies.' });
  const minor = world.toMinor(b.amount, from);
  if (minor <= 0) return res.status(400).json({ error: 'Enter an amount.' });
  try {
    const out = db.transaction(() => {
      const c = fx.convertMinor(minor, from, to);
      if (c.out <= 0) throw Object.assign(new Error('That amount is too small to convert.'), { status: 400 });
      debit(req.user.id, minor, from, 'convert_out', null, 'Converted to ' + to);
      credit(req.user.id, c.out, to, 'convert_in', null, 'Converted from ' + from);
      const a = adminId();
      if (c.margin > 0 && a && a !== req.user.id) credit(a, c.margin, to, 'fx_margin', null, 'Conversion margin');
      return c;
    })();
    res.json({ ok: true, out: out.out, rate: out.rate });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------- What I owe the owner (class-hosting fees, creator subscription) ----------
router.get('/fees', requireAuth, (req, res) => {
  const cf = ownerfees.creatorFee(req.user.id);
  res.json({
    payments_on: ownerfees.paymentsOn('class_fee') || ownerfees.paymentsOn('creator_fee'),
    waived: ownerfees.waived(req.user.id),
    due: ownerfees.dueInvoices(req.user.id),
    history: db.prepare('SELECT * FROM owner_invoices WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id),
    class_fee: { mode: getSetting('class_fee_mode'), when: getSetting('class_fee_when'), applies: getSetting('class_fee_applies'), currency: world.normCurrency(getSetting('class_fee_currency'), 'USD'), on: ownerfees.paymentsOn('class_fee') },
    creator_fee: { required: !!cf, amount: cf ? cf.amount : 0, currency: cf ? cf.currency : null, days: cf ? cf.days : 0, timing: getSetting('creator_fee_timing') },
    sub_until: (db.prepare('SELECT paid_until FROM creator_subscriptions WHERE user_id=?').get(req.user.id) || {}).paid_until || null
  });
});
router.post('/fees/:id/pay-wallet', requireAuth, (req, res) => {
  const inv = db.prepare("SELECT * FROM owner_invoices WHERE id=? AND user_id=? AND status='due'").get(req.params.id, req.user.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found or already paid.' });
  try { ownerfees.payFromWallet(inv); res.json({ ok: true }); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/withdraw', requireAuth, restrict('withdraw'), async (req, res) => {
  const b = req.body || {};
  const currency = world.normCurrency(b.currency, null);
  if (!currency) return res.status(400).json({ error: 'Choose a currency.' });
  const overdue = ownerfees.blocked(req.user.id, 'withdrawals');
  if (overdue) return res.status(403).json({ error: 'Please pay your overdue fee (' + world.format(overdue.amount, overdue.currency) + ') before withdrawing.', fee_due: true });
  const minor = world.toMinor(b.amount, currency);
  const method = ['crypto', 'paypal'].includes(b.method) ? b.method : 'bank';
  const convertTo = method === 'bank' && b.convert_to ? world.normCurrency(b.convert_to, null) : null;
  const target = convertTo || currency;
  const bank = method === 'bank'
    ? (b.bank_id ? db.prepare('SELECT * FROM bank_accounts WHERE id=? AND user_id=?').get(b.bank_id, req.user.id) : db.prepare('SELECT * FROM bank_accounts WHERE user_id=? ORDER BY is_default DESC, id LIMIT 1').get(req.user.id))
    : null;
  const ppAccount = method === 'paypal' ? db.prepare('SELECT * FROM paypal_accounts WHERE user_id=?').get(req.user.id) : null;
  if (method === 'paypal' && !ppAccount) return res.status(400).json({ error: 'Add your PayPal email first.' });
  if (method === 'paypal' && !providers.all.paypal.supports(currency)) return res.status(400).json({ error: 'PayPal cannot pay out in ' + currency + '. Convert to a PayPal currency such as USD first.' });
  const wallet = method === 'crypto' ? db.prepare('SELECT * FROM crypto_wallets WHERE user_id=? AND coin=? AND network=?').get(req.user.id, String(b.coin || '').toUpperCase(), String(b.network || '')) : null;
  if (method === 'bank' && !bank) return res.status(400).json({ error: 'Add your bank account first.' });
  if (method === 'crypto' && !wallet) return res.status(400).json({ error: 'Add that crypto wallet address first.' });
  if (convertTo && convertTo !== currency) {
    const local = (world.countries.find(c => c.code === bank.country) || {}).currency;
    if (local !== convertTo) return res.status(400).json({ error: 'Choose a bank in a country that uses ' + convertTo + ' to withdraw in ' + convertTo + '.' });
  }
  if (minor <= 0) return res.status(400).json({ error: 'Enter an amount.' });
  let id, payoutMinor = minor, quote = null;
  try {
    id = db.transaction(() => {
      if (target !== currency) {
        quote = fx.convertMinor(minor, currency, target);
        if (quote.out <= 0) throw Object.assign(new Error('That amount is too small to convert.'), { status: 400 });
        debit(req.user.id, minor, currency, 'convert_out', null, 'Converted to ' + target + ' for withdrawal');
        credit(req.user.id, quote.out, target, 'convert_in', null, 'Converted from ' + currency + ' for withdrawal');
        const a = adminId();
        if (quote.margin > 0 && a && a !== req.user.id) credit(a, quote.margin, target, 'fx_margin', null, 'Conversion margin');
        payoutMinor = quote.out;
      }
      const minMinor = world.toMinor(getSetting('min_withdrawal'), target);
      if (payoutMinor < minMinor) throw Object.assign(new Error('Minimum withdrawal is ' + world.format(minMinor, target) + '.'), { status: 400 });
      if (balanceOf(req.user.id, target) < payoutMinor) throw Object.assign(new Error('Insufficient ' + target + ' balance.'), { status: 400 });
      db.prepare('UPDATE wallets SET balance=balance-? WHERE user_id=? AND currency=?').run(payoutMinor, req.user.id, target);
      const snap = method === 'bank'
        ? { method: 'bank', country: bank.country, bank_name: bank.bank_name, account_number: bank.account_number, account_name: bank.account_name, swift_bic: bank.swift_bic, routing: bank.routing, extra: bank.extra, converted_from: quote ? { currency, amount: minor, rate: quote.rate } : null }
        : method === 'paypal' ? { method: 'paypal', email: ppAccount.email }
        : { method: 'crypto', coin: wallet.coin, network: wallet.network, address: wallet.address, memo: wallet.memo };
      const info = db.prepare('INSERT INTO withdrawals(user_id,amount,currency,bank_snapshot) VALUES(?,?,?,?)').run(req.user.id, payoutMinor, target, JSON.stringify(snap));
      db.prepare("INSERT INTO wallet_tx(user_id,type,amount,currency,ref,note) VALUES(?, 'withdrawal', ?, ?, ?, ?)").run(req.user.id, -payoutMinor, target, 'wd' + info.lastInsertRowid, method === 'crypto' ? 'Withdrawal to ' + wallet.coin : method === 'paypal' ? 'Withdrawal to PayPal' : 'Withdrawal to ' + bank.bank_name);
      return info.lastInsertRowid;
    })();
  } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }

  // Automatic bank transfer where a provider can reach this bank; crypto and other banks are paid by the owner.
  if (getSetting('auto_payout') === '1') {
    const reference = 'wd-' + id + '-' + crypto.randomBytes(5).toString('hex');
    try {
      if (method === 'paypal' && providers.all.paypal.payoutsOn()) {
        await providers.all.paypal.payout({ email: ppAccount.email, minor: payoutMinor, currency: target, reference, note: 'Payout' });
        db.prepare("UPDATE withdrawals SET status='processing' WHERE id=?").run(id);
        return res.json({ ok: true, status: 'processing', amount: payoutMinor, currency: target });
      }
      if (method === 'crypto' && wallet.coin === 'BTC' && /bitcoin/i.test(wallet.network) && providers.all.btcpay.payoutsOn()) {
        await providers.all.btcpay.payout({ address: wallet.address, minor: payoutMinor, currency: target, reference });
        db.prepare("UPDATE withdrawals SET status='processing' WHERE id=?").run(id);
        return res.json({ ok: true, status: 'processing', amount: payoutMinor, currency: target });
      }
      if (method !== 'bank') throw new Error('manual');
      if (providers.wise.payoutsOn() && world.validIban(bank.account_number) && !(bank.provider && ['paystack', 'flutterwave'].includes(bank.provider) && bank.recipient_code)) {
        const w = await providers.wise.payout({ iban: bank.account_number, name: bank.account_name, minor: payoutMinor, currency: target, reference, swift: bank.swift_bic });
        db.prepare("UPDATE withdrawals SET status='processing', note=? WHERE id=?").run('wise:' + w.id, id);
        return res.json({ ok: true, status: 'processing', amount: payoutMinor, currency: target });
      }
      if (bank.provider === 'paystack' && bank.recipient_code && target === 'NGN') {
        await providers.all.paystack.api('POST', '/transfer', { source: 'balance', amount: payoutMinor, recipient: bank.recipient_code, reason: 'Digital Enviro payout', reference });
        db.prepare("UPDATE withdrawals SET status='processing' WHERE id=?").run(id);
        return res.json({ ok: true, status: 'processing', amount: payoutMinor, currency: target });
      }
      if (bank.provider === 'flutterwave' && bank.bank_code && providers.all.flutterwave.enabled()) {
        await providers.all.flutterwave.api('POST', '/transfers', {
          account_bank: bank.bank_code, account_number: bank.account_number, amount: world.toMajor(payoutMinor, target), currency: target,
          narration: 'Digital Enviro payout', reference, beneficiary_name: bank.account_name
        });
        db.prepare("UPDATE withdrawals SET status='processing' WHERE id=?").run(id);
        return res.json({ ok: true, status: 'processing', amount: payoutMinor, currency: target });
      }
    } catch (e) { /* fall back to manual payout below */ }
  }
  notifyStaff('payments_manage', 'withdrawal', 'New withdrawal request: ' + world.format(payoutMinor, target) + (method === 'crypto' ? ' (crypto)' : ''), '/admin');
  res.json({ ok: true, status: 'pending', amount: payoutMinor, currency: target });
});

// Reward followers (or anyone) straight from your wallet balance - instant and fee-free
router.post('/reward', requireAuth, featureOn('tips'), (req, res) => {
  const b = req.body || {};
  const currency = world.normCurrency(b.currency, null);
  const to = db.prepare("SELECT id,username FROM users WHERE username=? AND status='active'").get(String(b.to_username || '').toLowerCase());
  if (!currency) return res.status(400).json({ error: 'Choose a currency.' });
  if (!to || to.id === req.user.id) return res.status(400).json({ error: 'Choose someone to reward.' });
  const minor = world.toMinor(b.amount, currency);
  if (minor < world.factor(currency) / 2) return res.status(400).json({ error: 'Amount is too small.' });
  try {
    db.transaction(() => {
      debit(req.user.id, minor, currency, 'reward_sent', null, 'Reward to @' + to.username);
      credit(to.id, minor, currency, 'reward_received', null, 'Reward from @' + req.user.username);
      db.prepare("INSERT INTO tips(ref,from_id,to_id,amount,currency,kind,message,status) VALUES(NULL,?,?,?,?, 'reward', ?, 'paid')").run(req.user.id, to.id, minor, currency, String(b.message || '').slice(0, 200));
    })();
  } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  notify(to.id, 'reward', '@' + req.user.username + ' rewarded you ' + world.format(minor, currency) + (b.message ? ': "' + String(b.message).slice(0, 100) + '"' : ''), '/wallet');
  res.json({ ok: true });
});

module.exports = router;
module.exports.finalize = finalize;
/** Checks Wise payouts that are still in flight and settles or returns them. Runs every few minutes. */
module.exports.pollPayouts = async function pollPayouts() {
  if (!providers.wise.enabled()) return;
  const rows = db.prepare("SELECT id,note FROM withdrawals WHERE status='processing' AND note LIKE 'wise:%' LIMIT 50").all();
  for (const w of rows) {
    try {
      const st = await providers.wise.status(w.note.slice(5));
      if (st === 'outgoing_payment_sent') db.prepare("UPDATE withdrawals SET status='paid' WHERE id=?").run(w.id);
      else if (['cancelled', 'funds_refunded', 'charged_back'].includes(st)) refundFailedWithdrawal(w.id, 'Bank transfer was not completed - returned to wallet');
    } catch (e) { /* try again next time */ }
  }
};
module.exports.verifyAndFinalize = verifyAndFinalize;
module.exports.credit = credit;
module.exports.debit = debit;
module.exports.balanceOf = balanceOf;
module.exports.settleToSeller = settleToSeller;
module.exports.commissionFor = commissionFor;
module.exports.grantMembership = grantMembership;
module.exports.adminId = adminId;
module.exports.PERIOD = PERIOD;
