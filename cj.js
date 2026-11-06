// CJ Dropshipping adapter (https://developers.cjdropshipping.com): ready-made products (millions of items) shipped from
// CJ warehouses in China, the US, Europe and more. CJ is prepaid: orders are paid from the CJ account balance, which the
// owner tops up. CJ cannot print the seller's logo through the API, so the brand shows on the store, the checkout and
// the emails customers receive, not on the parcel.
const { http, fail, variantKey, usd, countryName, days } = require('./util');
const { getSetting } = require('../db');
const world = require('../world');

const BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
const enabled = () => getSetting('cj_enabled') === '1' && !!getSetting('cj_api_key');

let token = null; // { value, until }
async function accessToken() {
  if (token && token.until > Date.now()) return token.value;
  const r = await http('CJ Dropshipping', BASE + '/authentication/getAccessToken', { method: 'POST', body: { apiKey: getSetting('cj_api_key') } });
  const d = r.json && r.json.data;
  if (!r.ok || !d || !d.accessToken) throw Object.assign(new Error('CJ Dropshipping rejected the API key: ' + ((r.json && r.json.message) || r.status)), { status: 503 });
  token = { value: d.accessToken, until: Date.now() + 10 * 24 * 3600e3 };
  return token.value;
}
async function api(method, path, body, query) {
  const qs = query ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([, v]) => v != null && v !== ''))).toString() : '';
  const run = async () => http('CJ Dropshipping', BASE + path + qs, { method, headers: { 'CJ-Access-Token': await accessToken() }, body });
  let r = await run();
  if (r.json && (r.json.code === 1600001 || r.json.code === 1600003)) { token = null; r = await run(); } // token expired
  if (!r.ok || !r.json || r.json.result === false || (r.json.code && r.json.code !== 200)) throw fail('CJ Dropshipping', r, (r.json && r.json.message) || undefined);
  return r.json.data;
}

const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const data = await fn();
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return data;
}
const money = v => { const n = parseFloat(String(v).split(/[-~]/)[0]); return usd(n); };

