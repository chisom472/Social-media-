/* Communities: browse, create (free or paid; knowledge / products / services), community home */
(function () {
  const { esc } = DE;
  const FOCUS = { knowledge: 'Knowledge sharing', products: 'Digital products', services: 'Services', mixed: 'Knowledge & products' };

  function focusSelect(id, sel) {
    return '<select class="i" id="' + id + '">' + Object.keys(FOCUS).map(k => '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + FOCUS[k] + '</option>').join('') + '</select>';
  }
  const badge = g => '<span class="pill ' + (g.price ? 'warn' : 'ok') + '">' + (g.price ? DE.money(g.price, g.currency) + ' to join' : 'Free to join') + '</span>';

  DE.route('/groups', () => DE.navigate('/communities', true));
  DE.route('/group/:id', (v, p) => DE.navigate('/community/' + p.id, true));

  DE.route('/communities', async (view, p, q) => {
    DE.title('Communities for sharing & selling knowledge');
    const [all, mine] = await Promise.all([DE.get('/groups' + (q.focus ? '?focus=' + encodeURIComponent(q.focus) : '')), DE.user ? DE.get('/groups/mine') : Promise.resolve([])]);
    view.innerHTML = '<div class="row between wrap"><h1>Communities</h1>' + (DE.user ? '<button class="btn primary" id="newG">+ Create a community</button>' : '<a class="btn" href="/login">Log in to create</a>') + '</div>' +
      '<p class="muted">Create a community around any skill. Share knowledge for free, charge for access, or run a storefront for your digital products and services - in any currency.</p>' +
      '<div class="chips" style="margin:10px 0"><span class="chip' + (!q.focus ? ' on' : '') + '" data-f="">All</span>' + Object.keys(FOCUS).map(k => '<span class="chip' + (q.focus === k ? ' on' : '') + '" data-f="' + k + '">' + FOCUS[k] + '</span>').join('') + '</div>' +
      (mine.length ? '<h2>My communities</h2><div class="grid">' + mine.map(g => '<a class="card" href="/community/' + g.id + '" style="color:inherit"><b>' + esc(g.name) + '</b><div class="muted small">' + g.members + ' members</div></a>').join('') + '</div>' : '') +
      '<h2 style="margin-top:20px">Discover</h2>' + (all.length ? '<div class="grid">' + all.map(g => '<a class="card" href="/community/' + g.id + '" style="color:inherit"><b>' + esc(g.name) + '</b><div class="muted small">' + esc(g.category || 'General') + ' · ' + esc(FOCUS[g.focus] || '') + ' · ' + g.members + ' members</div><div class="small" style="margin:6px 0">' + esc((g.description || '').slice(0, 100)) + '</div>' + badge(g) + '</a>').join('') + '</div>' : '<div class="card empty">No communities yet. Start the first one!</div>');
    DE.$$('.chip[data-f]', view).forEach(c => c.onclick = () => DE.navigate('/communities' + (c.dataset.f ? '?focus=' + c.dataset.f : '')));
    const nb = DE.$('#newG');
    if (nb) nb.onclick = () => DE.modal('<h2>Create a community</h2><label class="f">Community name</label><input class="i" id="gn" maxlength="80" placeholder="e.g. Python for Beginners">' +
      '<label class="f">What is it for?</label>' + focusSelect('gf', 'mixed') + '<label class="f">Topic</label>' + DE.categorySelect('gc', '', true) +
      '<label class="f">Description</label><textarea class="i" id="gd" maxlength="600" placeholder="What will members learn, share or buy here?"></textarea>' +
      '<div class="row"><div style="flex:1"><label class="f">Price to join (0 = free)</label><input class="i" id="gp" type="number" min="0" step="any" value="0"></div><div style="flex:1"><label class="f">Currency</label>' + DE.currencySelect('gcur') + '</div></div>' +
      '<div class="err" id="gerr"></div><div class="row" style="margin-top:12px"><button class="btn primary" id="gok">Create</button><button class="btn" data-close>Cancel</button></div>', (m, close) => {
      m.querySelector('#gok').onclick = async () => {
        try { const r = await DE.post('/groups', { name: m.querySelector('#gn').value, focus: m.querySelector('#gf').value, category: m.querySelector('#gc').value, description: m.querySelector('#gd').value, price: m.querySelector('#gp').value, currency: m.querySelector('#gcur').value }); close(); DE.navigate('/c/' + r.slug); setTimeout(() => DE.shareCommunity({ id: r.id, name: m.querySelector('#gn').value, slug: r.slug, url: r.url, price: 0, is_owner: true }), 600); }
        catch (ex) { m.querySelector('#gerr').textContent = ex.message; }
      };
    });
  });

  // Share a community anywhere: copy link, native share sheet, WhatsApp, Telegram, X, Facebook, email
  DE.shareCommunity = function (g) {
    const url = g.url, text = g.name + ' - join me on ' + (DE.config.site_name || 'Digital Enviro');
    const u = encodeURIComponent(url), t = encodeURIComponent(text);
    DE.modal('<h2>Share this community</h2><p class="muted small">Anyone with this link can open the community in a browser and join' + (g.price > 0 ? ' (they pay ' + DE.money(g.price, g.currency) + ' to get in)' : ' for free') + '. No account is needed to look.</p>' +
      '<div class="row"><input class="i grow mono" id="shl" readonly value="' + esc(url) + '"><button class="btn primary" id="shc">Copy</button></div>' +
      '<div class="row wrap" style="margin:12px 0"><a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent(text + ' ' + url) + '">WhatsApp</a><a class="btn" target="_blank" rel="noopener" href="https://t.me/share/url?url=' + u + '&text=' + t + '">Telegram</a><a class="btn" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?url=' + u + '&text=' + t + '">X</a><a class="btn" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=' + u + '">Facebook</a><a class="btn" href="mailto:?subject=' + t + '&body=' + encodeURIComponent(text + '\n' + url) + '">Email</a>' + (navigator.share ? '<button class="btn" id="shn">More…</button>' : '') + '</div>' +
      (g.is_owner ? '<details><summary>Change my community address</summary><label class="f">Address</label><div class="row"><span class="muted">/c/</span><input class="i grow" id="shs" value="' + esc(g.slug) + '" maxlength="30"></div><div class="small" id="shm"></div><button class="btn sm" id="shsave" style="margin-top:8px">Save address</button><div class="muted small">You can change it once every 30 days. Your old link keeps working.</div></details>' : '') + '<div class="row" style="margin-top:10px"><button class="btn" data-close>Close</button></div>', m => {
      m.querySelector('#shc').onclick = () => { try { navigator.clipboard.writeText(url); DE.toast('Link copied!'); } catch (e) { m.querySelector('#shl').select(); document.execCommand('copy'); } };
      const n = m.querySelector('#shn'); if (n) n.onclick = () => navigator.share({ title: g.name, text, url }).catch(() => {});
      const si = m.querySelector('#shs'); if (si) {
        let tm; si.oninput = () => { clearTimeout(tm); tm = setTimeout(async () => { try { const r = await DE.get('/groups/slug-check?id=' + g.id + '&slug=' + encodeURIComponent(si.value)); m.querySelector('#shm').innerHTML = r.available ? '<span style="color:var(--ok)">✔ ' + esc(r.url) + ' is free</span>' : '<span style="color:var(--danger)">' + esc(r.problem) + '</span>' + (r.suggestions.length ? ' Try: ' + r.suggestions.map(x => '<a href="#" data-sg="' + esc(x) + '">' + esc(x) + '</a>').join(', ') : ''); m.querySelectorAll('[data-sg]').forEach(a => a.onclick = ev => { ev.preventDefault(); si.value = a.dataset.sg; si.oninput(); }); } catch (e) { /* ignore */ } }, 350); };
        m.querySelector('#shsave').onclick = async () => { try { const r = await DE.put('/groups/' + g.id + '/slug', { slug: si.value }); DE.toast('Address saved'); history.replaceState(null, '', '/c/' + r.slug); DE.render(); } catch (e) { DE.fail(e); } };
      }
    });
  };

  DE.route('/community/:id', async (view, p, q) => {
    const g = await DE.get('/groups/' + p.id);
    if (g.slug && !q.noredirect) return history.replaceState(null, '', '/c/' + g.slug + (location.search || '')), renderCommunity(view, g, q);
    return renderCommunity(view, g, q);
  });
  DE.route('/c/:slug', async (view, p, q) => {
    const g = await DE.get('/groups/by-slug/' + encodeURIComponent(p.slug));
    if (g.redirect) { DE.navigate(g.redirect + (location.search || ''), true); return; }
    return renderCommunity(view, g, q);
  });

  async function renderCommunity(view, g, q) {
    DE.title(g.name);
    const tab = q.tab || (g.focus === 'products' || g.focus === 'services' ? 'products' : 'posts');
    view.innerHTML = '<div id="gRoot"><div class="card"><div class="row wrap"><div class="grow"><h1 style="margin:0">' + esc(g.name) + '</h1><div class="muted">' + esc(g.category || 'General') + ' · ' + esc(FOCUS[g.focus] || '') + ' · ' + g.members + ' members · by <a href="/u/' + esc(g.owner_username) + '">@' + esc(g.owner_username) + '</a></div><p>' + esc(g.description) + '</p>' + badge(g) + '</div>' +
      '<div class="row wrap"><button class="btn" id="shareG">🔗 Share</button>' + (g.joined ? (g.is_owner ? '<button class="btn" id="editG">Settings</button><button class="btn danger" id="delG">Delete</button>' : '<button class="btn" id="leaveG">Leave</button>') :
        (g.price > 0 ? '<button class="btn amber" id="buyG">Join for ' + DE.money(g.price, g.currency) + '</button>' : '<button class="btn primary" id="joinG">Join free</button>')) + '</div></div></div>' +
      '<div class="tabs" id="gt"><button data-t="posts">Discussion</button><button data-t="products">Shop' + (g.products.length ? ' (' + g.products.length + ')' : '') + '</button><button data-t="members">Members</button></div><div id="gBody"></div></div>';

    const body = DE.$('#gBody');
    async function show(t) {
      DE.$$('#gt button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
      if (!g.joined && t !== 'products') { body.innerHTML = '<div class="card empty">🔒 Join this community to see the discussion and members.</div>'; return; }
      if (t === 'posts') {
        body.innerHTML = DE.composer({ noStory: true, placeholder: 'Share knowledge with the community...' }) + '<div id="gPosts"><div class="spinner"></div></div>';
        DE.bindComposer(body, { group_id: g.id }, () => show('posts'));
        const posts = await DE.get('/groups/' + g.id + '/posts');
        DE.$('#gPosts').innerHTML = posts.length ? posts.map(x => DE.postCard(x)).join('') : '<div class="card empty">No posts yet - start the conversation.</div>';
        DE.observeViews(DE.$('#gPosts'));
      } else if (t === 'products') {
        body.innerHTML = (g.joined ? '<div style="margin-bottom:12px"><a class="btn primary" href="/sell?group=' + g.id + '">+ Share or sell a product / service here</a></div>' : '') +
          (g.products.length ? '<div class="grid">' + g.products.map(pr => '<a class="card" href="/product/' + pr.id + '" style="color:inherit"><b>' + esc(pr.title) + '</b> ' + (pr.locked ? '🔒' : '') + '<div class="muted small">' + esc(pr.kind) + (pr.members_only ? ' · members only' : '') + '</div><div style="margin-top:6px;font-weight:800;color:var(--brand)">' + (pr.price ? DE.money(pr.price, pr.currency) : 'Free') + '</div></a>').join('') + '</div>' : '<div class="card empty">Nothing listed here yet.</div>');
      } else {
        const ms = await DE.get('/groups/' + g.id + '/members');
        body.innerHTML = '<div class="card">' + ms.map(m => '<div class="row" style="padding:6px 0">' + DE.avatar(m, 'sm') + '<a class="grow" href="/u/' + esc(m.username) + '">' + esc(m.display_name || m.username) + ' <span class="muted small">' + (m.role === 'owner' ? '· owner' : '') + '</span></a>' + (g.is_owner && m.role !== 'owner' ? '<button class="btn sm danger" data-rm="' + m.id + '">Remove</button>' : '') + '</div>').join('') + '</div>';
        DE.$$('[data-rm]', body).forEach(b => b.onclick = async () => { await DE.post('/groups/' + g.id + '/members/' + b.dataset.rm + '/remove'); show('members'); });
      }
    }
    DE.$$('#gt button').forEach(b => b.onclick = () => show(b.dataset.t));
    DE.$('#shareG').onclick = () => DE.shareCommunity(g);
    const loginNext = () => DE.navigate('/login?next=' + encodeURIComponent('/c/' + g.slug + '?join=1'));
    const j = DE.$('#joinG'); if (j) j.onclick = () => { if (!DE.user) return loginNext(); DE.busy(j, async () => { await DE.post('/groups/' + g.id + '/join'); DE.render(); }); };
    const buy = DE.$('#buyG'); if (buy) buy.onclick = () => { if (!DE.user) return loginNext(); DE.busy(buy, () => DE.checkout({ purpose: 'group', group_id: g.id })); };
    const lv = DE.$('#leaveG'); if (lv) lv.onclick = async () => { if (await DE.confirm('Leave this community?', 'Leave')) { await DE.post('/groups/' + g.id + '/leave'); DE.render(); } };
    const dg = DE.$('#delG'); if (dg) dg.onclick = async () => { if (await DE.confirm('Delete this community and all its posts?', 'Delete')) { await DE.del('/groups/' + g.id); DE.navigate('/communities'); } };
    const eg = DE.$('#editG'); if (eg) eg.onclick = () => DE.modal('<h2>Community settings</h2><label class="f">Name</label><input class="i" id="en" value="' + esc(g.name) + '"><label class="f">Purpose</label>' + focusSelect('ef', g.focus) +
      '<label class="f">Description</label><textarea class="i" id="ed">' + esc(g.description) + '</textarea><div class="row"><div style="flex:1"><label class="f">Price to join (0 = free)</label><input class="i" id="ep" type="number" min="0" step="any" value="' + (g.price / Math.pow(10, DE.decimals(g.currency))) + '"></div><div style="flex:1"><label class="f">Currency</label>' + DE.currencySelect('ecur', g.currency) + '</div></div>' +
      '<label class="f">Cover picture</label><input type="file" class="i" id="ecov" accept="image/*"><div class="err" id="eerr"></div><div class="row" style="margin-top:12px"><button class="btn primary" id="eok">Save</button><button class="btn" data-close>Cancel</button></div>', (m, close) => {
      m.querySelector('#eok').onclick = async () => {
        try {
          await DE.put('/groups/' + g.id, { name: m.querySelector('#en').value, focus: m.querySelector('#ef').value, description: m.querySelector('#ed').value, price: m.querySelector('#ep').value, currency: m.querySelector('#ecur').value });
          const f = m.querySelector('#ecov').files[0];
          if (f) { const fd = new FormData(); fd.append('media', f); await DE.post('/groups/' + g.id + '/cover', fd); }
          close(); DE.render();
        } catch (ex) { m.querySelector('#eerr').textContent = ex.message; }
      };
    });
    show(tab);
    // arrived from a shared link and just logged in: finish joining
    if (q.join && DE.user && !g.joined) { history.replaceState(null, '', location.pathname); const b = DE.$('#joinG') || DE.$('#buyG'); if (b) b.click(); }
  }
})();
