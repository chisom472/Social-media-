/* Shared UI components: avatars, posts, composer, comments, payments, support modal */
(function () {
  const { esc } = DE;

  DE.avatar = function (u, cls) {
    u = u || {};
    cls = cls || '';
    if (u.avatar) return '<img class="av ' + cls + '" src="' + esc(u.avatar) + '" alt="" loading="lazy">';
    return '<span class="av ' + cls + '" aria-hidden="true" style="background:hsl(' + DE.hue(u) + ' 55% 36%);color:#fff">' + esc(DE.initial(u)) + '</span>';
  };

  DE.pwField = function (id, label, opts) {
    opts = opts || {};
    return '<label class="f" for="' + id + '">' + esc(label) + '</label><div class="pw"><input class="i" id="' + id + '" type="password" autocomplete="' + (opts.autocomplete || 'current-password') + '" ' + (opts.min ? 'minlength="8"' : '') + ' required>' +
      '<button type="button" class="icon-btn" data-act="toggle-pw" aria-label="Show or hide password" title="Show / hide password">👁</button></div>';
  };

  DE.categorySelect = function (id, selected, allowEmpty) {
    return '<select class="i" id="' + id + '">' + (allowEmpty ? '<option value="">Choose a topic</option>' : '') +
      DE.config.categories.map(c => '<option' + (c === selected ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>';
  };

  DE.followBtn = function (u) {
    if (DE.user && DE.user.id === u.id) return '';
    return '<button class="btn sm ' + (u.following ? '' : 'primary') + '" data-act="follow" data-username="' + esc(u.username) + '" data-state="' + (u.following ? 1 : 0) + '">' + (u.following ? 'Following' : 'Follow') + '</button>';
  };

  DE.userRow = function (u, extra) {
    return '<div class="row" style="padding:8px 0"><a href="/u/' + esc(u.username) + '">' + DE.avatar(u) + '</a><div class="grow"><a href="/u/' + esc(u.username) + '"><b>' + esc(u.display_name || u.username) + '</b></a>' +
      '<div class="muted small">@' + esc(u.username) + (u.is_creator ? ' · creator' : '') + (u.followers != null ? ' · ' + u.followers + ' followers' : '') + '</div></div>' + (extra === false ? '' : DE.followBtn(u)) + '</div>';
  };

  // ---------- Post card ----------
  DE.mediaHTML = function (p) {
    if (!p.media) return '';
    if (p.type === 'image') return '<div class="media"><img src="' + esc(p.media) + '" alt="' + esc(p.title || 'Post image') + '" loading="lazy"></div>';
    if (p.type === 'video') return '<div class="media"><video src="' + esc(p.media) + '" controls preload="metadata" playsinline></video></div>';
    if (p.type === 'audio') return '<div class="media"><audio src="' + esc(p.media) + '" controls preload="none"></audio></div>';
    if (p.type === 'story') {
      if (/\.(mp4|webm|mov|ogg)$/i.test(p.media)) return '<div class="media"><video src="' + esc(p.media) + '" controls playsinline></video></div>';
      if (/\.(mp3|wav|m4a|aac)$/i.test(p.media)) return '<div class="media"><audio src="' + esc(p.media) + '" controls></audio></div>';
      return '<div class="media"><img src="' + esc(p.media) + '" alt="Story"></div>';
    }
    return '';
  };

  DE.postCard = function (p, opts) {
    opts = opts || {};
    const mine = DE.user && DE.user.id === p.user_id;
    return '<article class="card post" data-post="' + p.id + '">' +
      '<div class="head"><a href="/u/' + esc(p.username) + '">' + DE.avatar(p) + '</a><div class="grow"><a class="name" href="/u/' + esc(p.username) + '">' + esc(p.display_name || p.username) + '</a>' +
      '<div class="muted small">@' + esc(p.username) + ' · ' + DE.timeago(p.created_at) + (p.category ? ' · ' + esc(p.category) : '') + '</div></div>' +
      (mine || (DE.user && DE.user.role === 'admin') ? '<button class="icon-btn" data-act="delete-post" data-id="' + p.id + '" title="Delete post" aria-label="Delete post">🗑</button>' : (DE.user ? '<button class="icon-btn" data-act="report" data-type="post" data-id="' + p.id + '" title="Report" aria-label="Report">⚑</button>' : '')) + '</div>' +
      (p.title ? '<h3 style="margin-top:10px"><a href="/post/' + p.id + '" style="color:inherit">' + esc(p.title) + '</a></h3>' : '') +
      (p.body ? '<div class="body" style="margin-top:8px">' + esc(p.body) + '</div>' : '') +
      DE.mediaHTML(p) +
      (p.original_owner ? '<div class="owner-note">✔ Original creator: <a href="/u/' + esc(p.original_owner) + '">@' + esc(p.original_owner) + '</a> - this file is registered to its owner</div>' : '') +
      ((p.tags && p.tags.length) ? '<div style="margin-top:8px">' + p.tags.map(t => '<span class="tag">#' + esc(t) + '</span>').join('') + '</div>' : '') +
      '<div class="actions">' +
      '<span class="react"><button class="act ' + (p.liked ? 'on' : '') + '" data-act="like" data-id="' + p.id + '">' + (p.my_reaction || (p.liked ? '❤️' : '♡')) + ' <span>' + p.likes + '</span></button><span class="react-pop">' + DE.REACTIONS.map(r => '<button type="button" data-act="react" data-id="' + p.id + '" data-emoji="' + r + '" aria-label="React ' + r + '">' + r + '</button>').join('') + '</span></span>' +
      '<a class="act" href="/post/' + p.id + '">💬 ' + p.comments + '</a>' +
      (mine ? '<button class="act" data-act="viewers" data-id="' + p.id + '">👁 ' + p.views + ' views</button>' : '<span class="act" style="cursor:default">👁 ' + p.views + '</span>') +
      (!mine && DE.user && DE.config.flags.tips !== false ? '<button class="act" data-act="support" data-username="' + esc(p.username) + '">💚 Support</button>' : '') +
      '<button class="act" data-act="share" data-id="' + p.id + '">↗ Share</button>' +
      '</div>' + (opts.comments ? '<div class="comments" id="commentsBox"></div>' : '') + '</article>';
  };

  // record views as posts scroll into view (the owner sees who viewed)
  const seen = new Set();
  let viewObserver = null;
  DE.observeViews = function (root) {
    if (!DE.user || !('IntersectionObserver' in window)) return;
    if (!viewObserver) {
      viewObserver = new IntersectionObserver(entries => {
        entries.forEach(en => {
          if (!en.isIntersecting) return;
          const id = en.target.getAttribute('data-post');
          if (!id || seen.has(id)) return;
          seen.add(id);
          DE.post('/posts/' + id + '/view').catch(() => {});
          viewObserver.unobserve(en.target);
        });
      }, { threshold: 0.6 });
    }
    DE.$$('.post[data-post]', root).forEach(el => viewObserver.observe(el));
  };

  // ---------- Composer ----------
  DE.composer = function (opts) {
    opts = opts || {};
    return '<form class="card" id="composer"><div class="row" style="align-items:flex-start">' + DE.avatar(DE.user) +
      '<div class="grow"><textarea class="i" name="body" placeholder="' + esc(opts.placeholder || 'Share a tip, idea, tutorial or something you made...') + '" maxlength="5000"></textarea>' +
      '<div class="row wrap" style="margin-top:8px">' +
      '<select class="i" name="type" style="width:auto"><option value="text">Text</option><option value="image">Picture</option><option value="video">Video</option><option value="audio">Song / audio</option>' + (opts.noStory || DE.config.flags.stories === false ? '' : '<option value="story">Story (24h)</option>') + '</select>' +
      '<input type="file" name="media" id="composerFile" accept="image/*,video/*,audio/*" class="i" style="width:auto;max-width:210px">' +
      '<select class="i" name="category" style="width:auto"><option value="">Topic</option>' + DE.config.categories.map(c => '<option>' + esc(c) + '</option>').join('') + '</select>' +
      '<input class="i" name="title" placeholder="Title (optional)" style="width:auto;flex:1;min-width:140px">' +
      '<input class="i" name="tags" placeholder="#tags, comma separated" style="width:auto;flex:1;min-width:140px">' +
      '<button class="btn primary" type="submit">Post</button></div><div class="err" id="composerErr"></div></div></div></form>';
  };

  DE.bindComposer = function (root, extra, onPosted) {
    const form = DE.$('#composer', root);
    if (!form) return;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(form);
      if (extra) Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
      const file = fd.get('media');
      if (!file || !file.size) fd.delete('media');
      else if (fd.get('type') === 'text') { fd.set('type', file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'audio'); }
      const err = DE.$('#composerErr', form); err.textContent = '';
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Posting...';
      try {
        const p = await DE.post('/posts', fd);
        form.reset();
        DE.toast('Posted!');
        onPosted && onPosted(p);
      } catch (ex) {
        err.textContent = ex.message;
      } finally { btn.disabled = false; btn.textContent = 'Post'; }
    });
  };

  // ---------- Comments ----------
  DE.loadComments = async function (postId, box) {
    const list = await DE.get('/posts/' + postId + '/comments');
    const byParent = {};
    list.forEach(c => (byParent[c.parent_id || 0] = byParent[c.parent_id || 0] || []).push(c));
    const draw = (pid, depth) => (byParent[pid] || []).map(c =>
      '<div class="comment" style="margin-left:' + Math.min(depth, 3) * 28 + 'px">' + DE.avatar(c, 'sm') +
      '<div class="bubble"><a href="/u/' + esc(c.username) + '"><b>' + esc(c.display_name || c.username) + '</b></a> <span class="muted small">' + DE.timeago(c.created_at) + '</span><div style="white-space:pre-wrap;word-break:break-word">' + esc(c.body) + '</div>' +
      (DE.user ? '<div class="small"><a href="#" data-act="reply" data-id="' + c.id + '" data-name="' + esc(c.username) + '">Reply</a>' + (DE.user.id === c.user_id || DE.user.role === 'admin' ? ' · <a href="#" data-act="del-comment" data-id="' + c.id + '">Delete</a>' : '') + '</div>' : '') +
      '</div></div>' + draw(c.id, depth + 1)).join('');
    box.innerHTML = (DE.user ? '<form id="commentForm" class="row"><input class="i" name="body" placeholder="Write a comment..." maxlength="2000" required><input type="hidden" name="parent_id"><button class="btn primary sm">Send</button></form><div class="small muted" id="replyingTo"></div>' : '<p class="muted"><a href="/login">Log in</a> to join the discussion.</p>') +
      '<div id="commentList">' + (list.length ? draw(0, 0) : '<div class="empty">No comments yet. Start the discussion!</div>') + '</div>';
    const f = DE.$('#commentForm', box);
    if (f) f.addEventListener('submit', async e => {
      e.preventDefault();
      const body = f.body.value.trim();
      if (!body) return;
      try {
        await DE.post('/posts/' + postId + '/comments', { body, parent_id: f.parent_id.value || null });
        DE.loadComments(postId, box);
      } catch (ex) { DE.fail(ex); }
    });
  };

  // ---------- Payments ----------
  DE.checkout = async function (payload) {
    try {
      const r = await DE.post('/pay/checkout', payload);
      if (r.manual) return DE.manualPayModal(r);
      DE.toast('Taking you to the secure payment page...');
      location.href = r.authorization_url;
    } catch (e) { DE.fail(e); }
  };

  // Pay by bank transfer / crypto straight to the owner: show where to send, then collect the reference for confirmation
  DE.manualPayModal = function (r) {
    const a = r.accounts || [];
    DE.modal('<h2>Send your payment</h2><p class="muted">Send exactly <b>' + esc(DE.money(r.amount, r.currency)) + '</b> using the details below, then enter your transfer reference or transaction hash. The owner confirms it and your purchase is unlocked.</p>' +
      (a.length ? a.map(x => '<div class="card flat mono small" style="word-break:break-all">' + (x.type === 'crypto' ? esc(x.coin) + ' (' + esc(x.network || '') + ')<br>' + esc(x.address) + (x.memo ? '<br>Memo/tag: ' + esc(x.memo) : '') : esc(x.bank_name) + '<br>' + esc(x.account_name) + '<br>' + esc(x.account_number) + (x.swift_bic ? '<br>SWIFT: ' + esc(x.swift_bic) : '')) + (x.instructions ? '<br>' + esc(x.instructions) : '') + '</div>').join('') : '<p class="err">No receiving account is set up yet.</p>') +
      '<label class="f">Transfer reference / transaction hash</label><input class="i" id="mpRef" maxlength="300"><label class="f">Note (optional)</label><input class="i" id="mpNote" maxlength="500">' +
      '<div class="row" style="margin-top:12px"><button class="btn primary" id="mpSend">I have paid</button><button class="btn" data-close>Later</button></div>', (m, close) => {
      m.querySelector('#mpSend').onclick = e => DE.busy(e.target, async () => { await DE.post('/pay/manual/' + encodeURIComponent(r.reference) + '/proof', { proof: m.querySelector('#mpRef').value, note: m.querySelector('#mpNote').value }); DE.toast('Thanks! We will confirm your payment shortly.'); close(); DE.navigate('/wallet'); });
    });
  };

  DE.supportModal = function (username) {
    if (!DE.user) { DE.navigate('/login?next=' + encodeURIComponent(location.pathname)); return; }
    DE.modal('<h2>Support @' + esc(username) + '</h2><p class="muted">Show some love to a creator whose content helps you.</p>' +
      '<div class="row"><div style="flex:1"><label class="f">Amount</label><input class="i" id="supAmt" type="number" min="1" step="any" placeholder="e.g. 10"></div><div style="flex:1"><label class="f">Currency</label>' + DE.currencySelect('supCur') + '</div></div>' +
      '<div id="supProv" class="small muted" style="margin-top:6px"></div>' +
      '<label class="f">Message (optional)</label><input class="i" id="supMsg" maxlength="200" placeholder="Thanks for the great content!">' +
      '<div class="row wrap" style="margin-top:14px"><button class="btn primary" id="supPay">Pay with card / bank</button><button class="btn" id="supWallet">Send from my wallet</button><button class="btn" data-close>Cancel</button></div>',
      (m, close) => {
        const showProv = async () => {
          const r = await DE.get('/pay/providers?currency=' + m.querySelector('#supCur').value).catch(() => ({ providers: [] }));
          m.querySelector('#supProv').textContent = r.providers.length ? 'Pay with: ' + r.providers.map(p => p.label.split(' (')[0]).join(' or ') : 'No card/bank payment method is enabled for this currency yet - you can still send from your wallet.';
        };
        m.querySelector('#supCur').onchange = showProv; showProv();
        m.querySelector('#supPay').onclick = e => DE.busy(e.target, () => DE.checkout({ purpose: 'support', to_username: username, amount: m.querySelector('#supAmt').value, currency: m.querySelector('#supCur').value, message: m.querySelector('#supMsg').value }));
        m.querySelector('#supWallet').onclick = e => DE.busy(e.target, async () => {
          await DE.post('/pay/reward', { to_username: username, amount: m.querySelector('#supAmt').value, currency: m.querySelector('#supCur').value, message: m.querySelector('#supMsg').value });
          DE.toast('Sent! Thank you for supporting a creator.'); close();
        });
      });
  };

  DE.rewardModal = function (username) { DE.supportModal(username); };

  // ---------- Global delegated actions ----------
  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'toggle-pw') {
      const inp = el.parentElement.querySelector('input');
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      el.textContent = show ? '🙈' : '👁';
      return;
    }
    if (el.tagName === 'A') e.preventDefault();
    const needLogin = () => { DE.toast('Please log in first.', true); DE.navigate('/login?next=' + encodeURIComponent(location.pathname)); };
    try {
      if (act === 'like' || act === 'react') {
        if (!DE.user) return needLogin();
        const r = await DE.post('/posts/' + el.dataset.id + '/like', act === 'react' ? { emoji: el.dataset.emoji } : {});
        const btn = el.closest('.react').querySelector('[data-act=like]');
        btn.classList.toggle('on', r.liked);
        btn.innerHTML = (r.my_reaction || '♡') + ' <span>' + r.likes + '</span>';
      } else if (act === 'follow') {
        if (!DE.user) return needLogin();
        const on = el.dataset.state === '1';
        await (on ? DE.del('/users/' + el.dataset.username + '/follow') : DE.post('/users/' + el.dataset.username + '/follow'));
        el.dataset.state = on ? '0' : '1';
        el.textContent = on ? 'Follow' : 'Following';
        el.classList.toggle('primary', on);
        DE.$$('[data-act=follow][data-username="' + el.dataset.username + '"]').forEach(b => { b.dataset.state = el.dataset.state; b.textContent = el.textContent; b.classList.toggle('primary', on); });
      } else if (act === 'delete-post') {
        if (!(await DE.confirm('Delete this post permanently?', 'Delete'))) return;
        await DE.del('/posts/' + el.dataset.id);
        const card = el.closest('.post'); if (card) card.remove();
        if (location.pathname.startsWith('/post/')) DE.navigate('/');
      } else if (act === 'viewers') {
        const list = await DE.get('/posts/' + el.dataset.id + '/viewers');
        DE.modal('<h2>Who viewed this post</h2>' + (list.length ? list.map(u => '<div class="row" style="padding:6px 0">' + DE.avatar(u, 'sm') + '<a class="grow" href="/u/' + esc(u.username) + '" data-close>' + esc(u.display_name || u.username) + ' <span class="muted small">@' + esc(u.username) + '</span></a><span class="muted small">' + DE.timeago(u.viewed_at) + '</span></div>').join('') : '<p class="muted">No views from other members yet.</p>') + '<div style="margin-top:12px"><button class="btn" data-close>Close</button></div>');
      } else if (act === 'support') {
        DE.supportModal(el.dataset.username);
      } else if (act === 'share') {
        const url = location.origin + '/post/' + el.dataset.id;
        if (navigator.share) { navigator.share({ title: document.title, url }).catch(() => {}); }
        else { await navigator.clipboard.writeText(url); DE.toast('Link copied!'); }
      } else if (act === 'report') {
        if (!DE.user) return needLogin();
        DE.modal('<h2>Report</h2><label class="f">What is wrong?</label><textarea class="i" id="repReason" maxlength="500"></textarea><div class="row" style="margin-top:12px"><button class="btn primary" id="repSend">Send report</button><button class="btn" data-close>Cancel</button></div>', (m, close) => {
          m.querySelector('#repSend').onclick = async () => { try { await DE.post('/users/report', { target_type: el.dataset.type, target_id: el.dataset.id, reason: m.querySelector('#repReason').value }); DE.toast('Thanks. The owner will review it.'); close(); } catch (ex) { DE.fail(ex); } };
        });
      } else if (act === 'reply') {
        const f = DE.$('#commentForm');
        if (f) { f.parent_id.value = el.dataset.id; f.body.focus(); DE.$('#replyingTo').textContent = 'Replying to @' + el.dataset.name; }
      } else if (act === 'del-comment') {
        await DE.del('/posts/comments/' + el.dataset.id);
        const m = location.pathname.match(/\/post\/(\d+)/);
        if (m) DE.loadComments(m[1], DE.$('#commentsBox'));
      } else if (act === 'logout') {
        await DE.post('/auth/logout').catch(() => {});
        DE.setSession(null); DE.renderChrome(); DE.navigate('/');
      } else if (act === 'block') {
        if (!(await DE.confirm('Block @' + el.dataset.username + '? You will not see each other\'s posts or messages.', 'Block'))) return;
        await DE.post('/users/' + el.dataset.username + '/block'); DE.toast('Blocked.'); DE.render();
      } else if (act === 'unblock') {
        await DE.del('/users/' + el.dataset.username + '/block'); DE.toast('Unblocked.'); DE.render();
      }
    } catch (ex) { DE.fail(ex); }
  });
})();
