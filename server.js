'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Game } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const game = new Game();

// socket.id -> playerId（旁观者为 null）
const sockets = new Map();
// 大厅里断线的玩家给一点重连时间再移除
const lobbyTimers = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.send('ok'));

function broadcast() {
  for (const [sid, pid] of sockets) {
    const s = io.sockets.sockets.get(sid);
    if (s) s.emit('state', game.viewFor(pid));
  }
}

const actions = {
  start: (pid) => game.start(pid),
  reset: (pid) => game.reset(pid),
  kick: (pid, a) => game.kick(pid, a.playerId),
  settings: (pid, a) => game.setSettings(pid, a.settings || {}),
  choose: (pid, a) => game.choose(pid, a.roles),
  forceChoose: (pid) => game.forceChoose(pid),
  transfer: (pid, a) => game.transfer(pid, a.to, a.amount),
  offer: (pid, a) => game.createOffer(pid, a),
  respondOffer: (pid, a) => game.respondOffer(pid, a.offerId, !!a.accept),
  withdraw: (pid, a) => game.withdraw(pid, a.slotId),
  threat: (pid, a) => game.useThreat(pid, a.target),
  heist: (pid) => game.startHeist(pid),
  readyHeist: (pid, a) => game.readyHeist(pid, !!a.on),
  name: (pid, a) => game.nameRole(pid, a.role),
  next: (pid) => game.nextRound(pid),
  chat: (pid, a) => game.addChat(pid, a.text),
  rename: (pid, a) => game.rename(pid, a.name),
  voteRestart: (pid, a) => game.voteRestart(pid, !!a.on),
};

io.on('connection', (socket) => {
  sockets.set(socket.id, null);
  socket.emit('state', game.viewFor(null));

  socket.on('join', ({ token, name } = {}, cb = () => {}) => {
    if (typeof token !== 'string' || token.length < 8) return cb({ error: '无效的身份令牌' });
    const res = game.join(token, name);
    if (res.error) return cb(res);
    if (res.playerId) {
      clearTimeout(lobbyTimers.get(res.playerId));
      lobbyTimers.delete(res.playerId);
    }
    sockets.set(socket.id, res.playerId || null);
    cb(res);
    broadcast();
  });

  socket.on('action', (a = {}, cb = () => {}) => {
    const pid = sockets.get(socket.id);
    const fn = actions[a.type];
    if (!pid) return cb({ error: '请先加入游戏' });
    if (!fn) return cb({ error: '未知操作' });
    let res;
    try {
      res = fn(pid, a) || {};
    } catch (e) {
      console.error(e);
      res = { error: '服务器出错了' };
    }
    cb(res);
    if (!res.error) broadcast();
  });

  socket.on('disconnect', () => {
    const pid = sockets.get(socket.id);
    sockets.delete(socket.id);
    if (!pid) return;
    // 同一玩家可能开了多个标签页
    if ([...sockets.values()].includes(pid)) return;
    game.disconnect(pid);
    if (game.phase === 'lobby') {
      lobbyTimers.set(pid, setTimeout(() => {
        lobbyTimers.delete(pid);
        if (game.player(pid) && !game.player(pid).connected) {
          game.remove(pid);
          broadcast();
        }
      }, 15000));
    }
    broadcast();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`百万美金 running on http://localhost:${PORT}`));
