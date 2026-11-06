/* Notifications, policy, custom pages, AI assistant */
(function () {
  const { esc } = DE;

  DE.route('/notifications', async view => {
    DE.title('Notifications');
    const r = await DE.get('/notifications');
    view.innerHTML = '<div class="row between"><h1>Notifications</h1><div class="row"><button class="btn sm" id="readAll">Mark all read</button><button class="btn sm danger" id="clearAll">Clear</button></div></div>' +
      '<div class="card">' + (r.items.length ? r.items.map(n => '<a class="row notif' + (n.is_read ? '' : ' unread') + '" href="' + esc(n.link || '/notifications') + '" style="padding:10px 4px;color:inherit;border-bottom:1px solid var(--line)"><span class="grow">' + esc(n.text) + '</span><span class="muted small">' + DE.timeago(n.created_at) + '</span></a>').join('') : '<p class="muted center">Nothing yet. We will let you know when something happens.</p>') + '</div>';
    DE.$('#readAll').onclick = async () => { await DE.post('/notifications/read'); DE.notifUnread = 0; DE.renderChrome(); DE.render(); };
    DE.$('#clearAll').onclick = async () => { await DE.del('/notifications'); DE.notifUnread = 0; DE.renderChrome(); DE.render(); };
    if (r.unread) { DE.post('/notifications/read').then(() => { DE.notifUnread = 0; DE.renderChrome(); }).catch(() => {}); }
  }, { auth: true });

  DE.route('/policy', async view => {
    DE.title('Community policy');
    const r = await DE.get('/public/policy');
    view.innerHTML = '<div class="card prose"><h1>Community policy</h1>' + (r.html || '<p>No policy has been published yet.</p>') + '</div>';
  });

  DE.route('/page/:slug', async (view, p) => {
    const r = await DE.get('/public/custom/' + encodeURIComponent(p.slug));
    DE.title(r.title);
    view.innerHTML = '<div class="card prose"><h1>' + esc(r.title) + '</h1>' + r.content + '</div>';
  });

  DE.route('/assistant', async view => {
    DE.title('AI tutor');
    const st = await DE.get('/ai/status');
    if (!st.ready) {
      view.innerHTML = '<div class="card center" style="max-width:520px;margin:30px auto"><div style="font-size:3rem">🤖</div><h1>' + esc(st.name) + ' is coming soon</h1><p class="muted">Our AI tutor is being prepared. Soon you will be able to ask it anything about the skills you are learning. We will tell you the moment it is live.</p><a class="btn primary" href="/">Back home</a></div>';
      return;
    }
    const history = [];
    view.innerHTML = '<h1>' + esc(st.name) + '</h1><div class="card chatbox"><div id="aiMsgs" class="aimsgs"><div class="msg them">Hi! I am ' + esc(st.name) + '. Ask me anything about the skills you want to learn.</div></div>' +
      '<form id="aiF" class="row" style="margin-top:10px"><input class="i grow" id="aiQ" maxlength="2000" placeholder="Ask a question…" autocomplete="off" required><button class="btn primary">Send</button></form>' +
      (st.daily_limit ? '<div class="muted small" id="aiLeft">' + st.remaining + ' of ' + st.daily_limit + ' questions left today</div>' : '') + '</div>';
    const box = DE.$('#aiMsgs');
    DE.$('#aiF').onsubmit = async e => {
      e.preventDefault();
      const q = DE.$('#aiQ').value.trim(); if (!q) return;
      DE.$('#aiQ').value = '';
      history.push({ role: 'user', content: q });
      box.insertAdjacentHTML('beforeend', '<div class="msg me">' + esc(q) + '</div><div class="msg them" id="aiWait">…</div>');
      box.scrollTop = box.scrollHeight;
      try {
        const r = await DE.post('/ai/chat', { messages: history });
        history.push({ role: 'assistant', content: r.reply });
        DE.$('#aiWait').outerHTML = '<div class="msg them" style="white-space:pre-wrap">' + esc(r.reply) + '</div>';
        const l = DE.$('#aiLeft'); if (l && st.remaining) { st.remaining--; l.textContent = st.remaining + ' of ' + st.daily_limit + ' questions left today'; }
      } catch (ex) { DE.$('#aiWait').outerHTML = '<div class="msg them err">' + esc(ex.message) + '</div>'; history.pop(); }
      box.scrollTop = box.scrollHeight;
    };
  }, { auth: true });
})();
