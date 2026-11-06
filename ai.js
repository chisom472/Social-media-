const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, getSetting } = require('../db');
const { requireAuth, optionalAuth, featureOn, restrict } = require('../auth');
const ai = require('../ai');

const router = express.Router();
router.use(featureOn('ai'));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false, message: { error: 'Slow down a little - try again in a minute.' } });
const today = () => new Date().toISOString().slice(0, 10);

router.get('/status', optionalAuth, (req, res) => {
  const limit = parseInt(getSetting('ai_daily_limit'), 10) || 0;
  let remaining = null;
  if (req.user && limit) {
    const u = db.prepare('SELECT count FROM ai_usage WHERE user_id=? AND day=?').get(req.user.id, today());
    remaining = Math.max(0, limit - (u ? u.count : 0));
  }
  res.json({ ready: ai.ready(), name: getSetting('ai_name') || 'Enviro AI', daily_limit: limit, remaining });
});

router.post('/chat', requireAuth, restrict('ai'), limiter, async (req, res) => {
  if (!ai.ready()) return res.status(503).json({ error: 'The AI assistant is coming soon.', soon: true });
  const raw = Array.isArray((req.body || {}).messages) ? req.body.messages : [];
  const messages = raw.slice(-16).map(m => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', content: String((m && m.content) || '').slice(0, 4000) })).filter(m => m.content.trim());
  if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'Ask a question first.' });
  while (messages.length && messages[0].role !== 'user') messages.shift(); // providers require a user message first
  const limit = parseInt(getSetting('ai_daily_limit'), 10) || 0;
  if (limit) {
    const u = db.prepare('SELECT count FROM ai_usage WHERE user_id=? AND day=?').get(req.user.id, today());
    if (u && u.count >= limit) return res.status(429).json({ error: 'You have used your ' + limit + ' AI questions for today. Come back tomorrow!' });
  }
  try {
    const out = await ai.ask(messages);
    db.prepare('INSERT INTO ai_usage(user_id,day,count) VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET count=count+1').run(req.user.id, today());
    res.json({ reply: out.reply });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, soon: !!e.soon });
  }
});

module.exports = router;
