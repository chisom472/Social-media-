// Printful adapter (print-on-demand, fulfilment centres worldwide). Uses ../printful.js for the raw API.
const pf = require('../printful');
const { getSetting } = require('../db');

const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const data = await fn();
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return data;
}

module.exports = {
  id: 'printful', label: 'Printful', kind: 'pod', draft: true,
  about: 'Print-on-demand with fulfilment centres in the US, Canada, Mexico, the UK, the EU, Australia, Japan and more. Your logo is printed on the product, inside labels and a branded packing slip are supported.',
  branding: { design: true, label: true, packing_slip: true }, mockup: true,
  enabled: () => pf.enabled(),
  webhookToken: () => getSetting('printful_webhook_token'),

  categories: () => cached('cats', 3600e3, async () => (await pf.categories()).map(c => ({ id: c.id, title: c.title }))),
  async browse({ category, q }) {
    const list = await cached('prods:' + (category || 0), 3600e3, async () => (await pf.products(category || null)).filter(p => !p.is_discontinued)
      .map(p => ({ id: p.id, title: p.title, type: p.type_name, image: p.image })));
    const s = String(q || '').toLowerCase().trim();
    return (s ? list.filter(p => (p.title + ' ' + (p.type || '')).toLowerCase().includes(s)) : list).slice(0, 80);
  },
  product: id => cached('prod:' + id, 1800e3, async () => {
    const [r, files] = await Promise.all([pf.product(id), pf.printfiles(id).catch(() => null)]);
    const cur = String(r.product.currency || 'USD').toUpperCase();
    const label = (r.product.files || []).find(f => f.type === 'label_inside');
    return {
      id: r.product.id, title: r.product.title, description: r.product.description, image: r.product.image, currency: cur,
      placements: files ? files.available_placements || {} : { front: 'Front' }, label_inside: label ? { price: pf.minor(label.additional_price, cur) } : null,
      variants: (r.variants || []).filter(v => v.in_stock !== false).map(v => ({ id: v.id, name: v.name, size: v.size, color: v.color, color_code: v.color_code, image: v.image, cost: pf.minor(v.price, cur) }))
    };
  }),
  // nothing to create up front: costs are already in the catalogue
  async prepare(src, ctx) { return src; },

  async rates({ src, variantId, qty, recipient, currency }) {
    const list = await pf.shippingRates({
      recipient: { address1: recipient.address1, city: recipient.city, country_code: recipient.country_code, state_code: recipient.state_code, zip: recipient.zip },
      items: [{ variant_id: variantId, quantity: qty }], currency: currency || 'USD'
    });
    return (Array.isArray(list) ? list : []).map(r => { const c = String(r.currency || currency || 'USD').toUpperCase();
      return { id: String(r.id), name: r.name, minor: pf.minor(r.rate, c), currency: c, min_days: r.minDeliveryDays || null, max_days: r.maxDeliveryDays || null }; });
  },

  async place({ order, src, variantId, qty, recipient, listing, store, designUrl, labelUrl, shipping, retailPrice }) {
    const area = await pf.printfileFor(src.product_id, variantId, src.placement);
    if (!area) throw Object.assign(new Error('No print area found for this product variant'), { status: 400 });
    const files = [{ type: src.placement, url: designUrl, position: pf.position(area, (listing.design_w || 1) / (listing.design_h || 1), listing.design_scale) }];
    if (listing.inside_label && labelUrl) files.push({ type: 'label_inside', url: labelUrl });
    const draft = await pf.createOrder({
      external_id: order.ref, shipping,
      recipient: { name: recipient.name, address1: recipient.address1, address2: recipient.address2, city: recipient.city, state_code: recipient.state_code, country_code: recipient.country_code, zip: recipient.zip, phone: recipient.phone, email: recipient.email },
      items: [{ variant_id: variantId, quantity: qty, retail_price: retailPrice, name: listing.title, files }],
      packing_slip: { email: store.support_email || undefined, store_name: store.brand_name, logo_url: labelUrl || undefined, message: 'Thank you for shopping with ' + store.brand_name + '!', custom_order_id: order.ref }
    }, false);
    return { id: String(draft.id), capital: pf.capitalOf(draft) };
  },
  confirm: id => pf.confirmOrder(id),
  async get(id) {
    const o = await pf.getOrder(id);
    const sh = (o.shipments || [])[0] || {};
    const st = String(o.status || '');
    return { state: st === 'canceled' ? 'canceled' : st === 'failed' ? 'failed' : (o.shipments || []).length ? 'shipped' : 'processing', tracking_number: sh.tracking_number || null, tracking_url: sh.tracking_url || null, carrier: sh.carrier || sh.service || null, reason: st };
  },
  cancel: id => pf.cancelOrder(id),
  parseWebhook: req => { const o = ((req.body || {}).data || {}).order || {}; return { order_ref: o.external_id || null, provider_order_id: o.id ? String(o.id) : null }; },
  setupWebhooks: url => pf.setupWebhooks(url),
  mockupTask: pf.mockupTask, mockupResult: pf.mockupResult, printfileFor: pf.printfileFor, position: pf.position
};
