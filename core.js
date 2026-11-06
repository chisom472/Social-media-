/* Core: state, API helper, router, toasts, modals, utilities */
(function () {
  const DE = (window.DE = { user: null, config: { flags: {}, categories: [], menu_pages: [] }, routes: [], socket: null, chatUnread: 0, notifUnread: 0, view: null });

  DE.store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };
  DE.REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🔥', '👏', '🙏'];

  DE.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  DE.$ = (s, r) => (r || document).querySelector(s);
  DE.$$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  // Money is stored as integer minor units (cents, kobo...) next to a currency code.
  DE.world = { countries: [], currencies: [] };
  DE.decimals = cur => { const c = DE.world.currencies.find(x => x.code === cur); return c ? c.decimals : 2; };
  DE.money = (minor, cur) => {
    cur = cur || DE.config.default_currency || 'USD';
    const d = DE.decimals(cur);
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, minimumFractionDigits: d, maximumFractionDigits: d }).format((Number(minor) || 0) / Math.pow(10, d)); }
    catch (e) { return ((Number(minor) || 0) / Math.pow(10, d)) + ' ' + cur; }
  };
  DE.currencySelect = (id, selected) => '<select class="i" id="' + id + '">' + DE.world.currencies.map(c => '<option value="' + c.code + '"' + (c.code === (selected || DE.config.default_currency) ? ' selected' : '') + '>' + c.code + ' - ' + DE.esc(c.name) + '</option>').join('') + '</select>';
  DE.countrySelect = (id, selected) => '<select class="i" id="' + id + '"><option value="">Select country</option>' + DE.world.countries.map(c => '<option value="' + c.code + '"' + (c.code === selected ? ' selected' : '') + '>' + DE.esc(c.name) + '</option>').join('') + '</select>';
  DE.parseTs = ts => new Date(String(ts).includes('T') ? ts : String(ts).replace(' ', 'T') + 'Z');
  DE.timeago = ts => {
    if (!ts) return '';
    const s = Math.max(0, (Date.now() - DE.parseTs(ts).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 604800) return Math.floor(s / 86400) + 'd';
    return DE.parseTs(ts).toLocaleDateString();
  };
  DE.clock = ts => DE.parseTs(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  DE.initial = u => (Array.from(String((u && (u.display_name || u.username)) || '?').trim())[0] || '?').toLocaleUpperCase();
  DE.hue = u => { let h = 0; for (const ch of String((u && u.username) || '?')) h = (h * 31 + ch.codePointAt(0)) >>> 0; return h % 360; };

  // ---------- API ----------
  DE.api = async function (method, url, body) {
    // the login lives in an httpOnly cookie (page scripts cannot read it); this header proves the request comes from our own pages
    const opts = { method, headers: { 'X-Requested-With': 'DigitalEnviro' }, credentials: 'same-origin' };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch('/api' + url, opts); } catch (e) { throw new Error('Network problem. Check your connection and try again.'); }
    let data = {};
    try { data = await res.json(); } catch (e) { /* not json */ }
    if (!res.ok) {
      if (res.status === 401 && DE.user) { DE.setSession(null); DE.renderChrome(); }
      const err = new Error(data.error || 'Something went wrong (' + res.status + ').');
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  };
  ['get', 'post', 'put', 'del'].forEach(m => {
    DE[m] = (url, body) => DE.api(m === 'del' ? 'DELETE' : m.toUpperCase(), url, body);
  });

  DE.setSession = function (user) {
    DE.user = user || null;
    if (!user && DE.socket) { DE.socket.disconnect(); DE.socket = null; }
  };

  // ---------- UI helpers ----------
  DE.toast = function (msg, bad) {
    const box = DE.$('#toasts');
    const t = document.createElement('div');
    t.className = 'toast' + (bad ? ' bad' : '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  };
  DE.fail = e => DE.toast((e && e.message) || 'Something went wrong', true);

  DE.modal = function (html, mount) {
    const root = DE.$('#modalRoot');
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' + html + '</div>';
    root.appendChild(bg);
    const close = () => bg.remove();
    bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
    bg.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
    if (mount) mount(bg.firstChild, close);
    return close;
  };

  DE.confirm = function (text, okLabel) {
    return new Promise(resolve => {
      const close = DE.modal('<p>' + DE.esc(text) + '</p><div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-close id="cNo">Cancel</button><button class="btn danger" id="cYes">' + DE.esc(okLabel || 'Confirm') + '</button></div>', m => {
        m.querySelector('#cNo').onclick = () => resolve(false);
        m.querySelector('#cYes').onclick = () => { resolve(true); close(); };
      });
    });
  };

  DE.busy = async function (btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); } catch (e) { DE.fail(e); } finally { if (btn) btn.disabled = false; }
  };

  DE.title = t => { document.title = t + ' - ' + (DE.config.site_name || 'Digital Enviro'); };

  // ---------- Router (History API, clean URLs for SEO) ----------
  DE.route = function (pattern, handler, opts) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    DE.routes.push({ re, keys, handler, opts: opts || {} });
  };
  DE.navigate = function (path, replace) {
    if (replace) history.replaceState({}, '', path); else history.pushState({}, '', path);
    return DE.render();
  };
  DE.query = () => Object.fromEntries(new URLSearchParams(location.search));

  let renderId = 0;
  DE.render = async function () {
    const id = ++renderId;
    const view = DE.$('#view');
    DE.view = view;
    const path = location.pathname;
    for (const r of DE.routes) {
      const m = path.match(r.re);
      if (!m) continue;
      if (r.opts.auth && !DE.user) { return DE.navigate('/login?next=' + encodeURIComponent(path + location.search), true); }
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      view.innerHTML = '<div class="spinner" role="status" aria-label="Loading"></div>';
      DE.cleanup && DE.cleanup();
      DE.cleanup = null;
      try {
        await r.handler(view, params, DE.query(), () => id === renderId);
      } catch (e) {
        if (id !== renderId) return;
        view.innerHTML = '<div class="card empty"><h2>' + DE.esc(e.status === 404 ? 'Not found' : 'Oops') + '</h2><p>' + DE.esc(e.message) + '</p><a class="btn" href="/">Go home</a></div>';
      }
      DE.highlightNav();
      if (id === renderId && !r.opts.keepScroll) window.scrollTo(0, 0);
      return;
    }
    view.innerHTML = '<div class="card empty"><h2>Page not found</h2><p>That page does not exist.</p><a class="btn" href="/">Go home</a></div>';
  };

  // intercept internal links
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('data-external') || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const href = a.getAttribute('href');
    if (!href || href[0] !== '/' || href.startsWith('//') || href.startsWith('/uploads') || href.startsWith('/admin') || href.startsWith('/api')) return;
    e.preventDefault();
    DE.navigate(href);
  });
  window.addEventListener('popstate', () => DE.render());
})();
