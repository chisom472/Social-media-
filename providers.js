// Payment providers. Each one can charge buyers (checkout) and verify payments.
//   Cards / bank / mobile money : Paystack, Flutterwave, Stripe
//   Crypto                      : NOWPayments (300+ coins), BTCPay Server (self-hosted, non-custodial)
//   Direct to the site owner    : manual bank transfer, manual crypto (owner confirms in the dashboard)
// Which currencies each provider accepts is configurable in the Admin Dashboard.
const crypto = require('crypto');
const { db, getSetting } = require('./db');
const { decimals, toMajor, toMinor } = require('./world');

function httpError(msg, status) { return Object.assign(new Error(msg), { status: status || 502 }); }

function currencyList(key) {
  const v = String(getSetting(key) || '').trim().toUpperCase();
  if (v === 'ALL' || v === '*' || v === '') return null; // null = every currency
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

async function call(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------------- Paystack ----------------
const paystack = {
  id: 'paystack',
  kind: 'fiat',
  label: 'Paystack (card, bank, USSD, transfer)',
  key: () => getSetting('paystack_secret_key'),
  enabled() { return !!this.key(); },
  supports(cur) { const l = currencyList('paystack_currencies'); return !l || l.includes(cur); },
  async api(method, endpoint, body) {
    if (!this.key()) throw httpError('Paystack is not set up.', 503);
    const { data } = await call('https://api.paystack.co' + endpoint, {
      method, headers: { Authorization: 'Bearer ' + this.key(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
    });
    if (!data.status) throw httpError(data.message || 'Paystack error');
    return data.data;
  },
  async init({ email, minor, currency, reference, callback, metadata }) {
    const d = await this.api('POST', '/transaction/initialize', { email, amount: minor, currency, reference, callback_url: callback, metadata });
    return { url: d.authorization_url };
  },
  async verify(reference) {
    const d = await this.api('GET', '/transaction/verify/' + encodeURIComponent(reference));
    return { paid: d.status === 'success', minor: d.amount, currency: String(d.currency || '').toUpperCase() };
  },
  verifyWebhook(rawBody, headers) {
    const sig = headers['x-paystack-signature'];
    if (!this.key() || !sig || !rawBody) return false;
    return safeEqual(crypto.createHmac('sha512', this.key()).update(rawBody).digest('hex'), sig);
  }
};

// ---------------- Flutterwave ----------------
const flutterwave = {
  id: 'flutterwave',
  kind: 'fiat',
  label: 'Flutterwave (card, mobile money, bank, 30+ countries)',
  key: () => getSetting('flutterwave_secret_key'),
  enabled() { return !!this.key(); },
  supports(cur) { const l = currencyList('flutterwave_currencies'); return !l || l.includes(cur); },
  async api(method, endpoint, body) {
    if (!this.key()) throw httpError('Flutterwave is not set up.', 503);
    const { data } = await call('https://api.flutterwave.com/v3' + endpoint, {
      method, headers: { Authorization: 'Bearer ' + this.key(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
    });
    if (data.status !== 'success') throw httpError(data.message || 'Flutterwave error');
    return data.data;
  },
  async init({ email, minor, currency, reference, callback, title }) {
    const d = await this.api('POST', '/payments', {
      tx_ref: reference, amount: toMajor(minor, currency), currency, redirect_url: callback,
      customer: { email }, customizations: { title: title || 'Digital Enviro' }
    });
    return { url: d.link };
  },
  async verify(reference) {
    const d = await this.api('GET', '/transactions/verify_by_reference?tx_ref=' + encodeURIComponent(reference));
    const cur = String(d.currency || '').toUpperCase();
    return { paid: d.status === 'successful', minor: toMinor(d.amount, cur), currency: cur };
  },
  verifyWebhook(rawBody, headers) {
    const h = headers['verif-hash'];
    const secret = getSetting('flutterwave_webhook_hash');
    return !!(secret && h && safeEqual(h, secret));
  }
};

// ---------------- Stripe (one-off and recurring card payments) ----------------
const stripe = {
  id: 'stripe',
  kind: 'fiat',
  label: 'Stripe (international cards, Apple Pay, Google Pay)',
  key: () => getSetting('stripe_secret_key'),
  enabled() { return !!this.key(); },
  supports(cur) { const l = currencyList('stripe_currencies'); return !l || l.includes(cur); },
  async api(method, endpoint, form) {
    if (!this.key()) throw httpError('Stripe is not set up.', 503);
    const { res, data } = await call('https://api.stripe.com/v1' + endpoint, {
      method,
      headers: { Authorization: 'Bearer ' + this.key(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form ? new URLSearchParams(form).toString() : undefined
    });
    if (!res.ok) throw httpError((data.error && data.error.message) || 'Stripe error');
    return data;
  },
  // recurring: 'week' | 'month' | 'year' creates a subscription that renews automatically
  async init({ email, minor, currency, reference, successUrl, cancelUrl, title, recurring }) {
    // Stripe needs 3-decimal currencies (KWD, BHD, ...) to end in 0
    const unit = decimals(currency) === 3 ? Math.ceil(minor / 10) * 10 : minor;
    const form = {
      mode: recurring ? 'subscription' : 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: email,
      client_reference_id: reference,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(unit),
      'line_items[0][price_data][product_data][name]': title || 'Digital Enviro payment',
      'metadata[reference]': reference
    };
    if (recurring) {
      form['line_items[0][price_data][recurring][interval]'] = recurring;
      form['subscription_data[metadata][reference]'] = reference;
    }
    const d = await this.api('POST', '/checkout/sessions', form);
    return { url: d.url, providerRef: d.id };
  },
  async verify(reference, providerRef) {
    if (!providerRef) throw httpError('Missing Stripe session.');
    const d = await this.api('GET', '/checkout/sessions/' + encodeURIComponent(providerRef));
    return { paid: d.payment_status === 'paid', minor: d.amount_total, currency: String(d.currency || '').toUpperCase(), subscriptionId: d.subscription || null };
  },
  async cancelSubscription(id) { return this.api('DELETE', '/subscriptions/' + encodeURIComponent(id)); },
  verifyWebhook(rawBody, headers) {
    const secret = getSetting('stripe_webhook_secret');
    const sig = headers['stripe-signature'];
    if (!secret || !sig || !rawBody) return false;
    const parts = Object.fromEntries(sig.split(',').map(p => p.split('=')));
    if (!parts.t || !parts.v1) return false;
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 600) return false; // replay protection
    return safeEqual(crypto.createHmac('sha256', secret).update(parts.t + '.' + rawBody.toString('utf8')).digest('hex'), parts.v1);
  }
};


// ---------------- PayPal (Checkout Orders v2 + Payouts) ----------------
const ZERO_DEC = new Set(['JPY', 'HUF', 'TWD']);
const paypal = {
  id: 'paypal',
  kind: 'fiat',
  label: 'PayPal (PayPal balance, cards)',
  _tok: null,
  base() { return getSetting('paypal_mode') === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com'; },
  enabled() { return !!(getSetting('paypal_client_id') && getSetting('paypal_client_secret')); },
  supports(cur) { const l = currencyList('paypal_currencies'); return !l || l.includes(cur); },
  async token() {
    if (this._tok && this._tok.exp > Date.now() + 30000 && this._tok.mode === getSetting('paypal_mode')) return this._tok.v;
    const basic = Buffer.from(getSetting('paypal_client_id') + ':' + getSetting('paypal_client_secret')).toString('base64');
    const { res, data } = await call(this.base() + '/v1/oauth2/token', { method: 'POST', headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    if (!res.ok || !data.access_token) throw httpError('PayPal sign-in failed. Check the client ID and secret in Admin > Payments.');
    this._tok = { v: data.access_token, exp: Date.now() + (data.expires_in || 300) * 1000, mode: getSetting('paypal_mode') };
    return this._tok.v;
  },
  async api(method, path, body, extra) {
    if (!this.enabled()) throw httpError('PayPal is not set up.', 503);
    const { res, data } = await call(this.base() + path, { method, headers: Object.assign({ Authorization: 'Bearer ' + await this.token(), 'Content-Type': 'application/json' }, extra || {}), body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw httpError((data.details && data.details[0] && data.details[0].description) || data.message || 'PayPal error');
    return data;
  },
  money(minor, cur) { return ZERO_DEC.has(cur) ? String(Math.round(minor / Math.pow(10, decimals(cur)))) : toMajor(minor, cur).toFixed(decimals(cur)); },
  async init({ minor, currency, reference, callback, cancelUrl, title }) {
    const d = await this.api('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{ custom_id: reference, invoice_id: reference, description: String(title || 'Digital Enviro payment').slice(0, 120), amount: { currency_code: currency, value: this.money(minor, currency) } }],
      payment_source: { paypal: { experience_context: { return_url: callback, cancel_url: cancelUrl || callback, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } } }
    }, { 'PayPal-Request-Id': reference });
    const link = (d.links || []).find(l => l.rel === 'payer-action' || l.rel === 'approve');
    if (!link) throw httpError('PayPal did not return a payment link.');
    return { url: link.href, providerRef: d.id };
  },
  // The buyer returns approved; we capture here (only once), then read the final amount from PayPal itself.
  async verify(reference, providerRef) {
    if (!providerRef) throw httpError('Missing PayPal order.');
    let o = await this.api('GET', '/v2/checkout/orders/' + encodeURIComponent(providerRef));
    if (o.status === 'APPROVED') o = await this.api('POST', '/v2/checkout/orders/' + encodeURIComponent(providerRef) + '/capture', {}, { 'PayPal-Request-Id': 'cap-' + reference });
    const cap = (((o.purchase_units || [])[0] || {}).payments || {}).captures || [];
    const done = cap.find(c => c.status === 'COMPLETED');
    if (o.status !== 'COMPLETED' || !done) return { paid: false };
    const cur = String(done.amount.currency_code).toUpperCase();
    return { paid: true, minor: ZERO_DEC.has(cur) ? Math.round(Number(done.amount.value) * Math.pow(10, decimals(cur))) : toMinor(done.amount.value, cur), currency: cur };
  },
  // Webhooks are checked by asking PayPal to verify the signature (needs the webhook ID from your PayPal app).
  async verifyWebhook(rawBody, headers) {
    const id = getSetting('paypal_webhook_id');
    if (!id || !rawBody || !headers['paypal-transmission-sig']) return false;
    try {
      const d = await this.api('POST', '/v1/notifications/verify-webhook-signature', {
        auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'], webhook_id: id, webhook_event: JSON.parse(rawBody.toString('utf8'))
      });
      return d.verification_status === 'SUCCESS';
    } catch (e) { return false; }
  },
  payoutsOn() { return this.enabled() && getSetting('paypal_payouts_enabled') === '1'; },
  // Automatic payout to a PayPal email (needs Payouts enabled on your PayPal business account)
  async payout({ email, minor, currency, reference, note }) {
    const d = await this.api('POST', '/v1/payments/payouts', {
      sender_batch_header: { sender_batch_id: reference, email_subject: 'You have a payout', email_message: 'Your payout from ' + (getSetting('site_name') || 'Digital Enviro') },
      items: [{ recipient_type: 'EMAIL', receiver: email, sender_item_id: reference, note: String(note || 'Payout').slice(0, 100), amount: { value: this.money(minor, currency), currency } }]
    });
    return { batch: d.batch_header && d.batch_header.payout_batch_id };
  }
};

// ---------------- Tap Payments (KNET, Kuwaiti dinar and Gulf currencies) ----------------
const tap = {
  id: 'tap',
  kind: 'fiat',
  label: 'KNET / cards in Kuwaiti dinar & Gulf currencies (Tap Payments)',
  key: () => getSetting('tap_secret_key'),
  enabled() { return !!this.key(); },
  supports(cur) { const l = currencyList('tap_currencies'); return !l || l.includes(cur); },
  async api(method, path, body) {
    if (!this.key()) throw httpError('Tap Payments is not set up.', 503);
    const { res, data } = await call('https://api.tap.company/v2' + path, { method, headers: { Authorization: 'Bearer ' + this.key(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw httpError((data.errors && data.errors[0] && data.errors[0].description) || data.message || 'Tap error');
    return data;
  },
  async init({ email, minor, currency, reference, callback, webhookUrl, title }) {
    const d = await this.api('POST', '/charges', {
      amount: toMajor(minor, currency), currency, threeDSecure: true, save_card: false, description: String(title || 'Digital Enviro payment').slice(0, 120),
      reference: { transaction: reference, order: reference }, receipt: { email: false, sms: false },
      customer: { first_name: 'Customer', email }, source: { id: 'src_all' }, post: { url: webhookUrl }, redirect: { url: callback }
    });
    if (!d.transaction || !d.transaction.url) throw httpError('Tap did not return a payment link.');
    return { url: d.transaction.url, providerRef: d.id };
  },
  async verify(reference, providerRef) {
    if (!providerRef) throw httpError('Missing Tap charge.');
    const d = await this.api('GET', '/charges/' + encodeURIComponent(providerRef));
    const cur = String(d.currency || '').toUpperCase();
    return { paid: d.status === 'CAPTURED' && !!(d.reference && d.reference.transaction === reference), minor: toMinor(d.amount, cur), currency: cur };
  },
  // Tap's post-back is only a nudge: we accept it for a charge we created and then re-read the charge from Tap before crediting anything.
  verifyWebhook(rawBody, headers, body) {
    const id = body && body.id;
    return !!(id && /^chg_/.test(String(id)) && (db.prepare('SELECT 1 FROM orders WHERE provider_ref=?').get(String(id)) || db.prepare('SELECT 1 FROM tips WHERE provider_ref=?').get(String(id))));
  }
};

// ---------------- Wise (automatic bank payouts in KWD and 40+ other currencies, paid from your Wise balance) ----------------
const wise = {
  id: 'wise',
  base() { return getSetting('wise_env') === 'sandbox' ? 'https://api.sandbox.transferwise.tools' : 'https://api.wise.com'; },
  enabled() { return !!(getSetting('wise_api_token') && getSetting('wise_profile_id')); },
  payoutsOn() { return this.enabled() && getSetting('wise_payouts_enabled') === '1'; },
  async api(method, path, body) {
    const { res, data } = await call(this.base() + path, { method, headers: { Authorization: 'Bearer ' + getSetting('wise_api_token'), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw httpError((data.errors && data.errors[0] && data.errors[0].message) || data.message || 'Wise error (' + res.status + ')');
    return data;
  },
  /** IBAN-based bank payout. Creates quote -> recipient -> transfer, then funds it from the Wise balance. */
  async payout({ iban, name, minor, currency, reference, swift }) {
    const profile = getSetting('wise_profile_id');
    const quote = await this.api('POST', '/v3/profiles/' + profile + '/quotes', { sourceCurrency: getSetting('wise_source_currency') || currency, targetCurrency: currency, targetAmount: toMajor(minor, currency), payOut: 'BANK_TRANSFER' });
    const acct = await this.api('POST', '/v1/accounts', { profile: Number(profile), accountHolderName: name, currency, type: 'iban', ownedByCustomer: false, details: { legalType: 'PRIVATE', iban: String(iban).replace(/\s+/g, '').toUpperCase(), ...(swift ? { bic: swift } : {}) } });
    const tr = await this.api('POST', '/v1/transfers', { targetAccount: acct.id, quoteUuid: quote.id, customerTransactionId: crypto.randomUUID(), details: { reference: String(reference).slice(0, 30) } });
    await this.api('POST', '/v3/profiles/' + profile + '/transfers/' + tr.id + '/payments', { type: 'BALANCE' });
    return { id: String(tr.id) };
  },
  async status(id) { const t = await this.api('GET', '/v1/transfers/' + encodeURIComponent(id)); return t.status; }
};

// ---------------- NOWPayments (crypto, 300+ coins, hosted invoice) ----------------
const sortKeys = o => Array.isArray(o) ? o.map(sortKeys) : (o && typeof o === 'object')
  ? Object.keys(o).sort().reduce((a, k) => { a[k] = sortKeys(o[k]); return a; }, {}) : o;

const nowpayments = {
  id: 'nowpayments',
  kind: 'crypto',
  label: 'Crypto - Bitcoin, USDT, ETH and 300+ coins (NOWPayments)',
  key: () => getSetting('nowpayments_api_key'),
  enabled() { return !!this.key(); },
  supports(cur) { const l = currencyList('nowpayments_currencies'); return !l || l.includes(cur); },
  async init({ minor, currency, reference, successUrl, cancelUrl, title, webhookUrl }) {
    const { res, data } = await call('https://api.nowpayments.io/v1/invoice', {
      method: 'POST', headers: { 'x-api-key': this.key(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ price_amount: toMajor(minor, currency), price_currency: currency.toLowerCase(), order_id: reference, order_description: title || 'Digital Enviro payment', ipn_callback_url: webhookUrl, success_url: successUrl, cancel_url: cancelUrl })
    });
    if (!res.ok || !data.invoice_url) throw httpError(data.message || 'NOWPayments error');
    return { url: data.invoice_url, providerRef: String(data.id || '') };
  },
  // NOWPayments confirms by signed IPN callback; the order is finalised from the webhook
  async verify() { return { paid: false, pending: true }; },
  verifyWebhook(rawBody, headers, body) {
    const secret = getSetting('nowpayments_ipn_secret');
    const sig = headers['x-nowpayments-sig'];
    if (!secret || !sig || !body) return false;
    return safeEqual(crypto.createHmac('sha512', secret).update(JSON.stringify(sortKeys(body))).digest('hex'), sig);
  }
};

// ---------------- BTCPay Server (self-hosted, non-custodial crypto) ----------------
const btcpay = {
  id: 'btcpay',
  kind: 'crypto',
  label: 'Crypto - Bitcoin, Lightning and more (BTCPay Server)',
  cfg() { return { url: String(getSetting('btcpay_url') || '').replace(/\/+$/, ''), store: getSetting('btcpay_store_id'), key: getSetting('btcpay_api_key') }; },
  enabled() { const c = this.cfg(); return !!(c.url && c.store && c.key); },
  supports(cur) { const l = currencyList('btcpay_currencies'); return !l || l.includes(cur); },
  async api(method, path, body) {
    const c = this.cfg();
    const { res, data } = await call(c.url + '/api/v1' + path, { method, headers: { Authorization: 'token ' + c.key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw httpError(data.message || 'BTCPay error');
    return data;
  },
  async init({ email, minor, currency, reference, successUrl, title }) {
    const d = await this.api('POST', '/stores/' + encodeURIComponent(this.cfg().store) + '/invoices', {
      amount: String(toMajor(minor, currency)), currency, metadata: { orderId: reference, itemDesc: title || 'Digital Enviro payment', buyerEmail: email },
      checkout: { redirectURL: successUrl, redirectAutomatically: false }
    });
    return { url: d.checkoutLink, providerRef: d.id };
  },
  async verify(reference, providerRef) {
    if (!providerRef) throw httpError('Missing BTCPay invoice.');
    const d = await this.api('GET', '/stores/' + encodeURIComponent(this.cfg().store) + '/invoices/' + encodeURIComponent(providerRef));
    const cur = String(d.currency || '').toUpperCase();
    return { paid: d.status === 'Settled', minor: toMinor(d.amount, cur), currency: cur };
  },
  payoutsOn() { return this.enabled() && getSetting('btcpay_payouts_enabled') === '1'; },
  // Automatic crypto payout: create the payout in BTCPay and approve it; BTCPay's payout processor then sends it from your store wallet.
  async payout({ address, minor, currency, reference }) {
    const store = encodeURIComponent(this.cfg().store);
    const method = getSetting('btcpay_payout_method') || 'BTC-CHAIN';
    const p = await this.api('POST', '/stores/' + store + '/payouts', { destination: address, amount: String(toMajor(minor, currency)), payoutMethodId: method, metadata: { reference } });
    await this.api('POST', '/stores/' + store + '/payouts/' + encodeURIComponent(p.id), { revision: p.revision || 0, rateRule: 'kraken(BTC_' + currency + ')' });
    return { id: p.id };
  },
  verifyWebhook(rawBody, headers) {
    const secret = getSetting('btcpay_webhook_secret');
    const sig = headers['btcpay-sig'];
    if (!secret || !sig || !rawBody) return false;
    return safeEqual('sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), sig);
  }
};

// ---------------- Direct to the owner: manual bank transfer / manual crypto ----------------
const receivingAccounts = (type, cur) => db.prepare("SELECT * FROM receiving_accounts WHERE active=1 AND type=? AND (currency IS NULL OR currency='' OR currency=?) ORDER BY id").all(type, cur || '');
const manualAllowed = purpose => getSetting('manual_for_all') === '1' || purpose === 'creator_fee';

const manualBank = {
  id: 'manual_bank', kind: 'manual', manual: true,
  label: 'Bank transfer to the site owner (confirmed by the owner)',
  enabled() { return getSetting('manual_bank_enabled') === '1'; },
  supports(cur, purpose) { return manualAllowed(purpose) && receivingAccounts('bank', cur).length > 0; },
  accounts: cur => receivingAccounts('bank', cur)
};
const manualCrypto = {
  id: 'manual_crypto', kind: 'manual', manual: true,
  label: 'Crypto sent to the site owner wallet (confirmed by the owner)',
  enabled() { return getSetting('manual_crypto_enabled') === '1'; },
  supports(cur, purpose) { return manualAllowed(purpose) && receivingAccounts('crypto', cur).length > 0; },
  accounts: cur => receivingAccounts('crypto', cur)
};

const all = { paystack, flutterwave, stripe, paypal, tap, nowpayments, btcpay, manual_bank: manualBank, manual_crypto: manualCrypto };

/** Is this currency one the site owner accepts at all? (Admin > Payments > accepted currencies) */
function accepts(cur) {
  const l = currencyList('accepted_currencies');
  return !l || l.includes(String(cur).toUpperCase());
}

/** Providers that are configured AND accept this currency (and purpose, for manual methods). */
function forCurrency(cur, purpose) {
  if (!accepts(cur)) return [];
  return Object.values(all).filter(p => p.enabled() && p.supports(cur, purpose));
}

function describe() {
  return Object.values(all).filter(p => p.enabled()).map(p => ({ id: p.id, label: p.label, kind: p.kind }));
}

module.exports = { wise, all, forCurrency, describe, accepts, httpError, receivingAccounts, currencyList };
