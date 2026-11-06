/* Classes: browse, host, enrol (free or paid), live room (Jitsi), recorded lessons */
(function () {
  const { esc } = DE;
  const when = c => c.kind === 'recorded' ? 'Recorded course' : new Date(String(c.starts_at).replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const priceOf = c => c.price ? DE.money(c.price, c.currency) : 'Free';
  const card = c => '<a class="card flat classcard" href="/class/' + c.id + '" style="color:inherit;display:block">' + (c.cover ? '<img src="' + esc(c.cover) + '" alt="" loading="lazy" style="border-radius:10px;width:100%;max-height:150px;object-fit:cover">' : '') +
    '<h3>' + esc(c.title) + '</h3><div class="muted small">' + esc(when(c)) + ' · ' + esc(c.kind) + '</div><div class="muted small">by @' + esc(c.host) + ' in ' + esc(c.group_name) + '</div>' +
    '<div class="row" style="margin-top:6px"><span class="pill ' + (c.price ? 'warn' : 'ok') + '">' + priceOf(c) + '</span><span class="muted small">' + c.enrolled + ' enrolled' + (c.full ? ' · full' : '') + '</span></div></a>';

  DE.route('/classes', async (view, p, q) => {
    DE.title('Classes');
    const f = q.price || '';
    const list = await DE.get('/classes' + (f ? '?price=' + f : ''));
    view.innerHTML = '<div class="row between wrap"><h1>Classes</h1>' + (DE.user ? '<div class="row"><a class="btn" href="/my-classes">My classes</a><a class="btn primary" href="/classes/new">+ Host a class</a></div>' : '') + '</div>' +
      '<div class="chips"><a class="chip ' + (!f ? 'on' : '') + '" href="/classes">All</a><a class="chip ' + (f === 'free' ? 'on' : '') + '" href="/classes?price=free">Free</a><a class="chip ' + (f === 'paid' ? 'on' : '') + '" href="/classes?price=paid">Paid</a></div>' +
      (list.length ? '<div class="grid">' + list.map(card).join('') + '</div>' : '<div class="card empty">No classes yet. Be the first to host one!</div>');
  });

  DE.route('/my-classes', async view => {
    DE.title('My classes');
    const r = await DE.get('/classes/mine');
    view.innerHTML = '<h1>My classes</h1><h2>Hosting</h2>' + (r.hosting.length ? '<div class="grid">' + r.hosting.map(card).join('') + '</div>' : '<p class="muted">You are not hosting any class.</p>') +
      '<h2>Attending</h2>' + (r.attending.length ? '<div class="grid">' + r.attending.map(card).join('') + '</div>' : '<p class="muted">You have not enrolled in any class.</p>');
  }, { auth: true });

  DE.route('/classes/new', async view => {
    DE.title('Host a class');
    const groups = (await DE.get('/groups/mine')).filter(g => g.owner_id === DE.user.id);
    if (!groups.length) { view.innerHTML = '<div class="card empty"><h2>Create a community first</h2><p>Classes are hosted inside your own community.</p><a class="btn primary" href="/communities">Go to communities</a></div>'; return; }
    view.innerHTML = '<h1>Host a class</h1><form class="card" id="f"><label class="f">Community</label><select class="i" id="g">' + groups.map(g => '<option value="' + g.id + '">' + esc(g.name) + '</option>').join('') + '</select>' +
      '<label class="f">Title</label><input class="i" id="t" maxlength="120" required><label class="f">Description</label><textarea class="i" id="d" maxlength="3000"></textarea>' +
      '<label class="f">Type</label><select class="i" id="k"><option value="live">Live class (built-in video room)</option><option value="external">Live class (my own Zoom/Meet link)</option><option value="recorded">Recorded course (lessons)</option></select>' +
      '<div id="live"><div class="two"><div><label class="f">Starts</label><input class="i" type="datetime-local" id="s"></div><div><label class="f">Minutes</label><input class="i" type="number" id="m" value="60" min="10" max="720"></div></div><div id="ext" class="hidden"><label class="f">Meeting link</label><input class="i" id="u" placeholder="https://"></div></div>' +
      '<div class="two"><div><label class="f">Price (0 = free)</label><input class="i" type="number" id="p" min="0" step="any" value="0"></div><div><label class="f">Currency</label>' + DE.currencySelect('c') + '</div></div>' +
      '<div class="two"><div><label class="f">Seats (empty = unlimited)</label><input class="i" type="number" id="cap" min="1"></div><div><label class="f">Who can join</label><select class="i" id="o"><option value="members">Community members</option><option value="anyone">Anyone</option></select></div></div>' +
      '<div id="acc" class="card flat hidden"><h3>Community access after the class</h3><p class="muted small">Students of a paid community pay for access. Choose what happens to their subscription when this class is over. You can still change this later.</p><label class="row"><input type="radio" name="ap" value="keep" checked> Keep their subscription running as normal</label><label class="row"><input type="radio" name="ap" value="end"> End their subscription when the class is over</label><div id="grw" class="hidden"><label class="f">Keep access for this many extra days after the class (0 = end straight away)</label><input class="i" type="number" id="gr" min="0" max="365" value="0" style="max-width:140px"></div></div>' +
      '<div class="err" id="err"></div><button class="btn primary" style="margin-top:14px">Create class</button></form>';
    const gs = groups; const showAcc = () => { const g = gs.find(x => String(x.id) === DE.$('#g').value); DE.$('#acc').classList.toggle('hidden', !(g && g.price > 0)); };
    DE.$('#g').onchange = showAcc; showAcc();
    DE.$$('[name=ap]').forEach(r => (r.onchange = () => DE.$('#grw').classList.toggle('hidden', DE.$('[name=ap]:checked').value !== 'end')));
    const k = DE.$('#k'); const sync = () => { DE.$('#live').classList.toggle('hidden', k.value === 'recorded'); DE.$('#ext').classList.toggle('hidden', k.value !== 'external'); }; k.onchange = sync; sync();
    DE.$('#f').onsubmit = async e => {
      e.preventDefault();
      try {
        const r = await DE.post('/classes', { group_id: DE.$('#g').value, title: DE.$('#t').value, description: DE.$('#d').value, kind: k.value, starts_at: DE.$('#s').value ? new Date(DE.$('#s').value).toISOString() : '', duration_min: DE.$('#m').value, meeting_url: DE.$('#u').value,
          price: DE.$('#p').value, currency: DE.$('#c').value, capacity: DE.$('#cap').value, open_to: DE.$('#o').value, access_policy: DE.$('[name=ap]:checked').value, access_grace_days: DE.$('#gr').value });
        if (r.fee && r.fee.payable_now) DE.toast('Class created. Pay the hosting fee to publish it.');
        DE.navigate('/class/' + r.id);
      } catch (ex) { DE.$('#err').textContent = ex.message; }
    };
  }, { auth: true });

  function loadJitsi(domain) {
    return new Promise((res, rej) => { if (window.JitsiMeetExternalAPI) return res(); const s = document.createElement('script'); s.src = 'https://' + domain + '/external_api.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load the video room.')); document.head.appendChild(s); });
  }

  // Host controls: what happens to students' community subscription after the class, plus extend / end per student
  async function accessPanel(c) {
    const a = await DE.get('/classes/' + c.id + '/access');
    const row = s => '<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)">' + DE.avatar(s, 'sm') + '<span class="grow">@' + esc(s.username) + '<div class="muted small">' + (s.role === 'owner' ? 'Owner' : s.active ? (s.expires_at ? 'Access until ' + esc(String(s.expires_at).slice(0, 16)) : 'Lifetime access') : 'No active access') + '</div></span>' +
      (s.role === 'owner' ? '' : '<button class="btn sm" data-ext="' + s.id + '">+ Extend</button>' + (s.active ? '<button class="btn sm danger" data-end="' + s.id + '">End</button>' : '')) + '</div>';
    DE.modal('<h2>Student access</h2><p class="muted small">Applies to the paid community “' + esc(c.group_name) + '”.</p>' +
      '<div class="card flat"><b>When this class is over</b><label class="row"><input type="radio" name="p" value="keep"' + (a.policy === 'keep' ? ' checked' : '') + '> Keep subscriptions running</label><label class="row"><input type="radio" name="p" value="end"' + (a.policy === 'end' ? ' checked' : '') + '> End subscriptions</label>' +
      '<div class="row"><span class="small">Extra days of access after the class:</span><input class="i" type="number" id="gd" min="0" max="365" value="' + a.grace_days + '" style="max-width:90px"></div><button class="btn sm primary" id="savep" style="margin-top:8px">Save</button>' + (a.applied ? ' <span class="pill">Already applied</span>' : '') + '</div>' +
      '<div class="row wrap" style="margin:10px 0"><button class="btn" id="extAll">+ Extend everyone</button><button class="btn danger" id="endAll">End everyone’s access now</button></div>' +
      '<div style="max-height:40vh;overflow:auto">' + (a.students.map(row).join('') || '<p class="muted">No students yet.</p>') + '</div><div class="err" id="err"></div><button class="btn" data-close style="margin-top:10px">Close</button>', (m, close) => {
      const days = async () => { const v = prompt('How many days should access be extended by?', '30'); const n = parseInt(v, 10); if (!v) return 0; if (!(n >= 1)) { DE.toast('Enter a number of days.', true); return 0; } return n; };
      const done = r => { DE.toast(r.extended != null ? 'Extended for ' + r.extended + ' student(s)' : 'Ended for ' + r.ended + ' student(s)'); close(); accessPanel(c); };
      m.querySelector('#savep').onclick = async () => { try { await DE.put('/classes/' + c.id, { access_policy: m.querySelector('[name=p]:checked').value, access_grace_days: m.querySelector('#gd').value }); DE.toast('Saved'); } catch (e) { m.querySelector('#err').textContent = e.message; } };
      m.querySelector('#extAll').onclick = async () => { const n = await days(); if (n) done(await DE.post('/classes/' + c.id + '/access/extend', { days: n }).catch(DE.fail)); };
      m.querySelector('#endAll').onclick = async () => { if (await DE.confirm('End community access for every student of this class now? Students who still have another upcoming class in this community are skipped.', 'End access')) done(await DE.post('/classes/' + c.id + '/access/end', { grace_days: 0 }).catch(DE.fail)); };
      DE.$$('[data-ext]', m).forEach(b => b.onclick = async () => { const n = await days(); if (n) done(await DE.post('/classes/' + c.id + '/access/extend', { days: n, user_id: b.dataset.ext }).catch(DE.fail)); });
      DE.$$('[data-end]', m).forEach(b => b.onclick = async () => { if (await DE.confirm('End this student’s access now?', 'End access')) done(await DE.post('/classes/' + c.id + '/access/end', { grace_days: 0, user_id: b.dataset.end }).catch(DE.fail)); });
    });
  }

  DE.route('/class/:id', async (view, p) => {
    const c = await DE.get('/classes/' + p.id);
    DE.title(c.title);
    const inv = c.fee_invoice;
    view.innerHTML = '<article class="card">' + (c.cover ? '<img src="' + esc(c.cover) + '" alt="" style="border-radius:12px;width:100%;max-height:240px;object-fit:cover">' : '') +
      '<h1>' + esc(c.title) + '</h1><div class="muted">' + esc(when(c)) + (c.kind !== 'recorded' ? ' · ' + c.duration_min + ' min' : '') + ' · ' + esc(priceOf(c)) + '</div>' +
      '<div class="row" style="margin:8px 0"><a href="/u/' + esc(c.host) + '">' + DE.avatar({ username: c.host, display_name: c.host_name, avatar: c.host_avatar }, 'sm') + '</a><span>Hosted by <a href="/u/' + esc(c.host) + '">' + esc(c.host_name || c.host) + '</a> in <a href="/community/' + c.group_id + '">' + esc(c.group_name) + '</a></span></div>' +
      '<p style="white-space:pre-wrap">' + esc(c.description) + '</p><div class="muted small">' + c.enrolled + ' enrolled' + (c.capacity ? ' of ' + c.capacity : '') + '</div>' +
      (inv ? '<div class="card warnbox">Hosting fee due: <b>' + DE.money(inv.amount, inv.currency) + '</b> <button class="btn sm primary" id="payFee">Pay now</button></div>' : '') +
      '<div class="row wrap" id="acts" style="margin-top:12px"></div><div id="room"></div><div id="lessons"></div>' + (c.replay_url ? '<p><a class="btn" href="' + esc(c.replay_url) + '" target="_blank" rel="noopener">▶ Watch replay</a></p>' : '') + '</article>';
    const acts = DE.$('#acts');
    const btn = (id, label, cls) => acts.insertAdjacentHTML('beforeend', '<button class="btn ' + (cls || '') + '" id="' + id + '">' + label + '</button>');
    if (!DE.user) acts.innerHTML = '<a class="btn primary" href="/login?next=' + encodeURIComponent('/class/' + c.id) + '">Log in to enrol</a>';
    else {
      if (c.can_enroll) btn('enrol', c.price ? 'Enrol for ' + priceOf(c) : 'Enrol free', 'primary');
      else if (!c.joined && !c.is_host && !c.full && !c.member) acts.innerHTML = '<span class="muted">Join the community to enrol.</span> <a class="btn" href="/community/' + c.group_id + '">Open community</a>';
      if (c.full && !c.joined) acts.innerHTML = '<span class="pill bad">Class is full</span>';
      if ((c.joined || c.is_host) && c.kind !== 'recorded') btn('join', '🎥 Join class', 'primary');
      if ((c.joined || c.is_host) && c.kind === 'recorded') loadLessons();
      if (c.joined && !c.price) btn('leave', 'Leave');
      if (c.is_host) { btn('att', 'Attendees'); btn('acc', '🔑 Student access'); btn('del', 'Cancel class', 'danger'); if (c.kind === 'recorded') loadLessons(true); }
    }
    const e1 = DE.$('#enrol'); if (e1) e1.onclick = () => DE.busy(e1, async () => { if (c.price) return DE.checkout({ purpose: 'class', class_id: c.id }); await DE.post('/classes/' + c.id + '/enroll'); DE.toast('You are enrolled!'); DE.render(); });
    const lv = DE.$('#leave'); if (lv) lv.onclick = () => DE.busy(lv, async () => { await DE.post('/classes/' + c.id + '/leave'); DE.render(); });
    const pf = DE.$('#payFee'); if (pf) pf.onclick = () => DE.busy(pf, () => DE.checkout({ purpose: 'owner_invoice', invoice_id: inv.id }));
    const dl = DE.$('#del'); if (dl) dl.onclick = async () => { if (await DE.confirm('Cancel this class? Enrolled people will be told.', 'Cancel class')) { try { await DE.del('/classes/' + c.id); DE.navigate('/classes'); } catch (e) { DE.fail(e); } } };
    const ac = DE.$('#acc'); if (ac) ac.onclick = () => accessPanel(c);
    const at = DE.$('#att'); if (at) at.onclick = async () => { const l = await DE.get('/classes/' + c.id + '/attendees'); DE.modal('<h2>Attendees (' + l.length + ')</h2>' + (l.map(u => DE.userRow(u, false)).join('') || '<p class="muted">Nobody yet.</p>') + '<button class="btn" data-close>Close</button>'); };
    const jn = DE.$('#join'); if (jn) jn.onclick = () => DE.busy(jn, async () => {
      const r = await DE.get('/classes/' + c.id + '/join');
      if (r.type === 'external') return window.open(r.url, '_blank', 'noopener');
      await loadJitsi(r.domain);
      DE.$('#room').innerHTML = '<div id="jitsi" style="height:70vh;margin-top:14px;border-radius:12px;overflow:hidden"></div>';
      const api = new JitsiMeetExternalAPI(r.domain, { roomName: r.room, parentNode: DE.$('#jitsi'), userInfo: { displayName: r.name }, configOverwrite: { subject: r.subject, prejoinPageEnabled: false }, interfaceConfigOverwrite: { MOBILE_APP_PROMO: false } });
      DE.cleanup = () => api.dispose();
    });
    async function loadLessons(editable) {
      const l = await DE.get('/classes/' + c.id + '/lessons').catch(() => []);
      DE.$('#lessons').innerHTML = '<h2>Lessons</h2>' + (l.length ? l.map((x, i) => '<div class="card flat"><b>' + (i + 1) + '. ' + esc(x.title) + '</b>' + (x.body ? '<p>' + esc(x.body) + '</p>' : '') + (x.media ? (/\.(mp4|webm|mov)$/i.test(x.media) ? '<video src="' + esc(x.media) + '" controls playsinline style="width:100%"></video>' : /\.(mp3|wav|m4a)$/i.test(x.media) ? '<audio src="' + esc(x.media) + '" controls></audio>' : '<a href="' + esc(x.media) + '" target="_blank" rel="noopener">Open file</a>') : '') + (c.is_host ? ' <button class="btn sm danger" data-dl="' + x.id + '">Delete</button>' : '') + '</div>').join('') : '<p class="muted">No lessons yet.</p>') +
        (c.is_host ? '<form id="lf" class="card flat"><h3>Add a lesson</h3><input class="i" name="title" placeholder="Lesson title" required maxlength="120"><textarea class="i" name="body" placeholder="Notes (optional)"></textarea><input class="i" type="file" name="media" accept="video/*,audio/*,image/*,application/pdf"><button class="btn primary" style="margin-top:8px">Add lesson</button></form>' : '');
      DE.$$('[data-dl]').forEach(b => b.onclick = async () => { await DE.del('/classes/lessons/' + b.dataset.dl); loadLessons(); });
      const lf = DE.$('#lf'); if (lf) lf.onsubmit = async e => { e.preventDefault(); const fd = new FormData(lf); if (!fd.get('media').size) fd.delete('media'); try { await DE.post('/classes/' + c.id + '/lessons', fd); loadLessons(); } catch (ex) { DE.fail(ex); } };
    }
  });
})();
