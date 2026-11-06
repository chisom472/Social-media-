/* Creator pages: directory, public page, create, and the in-built page builder */
(function () {
  const { esc } = DE;

  function embedUrl(u) {
    let m = String(u || '').match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/);
    if (m) return 'https://www.youtube-nocookie.com/embed/' + m[1];
    m = String(u || '').match(/vimeo\.com\/(\d+)/);
    if (m) return 'https://player.vimeo.com/video/' + m[1];
    return null;
  }

  function renderBlock(b) {
    const t = esc(b.text || '');
    switch (b.type) {
      case 'heading': return '<div class="block"><h' + (b.level || 2) + '>' + t + '</h' + (b.level || 2) + '></div>';
      case 'text': return '<div class="block" style="white-space:pre-wrap">' + t + '</div>';
      case 'quote': return '<div class="block"><blockquote>' + t + '</blockquote></div>';
      case 'code': return '<div class="block"><pre><code>' + t + '</code></pre></div>';
      case 'divider': return '<hr style="border:0;border-top:1px solid var(--line);margin:20px 0">';
      case 'image': return b.url ? '<figure class="block" style="margin:14px 0"><img src="' + esc(b.url) + '" alt="' + esc(b.caption || '') + '" style="width:100%;border-radius:12px" loading="lazy">' + (b.caption ? '<figcaption class="muted small">' + esc(b.caption) + '</figcaption>' : '') + '</figure>' : '';
      case 'video': return b.url ? '<div class="block"><video src="' + esc(b.url) + '" controls preload="metadata" style="width:100%;border-radius:12px"></video></div>' : '';
      case 'audio': return b.url ? '<div class="block"><div>' + esc(b.caption || '') + '</div><audio src="' + esc(b.url) + '" controls style="width:100%"></audio></div>' : '';
      case 'link': return b.url ? '<div class="block"><a href="' + esc(b.url) + '" target="_blank" rel="noopener noreferrer nofollow">🔗 ' + esc(b.label || b.url) + '</a></div>' : '';
      case 'button': return b.url ? '<div class="block"><a class="btn primary" href="' + esc(b.url) + '" target="_blank" rel="noopener noreferrer nofollow" data-external>' + esc(b.label || 'Open') + '</a></div>' : '';
      case 'embed': { const e = embedUrl(b.url); return e ? '<div class="block"><iframe src="' + e + '" allowfullscreen loading="lazy" title="Embedded video"></iframe></div>' : ''; }
    }
    return '';
  }

  DE.route('/pages', async (view, p, q) => {
    DE.title('Creator pages');
    const list = await DE.get('/pages' + (q.category ? '?category=' + encodeURIComponent(q.category) : ''));
    view.innerHTML = '<div class="row between"><h1>Creator pages</h1>' + (DE.user ? '<a class="btn primary" href="/create-page">+ Create my page</a>' : '') + '</div>' +
      '<div class="chips" style="margin-bottom:14px"><span class="chip' + (!q.category ? ' on' : '') + '" data-c="">All</span>' + DE.config.categories.map(c => '<span class="chip' + (q.category === c ? ' on' : '') + '" data-c="' + esc(c) + '">' + esc(c) + '</span>').join('') + '</div>' +
      (list.length ? '<div class="grid">' + list.map(g => '<a class="card" href="/p/' + esc(g.slug) + '" style="color:inherit"><div class="cover" style="height:110px;margin-bottom:10px;' + (g.cover ? 'background-image:url(' + esc(g.cover) + ')' : '') + '"></div><b>' + esc(g.name) + '</b><div class="muted small">' + esc(g.category || '') + ' · ' + g.followers + ' followers</div><div class="small" style="margin-top:6px">' + esc((g.description || '').slice(0, 90)) + '</div></a>').join('') + '</div>' : '<div class="card empty">No creator pages yet. Be the first!</div>');
    DE.$$('.chip', view).forEach(c => c.onclick = () => DE.navigate('/pages' + (c.dataset.c ? '?category=' + encodeURIComponent(c.dataset.c) : '')));
  });

  DE.route('/p/:slug', async (view, p) => {
    const pg = await DE.get('/pages/' + encodeURIComponent(p.slug));
    DE.title(pg.name);
    const owner = { id: pg.owner_id, username: pg.username, following: pg.is_following };
    view.innerHTML = '<div class="cover" style="' + (pg.cover ? 'background-image:url(' + esc(pg.cover) + ')' : '') + '"></div>' +
      '<div class="card" style="margin-top:-30px;position:relative"><div class="row wrap">' + DE.avatar({ avatar: pg.avatar, username: pg.username, display_name: pg.display_name }, 'lg') +
      '<div class="grow"><h1 style="margin:0">' + esc(pg.name) + '</h1><div class="muted">by <a href="/u/' + esc(pg.username) + '">@' + esc(pg.username) + '</a>' + (pg.category ? ' · ' + esc(pg.category) : '') + ' · ' + pg.followers + ' followers</div><p>' + esc(pg.description) + '</p></div>' +
      '<div class="row wrap">' + (pg.is_owner ? '<a class="btn primary" href="/edit-page">Edit page</a>' : DE.followBtn(owner) + (DE.user ? '<button class="btn amber" data-act="support" data-username="' + esc(pg.username) + '">💚 Support</button><button class="btn" id="pmsg">💬 Message</button>' : '')) + '</div></div></div>' +
      (pg.active ? '' : '<div class="card" style="border-color:var(--amber)"><b>This page is inactive.</b> The creator subscription has expired.</div>') +
      '<div class="card">' + (pg.blocks.map(renderBlock).join('') || '<p class="muted">This creator has not added content yet.</p>') + '</div>' +
      (pg.products.length ? '<h2>Shop</h2><div class="grid">' + pg.products.map(pr => '<a class="card" href="/product/' + pr.id + '" style="color:inherit"><b>' + esc(pr.title) + '</b><div class="muted small">' + esc(pr.kind) + '</div><div style="margin-top:8px;font-weight:800;color:var(--brand)">' + (pr.price ? DE.money(pr.price, pr.currency) : 'Free') + '</div></a>').join('') + '</div>' : '') +
      '<h2 style="margin-top:20px">Latest from @' + esc(pg.username) + '</h2><div id="posts"></div>';
    const pm = DE.$('#pmsg'); if (pm) pm.onclick = async () => { const r = await DE.post('/chat/dm/' + pg.username); DE.navigate('/chat/' + r.id); };
    const posts = await DE.get('/posts/user/' + encodeURIComponent(pg.username));
    DE.$('#posts').innerHTML = posts.length ? posts.slice(0, 10).map(x => DE.postCard(x)).join('') : '<div class="card empty">No posts yet.</div>';
    DE.observeViews(DE.$('#posts'));
  });

  DE.route('/create-page', async view => {
    DE.title('Create your creator page');
    const info = await DE.get('/pages/mine/info');
    if (info.page) return DE.navigate('/edit-page', true);
    const gate = info.fee_required && !info.active;
    view.innerHTML = '<div class="card" style="max-width:600px;margin:20px auto"><h1>Create your creator page</h1><p class="muted">Show your work with built-in content tools, sell services & digital products, and get supported by your followers.</p>' +
      (gate ? '<div class="card flat" style="border-color:var(--amber)"><b>Creator access: ' + DE.money(info.fee_amount, info.fee_currency) + ' for ' + info.fee_days + ' days</b><p class="small muted">Pay once to unlock your page and creator tools for ' + info.fee_days + ' days. Renew any time.</p><button class="btn amber" id="payFee">Pay ' + DE.money(info.fee_amount, info.fee_currency) + ' with card / bank</button></div>' : '') +
      '<form id="f"' + (gate ? ' style="opacity:.5;pointer-events:none"' : '') + '><label class="f">Page name</label><input class="i" name="name" required maxlength="80" placeholder="e.g. Chisom Codes">' +
      '<label class="f">Main topic</label>' + DE.categorySelect('cat', '', true) + '<label class="f">Short description</label><textarea class="i" name="description" maxlength="500"></textarea>' +
      '<div class="err" id="err"></div><button class="btn primary block" style="margin-top:14px">Create page</button></form></div>';
    const pf = DE.$('#payFee'); if (pf) pf.onclick = e => DE.busy(e.target, () => DE.checkout({ purpose: 'creator_fee' }));
    DE.$('#f').onsubmit = async e => {
      e.preventDefault();
      try { const r = await DE.post('/pages', { name: e.target.name.value, category: DE.$('#cat').value, description: e.target.description.value }); DE.user.is_creator = true; DE.navigate('/edit-page'); }
      catch (ex) { DE.$('#err').textContent = ex.message; }
    };
  }, { auth: true });

  // ---------- Page builder ----------
  DE.route('/edit-page', async view => {
    DE.title('Edit my page');
    const info = await DE.get('/pages/mine/info');
    if (!info.page) return DE.navigate('/create-page', true);
    const page = info.page;
    let blocks = page.blocks || [];

    const BLOCKS = [['heading', 'Heading'], ['text', 'Text'], ['image', 'Picture'], ['video', 'Video'], ['audio', 'Audio'], ['embed', 'YouTube/Vimeo'], ['link', 'Link'], ['button', 'Button'], ['quote', 'Quote'], ['code', 'Code'], ['divider', 'Divider']];

    function editorFor(b, i) {
      const move = '<div class="row" style="margin-top:6px"><button class="btn sm" data-mv="up" data-i="' + i + '">↑</button><button class="btn sm" data-mv="down" data-i="' + i + '">↓</button><button class="btn sm danger" data-mv="del" data-i="' + i + '">Remove</button></div>';
      let body = '';
      if (['heading', 'text', 'quote', 'code'].includes(b.type)) body = '<textarea class="i" data-f="text" data-i="' + i + '" placeholder="' + b.type + '...">' + esc(b.text || '') + '</textarea>';
      else if (['image', 'video', 'audio'].includes(b.type)) body = (b.url ? '<div class="small muted">Uploaded: ' + esc(b.url) + '</div>' : '') + '<input type="file" class="i" data-up="' + i + '" accept="' + b.type + '/*"><input class="i" data-f="caption" data-i="' + i + '" placeholder="Caption (optional)" value="' + esc(b.caption || '') + '" style="margin-top:6px">';
      else if (['link', 'button'].includes(b.type)) body = '<input class="i" data-f="label" data-i="' + i + '" placeholder="Label" value="' + esc(b.label || '') + '"><input class="i" data-f="url" data-i="' + i + '" placeholder="https://..." value="' + esc(b.url || '') + '" style="margin-top:6px">';
      else if (b.type === 'embed') body = '<input class="i" data-f="url" data-i="' + i + '" placeholder="Paste a YouTube or Vimeo link" value="' + esc(b.url || '') + '">';
      else body = '<div class="muted small">A divider line</div>';
      return '<div class="editor-block"><b class="small" style="color:var(--brand)">' + esc(b.type.toUpperCase()) + '</b>' + body + move + '</div>';
    }

    function draw() {
      DE.$('#blocks').innerHTML = blocks.map(editorFor).join('') || '<div class="empty">Add your first block below.</div>';
    }

    view.innerHTML = '<div id="editRoot"><div class="row between wrap"><h1>Edit my page</h1><div class="row"><a class="btn" href="/p/' + esc(page.slug) + '">View page</a><button class="btn primary" id="save">Save changes</button></div></div>' +
      '<div class="card"><h2>Subscription</h2>' + (info.fee_required ? '<p>' + (info.active ? 'Active until <b>' + esc(info.paid_until || '') + '</b>' : '<b style="color:var(--amber)">Expired</b>') + ' · ' + DE.money(info.fee_amount, info.fee_currency) + ' per ' + info.fee_days + ' days</p><button class="btn amber" id="renew">' + (info.active ? 'Extend' : 'Renew') + ' now</button>' : '<p class="muted">Creator pages are free right now.</p>') + '</div>' +
      '<div class="card"><h2>Page details</h2><label class="f">Page name</label><input class="i" id="pn" value="' + esc(page.name) + '" maxlength="80"><label class="f">Topic</label>' + DE.categorySelect('pc', page.category, true) + '<label class="f">Description</label><textarea class="i" id="pd" maxlength="500">' + esc(page.description) + '</textarea>' +
      '<label class="f">Cover picture</label><input type="file" class="i" id="cover" accept="image/*"><div class="err" id="coverErr"></div></div>' +
      '<div class="card"><h2>Content builder</h2><p class="muted small">Add pictures, videos, songs, text, links and buttons. Use the arrows to reorder.</p><div id="blocks"></div>' +
      '<div class="chips" style="margin-top:12px">' + BLOCKS.map(b => '<span class="chip" data-add="' + b[0] + '">+ ' + b[1] + '</span>').join('') + '</div></div>' +
      '<div class="card"><h2>Sell on your page</h2><p class="muted">Sell services, courses, templates, ebooks, software or any digital product. Buyers pay by card or bank, you withdraw to any bank.</p><a class="btn primary" href="/sell">+ Add a product or service</a> <a class="btn" href="/library">My products & sales</a></div></div>';
    const root = DE.$('#editRoot');
    draw();

    root.addEventListener('input', e => {
      const f = e.target.dataset.f; if (!f) return;
      blocks[+e.target.dataset.i][f] = e.target.value;
    });
    root.addEventListener('click', e => {
      const add = e.target.closest('[data-add]');
      if (add) { const type = add.dataset.add; blocks.push(type === 'heading' ? { type, text: '', level: 2 } : { type }); draw(); return; }
      const mv = e.target.closest('[data-mv]');
      if (!mv) return;
      const i = +mv.dataset.i;
      if (mv.dataset.mv === 'del') blocks.splice(i, 1);
      else if (mv.dataset.mv === 'up' && i > 0) [blocks[i - 1], blocks[i]] = [blocks[i], blocks[i - 1]];
      else if (mv.dataset.mv === 'down' && i < blocks.length - 1) [blocks[i + 1], blocks[i]] = [blocks[i], blocks[i + 1]];
      draw();
    });
    root.addEventListener('change', async e => {
      if (e.target.id === 'cover' && e.target.files[0]) {
        const fd = new FormData(); fd.append('media', e.target.files[0]); fd.append('as', 'cover');
        DE.$('#coverErr').textContent = '';
        try { await DE.post('/pages/' + page.slug + '/media', fd); DE.toast('Cover updated'); } catch (ex) { DE.$('#coverErr').textContent = ex.message; }
      }
      const up = e.target.dataset && e.target.dataset.up;
      if (up != null && e.target.files[0]) {
        const fd = new FormData(); fd.append('media', e.target.files[0]);
        DE.toast('Uploading...');
        try { const r = await DE.post('/pages/' + page.slug + '/media', fd); blocks[+up].url = r.url; draw(); DE.toast('Uploaded'); } catch (ex) { DE.fail(ex); e.target.value = ''; }
      }
    });
    DE.$('#save').onclick = e => DE.busy(e.target, async () => {
      await DE.put('/pages/' + page.slug, { name: DE.$('#pn').value, category: DE.$('#pc').value, description: DE.$('#pd').value, blocks });
      DE.toast('Page saved');
    }).catch(() => {});
    const rn = DE.$('#renew'); if (rn) rn.onclick = e => DE.busy(e.target, () => DE.checkout({ purpose: 'creator_fee' }));
  }, { auth: true });
})();
