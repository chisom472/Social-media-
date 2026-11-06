/* Chat (WhatsApp-style): DMs, group chats, replies, reactions, edit/delete, stars, files, voice notes, typing, read receipts, presence */
(function () {
  const { esc } = DE;
  const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

  function msgHTML(m, conv) {
    const mine = DE.user && m.sender_id === DE.user.id;
    if (m.type === 'system') return '<div class="msg sys" data-id="' + m.id + '">' + esc(m.body) + '</div>';
    let inner = '';
    if (!mine && conv && conv.type === 'group') inner += '<div class="who">' + esc(m.display_name || m.username) + '</div>';
    if (m.reply_to) inner += '<div class="quote"><b>@' + esc(m.reply_to.username) + '</b><br>' + esc(String(m.reply_to.body).slice(0, 80)) + '</div>';
    if (m.deleted) inner += '<i class="muted">🚫 This message was deleted</i>';
    else {
      if (m.media) {
        if (m.type === 'image') inner += '<a href="' + esc(m.media) + '" target="_blank" data-external><img src="' + esc(m.media) + '" alt="Image" loading="lazy"></a>';
        else if (m.type === 'video') inner += '<video src="' + esc(m.media) + '" controls preload="metadata"></video>';
        else if (m.type === 'audio' || m.type === 'voice') inner += '<audio src="' + esc(m.media) + '" controls preload="none"></audio>';
        else inner += '<a href="' + esc(m.media) + '" target="_blank" data-external download>📎 Download file</a>';
      }
      if (m.body) inner += '<div style="white-space:pre-wrap">' + esc(m.body) + '</div>';
    }
    const react = m.reactions && m.reactions.length ? '<div class="react">' + m.reactions.map(r => '<span>' + esc(r.emoji) + ' ' + r.c + '</span>').join('') + '</div>' : '';
    const tools = m.deleted ? '' : '<div class="tools"><button data-m="react" title="React">😊</button><button data-m="reply" title="Reply">↩</button><button data-m="star" title="Star">' + (m.starred ? '★' : '☆') + '</button>' +
      (mine && m.type === 'text' ? '<button data-m="edit" title="Edit">✎</button>' : '') + (mine ? '<button data-m="del" title="Delete for everyone">🗑</button>' : '') + '</div>';
    return '<div class="msg ' + (mine ? 'me' : '') + '" data-id="' + m.id + '">' + tools + inner + react + '<div class="meta">' + (m.edited ? 'edited · ' : '') + DE.clock(m.created_at) + (mine ? ' <span class="ticks ' + (m.read ? 'read' : '') + '">' + (m.read ? '✓✓' : '✓') + '</span>' : '') + '</div></div>';
  }

  function listHTML(list, activeId) {
    return list.map(c => '<div class="conv ' + (c.id === activeId ? 'on' : '') + '" data-conv="' + c.id + '">' + DE.avatar({ avatar: c.avatar, username: c.title, display_name: c.title }) +
      '<div class="grow"><div class="row between"><span class="t">' + esc(c.title) + (c.type === 'group' ? ' 👥' : '') + '</span><span class="muted small">' + (c.last ? DE.timeago(c.last.created_at) : '') + '</span></div>' +
      '<div class="row between"><span class="l">' + (c.last ? (c.last.mine ? 'You: ' : '') + esc(c.last.body) : 'No messages yet') + '</span>' + (c.unread ? '<span class="badge">' + c.unread + '</span>' : '') + '</div></div></div>').join('') || '<div class="empty">No chats yet. Start one with the + button.</div>';
  }

  async function render(view, convId) {
    DE.title('Chat');
    let convs = await DE.get('/chat/conversations');
    let active = convId ? convs.find(c => c.id === convId) : null;
    let replyTo = null, editing = null, typingTimer = null, rec = null, recChunks = [];
    const typers = {};

    view.innerHTML = '<div class="chatwrap ' + (convId ? 'inconv' : '') + '" id="cw"><div class="convlist"><div class="row between" style="padding:10px"><b>Chats</b><div class="row"><button class="icon-btn" id="newDm" title="New chat">＋</button><button class="icon-btn" id="newGrp" title="New group">👥</button><button class="icon-btn" id="starred" title="Starred messages">★</button></div></div>' +
      '<div style="padding:0 10px 8px"><input class="i" id="msearch" placeholder="Search messages..."></div><div id="convs">' + listHTML(convs, convId) + '</div></div>' +
      '<div class="chatpane" id="pane">' + (active ? '' : '<div class="empty" style="margin:auto">Select a chat or start a new one 💬</div>') + '</div></div>';

    const $ = s => DE.$(s, view);
    const convsEl = $('#convs');
    function refreshList() { return DE.get('/chat/conversations').then(l => { convs = l; convsEl.innerHTML = listHTML(convs, convId); }); }
    convsEl.onclick = e => { const c = e.target.closest('[data-conv]'); if (c) DE.navigate('/chat/' + c.dataset.conv); };

    $('#newDm').onclick = () => DE.modal('<h2>New chat</h2><input class="i" id="uq" placeholder="Search by username or name"><div id="ures"></div>', m => {
      let t; m.querySelector('#uq').oninput = e => { clearTimeout(t); t = setTimeout(async () => {
        const r = await DE.get('/users/search?q=' + encodeURIComponent(e.target.value)).catch(() => ({ users: [] }));
        m.querySelector('#ures').innerHTML = r.users.filter(u => u.id !== DE.user.id).map(u => '<div class="row" style="padding:6px 0;cursor:pointer" data-u="' + esc(u.username) + '">' + DE.avatar(u, 'sm') + '<span>' + esc(u.display_name || u.username) + ' <span class="muted small">@' + esc(u.username) + '</span></span></div>').join('') || '<p class="muted">No users found (type at least 3 letters).</p>';
      }, 300); };
      m.onclick = async e => { const r = e.target.closest('[data-u]'); if (r) { const d = await DE.post('/chat/dm/' + r.dataset.u); DE.$('#modalRoot').innerHTML = ''; DE.navigate('/chat/' + d.id); } };
    });
    $('#newGrp').onclick = () => DE.modal('<h2>New group chat</h2><label class="f">Group name</label><input class="i" id="gname" maxlength="60"><label class="f">Add people (usernames, comma separated)</label><input class="i" id="gusers" placeholder="chisom, ada, tunde"><div class="err" id="gerr"></div><div class="row" style="margin-top:12px"><button class="btn primary" id="gok">Create group</button><button class="btn" data-close>Cancel</button></div>', (m, close) => {
      m.querySelector('#gok').onclick = async () => { try { const r = await DE.post('/chat/groups', { name: m.querySelector('#gname').value, usernames: m.querySelector('#gusers').value.split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean) }); close(); DE.navigate('/chat/' + r.id); } catch (ex) { m.querySelector('#gerr').textContent = ex.message; } };
    });
    $('#starred').onclick = async () => { const l = await DE.get('/chat/starred-all'); DE.modal('<h2>Starred messages</h2>' + (l.map(m => '<div class="card flat" style="margin:6px 0"><b>@' + esc(m.username) + '</b> <span class="muted small">' + DE.timeago(m.created_at) + '</span><div>' + esc(m.body || '[' + m.type + ']') + '</div></div>').join('') || '<p class="muted">No starred messages.</p>') + '<button class="btn" data-close>Close</button>'); };
    let st; $('#msearch').oninput = e => { clearTimeout(st); st = setTimeout(async () => {
      const q = e.target.value.trim(); if (q.length < 4) { convsEl.innerHTML = listHTML(convs, convId); return; }
      const r = await DE.get('/chat/messages-search?q=' + encodeURIComponent(q)).catch(() => []);
      convsEl.innerHTML = r.map(x => '<div class="conv" data-conv="' + x.conversation_id + '"><div class="grow"><div class="l">' + esc(x.body.slice(0, 80)) + '</div><div class="muted small">' + DE.timeago(x.created_at) + '</div></div></div>').join('') || '<div class="empty">No matches.</div>';
    }, 350); };

    if (!active) return;
    const pane = $('#pane');
    const isGroup = active.type === 'group';
    const other = !isGroup ? active.members.find(m => m.id !== DE.user.id) : null;
    pane.innerHTML = '<div class="chathead"><button class="icon-btn" id="back">←</button>' + DE.avatar({ avatar: active.avatar, username: active.title, display_name: active.title }, 'sm') +
      '<div class="grow"><b>' + esc(active.title) + '</b><div class="muted small" id="sub">' + (isGroup ? active.members.length + ' members' : '') + '</div></div>' +
      '<button class="icon-btn" id="muteB" title="Mute">' + (active.muted ? '🔕' : '🔔') + '</button>' + (isGroup ? '<button class="icon-btn" id="info" title="Group info">ℹ</button>' : '') + '</div>' +
      '<div class="msgs" id="msgs"></div><div class="typing" id="typing"></div><div id="replybar"></div>' +
      '<form class="composer" id="cf"><label class="icon-btn" title="Attach file" style="cursor:pointer">📎<input type="file" id="cfile" hidden></label><textarea id="ctext" rows="1" placeholder="Type a message"></textarea><button type="button" class="icon-btn" id="mic" title="Voice note">🎤</button><button class="btn primary" id="send">Send</button></form>';
    $('#back').onclick = () => DE.navigate('/chat');
    const msgsEl = $('#msgs');

    const messages = await DE.get('/chat/' + convId + '/messages');
    const byId = {}; messages.forEach(m => (byId[m.id] = m));
    msgsEl.innerHTML = messages.map(m => msgHTML(m, active)).join('');
    msgsEl.scrollTop = msgsEl.scrollHeight;
    const markRead = () => DE.post('/chat/' + convId + '/read').then(refreshList).catch(() => {});
    markRead();
    DE.get('/chat/conversations').then(() => {});
    if (DE.socket && other) DE.socket.emit('presence:query', [other.id], r => { const s = $('#sub'); if (s) s.textContent = r[other.id] ? 'online' : 'offline'; });

    function put(m) {
      byId[m.id] = m;
      const old = msgsEl.querySelector('[data-id="' + m.id + '"]');
      const tmp = document.createElement('div'); tmp.innerHTML = msgHTML(m, active);
      if (old) old.replaceWith(tmp.firstChild);
      else { const near = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 160; msgsEl.appendChild(tmp.firstChild); if (near || m.sender_id === DE.user.id) msgsEl.scrollTop = msgsEl.scrollHeight; }
    }

    // ---- realtime ----
    const sock = DE.socket;
    const on = {
      'message:new': m => { if (m.conversation_id !== convId) return; put(m); if (m.sender_id !== DE.user.id) markRead(); },
      'message:update': m => { if (m.conversation_id === convId) put(m); },
      'conversation:read': d => { if (d.conversation_id === convId && d.user_id !== DE.user.id) DE.$$('.msg.me .ticks', msgsEl).forEach(t => { t.classList.add('read'); t.textContent = '✓✓'; }); },
      'typing': d => {
        if (d.conversation_id !== convId) return;
        if (d.typing) typers[d.user_id] = d.username; else delete typers[d.user_id];
        const names = Object.values(typers); const t = $('#typing'); if (t) t.textContent = names.length ? names.join(', ') + ' typing...' : '';
      },
      'presence': d => { if (other && d.user_id === other.id) { const s = $('#sub'); if (s) s.textContent = d.online ? 'online' : 'offline'; } },
      'conversation:update': d => { if (d.id === convId) DE.render(); }
    };
    if (sock) { Object.entries(on).forEach(([e, f]) => sock.on(e, f)); sock.emit('conversation:join', convId); }
    DE.cleanup = () => { if (sock) Object.entries(on).forEach(([e, f]) => sock.off(e, f)); if (rec && rec.state === 'recording') rec.stop(); };

    // ---- sending ----
    const ctext = $('#ctext');
    ctext.addEventListener('input', () => {
      ctext.style.height = 'auto'; ctext.style.height = Math.min(120, ctext.scrollHeight) + 'px';
      if (sock) { sock.emit('typing', { conversation_id: convId, typing: true }); clearTimeout(typingTimer); typingTimer = setTimeout(() => sock.emit('typing', { conversation_id: convId, typing: false }), 1800); }
    });
    ctext.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 800) { e.preventDefault(); $('#cf').requestSubmit(); } });
    function setReply(m) { replyTo = m; const rb = $('#replybar'); rb.innerHTML = m ? '<div class="replybar"><span>Replying to <b>@' + esc(m.username) + '</b>: ' + esc((m.body || '[' + m.type + ']').slice(0, 60)) + '</span><button class="icon-btn" id="cr">✕</button></div>' : ''; if (m) $('#cr').onclick = () => setReply(null); }
    async function sendFile(file, voice) {
      const fd = new FormData(); fd.append('media', file); if (voice) fd.append('voice', '1'); if (replyTo) fd.append('reply_to', replyTo.id); fd.append('body', ctext.value);
      ctext.value = ''; setReply(null);
      try { await DE.post('/chat/' + convId + '/messages', fd); } catch (ex) { DE.fail(ex); }
    }
    $('#cfile').onchange = e => { if (e.target.files[0]) sendFile(e.target.files[0]); e.target.value = ''; };
    $('#cf').onsubmit = async e => {
      e.preventDefault();
      const body = ctext.value.trim(); if (!body) return;
      try {
        if (editing) { await DE.put('/chat/messages/' + editing.id, { body }); editing = null; $('#send').textContent = 'Send'; }
        else await DE.post('/chat/' + convId + '/messages', { body, reply_to: replyTo ? replyTo.id : null });
        ctext.value = ''; ctext.style.height = 'auto'; setReply(null);
        if (sock) sock.emit('typing', { conversation_id: convId, typing: false });
      } catch (ex) { DE.fail(ex); }
    };

    // voice notes
    $('#mic').onclick = async () => {
      const mic = $('#mic');
      if (rec && rec.state === 'recording') { rec.stop(); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recChunks = []; rec = new MediaRecorder(stream);
        rec.ondataavailable = e => recChunks.push(e.data);
        rec.onstop = () => { stream.getTracks().forEach(t => t.stop()); mic.textContent = '🎤'; const type = rec.mimeType || 'audio/webm'; const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'; sendFile(new File(recChunks, 'voice-note.' + ext, { type: type.split(';')[0] }), true); };
        rec.start(); mic.textContent = '⏹';
        DE.toast('Recording... tap again to send');
      } catch (e) { DE.toast('Microphone permission is needed for voice notes.', true); }
    };

    // message actions
    msgsEl.onclick = async e => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      const el = b.closest('.msg'); const m = byId[el.dataset.id]; const act = b.dataset.m;
      try {
        if (act === 'reply') { setReply(m); ctext.focus(); }
        else if (act === 'star') { await DE.post('/chat/messages/' + m.id + '/star'); m.starred = !m.starred; put(m); }
        else if (act === 'del') { if (await DE.confirm('Delete this message for everyone?', 'Delete')) await DE.del('/chat/messages/' + m.id); }
        else if (act === 'edit') { editing = m; ctext.value = m.body; ctext.focus(); $('#send').textContent = 'Save'; }
        else if (act === 'react') {
          DE.modal('<div class="row wrap" style="justify-content:center;font-size:1.8rem">' + EMOJIS.map(x => '<button class="icon-btn" style="font-size:1.8rem" data-e="' + x + '">' + x + '</button>').join('') + '</div>', (mm, close) => {
            DE.$$('[data-e]', mm).forEach(x => x.onclick = async () => { close(); await DE.post('/chat/messages/' + m.id + '/react', { emoji: x.dataset.e }); });
          });
        }
      } catch (ex) { DE.fail(ex); }
    };

    $('#muteB').onclick = async () => { active.muted = !active.muted; await DE.post('/chat/' + convId + '/mute', { muted: active.muted }); $('#muteB').textContent = active.muted ? '🔕' : '🔔'; };
    const info = $('#info');
    if (info) info.onclick = () => {
      const admin = active.members.find(m => m.id === DE.user.id && m.role === 'admin');
      DE.modal('<h2>' + esc(active.title) + '</h2>' + active.members.map(m => '<div class="row" style="padding:5px 0">' + DE.avatar(m, 'sm') + '<span class="grow">' + esc(m.display_name || m.username) + (m.role === 'admin' ? ' <span class="tag">admin</span>' : '') + '</span>' + (admin && m.id !== DE.user.id ? '<button class="btn sm danger" data-rm="' + m.id + '">Remove</button>' : '') + '</div>').join('') +
        (admin ? '<div class="row" style="margin-top:10px"><input class="i" id="addu" placeholder="Add username"><button class="btn" id="addb">Add</button></div>' : '') + '<div class="row" style="margin-top:12px"><button class="btn danger" id="leave">Leave group</button><button class="btn" data-close>Close</button></div>', (m, close) => {
        DE.$$('[data-rm]', m).forEach(b => b.onclick = async () => { await DE.post('/chat/' + convId + '/members/' + b.dataset.rm + '/remove'); close(); });
        const ab = m.querySelector('#addb'); if (ab) ab.onclick = async () => { try { await DE.post('/chat/' + convId + '/members', { username: m.querySelector('#addu').value.replace(/^@/, '') }); close(); } catch (ex) { DE.fail(ex); } };
        m.querySelector('#leave').onclick = async () => { await DE.post('/chat/' + convId + '/leave'); close(); DE.navigate('/chat'); };
      });
    };
  }

  DE.route('/chat', (view) => render(view, null), { auth: true });
  DE.route('/chat/:id', (view, p) => render(view, parseInt(p.id, 10)), { auth: true });
})();
