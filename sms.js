// SMS through Twilio (works in most countries). The owner enters the Account SID, Auth Token and sender in Admin > Settings.
// If SMS is not configured, phone-only users can still reset their password through the owner (Admin > Users > reset link).
const { getSetting } = require('./db');

async function configured() {
  return getSetting('sms_enabled') === '1' && !!getSetting('sms_account_sid') && !!getSetting('sms_auth_token') && !!getSetting('sms_from');
}

async function send(to, body) {
  if (!(await configured())) throw Object.assign(new Error('SMS is not set up.'), { status: 503 });
  const sid = getSetting('sms_account_sid');
  const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(sid) + '/Messages.json', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + getSetting('sms_auth_token')).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: getSetting('sms_from'), Body: String(body).slice(0, 600) })
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw Object.assign(new Error('SMS failed: ' + (j.message || r.status)), { status: 502 });
  }
  return { sent: true };
}

module.exports = { configured, send };
