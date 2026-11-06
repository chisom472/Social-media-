/* App shell: boot, navigation, search, realtime, announcements, ads, push, install prompt, PWA */
(function () {
  const { esc } = DE;
  const flag = k => DE.config.flags[k] !== false;

  // ---------- navigation ----------
  function navItems() {
    const u = DE.user;
    const items = [['/', '🏠', 'Home'], ['/explore', '🧭', 'Explore']];
    if (flag('reels')) items.push(['/reels', '🎬', 'Reels']);
    if (flag('classes')) items.push(['/classes', '🎓', 'Classes']);
    if (flag('groups')) items.push(['/communities', '👥', 'Communities']);
    if (flag('creator_pages')) items.push(['/pages', '📄', 'Pages']);
    if (flag('marketplace')) items.push(['/market', '🛍️', 'Marketplace']);
    if (u && flag('chat')) items.push(['/chat', '💬', 'Chat', DE.chatUnread]);
    if (u) items.push(['/notifications', '🔔', 'Notifications', DE.notifUnread]);
    if (u && flag('ai')) items.push(['/assistant', '🤖', 'AI tutor']);
    if (u && flag('creator_dashboard')) items.push(['/creator', '📊', 'Creator studio']);
    if (u && flag('dropshipping')) items.push(['/dropship', '📦', 'My store']);
    if (u) items.push(['/wallet', '💰', 'Wallet'], ['/library', '📚', 'My library']);
    return items;
  }
  const isStaff = () => DE.user && (DE.user.role === 'admin' || DE.user.role === 'staff');

  DE.renderChrome = function () {
    const u = DE.user;
    const items = navItems();
    const badge = n => (n ? '<span class="badge">' + (n > 99 ? '99+' : n) + '</span>' : '');
    DE.$('#side').innerHTML = items.map(i => '<a class="nav" href="' + i[0] + '" data-nav="' + i[0] + '"><span class="ic">' + i[1] + '</span>' + i[2] + badge(i[3]) + '</a>').join('') +
      '<div class="sep"></div>' + (u ? '<a class="nav" href="/u/' + esc(u.username) + '" data-nav="/u/' + esc(u.username) + '"><span class="ic">👤</span>My profile</a><a class="nav" href="/settings" data-nav="/settings"><span class="ic">⚙️</span>Settings</a>' : '') +
      (isStaff() ? '<a class="nav" href="/admin" data-external><span class="ic">🛡️</span>Control dashboard</a>' : '') +
      (DE.config.menu_pages || []).map(p => '<a class="nav" href="/page/' + esc(p.slug) + '" data-nav="/page/' + esc(p.slug) + '"><span class="ic">•</span>' + esc(p.title) + '</a>').join('') +
      '<a class="nav" href="/policy" data-nav="/policy"><span class="ic">📜</span>Community policy</a>';

    const tabs = [['/', '🏠', 'Home']];
    if (flag('reels')) tabs.push(['/reels', '🎬', 'Reels']);
    tabs.push(['/explore', '🧭', 'Explore']);
    if (u && flag('chat')) tabs.push(['/chat', '💬', 'Chat']);
    tabs.push(u ? ['/menu', '☰', 'More'] : ['/login', '👤', 'Log in']);
    DE.$('#tabbar').innerHTML = tabs.map(t => '<a href="' + t[0] + '" data-nav="' + t[0] + '"><span class="ic">' + t[1] + '</span>' + t[2] + '</a>').join('');

    DE.$('#topnav').innerHTML = u
      ? '<a class="icon-btn" href="/notifications" aria-label="Notifications" title="Notifications">🔔' + badge(DE.notifUnread) + '</a><a href="/u/' + esc(u.username) + '" aria-label="My profile">' + DE.avatar(u, 'sm') + '</a>'
      : '<a class="btn" href="/login">Log in</a><a class="btn primary" href="/signup">Join</a>';
    DE.highlightNav();
    drawRail();
  };

  DE.highlightNav = function () {
    const p = location.pathname;
    DE.$$('[data-nav]').forEach(a => {
      const h = a.dataset.nav;
      a.classList.toggle('active', h === '/' ? p === '/' : (p === h || p.startsWith(h + '/')));
    });
  };

  // right-hand rail: suggestions + ad + write-ups
  async function drawRail() {
    const rail = DE.$('#rail'); if (!rail) return;
    let html = '';
    try {
      if (DE.user) {
        const s = await DE.get('/users/suggestions');
        if (s.people.length) html += '<div class="card"><h3>Who to follow</h3>' + s.people.slice(0, 5).map(p => DE.userRow(p)).join('') + '</div>';
      }
    } catch (e) { /* ignore */ }
    rail.innerHTML = html + '<div id="railAd"></div><div id="railWrite"></div>';
    DE.adSlot('sidebar', DE.$('#railAd'));
    writeups('sidebar', DE.$('#railWrite'));
    if (DE.config.footer_html) rail.insertAdjacentHTML('beforeend', '<div class="muted small footer-html">' + DE.config.footer_html + '</div>');
  }

  // owner write-ups (admin supplied, sanitised on the server)
  let writeCache = null;
  async function writeups(place, box) {
    if (!box) return;
    try {
      if (!writeCache) writeCache = await DE.get('/public/writeups');
      box.innerHTML = writeCache.filter(w => w.placement === place).map(w => '<div class="card writeup"><h3>' + esc(w.title) + '</h3><div>' + w.body + '</div></div>').join('');
    } catch (e) { /* ignore */ }
  }
  DE.writeups = writeups;

  // ads (only when the owner turned ads on)
  DE.adSlot = async function (placement, box, n) {
    if (!box || !DE.config.ads_enabled) return;
    try {
      const ads = await DE.get('/ads/serve?placement=' + placement + '&n=' + (n || 1));
      box.innerHTML = ads.map(a => '<a class="card ad" href="/api/ads/' + a.id + '/click" rel="sponsored noopener" target="_blank" data-external><span class="tag">Sponsored' + (a.advertiser ? ' · @' + esc(a.advertiser) : '') + '</span>' +
        (a.media ? (a.media_kind === 'video' ? '<video src="' + esc(a.media) + '" muted autoplay loop playsinline></video>' : '<img src="' + esc(a.media) + '" alt="" loading="lazy">') : '') +
        '<b>' + esc(a.title) + '</b><div class="muted small">' + esc(a.body || '') + '</div>' + (a.cta ? '<span class="btn sm primary">' + esc(a.cta) + '</span>' : '') + '</a>').join('');
    } catch (e) { /* ignore */ }
  };

  // announcement banner
  async function announcements() {
    const box = DE.$('#announce');
    try {
      const list = await DE.get('/announcements');
      const base = DE.config.announcement ? [{ id: 0, title: '', body: DE.config.announcement, dismissible: false, style: 'info' }] : [];
      const all = base.concat(list);
      if (!all.length) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = all.map(a => '<div class="ann ' + esc(a.style || 'info') + '" data-ann="' + a.id + '">' + (a.title ? '<b>' + esc(a.title) + '</b> ' : '') + esc(a.body) + (a.link ? ' <a href="' + esc(a.link) + '">Learn more</a>' : '') + (a.dismissible ? ' <button class="icon-btn" data-dismiss="' + a.id + '" aria-label="Dismiss">✕</button>' : '') + '</div>').join('');
      DE.$$('[data-dismiss]', box).forEach(b => b.onclick = async () => { b.closest('.ann').remove(); if (DE.user) DE.post('/announcements/' + b.dataset.dismiss + '/dismiss').catch(() => {}); if (!box.children.length) box.hidden = true; });
    } catch (e) { box.hidden = true; }
  }

  // ---------- realtime ----------
  DE.startSocket = function () {
    if (!DE.user || DE.socket || typeof io === 'undefined') return;
    DE.socket = io({ withCredentials: true, transports: ['websocket', 'polling'] });
    DE.socket.on('notification', n => {
      DE.notifUnread++; DE.renderChrome();
      DE.toast(n.text);
      if (location.pathname === '/notifications') DE.render();
    });
    DE.socket.on('message:new', m => {
      if (m.sender_id === DE.user.id || location.pathname.startsWith('/chat')) return;
      DE.chatUnread++; DE.renderChrome();
    });
  };

  async function refreshCounts() {
    if (!DE.user) return;
    try { DE.notifUnread = (await DE.get('/notifications/unread-count')).unread; const c = await DE.get('/chat/conversations'); DE.chatUnread = (c.conversations || c).reduce((s, x) => s + (x.unread || 0), 0); } catch (e) { /* ignore */ }
    DE.renderChrome();
  }

  // ---------- push notifications ----------
  const b64 = s => { const p = '='.repeat((4 - s.length % 4) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, c => c.charCodeAt(0)); };
  DE.enablePush = async function () {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !DE.config.push_key) throw new Error('Push notifications are not available here.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications were blocked. Allow them in your browser settings.');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(DE.config.push_key) });
    await DE.post('/notifications/push/subscribe', { subscription: sub.toJSON() });
  };
  DE.disablePush = async function () {
    try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) { await DE.post('/notifications/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); } } catch (e) { /* ignore */ }
  };

  // ---------- search ----------
  function searchBox() {
    DE.$('#searchForm').onsubmit = e => { e.preventDefault(); const q = DE.$('#searchInput').value.trim(); if (q.length >= 3) DE.navigate('/search?q=' + encodeURIComponent(q)); else DE.toast('Type at least 3 letters.', true); };
  }
  DE.route('/search', async (view, p, q) => {
    DE.title('Search');
    const term = (q.q || '').trim();
    DE.$('#searchInput').value = term;
    const r = await DE.get('/users/search?q=' + encodeURIComponent(term));
    const sec = (t, a) => a.length ? '<div class="card"><h3>' + t + '</h3>' + a.join('') + '</div>' : '';
    view.innerHTML = '<h1>Results for “' + esc(term) + '”</h1>' +
      sec('People', r.users.map(u => DE.userRow(u))) +
      sec('Pages', r.pages.map(x => '<div style="padding:6px 0"><a href="/p/' + esc(x.slug) + '"><b>' + esc(x.name) + '</b></a><div class="muted small">' + esc(x.category || '') + '</div></div>')) +
      sec('Communities', r.groups.map(g => '<div style="padding:6px 0"><a href="/community/' + g.id + '"><b>' + esc(g.name) + '</b></a><div class="muted small">' + esc(g.category || '') + '</div></div>')) +
      sec('Products', r.products.map(x => '<div style="padding:6px 0"><a href="/product/' + x.id + '"><b>' + esc(x.title) + '</b></a> <span class="muted small">' + DE.money(x.price, x.currency) + '</span></div>')) +
      sec('Posts', r.posts.map(x => '<div style="padding:6px 0"><a href="/post/' + x.id + '"><b>' + esc(x.title || (x.body || '').slice(0, 80)) + '</b></a> <span class="muted small">by @' + esc(x.username) + '</span></div>'));
    if (!r.users.length && !r.pages.length && !r.groups.length && !r.products.length && !r.posts.length) view.innerHTML += '<div class="card empty">Nothing found. Try different words.</div>';
  });

  // mobile "More" menu
  DE.route('/menu', async view => {
    DE.title('Menu');
    view.innerHTML = '<h1>Menu</h1><div class="card">' + navItems().concat([['/settings', '⚙️', 'Settings']]).map(i => '<a class="nav row" href="' + i[0] + '" style="padding:12px 4px;color:inherit"><span class="ic">' + i[1] + '</span><span class="grow">' + i[2] + '</span>' + (i[3] ? '<span class="badge">' + i[3] + '</span>' : '') + '</a>').join('') +
      (isStaff() ? '<a class="nav row" href="/admin" data-external style="padding:12px 4px;color:inherit"><span class="ic">🛡️</span>Control dashboard</a>' : '') + '</div><div class="card"><button class="btn danger" data-act="logout">Log out</button></div>';
  }, { auth: true });

  // ---------- install prompt + updates ----------
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); deferred = e;
    if (DE.store.get('de_install_dismissed')) return;
    const bar = document.createElement('div');
    bar.className = 'installbar';
    bar.innerHTML = '<span>Install ' + esc(DE.config.site_name || 'Digital Enviro') + ' on your device for a faster, app-like experience.</span><button class="btn sm primary" id="inst">Install</button><button class="icon-btn" id="instx" aria-label="Dismiss">✕</button>';
    document.body.appendChild(bar);
    bar.querySelector('#inst').onclick = async () => { deferred.prompt(); await deferred.userChoice; bar.remove(); };
    bar.querySelector('#instx').onclick = () => { DE.store.set('de_install_dismissed', '1'); bar.remove(); };
  });

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w && w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            const t = document.createElement('div'); t.className = 'installbar';
            t.innerHTML = '<span>A new version is ready.</span><button class="btn sm primary" id="upd">Refresh</button>';
            document.body.appendChild(t); t.querySelector('#upd').onclick = () => location.reload();
          }
        });
      });
    }).catch(() => {});
    navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.go) DE.navigate(e.data.go); });
  }

  // ---------- boot ----------
  async function boot() {
    try { DE.config = Object.assign(DE.config, await DE.get('/public/config')); } catch (e) { /* offline: keep defaults */ }
    try { DE.world = await DE.get('/public/world'); } catch (e) { /* ignore */ }
    const saved = DE.store.get('de_theme') || (DE.config.theme && DE.config.theme.mode !== 'auto' ? DE.config.theme.mode : null);
    if (saved) document.documentElement.dataset.theme = saved;
    else if (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) document.documentElement.dataset.theme = 'light';
    if (DE.config.theme && DE.config.theme.brand) document.documentElement.style.setProperty('--brand', DE.config.theme.brand);
    if (DE.config.theme && DE.config.theme.accent) document.documentElement.style.setProperty('--amber', DE.config.theme.accent);
    try { const me = await DE.get('/auth/me'); DE.setSession(me.user); DE.notifUnread = me.unread || 0; } catch (e) { DE.setSession(null); }
    if (DE.config.maintenance && !isStaff()) { DE.$('#view').innerHTML = '<div class="card center" style="max-width:520px;margin:40px auto"><h1>We will be right back</h1><p>' + esc(DE.config.maintenance) + '</p></div>'; return; }
    DE.startSocket(); DE.renderChrome(); searchBox(); announcements(); registerSW();
    if (DE.user) refreshCounts();
    DE.render();
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
