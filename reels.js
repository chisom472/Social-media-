/* Reels: vertical short-video player and uploader */
(function () {
  const { esc } = DE;

  DE.route('/reels', async (view, p, q, alive) => {
    DE.title('Reels');
    const rows = await DE.get('/posts/reels');
    view.innerHTML = '<div class="row between"><h1>Reels</h1>' + (DE.user ? '<a class="btn primary" href="/reels/new">+ New reel</a>' : '') + '</div><div id="reels" class="reels"></div><div id="reelAd"></div>';
    if (!rows.length) { DE.$('#reels').innerHTML = '<div class="card empty">No reels yet. Record the first one!</div>'; return; }
    DE.$('#reels').innerHTML = rows.map(r => '<section class="reel" data-post="' + r.id + '"><video src="' + esc(r.media) + '" loop playsinline preload="metadata"' + (r.poster ? ' poster="' + esc(r.poster) + '"' : '') + '></video>' +
      '<div class="reel-info"><a href="/u/' + esc(r.username) + '" class="row" style="color:#fff">' + DE.avatar(r, 'sm') + '<b>@' + esc(r.username) + '</b></a><div>' + esc(r.body || r.title || '') + '</div></div>' +
      '<div class="reel-side"><button class="act' + (r.liked ? ' on' : '') + '" data-act="like" data-id="' + r.id + '">' + (r.my_reaction || (r.liked ? '❤️' : '♡')) + '<span>' + r.likes + '</span></button><a class="act" href="/post/' + r.id + '">💬<span>' + (r.comments || 0) + '</span></a><button class="act" data-mute>🔊</button></div></section>').join('');
    const vids = DE.$$('.reel video');
    let muted = false;
    const io = new IntersectionObserver(es => es.forEach(e => {
      const v = e.target;
      if (e.isIntersecting && e.intersectionRatio > 0.6) { v.muted = muted; v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); const id = v.closest('.reel').dataset.post; if (DE.user && !v.dataset.seen) { v.dataset.seen = 1; DE.post('/posts/' + id + '/view').catch(() => {}); } }
      else v.pause();
    }), { threshold: [0.6] });
    vids.forEach(v => { io.observe(v); v.onclick = () => (v.paused ? v.play() : v.pause()); });
    DE.$$('[data-mute]').forEach(b => b.onclick = () => { muted = !muted; vids.forEach(v => (v.muted = muted)); DE.$$('[data-mute]').forEach(x => (x.textContent = muted ? '🔇' : '🔊')); });
    DE.cleanup = () => io.disconnect();
    DE.adSlot('reels', DE.$('#reelAd'));
    if (q.id) { const t = DE.$('[data-post="' + q.id + '"]'); if (t) t.scrollIntoView(); }
  });

  DE.route('/reels/new', async view => {
    DE.title('New reel');
    const max = DE.config.reel_max_seconds || 90;
    view.innerHTML = '<h1>New reel</h1><form class="card" id="f"><p class="muted">Short vertical video, up to ' + max + ' seconds. Only post videos you own or have the right to share.</p><input class="i" type="file" id="file" accept="video/*" required><video id="prev" controls playsinline class="hidden" style="max-height:50vh;margin-top:10px;border-radius:12px"></video>' +
      '<label class="f">Caption</label><textarea class="i" id="cap" maxlength="500"></textarea><label class="f">Topic</label>' + DE.categorySelect('cat', '', true) + '<div class="err" id="err"></div><button class="btn primary" style="margin-top:12px">Post reel</button></form>';
    let dur = 0;
    DE.$('#file').onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      const v = DE.$('#prev'); v.src = URL.createObjectURL(f); v.classList.remove('hidden');
      v.onloadedmetadata = () => { dur = v.duration; DE.$('#err').textContent = dur > max ? 'This video is ' + Math.round(dur) + 's. The limit is ' + max + 's.' : ''; };
    };
    DE.$('#f').onsubmit = async e => {
      e.preventDefault();
      if (dur > max) return;
      const fd = new FormData(); fd.append('type', 'reel'); fd.append('body', DE.$('#cap').value); fd.append('category', DE.$('#cat').value); fd.append('duration', dur); fd.append('media', DE.$('#file').files[0]);
      DE.busy(e.submitter, async () => { await DE.post('/posts', fd); DE.toast('Reel posted!'); DE.navigate('/reels'); });
    };
  }, { auth: true });
})();
