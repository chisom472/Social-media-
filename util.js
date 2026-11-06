// Shared helpers for the dropshipping platform adapters.
const world = require('../world');

/** JSON request with timeout. Errors carry status + retry so the caller knows whether trying again later can help. */
async function http(label, url, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'User-Agent': 'DigitalEnviro/1.0', ...headers }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
  } catch (e) { throw Object.assign(new Error('Could not reach ' + label + ': ' + e.message), { status: 502, retry: true }); }
  finally { clearTimeout(t); }
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (e) { /* not JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}
const fail = (label, r, msg) => Object.assign(new Error(msg || (label + ' error ' + r.status)), { status: r.status === 429 ? 429 : r.status >= 500 ? 502 : 400, retry: r.status === 429 || r.status >= 500 });

/** "Navy Blue" -> "navyblue": used to match the same size/colour between platforms. */
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const SIZE_ALIAS = { xsmall: 'xs', small: 's', medium: 'm', large: 'l', xlarge: 'xl', xxlarge: '2xl', xxxlarge: '3xl', '2xlarge': '2xl', '3xlarge': '3xl', onesize: 'os' };
const normSize = s => { const n = norm(s); return SIZE_ALIAS[n] || n; };
/** The key that identifies "the same variant" on every platform. */
const variantKey = v => (v.size || v.color) ? normSize(v.size) + '|' + norm(v.color) : norm(v.name);

const usd = v => world.toMinor(parseFloat(v) || 0, 'USD');
const countryName = code => (world.countries.find(c => c.code === code) || {}).name || code;
const splitName = full => { const p = String(full || '').trim().split(/\s+/); return { first: p.shift() || '-', last: p.join(' ') || '-' }; };
const days = s => { const m = String(s || '').match(/(\d+)\s*[-~to]+\s*(\d+)/i) || String(s || '').match(/(\d+)/); return m ? { min: +m[1], max: +(m[2] || m[1]) } : { min: null, max: null }; };

module.exports = { http, fail, norm, normSize, variantKey, usd, countryName, splitName, days };
