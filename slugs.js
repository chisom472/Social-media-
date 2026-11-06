/** Memorable, shareable addresses (stores use /s/<name>, communities /c/<name>). */
const RESERVED = new Set(['admin', 'api', 'www', 'app', 'login', 'signup', 'logout', 'settings', 'wallet', 'creator', 'new', 'create', 'edit', 'explore', 'search', 'help', 'support', 'about', 'policy', 'terms', 'privacy', 'static', 'uploads', 'img', 'css', 'js', 'community', 'communities', 'class', 'classes', 'store', 'stores', 'shop', 'chat', 'reels', 'feed', 'home', 'null', 'undefined', 'official', 'digitalenviro', 'digital-enviro', 'owner', 'root', 'mod', 'moderator', 'staff', 'team']);

function clean(input) {
  return String(input || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
}
function problem(slug) {
  if (slug.length < 3) return 'Use at least 3 letters or numbers.';
  if (RESERVED.has(slug)) return 'That address is reserved. Try another.';
  return null;
}
/** First free slug starting from a name. `taken(slug)` says whether it is in use. */
function unique(name, taken) {
  const base = clean(name) || 'community';
  let s = base.length >= 3 ? base : base + '-hub';
  for (let n = 2; RESERVED.has(s) || taken(s); n++) s = (base.slice(0, 26) + '-' + n).replace(/^-/, '');
  return s;
}
function suggestions(slug, taken) {
  const out = [];
  for (const sfx of ['-hub', '-club', '-official', '-1', '-2', '-co']) { const s = (slug.slice(0, 30 - sfx.length) + sfx); if (!RESERVED.has(s) && !taken(s)) out.push(s); if (out.length >= 3) break; }
  return out;
}
module.exports = { clean, problem, unique, suggestions, RESERVED };
