// Currency conversion for wallets. Rates are "units of currency per 1 US dollar".
// Rates refresh automatically (public rates feed) unless the owner pinned a rate by hand in Admin > Payments > Exchange rates.
// The owner's conversion margin (fx_margin_percent) is kept as platform income.
const { db, getSetting } = require('./db');
const world = require('./world');
const { safeFetch } = require('./utils');

function perUsd(cur) {
  cur = String(cur).toUpperCase();
  if (cur === 'USD') return 1;
  const r = db.prepare('SELECT per_usd FROM fx_rates WHERE currency=?').get(cur);
  return r ? r.per_usd : null;
}

/** 1 unit of `from` = rate units of `to` (null if either currency has no rate yet). */
function rate(from, to) {
  const a = perUsd(from), b = perUsd(to);
  return a && b ? b / a : null;
}

function marginPercent() {
  const m = parseFloat(getSetting('fx_margin_percent'));
  return Number.isFinite(m) ? Math.min(30, Math.max(0, m)) : 0;
}

/** Converts minor units. Returns { out, gross, margin, rate }; throws if no rate is known. */
function convertMinor(minor, from, to, pct) {
  if (from === to) return { out: minor, gross: minor, margin: 0, rate: 1 };
  const r = rate(from, to);
  if (!r) throw Object.assign(new Error('No exchange rate is available for ' + from + ' to ' + to + ' yet.'), { status: 503 });
  const gross = Math.floor((minor / world.factor(from)) * r * world.factor(to) + 1e-9);
  const margin = Math.floor(gross * (pct == null ? marginPercent() : pct) / 100);
  return { out: gross - margin, gross, margin, rate: r };
}

let lastRefresh = 0;
async function refresh(force) {
  if (!force && getSetting('fx_auto') !== '1') return { updated: 0, skipped: true };
  if (!force && Date.now() - lastRefresh < 30 * 60 * 1000) return { updated: 0, skipped: true };
  lastRefresh = Date.now();
  const res = await safeFetch(getSetting('fx_url') || 'https://open.er-api.com/v6/latest/USD', {}, { timeoutMs: 15000 });
  if (!res.ok) throw new Error('Rates feed answered ' + res.status);
  const j = await res.json();
  const rates = j.rates || j.conversion_rates || {};
  const up = db.prepare(`INSERT INTO fx_rates(currency,per_usd,source,updated_at) VALUES(?,?,'auto',CURRENT_TIMESTAMP)
    ON CONFLICT(currency) DO UPDATE SET per_usd=excluded.per_usd, updated_at=CURRENT_TIMESTAMP WHERE fx_rates.source!='manual'`);
  let n = 0;
  db.transaction(() => {
    world.currencies.forEach(c => {
      const v = Number(rates[c.code]);
      if (c.code !== 'USD' && v > 0 && Number.isFinite(v)) { up.run(c.code, v); n++; }
    });
  })();
  return { updated: n };
}

function setManual(cur, value) {
  cur = String(cur).toUpperCase();
  if (!world.isCurrency(cur)) throw Object.assign(new Error('Unknown currency.'), { status: 400 });
  const v = Number(value);
  if (!(v > 0) || !Number.isFinite(v)) throw Object.assign(new Error('Enter a rate greater than zero.'), { status: 400 });
  db.prepare(`INSERT INTO fx_rates(currency,per_usd,source,updated_at) VALUES(?,?,'manual',CURRENT_TIMESTAMP)
    ON CONFLICT(currency) DO UPDATE SET per_usd=excluded.per_usd, source='manual', updated_at=CURRENT_TIMESTAMP`).run(cur, v);
}
function clearManual(cur) { db.prepare("UPDATE fx_rates SET source='auto' WHERE currency=?").run(String(cur).toUpperCase()); }

module.exports = { perUsd, rate, convertMinor, refresh, setManual, clearManual, marginPercent };
