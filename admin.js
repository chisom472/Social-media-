/* Control dashboard. Every section only appears if the signed-in person has that permission (the owner has all). */
(function () {
  const DE = window.DE, esc = DE.esc, $ = DE.$, $$ = DE.$$;
  let ME = null, SECTION = 'overview';
  const can = p => !p || (ME && (ME.owner || ME.permissions.includes(p)));
  const T = (rows, cols, empty) => rows && rows.length ? '<div class="tablewrap"><table><tr>' + cols.map(c => '<th>' + c[1] + '</th>').join('') + '</tr>' + rows.map(r => '<tr>' + cols.map(c => '<td>' + (c[2] ? c[2](r) : esc(r[c[0]] == null ? '' : r[c[0]])) + '</td>').join('') + '</tr>').join('') + '</table></div>' : '<p class="muted">' + (empty || 'Nothing here.') + '</p>';
  const when = s => (s ? esc(String(s).slice(0, 16)) : '');
  const card = (h, body) => '<div class="card"><h3>' + h + '</h3>' + body + '</div>';
  const pill = (t, k) => '<span class="pill ' + (k || '') + '">' + esc(t) + '</span>';
  const A = path => '/admin' + path;
  const stepUp = async () => new Promise(res => DE.modal('<h2>Confirm it is you</h2><p class="muted">Enter your password to continue.</p><input class="i" type="password" id="spw" autocomplete="current-password"><div class="row" style="margin-top:12px"><button class="btn primary" id="spok">Continue</button><button class="btn" data-close>Cancel</button></div>', (m, close) => { m.querySelector('#spok').onclick = () => { const v = m.querySelector('#spw').value; close(); res(v); }; m.querySelector('[data-close]').addEventListener('click', () => res(null)); }));
  const ask = (title, fields, okLabel) => new Promise(res => DE.modal('<h2>' + title + '</h2>' + fields.map(f => '<label class="f">' + f.label + '</label>' + (f.type === 'textarea' ? '<textarea class="i" id="f_' + f.k + '" rows="5">' + esc(f.v || '') + '</textarea>' : f.type === 'select' ? '<select class="i" id="f_' + f.k + '">' + f.options.map(o => '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(f.v) ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select>' : f.type === 'check' ? '<label class="row"><input type="checkbox" id="f_' + f.k + '"' + (f.v ? ' checked' : '') + '> ' + esc(f.hint || '') + '</label>' : '<input class="i" id="f_' + f.k + '" type="' + (f.type || 'text') + '" value="' + esc(f.v == null ? '' : f.v) + '"' + (f.ph ? ' placeholder="' + esc(f.ph) + '"' : '') + '>')).join('') + '<div class="err" id="aerr"></div><div class="row" style="margin-top:12px"><button class="btn primary" id="aok">' + (okLabel || 'Save') + '</button><button class="btn" data-close>Cancel</button></div>', (m, close) => {
    m.querySelector('#aok').onclick = () => { const o = {}; fields.forEach(f => { const e = m.querySelector('#f_' + f.k); o[f.k] = f.type === 'check' ? e.checked : e.value; }); close(); res(o); };
    m.querySelector('[data-close]').addEventListener('click', () => res(null));
  }));
  const call = async (fn, ok) => { try { const r = await fn(); if (ok) DE.toast(ok); return r; } catch (e) { DE.fail(e); return null; } };

  // ------------------------------------------------------------ login
  function loginScreen(msg) {
    $('#app').innerHTML = '<div class="card" style="max-width:400px;margin:12vh auto"><h1>Control dashboard</h1><p class="muted">' + esc(msg || 'Sign in with your owner or admin account.') + '</p><form id="lf"><label class="f">Email, phone or username</label><input class="i" id="id" autocomplete="username" required>' + DE.pwField('pw', 'Password') + '<div class="err" id="err"></div><button class="btn primary block" style="margin-top:14px">Sign in</button></form></div>';
    $('#lf').onsubmit = async e => { e.preventDefault(); try { await DE.post('/auth/login', { identifier: $('#id').value, password: $('#pw').value }); boot(); } catch (ex) { $('#err').textContent = ex.message; } };
  }

  // ------------------------------------------------------------ sections
  const SECTIONS = [
    ['overview', '📊', 'Overview', null],
    ['users', '👥', 'Users', 'users_view'],
    ['countries', '🌍', 'Countries', 'users_view'],
    ['team', '🛡️', 'Admin team', 'owner'],
    ['payments', '💳', 'Payments', 'payments_view'],
    ['providers', '🔌', 'Payment providers', 'settings_payments'],
    ['accounts', '🏦', 'My receiving accounts', 'settings_payments'],
    ['fx', '💱', 'Exchange rates', 'settings_payments'],
    ['fees', '🧾', 'Fees & invoices', 'fees'],
    ['dropship', '📦', 'Dropshipping', 'dropship'],
    ['content', '🗂️', 'Content', 'content'],
    ['reports', '🚩', 'Reports', 'reports'],
    ['announce', '📣', 'Announcements', 'announcements'],
    ['ads', '📢', 'Ads', 'ads'],
    ['writeups', '✍️', 'Write-ups & pages', 'writeups'],
    ['site', '🎨', 'Site & features', 'site'],
    ['ai', '🤖', 'AI tutor', 'ai'],
    ['settings', '⚙️', 'All settings', 'any'],
    ['db', '🗄️', 'Database', 'db_read'],
    ['backups', '💾', 'Backups', 'owner'],
    ['audit', '📜', 'Audit log', 'audit']
  ];
  const visible = s => s[3] === 'owner' ? ME.owner : s[3] === 'any' ? true : can(s[3]);

  function frame() {
    $('#app').innerHTML = '<div class="admtop"><button class="btn" id="burger">☰</button><b>Control dashboard</b></div><div class="adm"><nav id="nav"><div class="brand row"><img src="/logo.svg" alt="" height="30"><b>Control</b></div>' +
      SECTIONS.filter(visible).map(s => '<a data-s="' + s[0] + '" class="' + (s[0] === SECTION ? 'on' : '') + '"><span>' + s[1] + '</span>' + s[2] + '</a>').join('') +
      '<div class="sep" style="margin:10px 0;border-top:1px solid var(--line)"></div><a href="/">↩ Back to the site</a><a id="out">Sign out</a><div class="muted small" style="padding:8px 12px">@' + esc(ME.username) + ' · ' + (ME.owner ? 'Owner' : 'Admin') + '</div></nav><main id="main"></main></div>';
    $$('#nav [data-s]').forEach(a => a.onclick = () => { SECTION = a.dataset.s; location.hash = SECTION; $('#nav').classList.remove('open'); frame(); load(); });
    $('#burger').onclick = () => $('#nav').classList.toggle('open');
    $('#out').onclick = async () => { await DE.post('/auth/logout').catch(() => {}); location.reload(); };
  }
  async function load() {
    const main = $('#main'); main.innerHTML = '<div class="spinner"></div>';
    try { await R[SECTION](main); } catch (e) { main.innerHTML = '<div class="card"><h2>Could not load</h2><p>' + esc(e.message) + '</p></div>'; }
  }
  const reload = () => load();

  const R = {};

  // ---------- overview
  R.overview = async m => {
    const s = await DE.get(A('/stats'));
    const k = (l, v, sub) => '<div class="stat"><div class="muted small">' + l + '</div><div class="bal">' + v + '</div>' + (sub ? '<div class="muted small">' + sub + '</div>' : '') + '</div>';
    m.innerHTML = '<h1>Overview</h1><div class="kv">' + k('Users', s.users, s.new_week + ' new this week') + k('Online now', s.online_now) + k('Creators', s.creators) + k('Posts', s.posts, s.reels + ' reels') + k('Communities', s.groups) + k('Classes', s.classes) + k('Stores', s.stores) +
      k('Open reports', s.open_reports) + k('Dropship needing attention', s.dropship_attention) + (s.gross_volume ? k('Paid orders', s.orders_paid) : '') + '</div>' +
      (s.gross_volume ? card('Money received (all time)', s.gross_volume.map(g => '<span class="pill">' + DE.money(g.total, g.currency) + '</span> ').join('') || '<span class="muted">Nothing yet</span>') : '') +
      (s.pending_withdrawals != null ? card('Waiting for you', '<p>Withdrawals to pay: <b>' + s.pending_withdrawals + '</b> · Manual payments to confirm: <b>' + (s.pending_manual || 0) + '</b></p>') : '');
  };

  // ---------- users
  R.users = async m => {
    const q = DE.store.get('adm_uq') || '', cc = DE.store.get('adm_cc') || '';
    const rows = await DE.get(A('/users?q=' + encodeURIComponent(q) + (cc ? '&country=' + cc : '')));
    const priv = rows.length && 'email' in rows[0];
    m.innerHTML = '<div class="row between wrap"><h1>Users</h1>' + (can('users_private') ? '<a class="btn" href="/api/admin/users/export.csv">Download CSV</a>' : '') + '</div><div class="row wrap"><input class="i grow" id="uq" placeholder="Search name, username' + (priv ? ', email, phone' : '') + '" value="' + esc(q) + '"><div style="min-width:220px">' + DE.countrySelect('ucc', cc, true) + '</div><button class="btn primary" id="go">Search</button></div>' +
      '<div class="card">' + T(rows, [['username', 'User', r => '<a href="#" data-u="' + r.id + '">@' + esc(r.username) + '</a>' + (r.role !== 'user' ? ' ' + pill(r.role) : '')], ['display_name', 'Name'], ...(priv ? [['email', 'Email'], ['phone', 'Phone'], ['dob', 'Born']] : []), ['country', 'Country', r => esc(r.country || r.last_country || r.signup_country || '')], ['status', 'Status', r => pill(r.status, r.status === 'active' ? 'ok' : 'bad') + (r.favoured ? ' ⭐' : '') + (r.restrictions ? ' 🚧' : '')], ['posts', 'Posts'], ['last_seen', 'Last seen', r => when(r.last_seen)]]) + '</div>';
    $('#go').onclick = () => { DE.store.set('adm_uq', $('#uq').value); DE.store.set('adm_cc', $('#ucc').value); reload(); };
    $('#uq').onkeydown = e => e.key === 'Enter' && $('#go').click();
    $$('[data-u]', m).forEach(a => a.onclick = e => { e.preventDefault(); userDetail(a.dataset.u); });
  };
  const RESTR = { post: 'Post', comment: 'Comment', chat: 'Chat', follow: 'Follow', sell: 'Sell / stores', withdraw: 'Withdraw money', community: 'Create communities', page: 'Create pages', class: 'Host classes', ai: 'Use AI', ads: 'Run ads' };
  async function userDetail(id) {
    const u = await DE.get(A('/users/' + id));
    const rs = (u.restrictions || '').split(',').filter(Boolean);
    DE.modal('<h2>@' + esc(u.username) + ' ' + (u.role !== 'user' ? pill(u.role) : '') + '</h2><div class="muted small">' + esc(u.display_name || '') + ' · joined ' + when(u.created_at) + ' · last seen ' + when(u.last_seen) + '</div>' +
      (u.email !== undefined ? '<div class="card flat small"><b>Private details</b><br>Email: ' + esc(u.email || '—') + '<br>Phone: ' + esc(u.phone || '—') + '<br>Born: ' + esc(u.dob || '—') + '<br>Location: ' + esc([u.city, u.region, u.country].filter(Boolean).join(', ') || '—') + '<br>Signed up from: ' + esc(u.signup_country || '—') + ' · last seen in ' + esc(u.last_country || '—') + '</div>' : '') +
      (u.wallets ? '<div class="card flat small"><b>Wallet</b> ' + (u.wallets.map(w => DE.money(w.balance, w.currency)).join(' · ') || '—') + '</div>' : '') +
      '<div class="row wrap"><select class="i" id="st" style="max-width:160px">' + ['active', 'suspended', 'banned'].map(s => '<option' + (u.status === s ? ' selected' : '') + '>' + s + '</option>').join('') + '</select><button class="btn" id="stb">Set status</button><label class="row"><input type="checkbox" id="fav"' + (u.favoured ? ' checked' : '') + '> ⭐ Favoured</label></div>' +
      '<h3>Restrictions</h3><div class="permgrid">' + Object.entries(RESTR).map(([k, l]) => '<label class="row small"><input type="checkbox" data-r="' + k + '"' + (rs.includes(k) || rs.includes('all') ? ' checked' : '') + '> ' + l + '</label>').join('') + '</div><input class="i" id="rn" placeholder="Reason shown to the user" value="' + esc(u.restriction_note || '') + '"><button class="btn sm" id="rsb" style="margin-top:6px">Save restrictions</button>' +
      (can('fees') ? '<h3>Fees</h3><label class="row"><input type="checkbox" id="wv"' + (u.owner_fee_waived ? ' checked' : '') + '> Waive all platform fees for this user</label><div class="two"><div><label class="f">Commission override %</label><input class="i" id="co" value="' + esc(u.commission_override == null ? '' : u.commission_override) + '"></div><div><label class="f">Class fee override (minor units)</label><input class="i" id="cf" value="' + esc(u.class_fee_override == null ? '' : u.class_fee_override) + '"></div></div><button class="btn sm" id="fsv" style="margin-top:6px">Save fees</button>' : '') +
      '<h3>Actions</h3><div class="row wrap"><button class="btn" id="rl">Password reset link</button><button class="btn" id="un">Unlock login</button>' + (!u.is_creator ? '<button class="btn" id="gc">Grant creator access</button>' : '') + (can('users_delete') && u.role !== 'admin' ? '<button class="btn danger" id="del">Delete account</button>' : '') + '</div>' +
      (u.logins ? '<h3>Recent logins</h3>' + T(u.logins, [['created_at', 'When', r => when(r.created_at)], ['ok', 'OK', r => (r.ok ? '✔' : '✖')], ['country', 'Country'], ['ua', 'Device', r => esc(String(r.ua || '').slice(0, 50))]]) : '') + '<button class="btn" data-close style="margin-top:10px">Close</button>', (mm, close) => {
      const done = (fn, msg) => async () => { if (await call(fn, msg) !== null) { close(); reload(); } };
      mm.querySelector('#stb').onclick = done(() => DE.post(A('/users/' + id + '/status'), { status: mm.querySelector('#st').value }), 'Status updated');
      mm.querySelector('#fav').onchange = e => call(() => DE.put(A('/users/' + id + '/flags'), { favoured: e.target.checked }), 'Saved');
      mm.querySelector('#rsb').onclick = done(() => DE.put(A('/users/' + id + '/flags'), { restrictions: $$('[data-r]:checked', mm).map(x => x.dataset.r), restriction_note: mm.querySelector('#rn').value }), 'Restrictions saved');
      const fs = mm.querySelector('#fsv'); if (fs) fs.onclick = done(() => DE.put(A('/users/' + id + '/flags'), { owner_fee_waived: mm.querySelector('#wv').checked, commission_override: mm.querySelector('#co').value, class_fee_override: mm.querySelector('#cf').value }), 'Fees saved');
      mm.querySelector('#rl').onclick = async () => { const r = await call(() => DE.post(A('/users/' + id + '/reset-link'))); if (r) DE.modal('<h2>Reset link</h2><p class="muted small">Send this to the user. It expires soon.</p><input class="i mono" readonly value="' + esc(r.url) + '"><button class="btn" data-close style="margin-top:10px">Close</button>'); };
      mm.querySelector('#un').onclick = () => call(() => DE.post(A('/users/' + id + '/unlock')), 'Unlocked');
      const gc = mm.querySelector('#gc'); if (gc) gc.onclick = done(() => DE.post(A('/users/' + id + '/grant-creator')), 'Creator access granted');
      const dl = mm.querySelector('#del'); if (dl) dl.onclick = async () => { if (await DE.confirm('Permanently delete @' + u.username + ' and everything they own? This cannot be undone.', 'Delete')) { const pw = await stepUp(); if (pw === null) return; done(() => DE.api('DELETE', A('/users/' + id), { password: pw }), 'Deleted')(); } };
    });
  }

  R.countries = async m => {
    const rows = await DE.get(A('/users/countries'));
    const total = rows.reduce((s, r) => s + r.users, 0) || 1;
    m.innerHTML = '<h1>Where your users live</h1>' + card('By country', T(rows, [['country', 'Country', r => esc((DE.world.countries.find(c => c.code === r.country) || {}).name || r.country || 'Unknown')], ['users', 'Users'], ['p', 'Share', r => '<div style="background:var(--card2);border-radius:6px;width:160px"><div style="background:var(--brand);height:8px;border-radius:6px;width:' + Math.round(r.users / total * 100) + '%"></div></div> ' + Math.round(r.users / total * 100) + '%']]));
  };

  // ---------- admin team
  R.team = async m => {
    const t = await DE.get(A('/team'));
    m.innerHTML = '<div class="row between wrap"><h1>Admin team</h1><button class="btn primary" id="add">+ Add an admin</button></div><p class="muted">Admins only see and do what you tick for them. Only you (the owner) can change this page, platform secrets, the database, backups, and pay your team.</p>' +
      t.staff.map(s => '<div class="card"><div class="row wrap"><div class="grow"><b>@' + esc(s.username) + '</b> ' + pill(s.status, s.status === 'active' ? 'ok' : 'bad') + '<div class="muted small">' + esc(s.email || '') + ' · last seen ' + when(s.last_seen) + '</div></div><button class="btn sm" data-perm="' + s.id + '">Permissions</button><button class="btn sm primary" data-pay="' + s.id + '">Pay</button><button class="btn sm" data-hist="' + s.id + '">Payments</button><button class="btn sm danger" data-rm="' + s.id + '">Remove</button></div><div class="muted small" style="margin-top:6px">' + (s.permissions ? s.permissions.split(',').map(p => t.catalogue[p] ? esc(t.catalogue[p]) : '').filter(Boolean).join(' · ') : 'No permissions yet') + '</div></div>').join('') || '<div class="card empty">No admins yet.</div>';
    const permForm = (cur) => '<div class="permgrid">' + Object.entries(t.catalogue).map(([k, l]) => '<label class="row small"><input type="checkbox" data-p="' + k + '"' + (cur.includes(k) ? ' checked' : '') + '> ' + esc(l) + '</label>').join('') + '</div>';
    $('#add').onclick = () => DE.modal('<h2>Add an admin</h2><label class="f">Username or email of an existing user</label><input class="i" id="w"><h3>What can they do?</h3>' + permForm([]) + '<div class="err" id="e"></div><div class="row" style="margin-top:12px"><button class="btn primary" id="ok">Add admin</button><button class="btn" data-close>Cancel</button></div>', (mm, close) => { mm.querySelector('#ok').onclick = async () => { try { await DE.post(A('/team'), { who: mm.querySelector('#w').value, permissions: $$('[data-p]:checked', mm).map(x => x.dataset.p) }); close(); reload(); } catch (e) { mm.querySelector('#e').textContent = e.message; } }; });
    $$('[data-perm]', m).forEach(b => b.onclick = () => { const s = t.staff.find(x => String(x.id) === b.dataset.perm); DE.modal('<h2>Permissions for @' + esc(s.username) + '</h2>' + permForm((s.permissions || '').split(',')) + '<div class="row" style="margin-top:12px"><button class="btn primary" id="ok">Save</button><button class="btn" data-close>Cancel</button></div>', (mm, close) => { mm.querySelector('#ok').onclick = async () => { if (await call(() => DE.put(A('/team/' + s.id), { permissions: $$('[data-p]:checked', mm).map(x => x.dataset.p) }), 'Saved') !== null) { close(); reload(); } }; }); });
    $$('[data-rm]', m).forEach(b => b.onclick = async () => { if (await DE.confirm('Remove this admin? They keep their normal user account.', 'Remove')) { await call(() => DE.del(A('/team/' + b.dataset.rm)), 'Removed'); reload(); } });
    $$('[data-pay]', m).forEach(b => b.onclick = async () => { const o = await ask('Pay this admin', [{ k: 'amount', label: 'Amount', type: 'number', ph: '0.00' }, { k: 'currency', label: 'Currency', type: 'select', v: DE.config.default_currency || 'USD', options: DE.world.currencies.map(c => [c.code, c.code + ' – ' + c.name]) }, { k: 'source', label: 'Pay from', type: 'select', v: 'wallet', options: [['wallet', 'My wallet (they can withdraw instantly, in any currency, to bank / fintech / PayPal / crypto)'], ['external', 'I paid them myself (just record it)']] }, { k: 'note', label: 'Note', v: 'Salary' }], 'Pay now'); if (o && await call(() => DE.post(A('/team/' + b.dataset.pay + '/pay'), o), 'Payment sent')) reload(); });
    $$('[data-hist]', m).forEach(b => b.onclick = async () => { const r = await DE.get(A('/team/' + b.dataset.hist + '/payments')); DE.modal('<h2>Payments to this admin</h2>' + T(r, [['created_at', 'When', x => when(x.created_at)], ['amount', 'Amount', x => DE.money(x.amount, x.currency)], ['source', 'From'], ['note', 'Note']]) + '<button class="btn" data-close>Close</button>'); });
  };

  // ---------- payments
  R.payments = async m => {
    const [man, wd, tx] = await Promise.all([DE.get(A('/manual-payments')), DE.get(A('/withdrawals')), DE.get(A('/transactions'))]);
    m.innerHTML = '<h1>Payments</h1>' +
      card('Transfers waiting for you to confirm', T(man.filter(x => x.status === 'pending'), [['created_at', 'When', r => when(r.created_at)], ['username', 'User', r => '@' + esc(r.username || '')], ['amount', 'Amount', r => DE.money(r.amount, r.currency)], ['purpose', 'For'], ['proof', 'Proof', r => esc(r.proof || '')], ['x', '', r => can('payments_manage') ? '<button class="btn sm primary" data-mok="' + r.id + '">Confirm</button><button class="btn sm danger" data-mno="' + r.id + '">Reject</button>' : '']], 'None waiting.')) +
      card('Withdrawals', T(wd, [['created_at', 'When', r => when(r.created_at)], ['username', 'User', r => '@' + esc(r.username || '')], ['amount', 'Amount', r => DE.money(r.amount, r.currency)], ['dest', 'Pay to', r => esc(r.dest || r.method || '')], ['status', 'Status', r => pill(r.status, r.status === 'paid' ? 'ok' : r.status === 'failed' || r.status === 'rejected' ? 'bad' : 'warn')], ['x', '', r => can('payments_manage') && ['pending', 'processing'].includes(r.status) ? '<button class="btn sm primary" data-wok="' + r.id + '">Mark paid</button><button class="btn sm danger" data-wno="' + r.id + '">Reject &amp; refund</button>' : '']])) +
      card('Latest transactions', T(tx.slice(0, 100), [['created_at', 'When', r => when(r.created_at)], ['username', 'User', r => '@' + esc(r.username || '')], ['type', 'Type'], ['amount', 'Amount', r => DE.money(r.amount, r.currency)], ['note', 'Note']]));
    $$('[data-mok]', m).forEach(b => b.onclick = async () => { if (await call(() => DE.post(A('/manual-payments/' + b.dataset.mok + '/approve')), 'Confirmed')) reload(); });
    $$('[data-mno]', m).forEach(b => b.onclick = async () => { const o = await ask('Reject payment', [{ k: 'reason', label: 'Reason' }]); if (o && await call(() => DE.post(A('/manual-payments/' + b.dataset.mno + '/reject'), o), 'Rejected')) reload(); });
    $$('[data-wok]', m).forEach(b => b.onclick = async () => { const o = await ask('Mark as paid', [{ k: 'reference', label: 'Transfer reference (optional)' }]); if (o && await call(() => DE.post(A('/withdrawals/' + b.dataset.wok + '/approve'), o), 'Marked paid')) reload(); });
    $$('[data-wno]', m).forEach(b => b.onclick = async () => { const o = await ask('Reject and refund', [{ k: 'reason', label: 'Reason' }]); if (o && await call(() => DE.post(A('/withdrawals/' + b.dataset.wno + '/reject'), o), 'Refunded to wallet')) reload(); });
  };

  // ---------- providers (webhook URLs + keys)
  const PROV_KEYS = {
    paystack: ['paystack_enabled', 'paystack_secret_key', 'paystack_currencies'],
    flutterwave: ['flutterwave_enabled', 'flutterwave_secret_key', 'flutterwave_secret_hash', 'flutterwave_currencies'],
    stripe: ['stripe_enabled', 'stripe_secret_key', 'stripe_webhook_secret', 'stripe_currencies'],
    paypal: ['paypal_mode', 'paypal_client_id', 'paypal_client_secret', 'paypal_webhook_id', 'paypal_currencies', 'paypal_payouts_enabled'],
    tap: ['tap_secret_key', 'tap_currencies'],
    nowpayments: ['nowpayments_api_key', 'nowpayments_ipn_secret'],
    btcpay: ['btcpay_url', 'btcpay_api_key', 'btcpay_store_id', 'btcpay_webhook_secret', 'btcpay_payouts_enabled', 'btcpay_payout_method'],
    wise: ['wise_env', 'wise_api_token', 'wise_profile_id', 'wise_source_currency', 'wise_payouts_enabled']
  };
  const HELP = {
    paypal: 'Create a REST app at developer.paypal.com → copy Client ID and Secret. Add the webhook URL below and paste its Webhook ID. PayPal Payouts must be enabled on your business account for automatic payouts.',
    tap: 'Tap Payments (KNET, cards, Gulf currencies — Kuwaiti dinar). Paste your Tap secret key and set the webhook (post) URL below in your Tap dashboard.',
    wise: 'Wise Business: create an API token (full access) and paste your profile ID. This pays out Kuwaiti dinar (and many other currencies) to users\' IBANs automatically from your Wise balance.',
    btcpay: 'Self-hosted BTCPay Server. Payouts require your store wallet to be set up with an automated payout processor.',
    paystack: 'Naira cards/transfers and automatic Nigerian bank payouts.', flutterwave: 'Cards, mobile money and bank transfers across Africa, plus bank payouts.', stripe: 'Cards and wallets worldwide (needs a Stripe-supported business country).', nowpayments: 'Crypto checkout (BTC, USDT and many more).'
  };
  R.providers = async m => {
    const [st, set] = await Promise.all([DE.get(A('/payments/status')), DE.get(A('/settings'))]);
    m.innerHTML = '<h1>Payment providers</h1>' + (st.public_https ? '' : '<div class="card warnbox">Your SITE_URL is not a public https address, so providers cannot reach your webhooks. Set SITE_URL in .env.</div>') +
      st.providers.filter(p => PROV_KEYS[p.id]).map(p => card(esc(p.label) + ' ' + pill(p.enabled ? 'connected' : 'not connected', p.enabled ? 'ok' : ''), '<p class="muted small">' + esc(HELP[p.id] || '') + '</p>' + (p.webhook ? '<div class="small">Webhook URL: <code class="mono">' + esc(p.webhook) + '</code></div>' : '') + settingsForm(PROV_KEYS[p.id], set, p.id))).join('') +
      card('Wise ' + pill(set.wise_api_token ? 'token saved' : 'not connected', set.wise_api_token ? 'ok' : ''), '<p class="muted small">' + HELP.wise + '</p>' + settingsForm(PROV_KEYS.wise, set, 'wise')) +
      card('General', settingsForm(['accepted_currencies', 'auto_payout', 'min_withdrawal', 'default_currency', 'commission_percent'], set, 'gen'));
    bindSettings(m);
  };

  // ---------- generic settings forms
  const LABEL = k => k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const BOOL = /(_enabled|^auto_|_on$|^allow_|^require_|^maintenance_mode$)/;
  function settingsForm(keys, set, id) {
    const rows = keys.filter(k => k in set).map(k => {
      const v = set[k]; const secret = v === '********' || /(secret|api_key|api_token|_token|password|_hash)$/.test(k);
      const long = /(_html|_text|description|footer|message)$/.test(k) || String(v).length > 90;
      let input;
      if (BOOL.test(k) && (v === '0' || v === '1' || v === '')) input = '<label class="row"><input type="checkbox" data-k="' + k + '"' + (v === '1' ? ' checked' : '') + '> On</label>';
      else if (/_mode$|_env$/.test(k) && /paypal|wise/.test(k)) input = '<select class="i" data-k="' + k + '"><option' + (v === 'live' ? ' selected' : '') + '>live</option><option' + (v === 'sandbox' ? ' selected' : '') + '>sandbox</option></select>';
      else if (long) input = '<textarea class="i" data-k="' + k + '" rows="4">' + esc(v) + '</textarea>';
      else input = '<input class="i" data-k="' + k + '" type="' + (secret ? 'password' : 'text') + '" value="' + esc(v) + '" autocomplete="off">';
      return '<div class="setrow"><label>' + esc(LABEL(k)) + '</label><div>' + input + '</div></div>';
    }).join('');
    return '<div data-sf="' + id + '">' + rows + '<button class="btn primary" data-save="' + id + '" style="margin-top:10px">Save</button></div>';
  }
  function bindSettings(root) {
    $$('[data-save]', root).forEach(b => b.onclick = async () => {
      const body = {};
      $$('[data-k]', $('[data-sf="' + b.dataset.save + '"]', root)).forEach(e => { body[e.dataset.k] = e.type === 'checkbox' ? e.checked : e.value; });
      const r = await call(() => DE.put(A('/settings'), body), 'Saved');
      if (r && r.denied && r.denied.length) DE.toast('Not allowed to change: ' + r.denied.join(', '), true);
    });
  }
  const settingsSection = (title, keys, extra) => async m => { const set = await DE.get(A('/settings')); m.innerHTML = '<h1>' + title + '</h1>' + (extra ? extra(set) : '') + card('Settings', settingsForm(keys.filter(k => k in set), set, 's')); bindSettings(m); };

  // ---------- receiving accounts (manual transfers into your bank/crypto, incl. KWD)
  R.accounts = async m => {
    const rows = await DE.get(A('/receiving-accounts'));
    m.innerHTML = '<div class="row between"><h1>My receiving accounts</h1><button class="btn primary" id="add">+ Add account</button></div><p class="muted">Shown to people who choose “bank transfer / crypto” at checkout. Add a Kuwaiti bank (KWD), a USD account, a Payoneer receiving account or a crypto address. Payments here are confirmed by you; use the automatic providers for hands-free payments.</p>' +
      '<div class="card">' + T(rows, [['label', 'Label'], ['type', 'Type'], ['currency', 'Currency'], ['bank_name', 'Bank / coin', r => esc(r.bank_name || r.coin || '')], ['account_number', 'Account / address', r => esc(r.account_number || r.address || '')], ['active', 'Active', r => (r.active ? '✔' : '—')], ['x', '', r => '<button class="btn sm" data-ed="' + r.id + '">Edit</button><button class="btn sm danger" data-del="' + r.id + '">Delete</button>']]) + '</div>';
    const form = async r => ask(r ? 'Edit account' : 'Add receiving account', [{ k: 'type', label: 'Type', type: 'select', v: r ? r.type : 'bank', options: [['bank', 'Bank account'], ['crypto', 'Crypto wallet']] }, { k: 'label', label: 'Label shown to payers', v: r ? r.label : '', ph: 'e.g. Kuwait bank (KWD)' }, { k: 'currency', label: 'Currency', type: 'select', v: r ? r.currency : 'KWD', options: DE.world.currencies.map(c => [c.code, c.code + ' – ' + c.name]) }, { k: 'bank_name', label: 'Bank name', v: r && r.bank_name }, { k: 'account_name', label: 'Account name', v: r && r.account_name }, { k: 'account_number', label: 'Account number / IBAN', v: r && r.account_number }, { k: 'swift_bic', label: 'SWIFT / BIC', v: r && r.swift_bic }, { k: 'country', label: 'Country code', v: r && r.country, ph: 'KW' }, { k: 'coin', label: 'Coin (crypto)', v: r && r.coin }, { k: 'network', label: 'Network (crypto)', v: r && r.network }, { k: 'address', label: 'Address (crypto)', v: r && r.address }, { k: 'memo', label: 'Memo / tag', v: r && r.memo }, { k: 'instructions', label: 'Instructions for payers', type: 'textarea', v: r && r.instructions }, { k: 'active', label: 'Active', type: 'check', v: r ? r.active : true, hint: 'Show to payers' }]);
    $('#add').onclick = async () => { const o = await form(); if (o && await call(() => DE.post(A('/receiving-accounts'), o), 'Added')) reload(); };
    $$('[data-ed]', m).forEach(b => b.onclick = async () => { const o = await form(rows.find(x => String(x.id) === b.dataset.ed)); if (o && await call(() => DE.put(A('/receiving-accounts/' + b.dataset.ed), o), 'Saved')) reload(); });
    $$('[data-del]', m).forEach(b => b.onclick = async () => { if (await DE.confirm('Delete this account?', 'Delete')) { await call(() => DE.del(A('/receiving-accounts/' + b.dataset.del))); reload(); } });
  };

  // ---------- fx
  R.fx = async m => {
    const r = await DE.get(A('/fx'));
    const rows = Array.isArray(r) ? r : (r.rates || []);
    m.innerHTML = '<div class="row between"><h1>Exchange rates</h1><button class="btn" id="rf">Refresh from the internet</button></div><p class="muted">Rates are used for conversions and withdrawals (Nigerian users can convert to naira, Kuwaiti users to dinar, etc). Set your own rate to override the automatic one.</p>' +
      '<div class="card">' + T(rows, [['currency', 'Currency'], ['per_usd', 'Per 1 USD'], ['manual', 'Source', r => (r.manual ? pill('your rate', 'warn') : pill('automatic'))], ['x', '', r => '<button class="btn sm" data-set="' + (r.currency || r.code) + '">Set</button>' + (r.manual ? '<button class="btn sm" data-auto="' + (r.currency || r.code) + '">Back to automatic</button>' : '')]]) + '</div>';
    $('#rf').onclick = async () => { await call(() => DE.post(A('/fx/refresh')), 'Refreshed'); reload(); };
    $$('[data-set]', m).forEach(b => b.onclick = async () => { const o = await ask('Rate for ' + b.dataset.set, [{ k: 'per_usd', label: 'How many ' + b.dataset.set + ' equal 1 USD?', type: 'number' }]); if (o && await call(() => DE.put(A('/fx/' + b.dataset.set), o), 'Saved')) reload(); });
    $$('[data-auto]', m).forEach(b => b.onclick = async () => { await call(() => DE.put(A('/fx/' + b.dataset.auto), { auto: true })); reload(); });
  };

  // ---------- fees
  R.fees = async m => {
    const [inv, set] = await Promise.all([DE.get(A('/invoices')), DE.get(A('/settings'))]);
    const feeKeys = Object.keys(set).filter(k => /^(owner_payments_enabled|pay_.*_enabled|class_fee|creator_fee|creator_|dropship_fee|commission|owner_fee|class_)/.test(k) && k !== '_perm');
    m.innerHTML = '<div class="row between"><h1>Fees & invoices</h1>' + (can('payments_manage') ? '<button class="btn primary" id="new">+ Invoice a user</button>' : '') + '</div>' +
      card('Fee settings', '<p class="muted small">Set what creators pay you, and when. Switch a kind of payment off, or waive it for one person from their user page.</p>' + settingsForm(feeKeys, set, 'fees')) +
      card('Invoices', T(inv, [['id', '#'], ['username', 'User', r => '@' + esc(r.username)], ['kind', 'For'], ['amount', 'Amount', r => DE.money(r.amount, r.currency)], ['status', 'Status', r => pill(r.status, r.status === 'paid' ? 'ok' : r.status === 'due' ? 'warn' : '')], ['due_at', 'Due', r => when(r.due_at)], ['x', '', r => r.status === 'due' && can('payments_manage') ? '<button class="btn sm" data-w="' + r.id + '">Waive</button><button class="btn sm danger" data-v="' + r.id + '">Void</button>' : '']]));
    bindSettings(m);
    const nb = $('#new'); if (nb) nb.onclick = async () => { const o = await ask('Invoice a user', [{ k: 'username', label: 'Username' }, { k: 'amount', label: 'Amount', type: 'number' }, { k: 'currency', label: 'Currency', type: 'select', v: DE.config.default_currency || 'USD', options: DE.world.currencies.map(c => [c.code, c.code]) }, { k: 'kind', label: 'Kind', type: 'select', v: 'creator_fee', options: [['creator_fee', 'Creator fee'], ['class_fee', 'Class fee'], ['ad', 'Advert'], ['dropship_fee', 'Dropship fee']] }, { k: 'note', label: 'Note' }, { k: 'grace_days', label: 'Days to pay', type: 'number', v: 7 }], 'Create invoice'); if (o && await call(() => DE.post(A('/invoices'), o), 'Created')) reload(); };
    $$('[data-w]', m).forEach(b => b.onclick = async () => { await call(() => DE.post(A('/invoices/' + b.dataset.w + '/waive')), 'Waived'); reload(); });
    $$('[data-v]', m).forEach(b => b.onclick = async () => { await call(() => DE.post(A('/invoices/' + b.dataset.v + '/void')), 'Voided'); reload(); });
  };

  // ---------- dropship
  R.dropship = async m => {
    const [plats, ords, stores, set] = await Promise.all([DE.get(A('/dropship/platforms')), DE.get(A('/dropship/orders')), DE.get(A('/stores')), DE.get(A('/settings'))]);
    const pk = ['printful_enabled', 'printful_api_token', 'printful_store_id', 'printful_webhook_secret', 'printify_enabled', 'printify_api_token', 'printify_shop_id', 'cj_enabled', 'cj_api_key', 'cj_origin_countries', 'dropship_auto_confirm', 'pod_default_markup', 'dropship_user_suppliers', 'store_domain'];
    const fk = ['dropship_fee_every', 'dropship_fee_mode', 'dropship_fee_amount', 'dropship_fee_percent', 'dropship_fee_currency', 'dropship_fee_grace_days', 'pay_dropship_fee_enabled'];
    m.innerHTML = '<h1>Dropshipping</h1>' + card('Platforms', '<p class="muted small">Connect the platforms sellers can use. Sellers choose one, or “all” and the app picks per product and country. You pay each platform for production and delivery from your account with them; customers\' payments cover it.</p>' + plats.map(p => '<div class="row wrap" style="padding:6px 0"><b class="grow">' + esc(p.label) + '</b>' + pill(p.enabled ? 'on' : 'off', p.enabled ? 'ok' : '') + (ME.owner && p.enabled ? '<button class="btn sm" data-conn="' + p.id + '">Connect webhooks</button>' : '') + '</div>').join('')) +
      (ME.owner ? card('Platform keys & settings', settingsForm(pk, set, 'pk')) + card('Seller fee (paid to you after every N sales)', settingsForm(fk, set, 'fk')) : '') +
      card('Orders', T(ords, [['ref', 'Order', r => '<span class="mono">' + esc(r.ref) + '</span>'], ['store', 'Store', r => esc(r.brand_name || r.store || '')], ['provider', 'Platform'], ['status', 'Status', r => pill(r.status, ['delivered', 'shipped'].includes(r.status) ? 'ok' : ['needs_attention', 'refund_needed', 'failed'].includes(r.status) ? 'bad' : 'warn')], ['total', 'Total', r => DE.money(r.total, r.currency)], ['note', 'Note', r => esc(String(r.note || '').slice(0, 80))], ['x', '', r => '<button class="btn sm" data-ap="' + r.id + '">Approve</button><button class="btn sm" data-rt="' + r.id + '">Retry</button>' + (r.status === 'refund_needed' ? '<button class="btn sm" data-rf="' + r.id + '">Mark refunded</button>' : '') + '<button class="btn sm danger" data-cn="' + r.id + '">Cancel</button>']])) +
      card('Stores', T(stores, [['brand_name', 'Store', r => '<a href="/s/' + esc(r.slug) + '" target="_blank">' + esc(r.brand_name) + '</a>'], ['username', 'Owner', r => '@' + esc(r.username)], ['products', 'Products'], ['active', 'Open', r => (r.active ? '✔' : '✖')], ['x', '', r => '<button class="btn sm" data-tg="' + r.id + '" data-on="' + (r.active ? 0 : 1) + '">' + (r.active ? 'Close' : 'Open') + '</button>']]));
    bindSettings(m);
    $$('[data-conn]', m).forEach(b => b.onclick = async () => { const r = await call(() => DE.post(A('/dropship/connect/' + b.dataset.conn))); if (r) DE.toast(r.note || 'Webhooks connected'); });
    const od = (sel, path, ok) => $$(sel, m).forEach(b => b.onclick = async () => { if (await call(() => DE.post(A('/dropship/orders/' + b.dataset[sel.slice(6, -1)] + path)), ok)) reload(); });
    od('[data-ap]', '/approve', 'Approved'); od('[data-rt]', '/retry', 'Retrying'); od('[data-rf]', '/refunded', 'Marked refunded'); od('[data-cn]', '/cancel', 'Cancelled');
    $$('[data-tg]', m).forEach(b => b.onclick = async () => { await call(() => DE.put(A('/stores/' + b.dataset.tg), { active: b.dataset.on === '1' })); reload(); });
  };

  // ---------- content & reports
  R.content = async m => {
    const kind = DE.store.get('adm_kind') || 'posts';
    const rows = await DE.get(A('/content/' + kind));
    m.innerHTML = '<h1>Content</h1><div class="chips">' + ['posts', 'pages', 'groups', 'products', 'classes'].map(k => '<span class="chip ' + (k === kind ? 'on' : '') + '" data-k="' + k + '">' + k + '</span>').join('') + '</div><div class="card">' + T(rows, Object.keys(rows[0] || { id: 1 }).map(k => [k, esc(k), r => esc(String(r[k] == null ? '' : r[k]).slice(0, 80))]).concat([['x', '', r => '<button class="btn sm danger" data-d="' + r.id + '">Delete</button>']])) + '</div>';
    $$('[data-k]', m).forEach(c => c.onclick = () => { DE.store.set('adm_kind', c.dataset.k); reload(); });
    $$('[data-d]', m).forEach(b => b.onclick = async () => { if (await DE.confirm('Delete this ' + kind.slice(0, -1) + '?', 'Delete')) { await call(() => DE.del(A('/content/' + kind + '/' + b.dataset.d)), 'Deleted'); reload(); } });
  };
  R.reports = async m => {
    const rows = await DE.get(A('/reports'));
    m.innerHTML = '<h1>Reports</h1><div class="card">' + T(rows, [['created_at', 'When', r => when(r.created_at)], ['reporter', 'By', r => '@' + esc(r.reporter || '')], ['kind', 'About', r => esc(r.kind || r.target_type || '') + ' #' + esc(r.target_id || '')], ['reason', 'Reason'], ['status', 'Status', r => pill(r.status, r.status === 'open' ? 'warn' : 'ok')], ['x', '', r => r.status === 'open' ? '<button class="btn sm" data-r="' + r.id + '">Resolve</button>' : '']], 'No reports. 🎉') + '</div>';
    $$('[data-r]', m).forEach(b => b.onclick = async () => { await call(() => DE.post(A('/reports/' + b.dataset.r + '/resolve')), 'Resolved'); reload(); });
  };

  // ---------- announcements
  R.announce = async m => {
    const [list, seg] = await Promise.all([DE.get(A('/announcements')), DE.get(A('/announce/segments'))]);
    m.innerHTML = '<div class="row between"><h1>Announcements</h1><button class="btn primary" id="new">+ New announcement</button></div><p class="muted">Send to everyone, a category of users, one country, or a single person. It shows as a banner and as a notification.</p><div class="card">' + T(list, [['created_at', 'Sent', r => when(r.created_at)], ['title', 'Title'], ['audience', 'To', r => esc(r.audience) + (r.audience_value ? ': ' + esc(r.audience_value) : '')], ['active', 'Live', r => (r.active ? '✔' : '—')], ['x', '', r => '<button class="btn sm danger" data-d="' + r.id + '">Remove</button>']]) + '</div>';
    $('#new').onclick = async () => {
      const o = await ask('New announcement', [{ k: 'title', label: 'Title' }, { k: 'body', label: 'Message', type: 'textarea' }, { k: 'link', label: 'Link (optional)' }, { k: 'audience', label: 'Send to', type: 'select', v: 'all', options: seg.map(s => [s.key, s.label]).concat([['user', 'One user (type the username below)']]) }, { k: 'audience_value', label: 'Country code / username / category (when needed)' }, { k: 'style', label: 'Look', type: 'select', v: 'info', options: [['info', 'Info'], ['success', 'Good news'], ['warn', 'Warning']] }, { k: 'notify', label: 'Also notify', type: 'check', v: true, hint: 'Send as a notification (and push)' }, { k: 'dismissible', label: 'Dismiss', type: 'check', v: true, hint: 'Users can dismiss the banner' }, { k: 'guests', label: 'Guests', type: 'check', v: false, hint: 'Also show to visitors who are not logged in' }], 'Send');
      if (o) { const c = await DE.get(A('/announce/count?audience=' + o.audience + '&value=' + encodeURIComponent(o.audience_value || ''))).catch(() => ({ count: '?' })); if (await DE.confirm('This will reach ' + c.count + ' user(s). Send now?', 'Send')) { await call(() => DE.post(A('/announcements'), o), 'Sent'); reload(); } }
    };
    $$('[data-d]', m).forEach(b => b.onclick = async () => { await call(() => DE.del(A('/announcements/' + b.dataset.d))); reload(); });
  };

  // ---------- ads
  R.ads = async m => {
    const [rows, set] = await Promise.all([DE.get(A('/ads')), DE.get(A('/settings'))]);
    m.innerHTML = '<div class="row between"><h1>Ads</h1><button class="btn primary" id="new">+ Run my own ad</button></div>' + card('Settings', '<p class="muted small">Turn advertising on or off, let users buy ads, and set the price.</p>' + settingsForm(Object.keys(set).filter(k => /^ads_/.test(k)), set, 'ads')) +
      card('Adverts', T(rows, [['title', 'Title'], ['username', 'By', r => r.username ? '@' + esc(r.username) : 'Owner'], ['placement', 'Where'], ['status', 'Status', r => pill(r.status, r.status === 'active' ? 'ok' : r.status === 'pending' ? 'warn' : '')], ['impressions', 'Views'], ['clicks', 'Clicks'], ['x', '', r => (r.status === 'pending' ? '<button class="btn sm primary" data-ap="' + r.id + '">Approve</button><button class="btn sm danger" data-rj="' + r.id + '">Reject</button>' : '') + (r.status === 'active' ? '<button class="btn sm" data-ps="' + r.id + '">Pause</button>' : '')]]));
    bindSettings(m);
    $('#new').onclick = async () => { const o = await ask('New advert', [{ k: 'title', label: 'Title' }, { k: 'body', label: 'Text' }, { k: 'link_url', label: 'Link (https://)' }, { k: 'cta', label: 'Button text', v: 'Learn more' }, { k: 'placement', label: 'Where', type: 'select', v: 'feed', options: ['feed', 'sidebar', 'reels', 'home'].map(x => [x, x]) }, { k: 'days', label: 'Days', type: 'number', v: 30 }, { k: 'countries', label: 'Countries (codes, empty = all)' }], 'Publish'); if (o && await call(() => DE.post(A('/ads'), o), 'Published')) reload(); };
    $$('[data-ap]', m).forEach(b => b.onclick = async () => { await call(() => DE.post(A('/ads/' + b.dataset.ap + '/approve')), 'Approved'); reload(); });
    $$('[data-rj]', m).forEach(b => b.onclick = async () => { const o = await ask('Reject advert', [{ k: 'reason', label: 'Reason' }]); if (o) { await call(() => DE.post(A('/ads/' + b.dataset.rj + '/reject'), o), 'Rejected'); reload(); } });
    $$('[data-ps]', m).forEach(b => b.onclick = async () => { await call(() => DE.post(A('/ads/' + b.dataset.ps + '/pause')), 'Paused'); reload(); });
  };

  // ---------- write-ups, pages
  R.writeups = async m => {
    const [w, pg, set] = await Promise.all([DE.get(A('/writeups')), DE.get(A('/custom-pages')), DE.get(A('/settings'))]);
    const wf = async r => ask(r ? 'Edit write-up' : 'New write-up', [{ k: 'title', label: 'Title', v: r && r.title }, { k: 'body', label: 'Content (HTML allowed, scripts are removed)', type: 'textarea', v: r && r.body }, { k: 'placement', label: 'Where', type: 'select', v: r ? r.placement : 'home_top', options: [['home_top', 'Top of the home feed'], ['home_bottom', 'Bottom of the home feed'], ['sidebar', 'Sidebar'], ['footer', 'Footer']] }, { k: 'audience', label: 'Who sees it', type: 'select', v: r ? r.audience : 'all', options: [['all', 'Everyone'], ['guests', 'Visitors only'], ['members', 'Logged-in users']] }, { k: 'sort', label: 'Order', type: 'number', v: r ? r.sort : 0 }, { k: 'active', label: 'Active', type: 'check', v: r ? r.active : true, hint: 'Visible' }]);
    m.innerHTML = '<h1>Write-ups & pages</h1>' + card('Write-ups on the site <button class="btn sm primary" id="nw" style="float:right">+ Add</button>', T(w, [['title', 'Title'], ['placement', 'Where'], ['audience', 'For'], ['active', 'Live', r => (r.active ? '✔' : '—')], ['x', '', r => '<button class="btn sm" data-we="' + r.id + '">Edit</button><button class="btn sm danger" data-wd="' + r.id + '">Delete</button>']])) +
      card('Your own pages (About, FAQ, Contact...) <button class="btn sm primary" id="np" style="float:right">+ Add page</button>', T(pg, [['title', 'Title'], ['slug', 'Address', r => '/page/' + esc(r.slug)], ['in_menu', 'In menu', r => (r.in_menu ? '✔' : '—')], ['x', '', r => '<button class="btn sm" data-pe="' + r.id + '">Edit</button><button class="btn sm danger" data-pd="' + r.id + '">Delete</button>']])) +
      card('Policy, terms & privacy', settingsForm(['policy_html', 'terms_html', 'privacy_html'].filter(k => k in set), set, 'pol'));
    bindSettings(m);
    $('#nw').onclick = async () => { const o = await wf(); if (o && await call(() => DE.post(A('/writeups'), o), 'Added')) reload(); };
    $$('[data-we]', m).forEach(b => b.onclick = async () => { const o = await wf(w.find(x => String(x.id) === b.dataset.we)); if (o && await call(() => DE.put(A('/writeups/' + b.dataset.we), o), 'Saved')) reload(); });
    $$('[data-wd]', m).forEach(b => b.onclick = async () => { if (await DE.confirm('Delete?', 'Delete')) { await call(() => DE.del(A('/writeups/' + b.dataset.wd))); reload(); } });
    const pf = r => ask(r ? 'Edit page' : 'New page', [{ k: 'title', label: 'Title', v: r && r.title }, { k: 'content', label: 'Content (HTML allowed)', type: 'textarea', v: r && r.content }, { k: 'in_menu', label: 'Menu', type: 'check', v: r ? r.in_menu : true, hint: 'Show in the menu' }]);
    $('#np').onclick = async () => { const o = await pf(); if (o && await call(() => DE.post(A('/custom-pages'), o), 'Added')) reload(); };
    $$('[data-pe]', m).forEach(b => b.onclick = async () => { const o = await pf(pg.find(x => String(x.id) === b.dataset.pe)); if (o && await call(() => DE.put(A('/custom-pages/' + b.dataset.pe), o), 'Saved')) reload(); });
    $$('[data-pd]', m).forEach(b => b.onclick = async () => { if (await DE.confirm('Delete this page?', 'Delete')) { await call(() => DE.del(A('/custom-pages/' + b.dataset.pd))); reload(); } });
  };

  // ---------- site, features, categories
  R.site = async m => {
    const [set, flags, cats] = await Promise.all([DE.get(A('/settings')), DE.get(A('/flags')), DE.get(A('/categories'))]);
    const siteKeys = Object.keys(set).filter(k => k !== '_perm' && set._perm[k] === 'site' && !/^(policy|terms|privacy)/.test(k));
    m.innerHTML = '<h1>Site & features</h1>' + card('Features (switch parts of the site on or off)', '<div class="permgrid">' + flags.map(f => '<label class="row"><input type="checkbox" data-f="' + esc(f.key) + '"' + (f.enabled ? ' checked' : '') + '> ' + esc(f.label || f.key) + '</label>').join('') + '</div>') +
      card('Topics / categories', '<div class="chips">' + cats.map(c => '<span class="chip">' + esc(c.name || c) + ' <a href="#" data-dc="' + esc(c.id || '') + '">✕</a></span>').join('') + '</div><div class="row" style="margin-top:8px"><input class="i grow" id="nc" placeholder="New category"><button class="btn" id="ac">Add</button></div>') +
      card('Site settings (name, theme, SEO keywords, sign-up rules...)', settingsForm(siteKeys, set, 'site'));
    bindSettings(m);
    $$('[data-f]', m).forEach(c => c.onchange = () => call(() => DE.put(A('/flags/' + c.dataset.f), { enabled: c.checked }), 'Saved'));
    $('#ac').onclick = async () => { if ($('#nc').value && await call(() => DE.post(A('/categories'), { name: $('#nc').value }))) reload(); };
    $$('[data-dc]', m).forEach(a => a.onclick = async e => { e.preventDefault(); if (a.dataset.dc) { await call(() => DE.del(A('/categories/' + a.dataset.dc))); reload(); } });
  };

  // ---------- AI
  R.ai = async m => {
    const r = await DE.get(A('/ai'));
    const set = await DE.get(A('/settings'));
    m.innerHTML = '<div class="row between"><h1>AI tutor</h1><button class="btn primary" id="add">+ Add AI provider</button></div><p class="muted">Until at least one provider is added, users see a “coming soon” page. Add as many providers as you like: they are tried in priority order.</p>' + card('Status', r.ready ? pill('live', 'ok') : pill('coming soon', 'warn')) +
      card('Providers', T(r.providers, [['name', 'Name'], ['type', 'Type'], ['model', 'Model'], ['priority', 'Priority'], ['has_key', 'Key', x => (x.has_key ? '✔' : '—')], ['enabled', 'On', x => (x.enabled ? '✔' : '—')], ['x', '', x => '<button class="btn sm" data-t="' + x.id + '">Test</button><button class="btn sm" data-ed="' + x.id + '">Edit</button><button class="btn sm danger" data-d="' + x.id + '">Delete</button>']])) + card('AI settings', settingsForm(Object.keys(set).filter(k => /^ai_/.test(k)), set, 'ai'));
    bindSettings(m);
    const form = p => ask(p ? 'Edit provider' : 'Add AI provider', [{ k: 'name', label: 'Name', v: p && p.name }, { k: 'type', label: 'Type', type: 'select', v: p ? p.type : r.types[0], options: r.types.map(t => [t, t]) }, { k: 'base_url', label: 'API address (for OpenAI-compatible)', v: p && p.base_url }, { k: 'model', label: 'Model', v: p && p.model }, { k: 'api_key', label: 'API key' + (p ? ' (leave blank to keep)' : ''), type: 'password' }, { k: 'priority', label: 'Priority (lower first)', type: 'number', v: p ? p.priority : 10 }, { k: 'enabled', label: 'Enabled', type: 'check', v: p ? p.enabled : true, hint: 'Use this provider' }]);
    $('#add').onclick = async () => { const o = await form(); if (o && await call(() => DE.post(A('/ai'), o), 'Added')) reload(); };
    $$('[data-ed]', m).forEach(b => b.onclick = async () => { const o = await form(r.providers.find(x => String(x.id) === b.dataset.ed)); if (o) { if (!o.api_key) delete o.api_key; if (await call(() => DE.put(A('/ai/' + b.dataset.ed), o), 'Saved')) reload(); } });
    $$('[data-d]', m).forEach(b => b.onclick = async () => { if (await DE.confirm('Delete this provider?', 'Delete')) { await call(() => DE.del(A('/ai/' + b.dataset.d))); reload(); } });
    $$('[data-t]', m).forEach(b => b.onclick = async () => { const x = await call(() => DE.post(A('/ai/test'), { id: b.dataset.t })); if (x) DE.modal('<h2>Test reply</h2><p>' + esc(x.reply || JSON.stringify(x)) + '</p><button class="btn" data-close>Close</button>'); });
  };

  R.settings = async m => {
    const set = await DE.get(A('/settings'));
    const groups = {};
    Object.keys(set).filter(k => k !== '_perm').forEach(k => { const g = (k.split('_')[0] || 'misc'); (groups[g] = groups[g] || []).push(k); });
    m.innerHTML = '<h1>All settings</h1><p class="muted">Every setting you are allowed to change, grouped by name. Secret values show as ******** and are only replaced if you type a new one.</p><input class="i" id="flt" placeholder="Filter settings…">' + Object.keys(groups).sort().map(g => '<details class="card" data-g><summary><b>' + esc(g) + '</b> <span class="muted small">(' + groups[g].length + ')</span></summary>' + settingsForm(groups[g], set, 'g_' + g) + '</details>').join('');
    bindSettings(m);
    $('#flt').oninput = e => { const q = e.target.value.toLowerCase(); $$('.setrow', m).forEach(r => (r.style.display = !q || r.textContent.toLowerCase().includes(q) ? '' : 'none')); if (q) $$('[data-g]', m).forEach(d => (d.open = true)); };
  };

  // ---------- database (read-only browser; edits need the owner's password)
  R.db = async m => {
    const t = await DE.get(A('/db/tables'));
    const name = DE.store.get('adm_tbl') || (t[0] && (t[0].name || t[0]));
    m.innerHTML = '<h1>Database</h1><div class="row wrap"><select class="i" id="tb" style="max-width:300px">' + t.map(x => { const n = x.name || x; return '<option' + (n === name ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') + '</select>' + (ME.owner ? '<button class="btn" id="sql">SQL console</button>' : '') + '</div><div id="tbl"></div>';
    async function show(n, off) {
      DE.store.set('adm_tbl', n);
      const d = await DE.get(A('/db/table/' + encodeURIComponent(n) + '?offset=' + (off || 0)));
      $('#tbl').innerHTML = '<p class="muted small">' + d.total + ' rows</p><div class="tablewrap"><table><tr>' + (ME.owner ? '<th></th>' : '') + d.cols.map(c => '<th>' + esc(c.name) + '</th>').join('') + '</tr>' + d.rows.map(r => '<tr>' + (ME.owner ? '<td><button class="btn sm" data-e="' + r._rowid_ + '">✎</button><button class="btn sm danger" data-x="' + r._rowid_ + '">🗑</button></td>' : '') + d.cols.map(c => '<td>' + esc(String(r[c.name] == null ? '' : r[c.name]).slice(0, 80)) + '</td>').join('') + '</tr>').join('') + '</table></div><div class="row"><button class="btn sm" id="pv"' + (off ? '' : ' disabled') + '>‹ Newer</button><button class="btn sm" id="nx"' + (d.total > (off || 0) + 50 ? '' : ' disabled') + '>Older ›</button></div>';
      $('#pv').onclick = () => show(n, Math.max(0, (off || 0) - 50)); $('#nx').onclick = () => show(n, (off || 0) + 50);
      $$('[data-e]').forEach(b => b.onclick = async () => { const row = d.rows.find(r => String(r._rowid_) === b.dataset.e); const o = await ask('Edit row ' + b.dataset.e, d.cols.filter(c => !c.pk).map(c => ({ k: c.name, label: c.name, v: row[c.name] }))); if (!o) return; const pw = await stepUp(); if (pw === null) return; await call(() => DE.put(A('/db/table/' + encodeURIComponent(n) + '/' + b.dataset.e), { values: o, password: pw }), 'Saved'); show(n, off); });
      $$('[data-x]').forEach(b => b.onclick = async () => { if (!await DE.confirm('Delete this row?', 'Delete')) return; const pw = await stepUp(); if (pw === null) return; await call(() => DE.api('DELETE', A('/db/table/' + encodeURIComponent(n) + '/' + b.dataset.x), { password: pw }), 'Deleted'); show(n, off); });
    }
    $('#tb').onchange = e => show(e.target.value); show(name);
    const sq = $('#sql'); if (sq) sq.onclick = async () => { const o = await ask('SQL console', [{ k: 'sql', label: 'SQL (SELECT runs directly; changes ask for your password)', type: 'textarea' }], 'Run'); if (!o) return; let r; try { r = await DE.post(A('/db/sql'), { sql: o.sql }); } catch (e) { if (e.needs_password || /password/i.test(e.message)) { const pw = await stepUp(); if (pw === null) return; r = await call(() => DE.post(A('/db/sql'), { sql: o.sql, password: pw })); } else return DE.fail(e); } if (r) DE.modal('<h2>Result</h2><pre style="max-height:50vh;overflow:auto">' + esc(JSON.stringify(r, null, 1)) + '</pre><button class="btn" data-close>Close</button>'); };
  };

  R.backups = async m => {
    const l = await DE.get(A('/backups'));
    m.innerHTML = '<div class="row between"><h1>Backups</h1><button class="btn primary" id="mk">Back up now</button></div><p class="muted">A backup is made automatically every 6 hours. Downloading one asks for your password.</p><div class="card">' + T(l, [['file', 'File'], ['size', 'Size', r => Math.round(r.size / 1024) + ' KB'], ['x', '', r => '<button class="btn sm" data-dl="' + esc(r.file) + '">Download</button>']]) + '</div>';
    $('#mk').onclick = async () => { await call(() => DE.post(A('/backups')), 'Backup created'); reload(); };
    $$('[data-dl]', m).forEach(b => b.onclick = async () => { const pw = await stepUp(); if (pw === null) return; const res = await fetch('/api/admin/backups/' + encodeURIComponent(b.dataset.dl) + '/download', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'DigitalEnviro' }, body: JSON.stringify({ password: pw }) }); if (!res.ok) return DE.toast('Wrong password or download failed', true); const u = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href = u; a.download = b.dataset.dl; a.click(); URL.revokeObjectURL(u); });
  };

  R.audit = async m => {
    const rows = await DE.get(A('/audit'));
    m.innerHTML = '<h1>Audit log</h1><p class="muted">Everything admins did, including who looked at private user details.</p><div class="card">' + T(rows, [['created_at', 'When', r => when(r.created_at)], ['username', 'Who', r => '@' + esc(r.username || '?')], ['action', 'Action'], ['detail', 'Detail', r => esc(String(r.detail || '').slice(0, 120))]]) + '</div>';
  };

  // ------------------------------------------------------------ boot
  async function boot() {
    try { DE.world = await DE.get('/public/world'); const c = await DE.get('/public/config'); DE.config = Object.assign(DE.config || {}, c); } catch (e) { /* ignore */ }
    const th = DE.store.get('de_theme'); if (th) document.documentElement.dataset.theme = th;
    try { ME = await DE.get(A('/me')); } catch (e) { return loginScreen(e.status === 403 ? 'This account is not an admin. Sign in with an admin account.' : null); }
    const h = (location.hash || '').slice(1); if (h && R[h] && visible(SECTIONS.find(s => s[0] === h))) SECTION = h;
    frame(); load();
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
