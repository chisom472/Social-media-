// Turns every notify() call into: a live update (Socket.IO), a push notification and, for important events, an email.
const { db, bus, getSetting } = require('./db');
const push = require('./push');
const { sendMail, esc } = require('./utils');

let io = null, isOnline = () => false;
const lastEmail = new Map(); // "userId:type" -> time, so nobody is spammed

function absolute(link) {
  const base = process.env.SITE_URL || '';
  return link && base ? base + link : link || base || '/';
}

async function deliver(n) {
  if (io) io.to('user:' + n.user_id).emit('notification', { id: n.id, type: n.type, text: n.text, link: n.link });
  const u = db.prepare("SELECT id,email,notify_email,notify_push FROM users WHERE id=? AND status='active'").get(n.user_id);
  if (!u) return;
  const online = isOnline(u.id);
  const site = getSetting('site_name') || 'Digital Enviro';
  if (!online && u.notify_push) await push.sendToUser(u.id, { title: site, body: n.text, url: n.link || '/notifications', tag: n.type + ':' + n.id });
  if (!online && u.notify_email && u.email && getSetting('smtp_host')) {
    const types = getSetting('email_notify_types').split(',').map(s => s.trim());
    const key = u.id + ':' + n.type;
    if (types.includes(n.type) && Date.now() - (lastEmail.get(key) || 0) > 10 * 60 * 1000) {
      lastEmail.set(key, Date.now());
      await sendMail(u.email, site + ': ' + n.text.slice(0, 80),
        '<p>' + esc(n.text) + '</p><p><a href="' + esc(absolute(n.link)) + '">Open ' + esc(site) + '</a></p><p style="color:#888;font-size:12px">You can turn email notifications off in Settings.</p>', site);
    }
  }
}

function init(opts) {
  io = opts.io; isOnline = opts.isOnline || isOnline;
  bus.on('notify', n => { deliver(n).catch(e => console.error('[notify]', e.message)); });
  // chat: push to members who are offline (the live socket already covers online ones)
  bus.on('chat', ({ convId, sender, msg, recipients }) => {
    recipients.forEach(uid => {
      if (isOnline(uid)) return;
      const u = db.prepare("SELECT notify_push FROM users WHERE id=? AND status='active'").get(uid);
      if (u && u.notify_push) push.sendToUser(uid, { title: '@' + sender.username, body: msg.type === 'text' ? String(msg.body || '').slice(0, 120) : 'Sent you a ' + msg.type, url: '/chat/' + convId, tag: 'chat:' + convId }).catch(() => {});
    });
  });
}

module.exports = { init };
