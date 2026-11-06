/* Dropshipping: seller hub (store setup, platforms, products, orders) and the public storefront */
(function () {
  const { esc } = DE;
  const STATUS = { awaiting_payment: 'Awaiting payment', paid: 'Paid', processing: 'Being made', shipped: 'Shipped', delivered: 'Delivered', needs_attention: 'Needs attention', refund_needed: 'Refund needed', failed: 'Failed', cancelled: 'Cancelled', awaiting_supplier: 'With supplier', held: 'Held' };
  const pill = s => '<span class="pill ' + ({ delivered: 'ok', shipped: 'ok', processing: 'warn', paid: 'warn', needs_attention: 'bad', refund_needed: 'bad', failed: 'bad' }[s] || '') + '">' + esc(STATUS[s] || s) + '</span>';
  const copy = t => { try { navigator.clipboard.writeText(t); DE.toast('Copied!'); } catch (e) { prompt('Copy this link', t); } };

  // =========================================================== seller hub
  DE.route('/dropship', async view => {
    DE.title('My store');
    const tab = DE.query().tab || 'store';
    const [st, ps] = await Promise.all([DE.get('/dropship/store'), DE.get('/pod/status')]);
    const s = st.store;
    if (!s) return setup(view, ps);
    const links = st.links;
    view.innerHTML = '<div class="row between wrap"><h1>' + esc(s.brand_name) + '</h1><div class="row"><a class="btn" href="/s/' + esc(s.slug) + '" target="_blank" rel="noopener">View my store ↗</a></div></div>' +
      '<div class="card"><h3>Your store link</h3><p class="muted small">Share it anywhere: social media, WhatsApp, business cards. Anyone can open it in a browser, no account needed.</p><div class="row wrap"><code class="grow mono" style="word-break:break-all">' + esc(links.url) + '</code><button class="btn sm" id="cp1">Copy</button><button class="btn sm" id="sh">Share</button></div>' +
      (links.short_url ? '<div class="row wrap" style="margin-top:6px"><code class="grow mono">' + esc(links.short_url) + '</code><button class="btn sm" id="cp2">Copy</button></div>' : '') + '</div>' +
      '<div class="tabs">' + [['store', 'Settings'], ['products', 'Products'], ['orders', 'Orders']].map(t => '<a class="tab ' + (tab === t[0] ? 'on' : '') + '" href="/dropship?tab=' + t[0] + '">' + t[1] + '</a>').join('') + '</div><div id="tabBody"></div>';
    DE.$('#cp1').onclick = () => copy(links.url); const c2 = DE.$('#cp2'); if (c2) c2.onclick = () => copy(links.short_url);
    DE.$('#sh').onclick = () => { if (navigator.share) navigator.share({ title: s.brand_name, url: links.url }).catch(() => {}); else copy(links.url); };
    const body = DE.$('#tabBody');
    if (tab === 'products') return products(body, s, ps);
    if (tab === 'orders') return orders(body);
    settings(body, s, ps, links);
  }, { auth: true });

  function platformOptions(ps, sel) {
    return '<option value="all"' + (sel === 'all' ? ' selected' : '') + '>All platforms — the app picks the best one for each product and delivery country</option>' + ps.platforms.map(p => '<option value="' + p.id + '"' + (sel === p.id ? ' selected' : '') + '>' + esc(p.label) + '</option>').join('');
  }

  function setup(view, ps) {
    view.innerHTML = '<h1>Open your store</h1><form class="card" id="f"><p class="muted">Sell printed and ready-made products with your own brand. Orders are taken from your customers, produced and delivered to them automatically. You never touch the goods.</p>' +
      '<label class="f">Brand name</label><input class="i" id="bn" maxlength="60" required><label class="f">Store address</label><div class="row"><span class="muted">/s/</span><input class="i grow" id="sl" maxlength="30" placeholder="your-brand"></div><div class="small" id="slm"></div>' +
      '<label class="f">Tagline</label><input class="i" id="tg" maxlength="140"><div class="two"><div><label class="f">Brand colour</label><input class="i" type="color" id="co" value="#2fd89a"></div><div><label class="f">Support email</label><input class="i" id="se" type="email"></div></div>' +
      '<label class="f">Which dropshipping platform should produce and ship your products?</label><select class="i" id="pm">' + platformOptions(ps, 'all') + '</select>' +
      (ps.platforms.length ? '' : '<div class="warnbox card small">No platform is switched on yet. The site owner needs to connect one before you can add products.</div>') +
      '<div class="err" id="err"></div><button class="btn primary" style="margin-top:14px">Create my store</button></form>';
    slugWatch(DE.$('#sl'), DE.$('#slm'), DE.$('#bn'));
    DE.$('#f').onsubmit = async e => { e.preventDefault(); try { await DE.put('/dropship/store', { brand_name: DE.$('#bn').value, slug: DE.$('#sl').value, tagline: DE.$('#tg').value, color: DE.$('#co').value, support_email: DE.$('#se').value, dropship_mode: DE.$('#pm').value }); DE.toast('Store created! Now add your logo.'); DE.render(); } catch (ex) { DE.$('#err').textContent = ex.message; } };
  }

  function slugWatch(input, msg, brandInput) {
    let t;
    const check = async () => {
      const v = input.value.trim() || (brandInput ? brandInput.value : '');
      if (v.length < 3) { msg.textContent = ''; return; }
      try { const r = await DE.get('/dropship/store/slug-check?slug=' + encodeURIComponent(v)); msg.innerHTML = r.available ? '<span style="color:var(--ok)">✔ ' + esc(r.url) + ' is free</span>' : '<span style="color:var(--danger)">' + esc(r.problem) + '</span>' + (r.suggestions.length ? ' Try: ' + r.suggestions.map(x => '<a href="#" data-sg="' + esc(x) + '">' + esc(x) + '</a>').join(', ') : ''); DE.$$('[data-sg]', msg).forEach(a => a.onclick = ev => { ev.preventDefault(); input.value = a.dataset.sg; check(); }); } catch (e) { /* ignore */ }
    };
    input.oninput = () => { clearTimeout(t); t = setTimeout(check, 400); };
    if (brandInput) brandInput.oninput = () => { if (!input.value) { clearTimeout(t); t = setTimeout(check, 500); } };
  }

  function settings(body, s, ps, links) {
    body.innerHTML = '<form class="card" id="f"><h3>Brand</h3><div class="row wrap">' + (s.logo ? '<img src="' + esc(s.logo) + '" alt="" style="height:64px;border-radius:10px">' : '<span class="muted">No logo yet — required before you add products.</span>') + '<input type="file" id="lg" accept="image/*"></div>' +
      '<label class="f">Brand name</label><input class="i" id="bn" value="' + esc(s.brand_name) + '" maxlength="60"><label class="f">Store address (change once every 30 days; the old link keeps working)</label><div class="row"><span class="muted">/s/</span><input class="i grow" id="sl" value="' + esc(s.slug) + '" maxlength="30"></div><div class="small" id="slm"></div>' +
      '<label class="f">Tagline</label><input class="i" id="tg" value="' + esc(s.tagline || '') + '" maxlength="140"><div class="two"><div><label class="f">Brand colour</label><input class="i" type="color" id="co" value="' + esc(s.color || '#2fd89a') + '"></div><div><label class="f">Support email</label><input class="i" id="se" value="' + esc(s.support_email || '') + '"></div></div>' +
      '<label class="row" style="margin-top:8px"><input type="checkbox" id="ac"' + (s.active ? ' checked' : '') + '> Store is open</label><div class="err" id="err"></div><button class="btn primary" style="margin-top:12px">Save</button></form>' +
      '<div class="card"><h3>Dropshipping platform</h3><p class="muted small">Choose one platform for everything, or use all of them: for each product and delivery country the app asks every platform for the delivery price and time, then books the one that fits (cheapest or fastest). Your customers only see delivery options, never the platform.</p>' +
      '<select class="i" id="pm">' + platformOptions(ps, ps.mode) + '</select><label class="f">When using several platforms, prefer</label><select class="i" id="rt"><option value="cheapest"' + (ps.routing === 'cheapest' ? ' selected' : '') + '>Lowest cost</option><option value="fastest"' + (ps.routing === 'fastest' ? ' selected' : '') + '>Fastest delivery</option></select><button class="btn" id="pms" style="margin-top:10px">Save platform choice</button></div>' +
      '<div class="card"><h3>Platform fee</h3><p class="muted small">You pay the site owner after every ' + ps.fee.every + ' sales' + (ps.fee.enabled ? '' : ' (currently switched off)') + '. The fee is added to your “Fees” page.</p></div>';
    slugWatch(DE.$('#sl'), DE.$('#slm'));
    DE.$('#lg').onchange = async e => { const fd = new FormData(); fd.append('logo', e.target.files[0]); try { await DE.post('/dropship/store/logo', fd); DE.toast('Logo saved'); DE.render(); } catch (ex) { DE.fail(ex); } };
    DE.$('#f').onsubmit = async e => { e.preventDefault(); try { await DE.put('/dropship/store', { brand_name: DE.$('#bn').value, slug: DE.$('#sl').value, tagline: DE.$('#tg').value, color: DE.$('#co').value, support_email: DE.$('#se').value, active: DE.$('#ac').checked }); DE.toast('Saved'); DE.render(); } catch (ex) { DE.$('#err').textContent = ex.message; } };
    DE.$('#pms').onclick = e => DE.busy(e.target, async () => { await DE.put('/pod/settings', { mode: DE.$('#pm').value, routing: DE.$('#rt').value }); DE.toast('Saved'); });
  }

  // ---------- products ----------
  async function products(body, s, ps) {
    const list = await DE.get('/pod/listings');
    body.innerHTML = '<div class="row between"><h3>My products</h3><button class="btn primary" id="add">+ Add product</button></div>' +
      (list.length ? '<div class="grid">' + list.map(l => '<div class="card flat">' + ((l.mockups[0] || l.images[0]) ? '<img src="' + esc(l.mockups[0] || l.images[0]) + '" alt="" style="width:100%;border-radius:10px;max-height:160px;object-fit:cover">' : '') + '<b>' + esc(l.title) + '</b><div class="muted small">' + l.variants.length + ' options · from ' + DE.money(Math.min(...l.variants.map(v => v.price)), l.currency) + '</div><div class="small muted">' + esc(l.sources.map(x => x.label).join(' + ')) + '</div>' +
        '<div class="row wrap" style="margin-top:8px"><a class="btn sm" href="/s/' + esc(s.slug) + '/p/' + l.id + '" target="_blank">View</a><button class="btn sm" data-price="' + l.id + '">Prices</button><button class="btn sm" data-src="' + l.id + '">+ Platform</button><button class="btn sm danger" data-del="' + l.id + '">Remove</button></div></div>').join('') + '</div>' : '<div class="card empty">No products yet. Add your first one.</div>');
    DE.$('#add').onclick = () => { if (!s.logo) return DE.toast('Upload your logo in Settings first.', true); if (!ps.platforms.length) return DE.toast('No dropshipping platform is connected yet.', true); catalogue(ps, null, () => DE.render()); };
    DE.$$('[data-del]').forEach(b => b.onclick = async () => { if (await DE.confirm('Remove this product from your store?', 'Remove')) { await DE.del('/pod/listings/' + b.dataset.del); DE.render(); } });
    DE.$$('[data-src]').forEach(b => b.onclick = () => catalogue(ps, list.find(x => String(x.id) === b.dataset.src), () => DE.render()));
    DE.$$('[data-price]').forEach(b => b.onclick = () => { const l = list.find(x => String(x.id) === b.dataset.price);
      DE.modal('<h2>Prices</h2><div class="tablewrap"><table><tr><th>Option</th><th>Your price (' + esc(l.currency) + ')</th></tr>' + l.variants.map(v => '<tr><td>' + esc(v.name) + '</td><td><input class="i" style="width:110px" type="number" step="any" data-k="' + esc(v.key) + '" value="' + (v.price / Math.pow(10, DE.decimals(l.currency))) + '"></td></tr>').join('') + '</table></div><div class="err" id="err"></div><div class="row" style="margin-top:12px"><button class="btn primary" id="ok">Save prices</button><button class="btn" data-close>Cancel</button></div>', (m, close) => {
        m.querySelector('#ok').onclick = async () => { try { await DE.put('/pod/listings/' + l.id, { prices: DE.$$('[data-k]', m).map(i => ({ key: i.dataset.k, price: i.value })) }); close(); DE.render(); } catch (ex) { m.querySelector('#err').textContent = ex.message; } };
      }); });
  }

  // Catalogue browser: pick a platform, browse, choose a product, sizes/colours, design, price
  function catalogue(ps, existing, done) {
    const mode = ps.mode;
    const avail = existing ? ps.platforms.filter(p => !existing.sources.some(x => x.provider === p.id) && (existing.kind === p.kind)) : ps.platforms.filter(p => mode === 'all' || p.id === mode);
    if (!avail.length) return DE.toast('No other platform can be added here.', true);
    let prov = avail[0].id, cat = '', q = '', design = null;
    const close = DE.modal('<h2>' + (existing ? 'Add a platform to “' + esc(existing.title) + '”' : 'Add a product') + '</h2><div class="tabs" id="pt">' + avail.map(p => '<button class="tab" data-p="' + p.id + '">' + esc(p.label) + '</button>').join('') + '</div><p class="muted small" id="about"></p>' +
      '<div class="row"><select class="i" id="cat" style="max-width:220px"></select><input class="i grow" id="q" placeholder="Search products"></div><div id="list" class="grid" style="margin-top:10px"></div><div id="detail"></div>', m => {
      const $ = s => m.querySelector(s);
      const about = () => { const p = avail.find(x => x.id === prov); $('#about').textContent = p ? p.about || '' : ''; DE.$$('#pt .tab', m).forEach(t => t.classList.toggle('on', t.dataset.p === prov)); };
      async function loadCats() { try { const c = await DE.get('/pod/catalog/' + prov + '/categories'); $('#cat').innerHTML = '<option value="">All categories</option>' + (c || []).map(x => '<option value="' + esc(x.id) + '">' + esc(x.title || x.name) + '</option>').join(''); } catch (e) { $('#cat').innerHTML = '<option value="">All</option>'; } }
      async function loadList() {
        $('#list').innerHTML = '<div class="spinner"></div>'; $('#detail').innerHTML = '';
        try { const r = await DE.get('/pod/catalog/' + prov + '/products?category=' + encodeURIComponent(cat) + '&q=' + encodeURIComponent(q)); $('#list').innerHTML = r.length ? r.map(p => '<button class="card flat" data-id="' + esc(p.id) + '" style="text-align:left">' + (p.image ? '<img src="' + esc(p.image) + '" alt="" loading="lazy" style="width:100%;height:110px;object-fit:contain">' : '') + '<div class="small"><b>' + esc(p.title) + '</b></div><div class="muted small">' + esc(p.type || '') + (p.from ? ' · from ' + esc(p.from) : '') + '</div></button>').join('') : '<p class="muted">Nothing found.</p>'; DE.$$('[data-id]', m).forEach(b => b.onclick = () => pick(b.dataset.id)); }
        catch (e) { $('#list').innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }
      }
      async function pick(id, option) {
        $('#list').classList.add('hidden');
        $('#detail').innerHTML = '<div class="spinner"></div>';
        let p; try { p = await DE.get('/pod/catalog/' + prov + '/products/' + encodeURIComponent(id) + (option ? '?option=' + option : '')); } catch (e) { $('#detail').innerHTML = '<p class="err">' + esc(e.message) + '</p><button class="btn" id="back">Back</button>'; $('#back').onclick = () => { $('#list').classList.remove('hidden'); $('#detail').innerHTML = ''; }; return; }
        const pod = p.platform.kind === 'pod';
        if (p.options && !option) { $('#detail').innerHTML = '<h3>' + esc(p.title) + '</h3><p class="muted small">Choose who prints and ships it:</p>' + p.options.map(o => '<button class="card flat row" data-o="' + o.id + '" style="width:100%;text-align:left"><b class="grow">' + esc(o.title) + '</b><span class="muted small">' + esc(o.location) + '</span></button>').join(''); DE.$$('[data-o]', m).forEach(b => b.onclick = () => pick(id, b.dataset.o)); return; }
        const cur = p.currency || 'USD';
        const places = p.placements ? Object.entries(p.placements) : [];
        $('#detail').innerHTML = '<h3>' + esc(p.title) + '</h3><p class="small muted">' + esc((p.description || '').slice(0, 300)) + '</p>' +
          (existing ? '' : '<label class="f">Title in your store</label><input class="i" id="ti" value="' + esc(p.title) + '" maxlength="120">') +
          (pod ? '<label class="f">Your logo / design (PNG, at least 800px)</label>' + (existing ? '<div class="small muted">Using the design already on this product.</div>' : '<input type="file" class="i" id="ds" accept="image/png,image/jpeg"><div id="dsm" class="small"></div>') + (places.length ? '<label class="f">Print position</label><select class="i" id="pl">' + places.map(x => '<option value="' + esc(x[0]) + '">' + esc(x[1]) + '</option>').join('') + '</select>' : '') + (existing ? '' : '<label class="f">Design size on product: <span id="scv">60</span>%</label><input type="range" id="sc" min="10" max="100" value="60">' + (p.label_inside ? '<label class="row"><input type="checkbox" id="il"> Put my brand label inside the garment (+' + esc(DE.money(p.label_inside.price, cur)) + ' each)</label>' : '')) : '') +
          '<label class="f">Sizes / colours to sell</label><div class="row wrap small"><button class="btn sm" id="selall">Select all</button><button class="btn sm" id="selnone">None</button></div><div id="vs" style="max-height:200px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:6px">' + p.variants.map(v => '<label class="row small"><input type="checkbox" value="' + esc(v.id) + '"> ' + esc(v.name) + (v.cost != null ? ' <span class="muted">cost ' + esc(DE.money(v.cost, cur)) + '</span>' : '') + '</label>').join('') + '</div>' +
          (existing ? '' : '<label class="f">Profit markup on cost (%)</label><input class="i" type="number" id="mk" value="' + (ps.default_markup || 60) + '" min="1" max="1000"><div class="small muted">You can set exact prices per option afterwards.</div>') +
          '<div class="err" id="err"></div><div class="row" style="margin-top:12px"><button class="btn primary" id="go">' + (existing ? 'Add platform' : 'Add to my store') + '</button><button class="btn" id="back">Back</button></div>';
        DE.$$('#vs input', m).slice(0, 3).forEach(i => (i.checked = true));
        $('#selall').onclick = () => DE.$$('#vs input', m).forEach(i => (i.checked = true)); $('#selnone').onclick = () => DE.$$('#vs input', m).forEach(i => (i.checked = false));
        $('#back').onclick = () => { $('#list').classList.remove('hidden'); $('#detail').innerHTML = ''; };
        const sc = $('#sc'); if (sc) sc.oninput = () => ($('#scv').textContent = sc.value);
        const ds = $('#ds'); if (ds) ds.onchange = async () => { const fd = new FormData(); fd.append('design', ds.files[0]); $('#dsm').textContent = 'Uploading…'; try { design = await DE.post('/pod/design', fd); $('#dsm').textContent = '✔ ' + design.width + '×' + design.height + ' uploaded'; } catch (ex) { design = null; $('#dsm').textContent = ex.message; } };
        $('#go').onclick = async e => {
          const ids = DE.$$('#vs input:checked', m).map(i => i.value);
          const source = { provider: prov, product_id: id, option: option ? { print_provider: option } : undefined, placement: $('#pl') ? $('#pl').value : undefined, variant_ids: ids };
          e.target.disabled = true; $('#err').textContent = '';
          try {
            if (existing) { const r = await DE.post('/pod/listings/' + existing.id + '/sources', source); DE.toast('Added. ' + r.matched + ' of ' + r.of + ' options matched.'); }
            else {
              if (pod && !design) throw new Error('Upload your design first.');
              await DE.post('/pod/listings', { sources: [source], title: $('#ti').value, markup_percent: $('#mk').value, design_url: design && design.url, design_w: design && design.width, design_h: design && design.height, scale: sc ? sc.value : 60, inside_label: !!($('#il') && $('#il').checked) });
              DE.toast('Product added!');
            }
            close(); done();
          } catch (ex) { $('#err').textContent = ex.message; e.target.disabled = false; }
        };
      }
      DE.$$('#pt .tab', m).forEach(t => t.onclick = async () => { prov = t.dataset.p; about(); await loadCats(); loadList(); });
      $('#cat').onchange = e => { cat = e.target.value; loadList(); };
      let tm; $('#q').oninput = e => { clearTimeout(tm); tm = setTimeout(() => { q = e.target.value; loadList(); }, 400); };
      about(); loadCats().then(loadList);
    });
  }

  // ---------- orders ----------
  async function orders(body) {
    const l = await DE.get('/dropship/orders');
    body.innerHTML = '<h3>Orders</h3>' + (l.length ? '<div class="card"><div class="tablewrap"><table><tr><th>Order</th><th>Product</th><th>Customer</th><th>Total</th><th>Status</th><th>Tracking</th><th>Your profit</th></tr>' + l.map(o => '<tr><td class="mono">' + esc(o.ref) + '</td><td>' + esc(o.product || '') + ' ×' + o.qty + '</td><td>' + esc(o.customer_name) + ' · ' + esc(o.country) + '</td><td>' + DE.money(o.total, o.currency) + '</td><td>' + pill(o.status) + (o.note ? '<div class="muted small">' + esc(o.note) + '</div>' : '') + '</td><td>' + (o.tracking_url ? '<a href="' + esc(o.tracking_url) + '" target="_blank" rel="noopener">' + esc(o.tracking_number || 'Track') + '</a>' : esc(o.tracking_number || '—')) + '</td><td>' + (o.settled ? 'Paid to wallet' : 'On delivery') + '</td></tr>').join('') + '</table></div></div>' : '<div class="card empty">No orders yet. Share your store link to get your first sale.</div>') +
      '<p class="muted small">When an order is paid, it is sent for production and delivery automatically. Your profit (price − production and delivery cost) is paid into your wallet once the parcel ships.</p>';
  }

  // =========================================================== public storefront
  const brandCss = s => (s.color ? '--brand:' + s.color : '');
  const storeHead = s => '<div class="storehead" style="' + brandCss(s) + '"><a href="/s/' + esc(s.slug) + '" class="row">' + (s.logo ? '<img src="' + esc(s.logo) + '" alt="" style="height:48px;border-radius:10px">' : '') + '<div><h1 style="margin:0">' + esc(s.brand_name) + '</h1>' + (s.tagline ? '<div class="muted">' + esc(s.tagline) + '</div>' : '') + '</div></a></div>';
  const minPrice = p => Math.min(...p.variants.map(v => v.price));

  DE.route('/s/:slug', async (view, p) => {
    const r = await DE.get('/store/' + encodeURIComponent(p.slug));
    DE.title(r.store.brand_name);
    const items = r.printed.map(x => ({ href: '/s/' + r.store.slug + '/p/' + x.id, title: x.title, img: x.images[0], price: DE.money(minPrice(x), x.currency) }))
      .concat(r.listings.map(x => ({ href: '/s/' + r.store.slug + '/p/s' + x.id, title: x.title, img: (x.images || [])[0], price: DE.money(x.price, x.currency) })));
    view.innerHTML = storeHead(r.store) + (items.length ? '<div class="grid" style="margin-top:16px">' + items.map(i => '<a class="card flat" href="' + i.href + '" style="color:inherit">' + (i.img ? '<img src="' + esc(i.img) + '" alt="' + esc(i.title) + '" loading="lazy" style="width:100%;height:180px;object-fit:cover;border-radius:10px">' : '') + '<b>' + esc(i.title) + '</b><div>' + i.price + '</div></a>').join('') + '</div>' : '<div class="card empty">This store has no products yet.</div>') +
      '<p class="muted small center" style="margin-top:20px">Delivered worldwide · Secure payment' + (r.store.support_email ? ' · <a href="mailto:' + esc(r.store.support_email) + '">Contact us</a>' : '') + '</p>';
  });

  DE.route('/s/:slug/p/:id', async (view, p) => {
    if (/^s\d+$/.test(p.id)) return supplierProduct(view, p);
    const r = await DE.get('/store/' + encodeURIComponent(p.slug) + '/pod/' + encodeURIComponent(p.id));
    const pr = r.product, s = r.store;
    DE.title(pr.title + ' – ' + s.brand_name);
    let variant = pr.variants[0], qty = 1, quote = null;
    const colors = [...new Set(pr.variants.map(v => v.color).filter(Boolean))], sizes = [...new Set(pr.variants.map(v => v.size).filter(Boolean))];
    view.innerHTML = storeHead(s) + '<div class="two" style="margin-top:16px;align-items:start"><div class="card"><img id="mainimg" src="' + esc(pr.images[0] || variant.image || '') + '" alt="' + esc(pr.title) + '" style="width:100%;border-radius:12px">' + (pr.images.length > 1 ? '<div class="row wrap" style="margin-top:8px">' + pr.images.map(i => '<img class="thumb" src="' + esc(i) + '" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:8px;cursor:pointer">').join('') + '</div>' : '') + '</div>' +
      '<div class="card"><h1>' + esc(pr.title) + '</h1><div class="bal" id="pr"></div><p style="white-space:pre-wrap" class="muted">' + esc(pr.description || '') + '</p>' +
      (colors.length ? '<label class="f">Colour</label><select class="i" id="cl">' + colors.map(c => '<option>' + esc(c) + '</option>').join('') + '</select>' : '') + (sizes.length ? '<label class="f">Size</label><select class="i" id="sz">' + sizes.map(c => '<option>' + esc(c) + '</option>').join('') + '</select>' : '') +
      (!colors.length && !sizes.length ? '<label class="f">Option</label><select class="i" id="vr">' + pr.variants.map(v => '<option value="' + esc(v.key) + '">' + esc(v.name) + '</option>').join('') + '</select>' : '') +
      '<label class="f">Quantity</label><input class="i" type="number" id="qt" min="1" max="20" value="1" style="max-width:100px">' +
      '<h3 style="margin-top:16px">Delivery</h3><form id="ck"><label class="f">Full name</label><input class="i" id="nm" required autocomplete="name"><div class="two"><div><label class="f">Email</label><input class="i" id="em" type="email" required autocomplete="email"></div><div><label class="f">Phone</label><input class="i" id="ph" type="tel" autocomplete="tel"></div></div>' +
      '<label class="f">Country</label>' + DE.countrySelect('co') + '<label class="f">Address</label><input class="i" id="a1" required autocomplete="address-line1"><input class="i" id="a2" placeholder="Apartment, suite (optional)" style="margin-top:6px"><div class="two"><div><label class="f">City</label><input class="i" id="ci" required></div><div><label class="f">State / region</label><input class="i" id="stt"></div></div><label class="f">Postal code</label><input class="i" id="zp" style="max-width:180px">' +
      '<div id="ship" class="stack" style="margin-top:10px"></div><div id="paym"></div><div class="err" id="err"></div><div id="sum" class="bal"></div><button class="btn primary block" id="pay" style="margin-top:10px" disabled>Choose country to see delivery</button></form></div></div>';
    const $ = s => DE.$(s);
    const cur = pr.currency;
    const pick = () => { const c = $('#cl') && $('#cl').value, z = $('#sz') && $('#sz').value; variant = $('#vr') ? pr.variants.find(v => v.key === $('#vr').value) : (pr.variants.find(v => (!colors.length || v.color === c) && (!sizes.length || v.size === z)) || pr.variants[0]); if (variant.image) $('#mainimg').src = variant.image; $('#pr').textContent = DE.money(variant.price, cur); };
    ['#cl', '#sz', '#vr'].forEach(s => $(s) && ($(s).onchange = () => { pick(); getQuote(); })); pick();
    DE.$$('.thumb').forEach(t => t.onclick = () => ($('#mainimg').src = t.src));
    $('#qt').onchange = () => { qty = Math.min(20, Math.max(1, parseInt($('#qt').value, 10) || 1)); getQuote(); };
    let qt;
    ['#co', '#a1', '#ci', '#stt', '#zp'].forEach(s => $(s).addEventListener('change', () => { clearTimeout(qt); qt = setTimeout(getQuote, 300); }));
    const addr = () => ({ line1: $('#a1').value, line2: $('#a2').value, city: $('#ci').value, state: $('#stt').value, postal: $('#zp').value });
    async function getQuote() {
      if (!$('#co').value) return;
      $('#ship').innerHTML = '<div class="muted small">Checking delivery options…</div>'; $('#pay').disabled = true; $('#err').textContent = '';
      try {
        quote = await DE.post('/store/' + encodeURIComponent(s.slug) + '/pod/' + pr.id + '/quote', { variant_key: variant.key, qty, country: $('#co').value, address: addr() });
        $('#ship').innerHTML = '<label class="f">Delivery method</label>' + quote.options.map((o, i) => '<label class="row card flat"><input type="radio" name="sh" value="' + esc(o.id) + '"' + (i === 0 ? ' checked' : '') + '><span class="grow">' + esc(o.name) + '<div class="muted small">' + (o.min_days ? o.min_days + '–' + o.max_days + ' days' : '') + '</div></span><b>' + DE.money(o.minor, quote.currency) + '</b></label>').join('');
        $('#paym').innerHTML = r.payment_methods.length > 1 ? '<label class="f">Pay with</label><select class="i" id="pv">' + r.payment_methods.map(m => '<option value="' + m.id + '">' + esc(m.label) + '</option>').join('') + '</select>' : '';
        const upd = () => { const o = quote.options.find(x => x.id === (DE.$('input[name=sh]:checked') || {}).value) || quote.options[0]; $('#sum').textContent = 'Total ' + DE.money(quote.item_total + o.minor, quote.currency); $('#pay').textContent = 'Pay ' + DE.money(quote.item_total + o.minor, quote.currency); $('#pay').disabled = false; };
        DE.$$('input[name=sh]').forEach(i => (i.onchange = upd)); upd();
      } catch (ex) { quote = null; $('#ship').innerHTML = ''; $('#err').textContent = ex.message; $('#pay').textContent = 'Not available'; }
    }
    $('#ck').onsubmit = async e => {
      e.preventDefault(); if (!quote) return;
      $('#pay').disabled = true;
      try {
        const x = await DE.post('/store/' + encodeURIComponent(s.slug) + '/pod/' + pr.id + '/checkout', { variant_key: variant.key, qty, country: $('#co').value, name: $('#nm').value, email: $('#em').value, phone: $('#ph').value, address: addr(), shipping_id: (DE.$('input[name=sh]:checked') || {}).value, provider: $('#pv') && $('#pv').value });
        DE.store.set('de_order_email', $('#em').value);
        location.href = x.authorization_url;
      } catch (ex) { $('#err').textContent = ex.message; $('#pay').disabled = false; }
    };
  });

  // supplier-listed (non print-on-demand) products keep the simple flow
  async function supplierProduct(view, p) {
    const id = p.id.slice(1);
    const r = await DE.get('/store/' + encodeURIComponent(p.slug) + '/product/' + id);
    const pr = r.product || r, s = r.store;
    DE.title(pr.title);
    view.innerHTML = storeHead(s) + '<div class="card"><h1>' + esc(pr.title) + '</h1><div class="bal">' + DE.money(pr.price, pr.currency) + '</div><p>' + esc(pr.description || '') + '</p><form id="ck"><label class="f">Name</label><input class="i" id="nm" required><label class="f">Email</label><input class="i" id="em" type="email" required><label class="f">Phone</label><input class="i" id="ph"><label class="f">Country</label>' + DE.countrySelect('co') + '<label class="f">Address</label><input class="i" id="a1" required><div class="two"><div><label class="f">City</label><input class="i" id="ci" required></div><div><label class="f">Postal code</label><input class="i" id="zp"></div></div><div class="err" id="err"></div><button class="btn primary block" style="margin-top:12px">Pay ' + DE.money(pr.price, pr.currency) + '</button></form></div>';
    DE.$('#ck').onsubmit = async e => { e.preventDefault(); try { const x = await DE.post('/store/' + encodeURIComponent(p.slug) + '/checkout', { listing_id: id, qty: 1, name: DE.$('#nm').value, email: DE.$('#em').value, phone: DE.$('#ph').value, country: DE.$('#co').value, address: { line1: DE.$('#a1').value, city: DE.$('#ci').value, postal: DE.$('#zp').value } }); location.href = x.authorization_url; } catch (ex) { DE.$('#err').textContent = ex.message; } };
  }

  // order tracking page (customer, no account): /s/<slug>/order/<ref>?email=
  DE.route('/s/:slug/order/:ref', async (view, p, q) => {
    const email = q.email || DE.store.get('de_order_email') || '';
    DE.title('Your order');
    if (!email) { view.innerHTML = '<div class="card" style="max-width:420px;margin:30px auto"><h1>Track your order</h1><form id="f"><label class="f">Email used at checkout</label><input class="i" id="em" type="email" required><button class="btn primary" style="margin-top:10px">Show my order</button></form></div>'; DE.$('#f').onsubmit = e => { e.preventDefault(); DE.navigate(location.pathname + '?email=' + encodeURIComponent(DE.$('#em').value)); }; return; }
    const o = await DE.get('/store/order/' + encodeURIComponent(p.ref) + '?email=' + encodeURIComponent(email));
    const steps = ['paid', 'processing', 'shipped', 'delivered']; const at = steps.indexOf(o.status);
    view.innerHTML = storeHead({ slug: o.slug, brand_name: o.brand_name, logo: o.logo, color: o.color }) + '<div class="card" style="margin-top:16px"><h2>Order ' + esc(o.ref) + '</h2><p>' + esc(o.product || '') + ' ×' + o.qty + ' · ' + DE.money(o.total, o.currency) + '</p><p>' + pill(o.status) + '</p>' +
      (at >= 0 ? '<div class="steps">' + steps.map((x, i) => '<span class="step ' + (i <= at ? 'on' : '') + '">' + esc(STATUS[x]) + '</span>').join('') + '</div>' : '') +
      (o.tracking_url ? '<p><a class="btn primary" href="' + esc(o.tracking_url) + '" target="_blank" rel="noopener">Track parcel ' + esc(o.tracking_number || '') + (o.carrier ? ' (' + esc(o.carrier) + ')' : '') + '</a></p>' : '') +
      (o.status === 'awaiting_payment' ? '<p class="muted">We have not received your payment yet. If you just paid, refresh in a minute.</p>' : '') + (o.can_download ? '<a class="btn" href="/api/store/order/' + esc(o.ref) + '/download?email=' + encodeURIComponent(email) + '">Download your file</a>' : '') + '</div>';
  });
})();
