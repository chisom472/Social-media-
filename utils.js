const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const nodemailer = require('nodemailer');
const { getSetting } = require('./db');
const world = require('./world');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function mediaKind(mime) {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'page';
}

function ref(prefix) {
  return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
}

/** Only http(s) links are ever allowed in user/owner supplied URLs (blocks javascript:, data: ...). */
function safeUrl(u) {
  try {
    const x = new URL(String(u || '').trim());
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString().slice(0, 1000) : null;
  } catch (e) { return null; }
}

// ---------- HTML sanitiser for owner-written content (write-ups, policy, custom pages) ----------
const ALLOWED_TAGS = new Set(['a', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'img', 'span', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'figcaption', 'small', 'sup', 'sub', 'iframe']);
const ALLOWED_ATTRS = { a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'title', 'width', 'height'], iframe: ['src', 'width', 'height', 'title', 'allowfullscreen'], '*': ['class'] };
const IFRAME_HOSTS = /^https:\/\/(www\.youtube(-nocookie)?\.com|player\.vimeo\.com)\//i;

function sanitizeHtml(html) {
  html = String(html == null ? '' : html).slice(0, 200000)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|object|embed|form|link|meta|base|svg|math|template)[\s\S]*?(<\/\1\s*>|$)/gi, '');
  return html.replace(/<\/?([a-z][a-z0-9]*)\b([^>]*)>/gi, (m, tag, attrs) => {
    tag = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    if (m.startsWith('</')) return '</' + tag + '>';
    const out = [];
    const re = /([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
    let a;
    while ((a = re.exec(attrs))) {
      const name = a[1].toLowerCase();
      const val = a[2] != null ? a[2] : a[3] != null ? a[3] : a[4];
      if (!((ALLOWED_ATTRS[tag] || []).includes(name) || ALLOWED_ATTRS['*'].includes(name))) continue;
      if (['href', 'src'].includes(name)) {
        const v = val.trim().replace(/[\u0000-\u001f\s]/g, '');
        if (!(/^(https?:\/\/|\/(?!\/)|#|mailto:)/i.test(v))) continue;
        if (tag === 'iframe' && !IFRAME_HOSTS.test(v)) continue;
      }
      out.push(name + '="' + esc(val) + '"');
    }
    if (tag === 'iframe' && !out.some(x => x.startsWith('src='))) return '';
    if (tag === 'a') { out.push('rel="noopener noreferrer nofollow"'); }
    return '<' + tag + (out.length ? ' ' + out.join(' ') : '') + '>';
  });
}

/** Country hint from the CDN / proxy in front of the site (Cloudflare, Vercel, CloudFront...). No IP address is stored. */
function clientCountry(req) {
  const c = String(req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['cloudfront-viewer-country'] || req.headers['x-country-code'] || '').toUpperCase();
  return /^[A-Z]{2}$/.test(c) && world.isCountry(c) ? c : null;
}

// ---------- Outbound requests to user/owner supplied URLs (SSRF protection) ----------
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}

async function assertPublicUrl(raw, { allowHttp = false } = {}) {
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error('That is not a valid URL.'); }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new Error('Only https:// URLs are allowed.');
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => privateIp(a.address))) throw new Error('That address points to a private network and is not allowed.');
  return u;
}

/** fetch() for URLs we do not control: public hosts only, no redirects, timeout, small response. */
async function safeFetch(url, opts = {}, { timeoutMs = 10000, allowHttp = false } = {}) {
  await assertPublicUrl(url, { allowHttp });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, redirect: 'manual', signal: ctl.signal }); } finally { clearTimeout(t); }
}

// ---------- Email ----------
let transport = null, transportKey = '';
function mailTransport() {
  const key = [getSetting('smtp_host'), getSetting('smtp_port'), getSetting('smtp_user'), getSetting('smtp_pass')].join('|');
  if (transport && key === transportKey) return transport;
  const port = parseInt(getSetting('smtp_port') || '587', 10);
  transport = nodemailer.createTransport({
    host: getSetting('smtp_host'), port, secure: port === 465,
    auth: getSetting('smtp_user') ? { user: getSetting('smtp_user'), pass: getSetting('smtp_pass') } : undefined,
    pool: true, maxConnections: 3
  });
  transportKey = key;
  return transport;
}

async function sendMail(to, subject, html, fromName) {
  const host = getSetting('smtp_host');
  if (!host) {
    console.log('[mail:not-configured] To: ' + to + ' | ' + subject);
    return { sent: false, reason: 'SMTP not configured' };
  }
  const addr = getSetting('smtp_from') || getSetting('smtp_user');
  const m = String(addr).match(/<([^>]+)>/);
  const from = fromName ? '"' + String(fromName).replace(/["\r\n]/g, '') + '" <' + (m ? m[1] : addr) + '>' : addr;
  await mailTransport().sendMail({ from, to, subject, html });
  return { sent: true };
}

function inRange(v, a, b) { return v >= a && v <= b; }

module.exports = { UPLOAD_DIR, sha256File, mediaKind, esc, slugify, ref, safeUrl, sanitizeHtml, clientCountry, assertPublicUrl, safeFetch, privateIp, sendMail, inRange };
