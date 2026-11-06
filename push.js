// Web Push (browser/phone notifications even when the site is closed). Keys are generated automatically on first use.
const { db, getSetting, setSetting } = require('./db');

let webpush = null;
try { webpush = require('web-push'); } catch (e) { console.warn('[push] "web-push" is not installed - run npm install. Push notifications are disabled until then.'); }

function ready() {
  if (!webpush || getSetting('push_enabled') !== '1') return false;
  if (!getSetting('vapid_public') || !getSetting('vapid_private')) {
    const k = webpush.generateVAPIDKeys();
    setSetting('vapid_public', k.publicKey);
    setSetting('vapid_private', k.privateKey);
  }
  const contact = getSetting('vapid_subject') || (process.env.SITE_URL && /^https:/.test(process.env.SITE_URL) ? process.env.SITE_URL : 'mailto:' + (process.env.ADMIN_EMAIL || 'admin@example.com'));
  webpush.setVapidDetails(contact, getSetting('vapid_public'), getSetting('vapid_private'));
  return true;
}

function publicKey() { return ready() ? getSetting('vapid_public') : null; }

async function sendToUser(userId, payload) {
  if (!ready()) return 0;
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id=?').all(userId);
  let sent = 0;
  const body = JSON.stringify(payload).slice(0, 3500);
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 86400, urgency: payload.urgent ? 'high' : 'normal' });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(s.id); // browser unsubscribed
    }
  }));
  return sent;
}

module.exports = { ready, publicKey, sendToUser };
