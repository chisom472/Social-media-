/* Sign up, log in (with optional Google), password reset, onboarding and settings */
(function () {
  const { esc } = DE;

  function afterLogin(r, next) {
    DE.setSession(r.user);
    DE.startSocket && DE.startSocket();
    DE.renderChrome();
    DE.navigate(r.onboarding && !next ? '/welcome' : (next && next[0] === '/' && next[1] !== '/' ? next : '/'), true);
  }

  // ---------- Google (optional) ----------
  let gisLoaded = null;
  function loadGoogle() {
    if (gisLoaded) return gisLoaded;
    gisLoaded = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error('Could not load Google sign-in.'));
      document.head.appendChild(s);
    });
    return gisLoaded;
  }
  async function googleButton(box, next) {
    const g = DE.config.google;
    if (!g || !g.enabled || !box) return;
    try {
      await loadGoogle();
      google.accounts.id.initialize({ client_id: g.client_id, callback: async resp => {
        try {
          const r = await DE.post('/auth/google', { credential: resp.credential });
          if (r.needs_link) return googleLink(r, next);
          if (r.needs_profile) return googleProfile(r, next);
          afterLogin(r, next);
        } catch (e) { DE.fail(e); }
      } });
      box.innerHTML = '<div class="center muted small" style="margin:12px 0">or</div><div id="gbtn" style="display:flex;justify-content:center"></div>';
      google.accounts.id.renderButton(DE.$('#gbtn', box), { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: 300 });
    } catch (e) { box.innerHTML = ''; }
  }
  function googleLink(r, next) {
    DE.modal('<h2>Link your Google account</h2><p class="muted">An account with <b>' + esc(r.email) + '</b> already exists (@' + esc(r.username) + '). Enter its password once to link Google to it.</p>' + DE.pwField('lkpw', 'Password') + '<div class="err" id="lkErr"></div><div class="row" style="margin-top:12px"><button class="btn primary" id="lkGo">Link and continue</button><button class="btn" data-close>Cancel</button></div>', (m, close) => {
      m.querySelector('#lkGo').onclick = async () => { try { afterLogin(await DE.post('/auth/google/link', { ticket: r.ticket, password: m.querySelector('#lkpw').value }), next); close(); } catch (e) { m.querySelector('#lkErr').textContent = e.message; } };
    });
  }
  function googleProfile(r, next) {
    DE.modal('<h2>Almost there</h2><p class="muted">Signed in with Google as <b>' + esc(r.email) + '</b>. Choose a username and confirm a few details.</p><form id="gp">' +
      '<label class="f">Name</label><input class="i" name="display_name" value="' + esc(r.name || '') + '" maxlength="50">' +
      '<label class="f">Username</label><input class="i" name="username" value="' + esc(r.suggested_username) + '" pattern="[A-Za-z0-9_]{3,20}" required>' +
      '<label class="f">Date of birth</label><input class="i" type="date" name="dob" required>' +
      '<label class="f">Phone number (optional, with country code)</label><input class="i" name="phone" placeholder="+234 801 234 5678">' +
      '<label class="row" style="margin-top:12px;align-items:flex-start"><input type="checkbox" name="pol" required> <span class="small">I agree to the <a href="/policy" target="_blank">community policy</a>.</span></label>' +
      '<div class="err" id="gpErr"></div><div class="row" style="margin-top:12px"><button class="btn primary">Create my account</button><button type="button" class="btn" data-close>Cancel</button></div></form>', (m, close) => {
      m.querySelector('#gp').onsubmit = async e => {
        e.preventDefault(); const f = e.target;
        try { afterLogin(await DE.post('/auth/google/complete', { ticket: r.ticket, display_name: f.display_name.value, username: f.username.value, dob: f.dob.value, phone: f.phone.value, accepted_policy: f.pol.checked }), next); close(); }
        catch (ex) { m.querySelector('#gpErr').textContent = ex.message; }
      };
    });
  }

  DE.route('/login', async (view, p, q) => {
    if (DE.user) return DE.navigate('/', true);
    DE.title('Log in');
    view.innerHTML = '<div class="card" style="max-width:440px;margin:30px auto"><h1>Welcome back</h1><form id="f">' +
      '<label class="f" for="id">Email, phone number or username</label><input class="i" id="id" autocomplete="username" required>' +
      DE.pwField('pw', 'Password') + '<div class="err" id="err"></div>' +
      '<button class="btn primary block" style="margin-top:16px">Log in</button></form><div id="g"></div>' +
      '<p class="center small"><a href="/forgot">Forgot your password?</a></p><p class="center muted">New here? <a href="/signup' + (q.next ? '?next=' + encodeURIComponent(q.next) : '') + '">Create an account</a></p></div>';
    googleButton(DE.$('#g'), q.next);
    DE.$('#f').onsubmit = async e => {
      e.preventDefault();
      DE.$('#err').textContent = '';
      try { afterLogin(await DE.post('/auth/login', { identifier: DE.$('#id').value, password: DE.$('#pw').value }), q.next); }
      catch (ex) { DE.$('#err').textContent = ex.message; }
    };
  });

  DE.route('/signup', async (view, p, q) => {
    if (DE.user) return DE.navigate('/', true);
    DE.title('Join the community');
    if (DE.config.allow_signups === false) { view.innerHTML = '<div class="card empty">Sign-ups are currently closed.</div>'; return; }
    const maxDob = new Date(Date.now() - (DE.config.min_age || 13) * 365.25 * 864e5).toISOString().slice(0, 10);
    view.innerHTML = '<div class="card" style="max-width:600px;margin:20px auto"><h1>Join ' + esc(DE.config.site_name || 'Digital Enviro') + '</h1><p class="muted">Learn, share, and earn from the skills you love.</p><div id="g"></div><form id="f">' +
      '<label class="f" for="dn">Your name</label><input class="i" id="dn" maxlength="50" autocomplete="name">' +
      '<label class="f" for="un">Username</label><input class="i" id="un" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" autocomplete="username" required>' +
      '<div class="two"><div><label class="f" for="em">Email</label><input class="i" id="em" type="email" autocomplete="email"></div>' +
      '<div><label class="f" for="ph">Phone number</label><input class="i" id="ph" type="tel" autocomplete="tel" placeholder="+234 801 234 5678"></div></div>' +
      '<div class="muted small">Give an email or a phone number (or both). You can add the other one later in Settings.</div>' +
      '<label class="f" for="dob">Date of birth</label><input class="i" id="dob" type="date" max="' + maxDob + '" required>' +
      DE.pwField('pw', 'Password (at least 8 characters)', { autocomplete: 'new-password', min: true }) +
      '<details style="margin-top:12px"><summary>Add my location (optional)</summary><div class="two"><div><label class="f">Country</label>' + DE.countrySelect('co') + '</div><div><label class="f">City</label><input class="i" id="ci" maxlength="60"></div></div>' +
      '<label class="f">Who can see my location?</label><select class="i" id="lp"><option value="country">Only my country is public</option><option value="city">Country and city are public</option><option value="private">Nobody (only the site owner)</option></select></details>' +
      '<label class="f">What do you want to learn or share? (pick a few so we can recommend the right people)</label><div class="chips" id="interests">' +
      DE.config.categories.map(c => '<span class="chip" data-v="' + esc(c) + '">' + esc(c) + '</span>').join('') + '</div>' +
      '<label class="row" style="margin-top:14px;align-items:flex-start"><input type="checkbox" id="pol" required> <span class="small">I agree to the <a href="/policy" target="_blank">community policy</a>. I will only post content I own or have the right to share.</span></label>' +
      '<div class="err" id="err"></div><button class="btn primary block" style="margin-top:16px">Create my account</button></form><p class="center muted">Already a member? <a href="/login' + (q.next ? '?next=' + encodeURIComponent(q.next) : '') + '">Log in</a></p></div>';
    googleButton(DE.$('#g'), q.next);
    DE.$$('#interests .chip').forEach(c => c.onclick = () => c.classList.toggle('on'));
    DE.$('#f').onsubmit = async e => {
      e.preventDefault();
      DE.$('#err').textContent = '';
      if (!DE.$('#em').value.trim() && !DE.$('#ph').value.trim()) { DE.$('#err').textContent = 'Add an email address or a phone number.'; return; }
      try {
        afterLogin(await DE.post('/auth/signup', {
          display_name: DE.$('#dn').value, username: DE.$('#un').value, email: DE.$('#em').value, phone: DE.$('#ph').value, dob: DE.$('#dob').value, password: DE.$('#pw').value,
          country: DE.$('#co').value, city: DE.$('#ci').value, location_privacy: DE.$('#lp').value,
          interests: DE.$$('#interests .chip.on').map(c => c.dataset.v), accepted_policy: DE.$('#pol').checked
        }), q.next);
      } catch (ex) { DE.$('#err').textContent = ex.message; }
    };
  });

  DE.route('/forgot', async view => {
    DE.title('Reset password');
    view.innerHTML = '<div class="card" style="max-width:440px;margin:30px auto"><h1>Forgot your password?</h1><p class="muted">Enter the email or phone number you registered with. We will send you a link to choose a new password.</p><form id="f">' +
      '<label class="f" for="em">Email or phone number</label><input class="i" id="em" required><div class="err" id="err"></div><div class="okmsg" id="ok"></div>' +
      '<button class="btn primary block" style="margin-top:16px">Send reset link</button></form><p class="center small"><a href="/login">Back to login</a></p></div>';
    DE.$('#f').onsubmit = async e => {
      e.preventDefault();
      try { const r = await DE.post('/auth/forgot', { identifier: DE.$('#em').value }); DE.$('#ok').textContent = r.message; }
      catch (ex) { DE.$('#err').textContent = ex.message; }
    };
  });

  DE.route('/reset/:token', async (view, p) => {
    DE.title('Choose a new password');
    view.innerHTML = '<div class="card" style="max-width:440px;margin:30px auto"><h1>Choose a new password</h1><form id="f">' +
      DE.pwField('pw', 'New password', { autocomplete: 'new-password', min: true }) + DE.pwField('pw2', 'Confirm new password', { autocomplete: 'new-password', min: true }) +
      '<div class="err" id="err"></div><button class="btn primary block" style="margin-top:16px">Save password</button></form></div>';
    DE.$('#f').onsubmit = async e => {
      e.preventDefault();
      if (DE.$('#pw').value !== DE.$('#pw2').value) { DE.$('#err').textContent = 'The two passwords do not match.'; return; }
      try { await DE.post('/auth/reset', { token: p.token, password: DE.$('#pw').value }); DE.toast('Password updated. You can log in now.'); DE.navigate('/login'); }
      catch (ex) { DE.$('#err').textContent = ex.message; }
    };
  });

  // Onboarding: recommended pages, people and groups right after signup
  DE.route('/welcome', async view => {
    DE.title('Welcome');
    const s = await DE.get('/users/suggestions');
    view.innerHTML = '<div class="hero"><h1>Welcome, ' + esc(DE.user.display_name || DE.user.username) + '! 🎉</h1><p>Based on your interests, here are people, pages and communities worth following. Follow a few to build your feed.</p></div>' +
      '<div class="card"><h2>People & creators</h2>' + (s.people.length ? s.people.map(u => DE.userRow(u)).join('') : '<p class="muted">You are one of the first here! Invite friends to join.</p>') + '</div>' +
      '<div class="card"><h2>Creator pages</h2>' + (s.pages.length ? '<div class="grid">' + s.pages.map(pg => '<a class="card flat" href="/p/' + esc(pg.slug) + '" style="color:inherit"><b>' + esc(pg.name) + '</b><div class="muted small">' + esc(pg.category || '') + ' · @' + esc(pg.username) + '</div></a>').join('') + '</div>' : '<p class="muted">No pages yet.</p>') + '</div>' +
      '<div class="card"><h2>Communities</h2>' + (s.groups.length ? s.groups.map(g => '<div class="row" style="padding:6px 0"><div class="grow"><a href="/community/' + g.id + '"><b>' + esc(g.name) + '</b></a><div class="muted small">' + g.members + ' members' + (g.price ? ' · ' + DE.money(g.price, g.currency) : ' · free') + '</div></div></div>').join('') : '<p class="muted">No communities yet. Create the first one!</p>') + '</div>' +
      '<div class="center" style="margin:20px"><a class="btn primary" href="/">Go to my feed</a></div>';
  }, { auth: true });

  // ---------- Settings ----------
  DE.route('/settings', async view => {
    DE.title('Settings');
    const [meR, prefs, blocked] = await Promise.all([DE.get('/auth/me'), DE.get('/notifications/prefs').catch(() => ({})), DE.get('/users/me/blocked').catch(() => [])]);
    const me = meR.user;
    const pushOk = 'serviceWorker' in navigator && 'PushManager' in window && DE.config.push_key;
    view.innerHTML = '<h1>Settings</h1>' +
      '<div class="card"><h2>Profile</h2><div class="row wrap">' + DE.avatar(me, 'lg') + (me.avatar_video ? '<video src="' + esc(me.avatar_video) + '" muted loop autoplay playsinline style="width:96px;height:96px;border-radius:50%;object-fit:cover"></video>' : '') + '</div>' +
      '<p class="muted small">No picture yet? We show the first letter of your name until you upload one.</p>' +
      '<form id="pf"><label class="f">Profile picture</label><input type="file" name="avatar" accept="image/*" class="i"><label class="f">Profile video (optional, plays on your profile)</label><input type="file" name="video" accept="video/*" class="i">' +
      '<div class="err" id="avErr"></div><button class="btn" style="margin-top:10px">Upload</button> ' + (me.avatar_video ? '<button type="button" class="btn danger" id="rmVid">Remove video</button>' : '') + '</form>' +
      '<form id="info"><label class="f">Display name</label><input class="i" name="display_name" value="' + esc(me.display_name) + '" maxlength="50"><label class="f">Bio</label><textarea class="i" name="bio" maxlength="400">' + esc(me.bio) + '</textarea>' +
      '<label class="f">Date of birth</label><input class="i" type="date" name="dob" value="' + esc(me.dob || '') + '">' +
      '<label class="f">Interests (we use these to recommend content)</label><div class="chips" id="ints">' + DE.config.categories.map(c => '<span class="chip' + (me.interests.includes(c) ? ' on' : '') + '" data-v="' + esc(c) + '">' + esc(c) + '</span>').join('') + '</div>' +
      '<button class="btn primary" style="margin-top:12px">Save profile</button></form></div>' +

      '<div class="card"><h2>Contact details</h2><p class="muted small">Keep at least one of these. Having both makes it easier to recover your account.</p><form id="ct">' +
      '<div class="two"><div><label class="f">Email</label><input class="i" name="email" type="email" value="' + esc(me.email || '') + '"></div><div><label class="f">Phone (with country code)</label><input class="i" name="phone" type="tel" value="' + esc(me.phone || '') + '"></div></div>' +
      DE.pwField('ctpw', 'Your password (to confirm)') + '<div class="err" id="ctErr"></div><button class="btn" style="margin-top:12px">Save contact details</button></form></div>' +

      '<div class="card"><h2>My location</h2><form id="loc"><div class="two"><div><label class="f">Country</label>' + DE.countrySelect('lco', me.country) + '</div><div><label class="f">City</label><input class="i" name="city" value="' + esc(me.city || '') + '" maxlength="60"></div></div>' +
      '<label class="f">Region / state (optional)</label><input class="i" name="region" value="' + esc(me.region || '') + '" maxlength="60">' +
      '<label class="f">Who can see it?</label><select class="i" name="location_privacy">' + [['country', 'Only my country is public'], ['city', 'Country and city are public'], ['private', 'Nobody (only the site owner)']].map(o => '<option value="' + o[0] + '"' + (me.location_privacy === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>' +
      '<div class="row" style="margin-top:12px"><button class="btn">Save location</button><button type="button" class="btn" id="geo">Use my current location</button></div></form></div>' +

      '<div class="card"><h2>Notifications</h2><label class="row"><input type="checkbox" id="nEmail"' + (prefs.email ? ' checked' : '') + '> Email me about important things</label>' +
      '<label class="row" style="margin-top:8px"><input type="checkbox" id="nPush"' + (prefs.push ? ' checked' : '') + (pushOk ? '' : ' disabled') + '> Push notifications on this device' + (pushOk ? '' : ' <span class="muted small">(install the app or use a browser that supports it)</span>') + '</label>' +
      '<div class="row" style="margin-top:12px"><button class="btn" id="nSave">Save</button><button class="btn" id="nTest">Send a test</button></div></div>' +

      '<div class="card"><h2>Sign-in</h2>' + (me.google_linked ? '<p>✅ Google account linked.</p>' : (DE.config.google && DE.config.google.enabled ? '<div id="gconn"></div>' : '<p class="muted">Google sign-in is not turned on.</p>')) +
      '<h3 style="margin-top:14px">Change password</h3><form id="cp">' + DE.pwField('cur', 'Current password') + DE.pwField('np', 'New password', { autocomplete: 'new-password', min: true }) + '<div class="err" id="cpErr"></div><button class="btn" style="margin-top:12px">Update password</button></form>' +
      '<button class="btn" id="outAll" style="margin-top:12px">Sign out on all devices</button></div>' +

      '<div class="card"><h2>Blocked people</h2>' + (blocked.length ? blocked.map(u => '<div class="row" style="padding:6px 0">' + DE.avatar(u, 'sm') + '<span class="grow">@' + esc(u.username) + '</span><button class="btn sm" data-act="unblock" data-username="' + esc(u.username) + '">Unblock</button></div>').join('') : '<p class="muted">You have not blocked anyone.</p>') + '</div>' +
      '<div class="card"><h2>Appearance</h2><button class="btn" id="theme">Switch light / dark theme</button></div>' +
      '<div class="card"><button class="btn danger" data-act="logout">Log out</button> <button class="btn danger" id="delAcc">Delete my account</button></div>';

    DE.$$('#ints .chip').forEach(c => c.onclick = () => c.classList.toggle('on'));
    if (DE.$('#gconn')) { const g = await (async () => { await new Promise(r => { const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.onload = r; s.onerror = r; document.head.appendChild(s); }); return window.google; })();
      if (g) { g.accounts.id.initialize({ client_id: DE.config.google.client_id, callback: async resp => { try { await DE.post('/auth/google/connect', { credential: resp.credential }); DE.toast('Google linked'); DE.render(); } catch (e) { DE.fail(e); } } }); g.accounts.id.renderButton(DE.$('#gconn'), { theme: 'outline', text: 'continue_with', shape: 'pill' }); } }
    DE.$('#pf').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      ['avatar', 'video'].forEach(k => { const f = fd.get(k); if (!f || !f.size) fd.delete(k); });
      DE.$('#avErr').textContent = '';
      try { const r = await DE.post('/users/me/avatar', fd); if (r.avatar) DE.user.avatar = r.avatar; DE.toast('Updated!'); DE.renderChrome(); DE.render(); }
      catch (ex) { DE.$('#avErr').textContent = ex.message; }
    };
    const rm = DE.$('#rmVid'); if (rm) rm.onclick = async () => { await DE.del('/users/me/avatar-video'); DE.render(); };
    DE.$('#info').onsubmit = async e => {
      e.preventDefault();
      try { await DE.put('/users/me/profile', { display_name: e.target.display_name.value, bio: e.target.bio.value, dob: e.target.dob.value || undefined, interests: DE.$$('#ints .chip.on').map(c => c.dataset.v) }); DE.user.display_name = e.target.display_name.value; DE.renderChrome(); DE.toast('Profile saved'); } catch (ex) { DE.fail(ex); }
    };
    DE.$('#ct').onsubmit = async e => {
      e.preventDefault(); DE.$('#ctErr').textContent = '';
      try { await DE.put('/auth/contact', { email: e.target.email.value, phone: e.target.phone.value, password: DE.$('#ctpw').value }); DE.toast('Contact details saved'); DE.$('#ctpw').value = ''; }
      catch (ex) { DE.$('#ctErr').textContent = ex.message; }
    };
    DE.$('#loc').onsubmit = async e => {
      e.preventDefault();
      try { await DE.put('/users/me/location', { country: DE.$('#lco').value, city: e.target.city.value, region: e.target.region.value, location_privacy: e.target.location_privacy.value }); DE.toast('Location saved'); } catch (ex) { DE.fail(ex); }
    };
    DE.$('#geo').onclick = () => {
      if (!navigator.geolocation) return DE.toast('Your browser cannot share its location.', true);
      navigator.geolocation.getCurrentPosition(async pos => {
        try {
          const r = await fetch('https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&lat=' + pos.coords.latitude + '&lon=' + pos.coords.longitude);
          const j = await r.json(); const a = j.address || {};
          if (a.country_code) DE.$('#lco').value = a.country_code.toUpperCase();
          DE.$('#loc').city.value = a.city || a.town || a.village || ''; DE.$('#loc').region.value = a.state || '';
          DE.toast('Location filled in. Press Save to keep it.');
        } catch (e) { DE.toast('Could not work out your place. Type it in instead.', true); }
      }, () => DE.toast('Location permission was not given.', true));
    };
    DE.$('#nSave').onclick = async e => DE.busy(e.target, async () => {
      await DE.put('/notifications/prefs', { email: DE.$('#nEmail').checked, push: DE.$('#nPush').checked });
      if (DE.$('#nPush').checked) await DE.enablePush(); else await DE.disablePush();
      DE.toast('Saved');
    });
    DE.$('#nTest').onclick = e => DE.busy(e.target, async () => { await DE.post('/notifications/test'); DE.toast('Test sent'); });
    DE.$('#cp').onsubmit = async e => {
      e.preventDefault(); DE.$('#cpErr').textContent = '';
      try { await DE.post('/auth/change-password', { current: DE.$('#cur').value, password: DE.$('#np').value }); DE.toast('Password changed'); e.target.reset(); }
      catch (ex) { DE.$('#cpErr').textContent = ex.message; }
    };
    DE.$('#outAll').onclick = async () => { if (await DE.confirm('Sign out on every device, including this one?', 'Sign out everywhere')) { await DE.post('/auth/logout-all'); DE.setSession(null); DE.renderChrome(); DE.navigate('/login'); } };
    DE.$('#theme').onclick = () => { const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = next; DE.store.set('de_theme', next); };
    DE.$('#delAcc').onclick = () => DE.modal('<h2>Delete your account</h2><p class="muted">This permanently removes your profile, posts and wallet. It cannot be undone.</p>' + DE.pwField('dpw', 'Your password') + '<label class="row"><input type="checkbox" id="dLose"> I understand any money left in my wallet will be lost</label><div class="err" id="dErr"></div><div class="row" style="margin-top:12px"><button class="btn danger" id="dGo">Delete forever</button><button class="btn" data-close>Cancel</button></div>', m => {
      m.querySelector('#dGo').onclick = async () => { try { await DE.post('/auth/delete-account', { password: m.querySelector('#dpw').value, confirm_lose_balance: m.querySelector('#dLose').checked }); DE.setSession(null); location.href = '/'; } catch (ex) { m.querySelector('#dErr').textContent = ex.message; } };
    });
  }, { auth: true });
})();
