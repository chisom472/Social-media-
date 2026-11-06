// "Sign in with Google": verifies the Google ID token (RS256 signature, issuer, audience, expiry) on the server.
const crypto = require('crypto');
const { getSetting } = require('./db');

let jwks = { keys: [], at: 0 };

async function keys() {
  if (jwks.keys.length && Date.now() - jwks.at < 3600 * 1000) return jwks.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('Could not reach Google to check your sign-in.');
  jwks = { keys: (await r.json()).keys || [], at: Date.now() };
  return jwks.keys;
}

function enabled() { return getSetting('google_login_enabled') === '1' && !!getSetting('google_client_id'); }

/** Returns { sub, email, name, picture } or throws. */
async function verify(idToken) {
  const clientId = getSetting('google_client_id');
  if (!enabled()) throw Object.assign(new Error('Google sign-in is not turned on.'), { status: 503 });
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw Object.assign(new Error('Invalid Google sign-in.'), { status: 400 });
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch (e) { throw Object.assign(new Error('Invalid Google sign-in.'), { status: 400 }); }
  if (header.alg !== 'RS256') throw Object.assign(new Error('Invalid Google sign-in.'), { status: 400 });
  let jwk = (await keys()).find(k => k.kid === header.kid);
  if (!jwk) { jwks.at = 0; jwk = (await keys()).find(k => k.kid === header.kid); }
  if (!jwk) throw Object.assign(new Error('Invalid Google sign-in.'), { status: 400 });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  const now = Math.floor(Date.now() / 1000);
  if (!ok || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.aud !== clientId || !(claims.exp > now) || !claims.sub)
    throw Object.assign(new Error('Google sign-in could not be verified.'), { status: 401 });
  if (!claims.email || claims.email_verified !== true) throw Object.assign(new Error('Your Google email address is not verified.'), { status: 400 });
  return { sub: String(claims.sub), email: String(claims.email).toLowerCase(), name: String(claims.name || '').slice(0, 50), picture: claims.picture || null };
}

module.exports = { enabled, verify };
