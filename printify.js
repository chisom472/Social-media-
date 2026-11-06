// Printify adapter (https://developers.printify.com): print-on-demand through a network of print providers worldwide
// (US, EU, UK, Canada, Australia, China ...). The owner connects one Printify shop of type "API / manual orders".
// Printify does not list prices in its catalogue, so a product is created in the shop when a listing is made, and the
// real production cost is read back from it.
const { http, fail, norm, variantKey, splitName } = require('./util');
const { getSetting } = require('../db');
const world = require('../world');

const BASE = 'https://api.printify.com/v1';
const enabled = () => getSetting('printify_enabled') === '1' && !!getSetting('printify_api_token');

async function api(method, path, body) {
  const token = getSetting('printify_api_token');
  if (!token) throw Object.assign(new Error('Printify is not connected yet.'), { status: 503 });
  const r = await http('Printify', BASE + path, { method, headers: { Authorization: 'Bearer ' + token }, body });
  if (!r.ok) throw fail('Printify', r, r.json && (r.json.errors ? JSON.stringify(r.json.errors).slice(0, 200) : r.json.error || r.json.message));
  return r.json;
}
let shopCache = null;
async function shopId() {
  const s = getSetting('printify_shop_id');
  if (s) return s;
  if (shopCache) return shopCache;
  const shops = await api('GET', '/shops.json');
  if (!shops.length) throw Object.assign(new Error('The Printify account has no shop. Create an "API" shop first.'), { status: 503 });
  return (shopCache = String(shops[0].id));
}

const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const data = await fn();
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return data;
}

const METHOD = { standard: 1, express: 2, priority: 3, printify_express: 3, economy: 4 };
const METHOD_NAME = { standard: 'Standard', express: 'Express', priority: 'Priority', printify_express: 'Express', economy: 'Economy' };
const addr = r => { const n = splitName(r.name); return { first_name: n.first, last_name: n.last, email: r.email, phone: r.phone, country: r.country_code, region: r.state_code || '', address1: r.address1, address2: r.address2 || '', city: r.city, zip: r.zip }; };

