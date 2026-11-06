/* Marketplace: browse, product page, sell, library (purchases & sales) */
(function () {
  const { esc } = DE;
  const KINDS = { digital: 'Digital product', service: 'Service', course: 'Course', ebook: 'Ebook', template: 'Template', software: 'Software / app', media: 'Media (photos, video, music)', other: 'Other' };

  DE.route('/market', async (view, p, q) => {
    DE.title('Marketplace: digital products & services');
    const qs = new URLSearchParams(); ['category', 'kind', 'q'].forEach(k => q[k] && qs.set(k, q[k]));
    const list = await DE.get('/market?' + qs.toString());
    view.innerHTML = '<div class="row between wrap"><h1>Marketplace</h1>' + (DE.user ? '<a class="btn primary" href="/sell">+ Sell something</a>' : '<a class="btn" href="/login">Log in to sell</a>') + '</div>' +
      '<p class="muted">Digital products and services from creators around the world. Sellers get paid in their own currency, to their own bank.</p>' +
      '<div class="row wrap" style="margin:10px 0"><select class="i" id="mk" style="width:auto"><option value="">All types</option>' + Object.keys(KINDS).map(k => '<option value="' + k + '"' + (q.kind === k ? ' selected' : '') + '>' + KINDS[k] + '</option>').join('') + '</select>' +
      '<select class="i" id="mc" style="width:auto"><option value="">All topics</option>' + DE.config.categories.map(c => '<option' + (q.category === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>' +
      (list.length ? '<div class="grid">' + list.map(x => '<a class="card" href="/product/' + x.id + '" style="color:inherit"><span class="tag">' + esc(KINDS[x.kind] || x.kind) + '</span><h3 style="margin:8px 0 4px">' + esc(x.title) + '</h3><div class="muted small">by @' + esc(x.username) + '</div><div class="small" style="margin:6px 0">' + esc((x.description || '').slice(0, 90)) + '</div><div style="font-weight:800;color:var(--brand)">' + (x.price ? DE.money(x.price, x.currency) : 'Free') + '</div></a>').join('') + '</div>' : '<div class="card empty">Nothing here yet.</div>');
    const go = () => DE.navigate('/market?kind=' + encodeURIComponent(DE.$('#mk').value) + '&category=' + encodeURIComponent(DE.$('#mc').value));
    DE.$('#mk').onchange = go; DE.$('#mc').onchange = go;
  });

  DE.route('/product/:id', async (view, p) => {
    const x = await DE.get('/market/' + p.id);
    DE.title(x.title);
    view.innerHTML = '<div class="card"><span class="tag">' + esc(KINDS[x.kind] || x.kind) + '</span>' + (x.members_only ? '<span class="tag">members only</span>' : '') + '<h1 style="margin:8px 0">' + esc(x.title) + '</h1>' +
      '<div class="muted">by <a href="/u/' + esc(x.username) + '">@' + esc(x.username) + '</a>' + (x.category ? ' · ' + esc(x.category) : '') + '</div>' +
      '<p style="white-space:pre-wrap">' + esc(x.description) + '</p><div class="bal" style="font-size:1.8rem">' + (x.price ? DE.money(x.price, x.currency) : 'Free') + '</div>' +
      '<div class="row wrap" style="margin-top:12px" id="actions"></div><div class="err" id="err"></div></div>';
    const a = DE.$('#actions');
    if (x.is_owner) a.innerHTML = '<span class="pill ok">Your product</span><button class="btn" id="toggle">' + (x.active ? 'Hide from market' : 'Show in market') + '</button><button class="btn danger" id="del">Delete</button>';
    else if (x.has_access) a.innerHTML = (x.downloadable ? '<button class="btn primary" id="dl">⬇ Download</button>' : '<span class="pill ok">You have access</span>') + '<a class="btn" href="/u/' + esc(x.username) + '">Contact seller</a>';
    else if (x.price > 0) a.innerHTML = '<button class="btn primary" id="buy">Buy now</button><span class="muted small">Pay by card or bank. Secure checkout.</span>';
    else a.innerHTML = '<a class="btn primary" href="/login">Log in to get this free</a>';

    const buy = DE.$('#buy');
    if (buy) {
      const prov = await DE.get('/pay/providers?currency=' + x.currency).catch(() => ({ providers: [] }));
      if (!prov.providers.length) { DE.$('#err').textContent = 'Payments in ' + x.currency + ' are not enabled yet.'; buy.disabled = true; }
      buy.onclick = () => {
        if (!DE.user) return DE.navigate('/login?next=' + encodeURIComponent(location.pathname));
        if (prov.providers.length > 1) {
          DE.modal('<h2>Choose how to pay</h2>' + prov.providers.map(pv => '<button class="btn block" style="margin:6px 0" data-pv="' + pv.id + '">' + esc(pv.label) + '</button>').join('') + '<button class="btn" data-close style="margin-top:8px">Cancel</button>', (m, close) => {
            DE.$$('[data-pv]', m).forEach(b => b.onclick = () => { close(); DE.checkout({ purpose: 'product', product_id: x.id, provider: b.dataset.pv }); });
          });
        } else DE.checkout({ purpose: 'product', product_id: x.id, provider: prov.providers[0].id });
      };
    }
    const dl = DE.$('#dl');
    if (dl) dl.onclick = () => DE.busy(dl, async () => {
      const res = await fetch('/api/market/' + x.id + '/download', { credentials: 'same-origin', headers: { 'X-Requested-With': 'DigitalEnviro' } });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Download failed'); }
      const blob = await res.blob(); const u = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = u; link.download = x.title; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(u), 5000);
    });
    const tg = DE.$('#toggle'); if (tg) tg.onclick = async () => { await DE.put('/market/' + x.id, { active: !x.active }); DE.render(); };
    const dd = DE.$('#del'); if (dd) dd.onclick = async () => { if (await DE.confirm('Delete this product?', 'Delete')) { await DE.del('/market/' + x.id); DE.navigate('/library'); } };
  });

  DE.route('/sell', async (view, p, q) => {
    DE.title('Sell a product or service');
    const mine = await DE.get('/groups/mine');
    const info = await DE.get('/pay/wallet');
    view.innerHTML = '<div class="card" style="max-width:640px;margin:10px auto"><h1>Sell a product or service</h1>' +
      (!(info.banks && info.banks.length) && !info.paypal ? '<div class="card flat" style="border-color:var(--amber)">💡 Add a bank, fintech, PayPal or crypto payout method in your <a href="/wallet">wallet</a> so you can withdraw your earnings - any bank, any country.</div>' : '') +
      '<form id="f"><label class="f">Title</label><input class="i" name="title" required maxlength="120" placeholder="e.g. React Mastery Course / Logo design service">' +
      '<label class="f">Type</label><select class="i" name="kind">' + Object.keys(KINDS).map(k => '<option value="' + k + '">' + KINDS[k] + '</option>').join('') + '</select>' +
      '<label class="f">Topic</label>' + DE.categorySelect('cat', '', true) +
      '<label class="f">Description</label><textarea class="i" name="description" maxlength="3000" placeholder="What does the buyer get?"></textarea>' +
      '<div class="row"><div style="flex:1"><label class="f">Price (0 = free)</label><input class="i" name="price" type="number" min="0" step="any" value="0"></div><div style="flex:1"><label class="f">Currency you want to be paid in</label>' + DE.currencySelect('cur') + '</div></div>' +
      '<label class="f">Where to list it</label><select class="i" name="group_id" id="grp"><option value="">My profile / page & the marketplace</option>' + mine.map(g => '<option value="' + g.id + '"' + (String(q.group) === String(g.id) ? ' selected' : '') + '>Community: ' + esc(g.name) + '</option>').join('') + '</select>' +
      '<label class="row" id="mo" style="margin-top:10px;display:none"><input type="checkbox" name="members_only" value="1"> <span class="small">Members only (outsiders cannot buy it)</span></label>' +
      '<label class="f">File to deliver (optional - ebook, zip, video, template... for services you can skip this)</label><input type="file" name="file" class="i">' +
      '<label class="f">Cover picture (optional)</label><input type="file" id="cover" accept="image/*" class="i">' +
      '<div class="err" id="err"></div><button class="btn primary block" style="margin-top:14px">Publish</button></form></div>';
    const grp = DE.$('#grp'); const mo = DE.$('#mo');
    const sync = () => (mo.style.display = grp.value ? 'flex' : 'none'); grp.onchange = sync; sync();
    DE.$('#f').onsubmit = async e => {
      e.preventDefault(); DE.$('#err').textContent = '';
      const fd = new FormData(e.target);
      fd.set('category', DE.$('#cat').value); fd.set('currency', DE.$('#cur').value);
      const f = fd.get('file'); if (!f || !f.size) fd.delete('file');
      try {
        const r = await DE.post('/market', fd);
        const c = DE.$('#cover').files[0];
        if (c) { const cf = new FormData(); cf.append('media', c); try { await DE.post('/market/' + r.id + '/cover', cf); } catch (ex) { DE.toast(ex.message, true); } }
        DE.toast('Published!'); DE.navigate('/product/' + r.id);
      } catch (ex) { DE.$('#err').textContent = ex.message; }
    };
  }, { auth: true });

  DE.route('/library', async view => {
    DE.title('My products, purchases & sales');
    const d = await DE.get('/market/mine');
    view.innerHTML = '<div class="row between wrap"><h1>My marketplace</h1><a class="btn primary" href="/sell">+ Sell something</a></div>' +
      '<div class="card"><h2>My products & services</h2>' + (d.products.length ? d.products.map(x => '<div class="row" style="padding:6px 0"><a class="grow" href="/product/' + x.id + '"><b>' + esc(x.title) + '</b></a><span class="muted small">' + (x.price ? DE.money(x.price, x.currency) : 'Free') + '</span><span class="pill ' + (x.active ? 'ok' : '') + '">' + (x.active ? 'live' : 'hidden') + '</span></div>').join('') : '<p class="muted">You have not listed anything yet.</p>') + '</div>' +
      '<div class="card"><h2>My sales</h2>' + (d.sales.length ? d.sales.map(x => '<div class="row" style="padding:6px 0"><div class="grow">' + esc(x.title) + ' <span class="muted small">to @' + esc(x.buyer) + ' · ' + DE.timeago(x.created_at) + '</span></div><b>' + DE.money(x.amount, x.currency) + '</b></div>').join('') : '<p class="muted">No sales yet.</p>') + '</div>' +
      '<div class="card"><h2>My purchases</h2>' + (d.purchases.length ? d.purchases.map(x => '<div class="row" style="padding:6px 0"><a class="grow" href="/product/' + x.product_id + '">' + esc(x.title) + ' <span class="muted small">from @' + esc(x.seller) + '</span></a><b>' + DE.money(x.amount, x.currency) + '</b></div>').join('') : '<p class="muted">You have not bought anything yet.</p>') + '</div>';
  }, { auth: true });
})();
