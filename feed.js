/* Home feed, explore and single post */
(function () {
  const { esc } = DE;

  async function storiesStrip() {
    if (DE.config.flags.stories === false) return '';
    let list = [];
    try { list = await DE.get('/posts/stories'); } catch (e) { return ''; }
    if (!list.length) return '';
    const byUser = {};
    list.forEach(s => (byUser[s.username] = byUser[s.username] || []).push(s));
    window.__stories = byUser;
    return '<div class="stories">' + Object.keys(byUser).map(u => '<div class="story" data-story="' + esc(u) + '">' + DE.avatar(byUser[u][0]) + '<div>' + esc(u) + '</div></div>').join('') + '</div>';
  }

  DE.route('/', async (view, p, q, alive) => {
    DE.title('Learn, Share & Earn from Tech Skills');
    const mode = q.mode || (DE.user ? 'foryou' : 'latest');
    let offset = 0;
    const hero = !DE.user ? '<div class="hero"><h1>Learn. Share. Earn. Build a legacy.</h1><p>' + esc(DE.config.tagline || '') + ' Join a community of developers, designers, photographers, video editors and creators. Follow creators, join groups, sell your digital products and get supported for what you love to do.</p><div class="row wrap"><a class="btn primary" href="/signup">Join free</a><a class="btn" href="/explore">Explore topics</a></div></div>' : '';
    view.innerHTML = hero + (DE.user ? DE.composer() : '') + '<div id="stories"></div>' +
      '<div class="tabs" id="modeTabs"><button data-m="foryou" class="' + (mode === 'foryou' ? 'on' : '') + '">For you</button><button data-m="following" class="' + (mode === 'following' ? 'on' : '') + '">Following</button><button data-m="latest" class="' + (mode === 'latest' ? 'on' : '') + '">Latest</button></div>' +
      '<div id="feed"></div><div class="center" style="margin:14px"><button class="btn" id="more" hidden>Load more</button></div>';
    if (DE.user) DE.bindComposer(view, {}, () => load(true));
    DE.$$('#modeTabs button').forEach(b => b.onclick = () => DE.navigate('/?mode=' + b.dataset.m));
    storiesStrip().then(h => { const s = DE.$('#stories'); if (s && alive()) s.innerHTML = h; });

    async function load(reset) {
      if (reset) { offset = 0; DE.$('#feed').innerHTML = '<div class="spinner"></div>'; }
      const rows = await DE.get('/posts/feed?mode=' + mode + '&offset=' + offset);
      if (!alive()) return;
      const feed = DE.$('#feed');
      if (reset) feed.innerHTML = '';
      if (!rows.length && offset === 0) feed.innerHTML = '<div class="card empty">' + (mode === 'following' ? 'Follow some creators to see their posts here.' : 'Nothing here yet. Be the first to post!') + '</div>';
      const tmp = document.createElement('div');
      tmp.innerHTML = rows.map(r => DE.postCard(r)).join('');
      while (tmp.firstChild) feed.appendChild(tmp.firstChild);
      DE.observeViews(feed);
      offset += rows.length;
      DE.$('#more').hidden = rows.length < 30;
    }
    DE.$('#more').onclick = e => DE.busy(e.target, () => load(false));
    await load(true);
  });

  document.addEventListener('click', e => {
    const s = e.target.closest('[data-story]');
    if (!s || !window.__stories) return;
    const items = window.__stories[s.dataset.story] || [];
    let i = 0;
    const draw = m => {
      const it = items[i];
      m.innerHTML = '<div class="row"><b class="grow">@' + esc(it.username) + '</b><span class="muted small">' + DE.timeago(it.created_at) + '</span></div>' + DE.mediaHTML(it) + (it.body ? '<p>' + esc(it.body) + '</p>' : '') +
        '<div class="row between"><button class="btn sm" id="sp"' + (i ? '' : ' disabled') + '>‹ Prev</button><span class="muted small">' + (i + 1) + ' / ' + items.length + '</span><button class="btn sm" id="sn"' + (i < items.length - 1 ? '' : ' disabled') + '>Next ›</button></div><div style="margin-top:10px"><button class="btn" data-close>Close</button></div>';
      m.querySelector('#sp').onclick = () => { i--; draw(m); };
      m.querySelector('#sn').onclick = () => { i++; draw(m); };
      if (DE.user) DE.post('/posts/' + it.id + '/view').catch(() => {});
    };
    DE.modal('', m => draw(m));
  });

  DE.route('/explore', async (view, p, q, alive) => {
    DE.title('Explore tech topics & creators');
    view.innerHTML = '<h1>Explore</h1><div class="chips" id="cats"><span class="chip' + (!q.category && !q.q ? ' on' : '') + '" data-c="">Trending</span>' +
      DE.config.categories.map(c => '<span class="chip' + (q.category === c ? ' on' : '') + '" data-c="' + esc(c) + '">' + esc(c) + '</span>').join('') + '</div><div id="out" style="margin-top:14px"><div class="spinner"></div></div>';
    DE.$$('#cats .chip').forEach(c => c.onclick = () => DE.navigate('/explore' + (c.dataset.c ? '?category=' + encodeURIComponent(c.dataset.c) : '')));
    if (q.q) {
      const r = await DE.get('/users/search?q=' + encodeURIComponent(q.q));
      if (!alive()) return;
      const sec = (t, h) => h ? '<div class="card"><h2>' + t + '</h2>' + h + '</div>' : '';
      DE.$('#out').innerHTML = '<h2>Results for "' + esc(q.q) + '"</h2>' +
        sec('People', r.users.map(u => DE.userRow(u)).join('')) +
        sec('Creator pages', r.pages.map(g => '<div><a href="/p/' + esc(g.slug) + '"><b>' + esc(g.name) + '</b></a> <span class="muted small">' + esc(g.category || '') + '</span></div>').join('')) +
        sec('Communities', r.groups.map(g => '<div><a href="/community/' + g.id + '"><b>' + esc(g.name) + '</b></a> <span class="muted small">' + (g.price ? DE.money(g.price, g.currency) : 'free') + '</span></div>').join('')) +
        sec('Products', r.products.map(g => '<div><a href="/product/' + g.id + '"><b>' + esc(g.title) + '</b></a> <span class="muted small">' + (g.price ? DE.money(g.price, g.currency) : 'free') + '</span></div>').join('')) +
        sec('Posts', r.posts.map(g => '<div style="margin:6px 0"><a href="/post/' + g.id + '"><b>' + esc(g.title || g.body.slice(0, 80)) + '</b></a> <span class="muted small">@' + esc(g.username) + '</span></div>').join('')) ||
        '<div class="card empty">No results found.</div>';
      return;
    }
    const posts = await DE.get('/posts/explore' + (q.category ? '?category=' + encodeURIComponent(q.category) : ''));
    if (!alive()) return;
    DE.$('#out').innerHTML = posts.length ? posts.map(x => DE.postCard(x)).join('') : '<div class="card empty">No posts in this topic yet.</div>';
    DE.observeViews(DE.$('#out'));
  });

  DE.route('/post/:id', async (view, p) => {
    const post = await DE.get('/posts/' + p.id);
    DE.title(post.title || 'Post by @' + post.username);
    view.innerHTML = DE.postCard(post, { comments: true });
    DE.observeViews(view);
    DE.loadComments(post.id, DE.$('#commentsBox'));
  });
})();
