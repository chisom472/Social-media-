const { Server } = require('socket.io');
const { verifyToken, parseCookies, COOKIE } = require('./auth');
const notifier = require('./notifier');
const { db } = require('./db');
const chat = require('./routes/chat');

const online = new Map(); // userId -> connection count

function init(httpServer) {
  const io = new Server(httpServer, { cors: { origin: false }, maxHttpBufferSize: 1e6 });
  chat.setIO(io);
  notifier.init({ io, isOnline: id => online.has(id) });

  // same-origin only; the session comes from the httpOnly cookie (never from page JavaScript)
  io.use((socket, next) => {
    const origin = socket.handshake.headers.origin;
    if (origin) { try { if (new URL(origin).host !== socket.handshake.headers.host) return next(new Error('forbidden')); } catch (e) { return next(new Error('forbidden')); } }
    const u = verifyToken(parseCookies(socket.handshake.headers.cookie)[COOKIE]);
    if (!u) return next(new Error('unauthorized'));
    socket.user = u;
    next();
  });

  io.on('connection', socket => {
    const uid = socket.user.id;
    socket.join('user:' + uid);
    online.set(uid, (online.get(uid) || 0) + 1);
    io.emit('presence', { user_id: uid, online: true });

    // join all of the user's conversation rooms
    db.prepare('SELECT conversation_id FROM conversation_members WHERE user_id=?').all(uid)
      .forEach(r => socket.join('conv:' + r.conversation_id));

    socket.on('conversation:join', id => {
      if (chat.memberOf(id, uid)) socket.join('conv:' + id);
    });

    socket.on('typing', ({ conversation_id, typing }) => {
      if (!chat.memberOf(conversation_id, uid)) return;
      socket.to('conv:' + conversation_id).emit('typing', { conversation_id, user_id: uid, username: socket.user.username, typing: !!typing });
    });

    socket.on('presence:query', (ids, cb) => {
      if (typeof cb !== 'function' || !Array.isArray(ids)) return;
      const out = {};
      ids.slice(0, 200).forEach(i => (out[i] = online.has(i)));
      cb(out);
    });

    socket.on('disconnect', () => {
      const n = (online.get(uid) || 1) - 1;
      if (n <= 0) {
        online.delete(uid);
        db.prepare('UPDATE users SET last_seen=CURRENT_TIMESTAMP WHERE id=?').run(uid);
        io.emit('presence', { user_id: uid, online: false });
      } else online.set(uid, n);
    });
  });
  return io;
}

module.exports = { init, online };