module.exports = {
  id: 'printify', label: 'Printify', kind: 'pod', draft: true, needsOption: 'print_provider',
  about: 'Print-on-demand through hundreds of independent print providers worldwide. Your design is printed on the product. (Printify cannot add your brand to the packing slip.)',
  branding: { design: true, label: false, packing_slip: false }, mockup: false,
  enabled,
  webhookToken: () => getSetting('printify_webhook_secret'),

  categories: async () => [],
  async browse({ q }) {
    const list = await cached('bp', 6 * 3600e3, async () => (await api('GET', '/catalog/blueprints.json')).map(b => ({ id: b.id, title: b.title, type: b.brand || b.model || '', image: (b.images || [])[0] || null })));
    const s = String(q || '').toLowerCase().trim();
    return (s ? list.filter(p => (p.title + ' ' + p.type).toLowerCase().includes(s)) : list).slice(0, 80);
  },
  /** First call (no option): blueprint + the print providers that can make it. Second call (option.print_provider): its variants. */
  async product(id, option) {
    const bp = await cached('bp:' + id, 3600e3, () => api('GET', '/catalog/blueprints/' + parseInt(id, 10) + '.json'));
    const out = { id: bp.id, title: bp.title, description: String(bp.description || '').replace(/<[^>]+>/g, ' ').slice(0, 1500), image: (bp.images || [])[0] || null, currency: 'USD', placements: { front: 'Front', back: 'Back' }, label_inside: null, variants: [] };
    const provs = await cached('pp:' + id, 3600e3, () => api('GET', '/catalog/blueprints/' + parseInt(id, 10) + '/print_providers.json'));
    out.options = provs.map(p => ({ id: p.id, title: p.title, location: [p.location && p.location.city, p.location && p.location.country].filter(Boolean).join(', ') }));
    if (!option || !option.print_provider) return out;
    const pid = parseInt(option.print_provider, 10);
    const v = await cached('v:' + id + ':' + pid, 1800e3, () => api('GET', '/catalog/blueprints/' + parseInt(id, 10) + '/print_providers/' + pid + '/variants.json'));
    out.variants = (v.variants || []).map(x => ({ id: x.id, name: x.title, size: (x.options || {}).size, color: (x.options || {}).color, color_code: null, image: null, cost: null }));
    const ph = ((v.variants || [])[0] || {}).placeholders || [];
    if (ph.length) out.placements = Object.fromEntries(ph.map(p => [p.position, p.position.replace(/_/g, ' ')]));
    return out;
  },

  /** Uploads the design and creates the product in the Printify shop so the real costs are known. */
  async prepare(src, { listing, chosen, designUrl }) {
    const shop = await shopId();
    const up = await api('POST', '/uploads/images.json', { file_name: 'design-' + Date.now() + '.png', url: designUrl });
    const ids = chosen.map(c => c.id);
    const p = await api('POST', '/shops/' + shop + '/products.json', {
      title: String(listing.title).slice(0, 100), description: 'Made to order', blueprint_id: parseInt(src.product_id, 10), print_provider_id: parseInt(src.option.print_provider, 10),
      variants: ids.map(id => ({ id, price: 9999, is_enabled: true })),
      print_areas: [{ variant_ids: ids, placeholders: [{ position: src.placement, images: [{ id: up.id, x: 0.5, y: 0.5, scale: Math.min(1, Math.max(0.1, listing.design_scale / 100)), angle: 0 }] }] }]
    });
    src.extra = { printify_product_id: p.id };
    const costs = {};
    (p.variants || []).forEach(v => { costs[v.id] = Math.round(Number(v.cost) || 0); });
    src.variants = Object.fromEntries(Object.entries(src.variants).map(([k, v]) => [k, { id: v.id, cost: costs[v.id] || 0, currency: 'USD' }]));
    if (Object.values(src.variants).some(v => !v.cost)) { await api('DELETE', '/shops/' + shop + '/products/' + p.id + '.json').catch(() => {}); throw Object.assign(new Error('Printify did not return the production cost for this product.'), { status: 502 }); }
    return src;
  },
  async cleanup(src) { if (src.extra && src.extra.printify_product_id) await api('DELETE', '/shops/' + (await shopId()) + '/products/' + src.extra.printify_product_id + '.json').catch(() => {}); },

  async rates({ src, variantId, qty, recipient }) {
    const r = await api('POST', '/shops/' + (await shopId()) + '/orders/shipping.json', { line_items: [{ product_id: src.extra.printify_product_id, variant_id: variantId, quantity: qty }], address_to: addr(recipient) });
    return Object.keys(METHOD).filter(k => r[k] != null && !(k === 'printify_express' && r.express != null)).map(k => ({ id: String(METHOD[k]), name: METHOD_NAME[k], minor: Math.round(Number(r[k])), currency: 'USD', min_days: null, max_days: null }));
  },
  async place({ order, src, variantId, qty, recipient, shipping }) {
    const shop = await shopId();
    const o = await api('POST', '/shops/' + shop + '/orders.json', {
      external_id: order.ref, label: order.ref, line_items: [{ product_id: src.extra.printify_product_id, variant_id: variantId, quantity: qty }],
      shipping_method: parseInt(shipping, 10) || 1, send_shipping_notification: false, address_to: addr(recipient)
    });
    const full = await api('GET', '/shops/' + shop + '/orders/' + o.id + '.json').catch(() => o);
    const total = (Number(full.total_price) || 0) + (Number(full.total_shipping) || 0) + (Number(full.total_tax) || 0);
    return { id: String(o.id), capital: total > 0 ? { minor: Math.round(total), currency: 'USD' } : null };
  },
  confirm: async id => api('POST', '/shops/' + (await shopId()) + '/orders/' + id + '/send_to_production.json'),
  async get(id) {
    const o = await api('GET', '/shops/' + (await shopId()) + '/orders/' + id + '.json');
    const sh = (o.shipments || [])[0] || {};
    return { state: o.status === 'canceled' ? 'canceled' : (o.status === 'fulfilled' || (o.shipments || []).length) ? 'shipped' : 'processing', tracking_number: sh.number || null, tracking_url: sh.url || null, carrier: sh.carrier || null, reason: o.status };
  },
  cancel: async id => api('POST', '/shops/' + (await shopId()) + '/orders/' + id + '/cancel.json'),
  parseWebhook: req => { const r = (req.body || {}).resource || {}; return { order_ref: null, provider_order_id: r.id ? String(r.id) : null }; },
  async setupWebhooks(url, token) {
    const shop = await shopId();
    const have = await api('GET', '/shops/' + shop + '/webhooks.json').catch(() => []);
    for (const w of have) if (/\/api\/pod\/webhook\/printify\//.test(w.url || '')) await api('DELETE', '/shops/' + shop + '/webhooks/' + w.id + '.json').catch(() => {});
    for (const topic of ['order:shipment:created', 'order:shipment:delivered', 'order:updated']) await api('POST', '/shops/' + shop + '/webhooks.json', { topic, url, secret: token });
  }
};
