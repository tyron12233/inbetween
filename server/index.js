const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const game = require('./game');
const { Store } = require('./store');

// Room codes skip look-alike letters (I, L, O) so they're easy to read out loud.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ';

function makeCode(store) {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!store.get(code)) return code;
  }
}

function validId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);
}

function createApp({ dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data') } = {}) {
  const store = new Store(dataDir);
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.get('/healthz', (req, res) => res.send('ok'));

  function connectedIds(code) {
    const ids = new Set();
    for (const s of io.sockets.adapter.rooms.get(code) || []) {
      const sock = io.sockets.sockets.get(s);
      if (sock?.data.playerId) ids.add(sock.data.playerId);
    }
    return ids;
  }

  function broadcast(room) {
    io.to(room.code).emit('state', game.publicView(room, connectedIds(room.code)));
  }

  io.on('connection', (socket) => {
    const reply = (ack, payload) => typeof ack === 'function' && ack(payload);

    function enter(room, player) {
      if (socket.data.code && socket.data.code !== room.code) socket.leave(socket.data.code);
      socket.data.code = room.code;
      socket.data.playerId = player.id;
      socket.join(room.code);
    }

    socket.on('room:create', (msg = {}, ack) => {
      try {
        if (!validId(msg.playerId) || !validId(msg.secret)) throw new game.GameError('Bad identity');
        const code = makeCode(store);
        const room = game.createRoom({
          code,
          host: { id: msg.playerId, secret: msg.secret, name: msg.name },
          settings: msg.settings || {},
        });
        store.set(room);
        enter(room, game.getPlayer(room, msg.playerId));
        reply(ack, { ok: true, code });
        broadcast(room);
      } catch (err) {
        reply(ack, { ok: false, error: errMsg(err) });
      }
    });

    socket.on('room:join', (msg = {}, ack) => {
      try {
        const code = String(msg.code || '').toUpperCase().trim();
        const room = store.get(code);
        if (!room) throw new game.GameError(`No room called ${code || '…'}`);
        if (!validId(msg.playerId) || !validId(msg.secret)) throw new game.GameError('Bad identity');
        let player = game.getPlayer(room, msg.playerId);
        if (player) {
          if (player.secret !== msg.secret) throw new game.GameError('That seat belongs to someone else');
        } else {
          player = game.addPlayer(room, { id: msg.playerId, secret: msg.secret, name: msg.name });
          store.touch(room);
        }
        enter(room, player);
        reply(ack, { ok: true, code });
        broadcast(room);
      } catch (err) {
        reply(ack, { ok: false, error: errMsg(err) });
      }
    });

    // Every in-room action follows the same shape: run the rule, save, broadcast.
    const actions = {
      'player:rename': (room, me, msg) => game.renamePlayer(room, me, msg.name),
      'game:start': (room, me) => game.startGame(room, me),
      'turn:deal': (room, me) => game.dealPosts(room, me),
      'turn:bet': (room, me, msg) => game.placeBet(room, me, { amount: msg.amount, guess: msg.guess }),
      'turn:pass': (room, me) => game.pass(room, me),
      'host:skip': (room, me) => {
        if (room.hostId !== me) throw new game.GameError('Only the host can do that');
        game.pass(room, me, true);
      },
      'player:sit': (room, me, msg) => game.setSittingOut(room, me, msg.playerId || me, !!msg.out),
      'player:remove': (room, me, msg) => game.removePlayer(room, me, msg.playerId),
      'host:settings': (room, me, msg) => game.updateSettings(room, me, msg.settings || {}),
      'host:transfer': (room, me, msg) => game.transferHost(room, me, msg.playerId),
      'host:claim': (room, me) => game.claimHost(room, me, connectedIds(room.code).has(room.hostId)),
      'game:end': (room, me) => game.endGame(room, me),
      'game:new': (room, me) => game.newSession(room, me),
    };

    for (const [event, run] of Object.entries(actions)) {
      socket.on(event, (msg = {}, ack) => {
        try {
          const room = store.get(socket.data.code);
          if (!room || !socket.data.playerId) throw new game.GameError('Join a room first');
          run(room, socket.data.playerId, msg || {});
          store.touch(room);
          reply(ack, { ok: true });
          broadcast(room);
        } catch (err) {
          reply(ack, { ok: false, error: errMsg(err) });
        }
      });
    }

    socket.on('disconnect', () => {
      const room = store.get(socket.data.code);
      if (room) broadcast(room);
    });
  });

  return { app, server, io, store };
}

function errMsg(err) {
  if (err instanceof game.GameError) return err.message;
  console.error(err);
  return 'Something went wrong';
}

if (require.main === module) {
  const { server, store } = createApp();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => console.log(`In-Between running on http://localhost:${port}`));
  const shutdown = () => {
    store.flush();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createApp };
