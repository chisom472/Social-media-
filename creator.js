/* Creator studio: overview, content, audience, earnings, fees, ads and shortcuts */
(function () {
  const { esc } = DE;
  const TABS = [['', 'Overview'], ['content', 'Content'], ['audience', 'Audience'], ['earnings', 'Earnings'], ['fees', 'Fees'], ['ads', 'Ads']];
  const SRC = { product: 'Digital products', group: 'Communities', class: 'Classes', support: 'Support from fans', reward_received: 'Rewards', dropship: 'Dropshipping', dropship_supply: 'Supplying', sale: 'Sales' };
  const nav = cur => '<div class="tabs">' + TABS.map(t => '<a class="tab ' + (cur === t[0] ? 'on' : '') + '" href="/creator' + (t[0] ? '/' + t[0] : '') + '">' + t[1] + '</a>').join('') + '</div>';
  const stat = (label, val, sub) => '<div class="stat"><div class="muted small">' + label + '</div><div class="bal">' + val + '</div>' + (sub ? '<div class="muted small">' + sub + '</div>' : '') + '</div>';
  const bars = (rows, label, val) => { const max = Math.max(1, ...rows.map(val)); return '<div class="bars">' + rows.map(r => '<div class="bar" title="' + esc(label(r)) + ': ' + val(r) + '"><i style="height:' + Math.max(3, val(r) / max * 100) + '%"></i></div>').join('') + '</div>'; };

  async function overview(view, days) {
    const o = await DE.get('/creator/overview?days=' + days);
    const total = o.income.map(i => DE.money(i.total, i.currency)).join(' + ') || DE.money(0);
    view.innerHTML = '<div class="row between wrap"><h1>Creator studio</h1><div class="row"><select class="i" id="days"><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select><a class="btn primary" href="/">+ Create post</a></div></div>' + nav('') +
      (o.todo.length ? '<div class="card"><h3>To do</h3>' + o.todo.map(t => '<a class="row" href="' + esc(t.link) + '" style="padding:6px 0;color:inherit">' + (t.urgent ? '🔴' : '🔹') + ' <span class="grow">' + esc(t.text) + '</span> ›</a>').join('') + '</div>' : '') +
      '<div class="grid">' + stat('Earned', total, o.days + ' days') + stat('Followers', o.followers.total, '+' + o.followers.gained + ' new') + stat('Views', o.content.views, o.content.published + ' posts published') + stat('Reactions', o.content.reactions, o.content.comments + ' comments') + '</div>' +
      '<div class="card"><h3>Wallet</h3>' + (o.wallet.map(w => '<span class="pill">' + DE.money(w.balance, w.currency) + '</span> ').join('') || '<span class="muted">Empty</span>') + (o.pending_withdrawals.length ? '<div class="muted small">Pending withdrawal: ' + o.pending_withdrawals.map(w => DE.money(w.total, w.currency)).join(', ') + '</div>' : '') + '<div class="row" style="margin-top:10px"><a class="btn" href="/wallet">Withdraw / manage money</a></div></div>' +
      '<div class="card"><h3>Where your money comes from</h3>' + (o.by_source.length ? o.by_source.map(s => '<div class="row" style="padding:4px 0"><span class="grow">' + esc(SRC[s.source] || s.source) + '</span><span class="muted small">' + s.n + '×</span><b>' + DE.money(s.total, s.currency) + '</b></div>').join('') : '<p class="muted">No earnings in this period yet.</p>') + '</div>' +
      '<div class="card"><h3>Top posts</h3>' + (o.top_posts.map(p => '<a class="row" href="/post/' + p.id + '" style="padding:6px 0;color:inherit"><span class="grow">' + esc(p.title || p.body || p.type) + '</span><span class="muted small">👁 ' + p.views + ' · ❤ ' + p.reactions + ' · 💬 ' + p.comments + '</span></a>').join('') || '<p class="muted">Post something to see how it performs.</p>') + '</div>' +
      '<div class="grid"><div class="card"><h3>Classes</h3>' + (o.classes.map(c => '<a class="row" href="/class/' + c.id + '" style="color:inherit;padding:4px 0"><span class="grow">' + esc(c.title) + '</span><span class="muted small">' + c.enrolled + ' enrolled</span></a>').join('') || '<p class="muted">None yet.</p>') + '<a class="btn sm" href="/classes/new">Host a class</a></div>' +
      '<div class="card"><h3>Communities</h3>' + (o.communities.map(c => '<a class="row" href="/community/' + c.id + '" style="color:inherit;padding:4px 0"><span class="grow">' + esc(c.name) + '</span><span class="muted small">' + c.members + ' members</span></a>').join('') || '<p class="muted">None yet.</p>') + '<a class="btn sm" href="/communities">Manage</a></div>' +
      '<div class="card"><h3>Products</h3><p>' + o.products.count + ' live · ' + o.products.sold + ' sold</p><a class="btn sm" href="/sell">Sell a product</a></div>' +
      '<div class="card"><h3>My page</h3>' + (o.page ? '<p><a href="/p/' + esc(o.page.slug) + '">' + esc(o.page.name) + '</a></p><a class="btn sm" href="/edit-page">Edit page</a>' : '<p class="muted">Create a creator page with your tools and links.</p><a class="btn sm primary" href="/create-page">Create page</a>') + '</div>' +
      '<div class="card"><h3>My store</h3>' + (o.store ? '<p>' + esc(o.store.brand_name || o.store.slug) + ' · ' + o.store.orders + ' orders</p><a class="btn sm" href="/dropship">Open store hub</a>' : '<p class="muted">Sell printed and ready-made products delivered worldwide, with your brand.</p><a class="btn sm primary" href="/dropship">Start a store</a>') + '</div></div>';
    DE.$('#days').value = days; DE.$('#days').onchange = e => overview(view, e.target.value);
  }

  DE.route('/creator', async view => { DE.title('Creator studio'); await overview(view, 30); }, { auth: true });

  DE.route('/creator/content', async view => {
    DE.title('My content');
    const type = DE.query().type || '';
    const rows = await DE.get('/creator/content' + (type ? '?type=' + type : ''));
    view.innerHTML = '<h1>Creator studio</h1>' + nav('content') + '<div class="chips">' + ['', 'text', 'image', 'video', 'audio', 'reel', 'story'].map(t => '<a class="chip ' + (type === t ? 'on' : '') + '" href="/creator/content' + (t ? '?type=' + t : '') + '">' + (t || 'all') + '</a>').join('') + '</div>' +
      '<div class="card">' + (rows.length ? '<div class="tablewrap"><table><tr><th>Post</th><th>Type</th><th>👁</th><th>❤</th><th>💬</th><th>When</th><th></th></tr>' + rows.map(p => '<tr><td><a href="/post/' + p.id + '">' + esc(p.title || p.body || '(media)') + '</a></td><td>' + p.type + '</td><td>' + p.views + '</td><td>' + p.reactions + '</td><td>' + p.comments + '</td><td>' + DE.timeago(p.created_at) + '</td><td><button class="icon-btn" data-act="delete-post" data-id="' + p.id + '" aria-label="Delete">🗑</button></td></tr>').join('') + '</table></div>' : '<p class="muted">Nothing posted yet.</p>') + '</div>';
  }, { auth: true });

  DE.route('/creator/audience', async view => {
    DE.title('My audience');
    const a = await DE.get('/creator/audience');
    view.innerHTML = '<h1>Creator studio</h1>' + nav('audience') +
      '<div class="card"><h3>New followers (30 days)</h3>' + (a.growth.length ? bars(a.growth, r => r.day, r => r.n) : '<p class="muted">No new followers yet.</p>') + '</div>' +
      '<div class="grid"><div class="card"><h3>Recent followers</h3>' + (a.recent.map(u => DE.userRow(u, false)).join('') || '<p class="muted">None yet.</p>') + '</div>' +
      '<div class="card"><h3>Where they live</h3>' + (a.countries.map(c => '<div class="row"><span class="grow">' + esc(c.name) + '</span><b>' + c.n + '</b></div>').join('') || '<p class="muted">No location data.</p>') + '</div>' +
      '<div class="card"><h3>Top supporters</h3>' + (a.supporters.map(s => '<div class="row"><a class="grow" href="/u/' + esc(s.username) + '">@' + esc(s.username) + '</a><b>' + DE.money(s.total, s.currency) + '</b></div>').join('') || '<p class="muted">None yet.</p>') + '</div>' +
      '<div class="card"><h3>Most engaged</h3>' + (a.top_viewers.map(s => '<div class="row"><a class="grow" href="/u/' + esc(s.username) + '">@' + esc(s.username) + '</a><span class="muted small">' + s.views + ' views</span></div>').join('') || '<p class="muted">None yet.</p>') + '</div></div>';
  }, { auth: true });

  DE.route('/creator/earnings', async view => {
    DE.title('My earnings');
    const e = await DE.get('/creator/earnings?days=90');
    view.innerHTML = '<h1>Creator studio</h1>' + nav('earnings') + '<div class="card"><h3>Last 90 days</h3>' + (e.daily.length ? bars(e.daily, r => r.day + ' ' + r.currency, r => r.total) : '<p class="muted">No earnings yet.</p>') + '</div>' +
      '<div class="card"><h3>Recent payments received</h3>' + (e.recent.length ? '<div class="tablewrap"><table><tr><th>When</th><th>From</th><th>Amount</th><th>Note</th></tr>' + e.recent.map(r => '<tr><td>' + DE.timeago(r.created_at) + '</td><td>' + esc(SRC[r.source] || r.source) + '</td><td style="color:var(--ok)">+' + DE.money(r.amount, r.currency) + '</td><td>' + esc(r.note || '') + '</td></tr>').join('') + '</table></div>' : '<p class="muted">Nothing yet.</p>') + '</div><a class="btn primary" href="/wallet">Open wallet</a>';
  }, { auth: true });

  DE.route('/creator/fees', async view => {
    DE.title('Fees');
    const f = await DE.get('/pay/fees');
    view.innerHTML = '<h1>Creator studio</h1>' + nav('fees') +
      (f.waived ? '<div class="card">✅ The site owner has waived your platform fees.</div>' : '') +
      '<div class="card"><h3>Due now</h3>' + (f.due.length ? f.due.map(i => '<div class="row" style="padding:8px 0"><span class="grow">' + esc(i.note || i.kind) + '<div class="muted small">' + (i.due_at ? 'Due ' + esc(String(i.due_at).slice(0, 10)) : '') + '</div></span><b>' + DE.money(i.amount, i.currency) + '</b><button class="btn sm primary" data-w="' + i.id + '">Pay from wallet</button><button class="btn sm" data-c="' + i.id + '">Pay online</button></div>').join('') : '<p class="muted">You do not owe anything.</p>') + '</div>' +
      '<div class="card"><h3>How fees work</h3><ul><li>Class hosting: ' + (f.class_fee.on ? esc(f.class_fee.mode) + ' (' + esc(f.class_fee.when) + ')' : 'not charged') + '</li><li>Creator subscription: ' + (f.creator_fee.required ? DE.money(f.creator_fee.amount, f.creator_fee.currency) + ' every ' + f.creator_fee.days + ' days (' + esc(f.creator_fee.timing) + ')' : 'not charged') + '</li>' + (f.sub_until ? '<li>Subscription paid until ' + esc(String(f.sub_until).slice(0, 10)) + '</li>' : '') + '</ul></div>' +
      '<div class="card"><h3>History</h3>' + (f.history.length ? '<div class="tablewrap"><table><tr><th>When</th><th>For</th><th>Amount</th><th>Status</th></tr>' + f.history.map(i => '<tr><td>' + DE.timeago(i.created_at) + '</td><td>' + esc(i.note || i.kind) + '</td><td>' + DE.money(i.amount, i.currency) + '</td><td><span class="pill ' + (i.status === 'paid' ? 'ok' : i.status === 'due' ? 'warn' : '') + '">' + esc(i.status) + '</span></td></tr>').join('') + '</table></div>' : '<p class="muted">No fees yet.</p>') + '</div>';
    DE.$$('[data-w]').forEach(b => b.onclick = () => DE.busy(b, async () => { await DE.post('/pay/fees/' + b.dataset.w + '/pay-wallet'); DE.toast('Paid'); DE.render(); }));
    DE.$$('[data-c]').forEach(b => b.onclick = () => DE.busy(b, () => DE.checkout({ purpose: 'owner_invoice', invoice_id: b.dataset.c })));
  }, { auth: true });

  DE.route('/creator/ads', async view => {
    DE.title('Advertising');
    const r = await DE.get('/ads/mine'); const p = r.pricing;
    view.innerHTML = '<h1>Creator studio</h1>' + nav('ads') +
      (p.enabled && p.self_serve ? '<div class="card"><h3>Promote something</h3><p class="muted small">' + (p.price_per_day ? DE.money(p.price_per_day, p.currency) + ' per day' : 'Free for now') + ' · up to ' + p.max_days + ' days · reviewed before going live</p><form id="af"><label class="f">Title</label><input class="i" name="title" maxlength="80" required><label class="f">Text</label><input class="i" name="body" maxlength="300"><label class="f">Link (https://)</label><input class="i" name="link_url" required>' +
        '<div class="two"><div><label class="f">Where</label><select class="i" name="placement">' + p.placements.map(x => '<option>' + x + '</option>').join('') + '</select></div><div><label class="f">Days</label><input class="i" type="number" name="days" min="1" max="' + p.max_days + '" value="7"></div></div>' +
        '<label class="f">Countries (codes like NG,GH — empty = everywhere)</label><input class="i" name="countries"><label class="f">Image or video</label><input class="i" type="file" name="media" accept="image/*,video/*"><div class="err" id="err"></div><button class="btn primary" style="margin-top:10px">Submit advert</button></form></div>' : '<div class="card muted">Advertising is not open right now.</div>') +
      '<div class="card"><h3>My adverts</h3>' + (r.ads.length ? '<div class="tablewrap"><table><tr><th>Title</th><th>Status</th><th>Views</th><th>Clicks</th><th></th></tr>' + r.ads.map(a => '<tr><td>' + esc(a.title) + '</td><td><span class="pill">' + esc(a.status) + '</span>' + (a.reject_reason ? ' <span class="muted small">' + esc(a.reject_reason) + '</span>' : '') + '</td><td>' + a.impressions + '</td><td>' + a.clicks + '</td><td>' + (a.status === 'pending_payment' ? '<button class="btn sm primary" data-pay="' + a.id + '">Pay</button>' : '') + '<button class="btn sm danger" data-del="' + a.id + '">Delete</button></td></tr>').join('') + '</table></div>' : '<p class="muted">No adverts yet.</p>') + '</div>';
    const f = DE.$('#af');
    if (f) f.onsubmit = async e => { e.preventDefault(); const fd = new FormData(f); if (!fd.get('media').size) fd.delete('media'); DE.$('#err').textContent = ''; try { const x = await DE.post('/ads', fd); if (x.needs_payment) return DE.checkout({ purpose: 'ad', ad_id: x.id }); DE.toast('Submitted for review'); DE.render(); } catch (ex) { DE.$('#err').textContent = ex.message; } };
    DE.$$('[data-pay]').forEach(b => b.onclick = () => DE.checkout({ purpose: 'ad', ad_id: b.dataset.pay }));
    DE.$$('[data-del]').forEach(b => b.onclick = async () => { if (await DE.confirm('Delete this advert?', 'Delete')) { await DE.del('/ads/' + b.dataset.del); DE.render(); } });
  }, { auth: true });
})();