module.exports = {
  id: 'cj', label: 'CJ Dropshipping', kind: 'general', draft: false,
  about: 'Millions of ready-made products (gadgets, fashion, home, beauty, pets and more) from warehouses in the US, Europe, China and other countries. The brand appears on your store, checkout and emails.',
  branding: { design: false, label: false, packing_slip: false }, mockup: false,
  enabled,
  webhookToken: () => '',

  categories: () => cached('cats', 6 * 3600e3, async () => {
    const out = [];
    (await api('GET', '/product/getCategory') || []).forEach(a => (a.categoryFirstList || []).forEach(b => (b.categorySecondList || []).forEach(c =>
      out.push({ id: c.categoryId, title: a.categoryFirstName + ' > ' + b.categorySecondName + ' > ' + c.categoryName }))));
    return out;
  }),
  async browse({ category, q, page }) {
    const d = await api('GET', '/product/list', null, { pageNum: parseInt(page, 10) || 1, pageSize: 30, categoryId: category, productNameEn: q });
    return ((d && d.list) || []).map(p => ({ id: p.pid, title: p.productNameEn || p.productName, type: p.categoryName || '', image: p.productImage, from: money(p.sellPrice) }));
  },
  async product(id) {
    const d = await api('GET', '/product/query', null, { pid: id });
    let imgs = []; try { imgs = JSON.parse(d.productImage); } catch (e) { imgs = d.productImage ? [d.productImage] : []; }
    return {
      id: d.pid, title: d.productNameEn || d.productName, description: String(d.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2000), image: imgs[0] || null, images: imgs.slice(0, 6),
      currency: 'USD', placements: null, label_inside: null, weight: d.productWeight || null,
      variants: (d.variants || []).map(v => {
        const parts = String(v.variantKey || v.variantNameEn || '').split(/[-/]/).map(s => s.trim()).filter(Boolean);
        const size = parts.find(s => /^(xxs|xs|s|m|l|xl|xxl|xxxl|\d+xl|\d{2}|one size)$/i.test(s)) || null;
        const color = parts.find(s => s !== size) || null;
        return { id: v.vid, name: v.variantNameEn || v.variantKey, size, color, color_code: null, image: v.variantImage || imgs[0] || null, cost: money(v.variantSellPrice) };
      })
    };
  },
  async prepare(src) { return src; },

  /** Countries whose CJ warehouse has this variant in stock (falls back to the owner's default list). */
  async origins(vid, qty) {
    const dflt = String(getSetting('cj_origin_countries') || 'CN').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    try {
      const st = await cached('stock:' + vid, 600e3, () => api('GET', '/product/stock/queryByVid', null, { vid }));
      const ok = (st || []).filter(s => (Number(s.totalInventoryNum != null ? s.totalInventoryNum : s.totalInventory) || 0) >= qty).map(s => String(s.countryCode || '').toUpperCase()).filter(Boolean);
      return ok.length ? [...new Set(ok)].slice(0, 4) : dflt.slice(0, 3);
    } catch (e) { return dflt.slice(0, 3); }
  },
  async rates({ variantId, qty, recipient }) {
    const out = [];
    for (const from of await this.origins(variantId, qty)) {
      try {
        const list = await api('POST', '/logistic/freightCalculate', { startCountryCode: from, endCountryCode: recipient.country_code, zip: recipient.zip, products: [{ quantity: qty, vid: variantId }] });
        (list || []).forEach(r => { const d = days(r.logisticAging);
          out.push({ id: from + '|' + r.logisticName, name: r.logisticName + (from !== 'CN' ? ' (ships from ' + countryName(from) + ')' : ''), minor: usd(r.totalPostageFee != null ? r.totalPostageFee : r.logisticPrice), currency: 'USD', min_days: d.min, max_days: d.max }); });
      } catch (e) { /* this warehouse cannot ship there */ }
    }
    return out;
  },
  async place({ order, variantId, qty, recipient, shipping }) {
    const [from, ...rest] = String(shipping).split('|');
    const d = await api('POST', '/shopping/order/createOrderV2', {
      orderNumber: order.ref.slice(0, 50), shippingCountryCode: recipient.country_code, shippingCountry: countryName(recipient.country_code),
      shippingProvince: recipient.state_code || recipient.city, shippingCity: recipient.city, shippingCustomerName: recipient.name,
      shippingAddress: recipient.address1, shippingAddress2: recipient.address2 || undefined, shippingZip: recipient.zip, shippingPhone: recipient.phone || '0000000000', email: recipient.email,
      logisticName: rest.join('|'), fromCountryCode: from, products: [{ vid: variantId, quantity: qty }], payType: 2 // pay from the CJ balance
    });
    const amount = d && (d.orderAmount != null ? d.orderAmount : d.actualPayment);
    return { id: String(d.orderId), capital: amount != null ? { minor: usd(amount), currency: 'USD' } : null };
  },
  confirm: async () => {}, // already paid from the balance when created
  async get(id) {
    const d = await api('GET', '/shopping/order/getOrderDetail', null, { orderId: id });
    const st = String(d.orderStatus || '').toUpperCase();
    return { state: st === 'CANCELLED' || st === 'CANCELED' ? 'canceled' : (st === 'SHIPPED' || st === 'DELIVERED' || d.trackNumber) ? 'shipped' : 'processing',
      tracking_number: d.trackNumber || null, tracking_url: d.trackNumber ? 'https://www.17track.net/en/track?nums=' + encodeURIComponent(d.trackNumber) : null, carrier: d.logisticName || null, reason: st };
  },
  cancel: async id => api('DELETE', '/shopping/order/deleteOrder', null, { orderId: id }),
  parseWebhook: () => ({ order_ref: null, provider_order_id: null })
};
