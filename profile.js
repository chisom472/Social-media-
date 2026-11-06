/* User profile */
(function () {
  const { esc } = DE;

  DE.route('/u/:username', async (view, p, q, alive) => {
    const uname = p.username === 'me' && DE.user ? DE.user.username : p.username;
    const u = await DE.get('/users/' + encodeURIComponent(uname));
    if (!alive()) return;
    DE.title((u.display_name || u.username) + ' (@' + u.username + ')');
    view.innerHTML = '<div class="card"><div class="row wrap" style="align-items:flex-start">' +
      (u.avatar_video ? '<video src="' + esc(u.avatar_video) + '" autoplay muted loop playsinline poster="' + esc(u.avatar || '') + '" style="width:110px;height:110px;border-radius:50%;object-fit:cover;border:3px solid var(--brand)"></video>' : DE.avatar(u, 'lg')) +
      '<div class="grow"><h1 style="margin:0">' + esc(u.display_name || u.username) + '</h1><div class="muted">@' + esc(u.username) + (u.is_creator ? ' · <span class="tag">creator</span>' : '') + '</div>' +
      '<p>' + esc(u.bio || '') + '</p>' + ((u.country || u.city) ? '<div class="muted small">📍 ' + esc([u.city, (DE.world.countries.find(c => c.code === u.country) || {}).name || u.country].filter(Boolean).join(', ')) + '</div>' : '') +
      '<div class="stat"><div><b>' + u.posts + '</b>posts</div><div><b><a href="#" id="showFollowers">' + u.followers + '</a></b>followers</div><div><b>' + u.following + '</b>following</div></div></div></div>' +
      '<div class="row wrap" style="margin-top:14px">' +
      (u.is_me ? '<a class="btn" href="/settings">Edit profile</a>' + (u.page ? '<a class="btn" href="/edit-page">Edit my page</a>' : '<a class="btn primary" href="/create-page">Create creator page</a>') :
        DE.followBtn({ id: u.id, username: u.username, following: u.is_following }) +
        (DE.user ? '<button class="btn" data-act="' + (u.blocked_by_me ? 'unblock' : 'block') + '" data-username="' + esc(u.username) + '">' + (u.blocked_by_me ? 'Unblock' : 'Block') + '</button><button class="btn" id="msgBtn">💬 Message</button><button class="btn amber" data-act="support" data-username="' + esc(u.username) + '">💚 Support</button>' : '')) +
      (u.page ? '<a class="btn" href="/p/' + esc(u.page.slug) + '">View page: ' + esc(u.page.name) + '</a>' : '') + '</div></div>' +
      '<h2 style="margin-top:18px">Posts</h2><div id="posts"><div class="spinner"></div></div>';

    const fl = DE.$('#showFollowers');
    if (fl) fl.onclick = async e => {
      e.preventDefault();
      const list = await DE.get('/users/' + encodeURIComponent(u.username) + '/followers');
      DE.modal('<h2>Followers</h2>' + (list.length ? list.map(x => '<div class="row" style="padding:6px 0">' + DE.avatar(x, 'sm') + '<a class="grow" href="/u/' + esc(x.username) + '" data-close>' + esc(x.display_name || x.username) + '</a></div>').join('') : '<p class="muted">No followers yet.</p>') + '<button class="btn" data-close style="margin-top:10px">Close</button>');
    };
    const mb = DE.$('#msgBtn');
    if (mb) mb.onclick = () => DE.busy(mb, async () => { const r = await DE.post('/chat/dm/' + encodeURIComponent(u.username)); DE.navigate('/chat/' + r.id); });

    const posts = u.blocked_by_me ? [] : await DE.get('/posts/user/' + encodeURIComponent(u.username));
    if (!alive()) return;
    DE.$('#posts').innerHTML = posts.length ? posts.map(x => DE.postCard(x)).join('') : '<div class="card empty">No posts yet.</div>';
    DE.observeViews(DE.$('#posts'));
  });
})();
