const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');
const { createDeck, shuffle, sortTiles, checkWin, getValidClaims } = require('./mahjong');
const { pickBotName, chooseDiscard, findConcealedKong, decideClaim } = require('./bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const WINDS = ['east', 'south', 'west', 'north'];

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function genToken() {
  return crypto.randomBytes(16).toString('hex');
}

function publicRoom(room) {
  return {
    code: room.code,
    state: room.state,
    hostIndex: 0,
    players: room.players.map(p => ({
      name: p.name,
      seatWind: p.seatWind,
      connected: p.connected,
      isBot: !!p.isBot,
      difficulty: p.isBot ? (p.difficulty || 'normal') : null,
    })),
  };
}

function gameStateFor(room, playerIndex) {
  const g = room.game;
  if (!g) return null;
  return {
    playerIndex,
    players: room.players.map((p, i) => ({
      name: p.name,
      seatWind: p.seatWind,
      isBot: !!p.isBot,
      handCount: p.hand.length,
      hand: i === playerIndex ? sortTiles(p.hand) : null,
      melds: p.melds,
      flowers: p.flowers,
      connected: p.connected,
    })),
    wallCount: g.wall.length,
    discardPile: g.discardPile,
    currentTurn: g.currentTurn,
    phase: g.phase,
    lastDiscard: g.lastDiscard,
    lastDiscardPlayer: g.lastDiscardPlayer,
    claimDeadline: g.claimDeadline,
  };
}

function broadcast(room) {
  const g = room.game;
  if (g) g.seq = (g.seq || 0) + 1;
  room.players.forEach((p, i) => {
    if (!p.isBot && p.connected && p.socketId) {
      io.to(p.socketId).emit('gameUpdate', gameStateFor(room, i));
    }
  });
  scheduleBots(room);
}

// ── Chat & action feed ───────────────────────────────────────────────────────

const CHAT_HISTORY = 50; // messages kept per room (in memory)

function pushChat(room, entry) {
  if (!room.chat) room.chat = [];
  room.chat.push(entry);
  if (room.chat.length > CHAT_HISTORY) room.chat.splice(0, room.chat.length - CHAT_HISTORY);
}

// Announce a claimed meld (pong / kong / chow) to everyone — shown as a chat
// bubble over the actor's seat and logged in the chat feed. Discards, passes,
// wins and concealed kongs are intentionally NOT announced.
function announceAction(room, seat, type, tiles) {
  const entry = { kind: 'action', seat, name: room.players[seat].name, type, tiles };
  pushChat(room, entry);
  io.to(room.code).emit('playerAction', entry);
}

function drawFlowers(room, playerIndex) {
  const p = room.players[playerIndex];
  const g = room.game;
  let found = true;
  while (found) {
    found = false;
    for (let i = p.hand.length - 1; i >= 0; i--) {
      if (p.hand[i].suit === 'flower') {
        p.flowers.push(p.hand.splice(i, 1)[0]);
        if (g.wall.length > 0) p.hand.push(g.wall.pop());
        found = true;
      }
    }
  }
}

function startGame(room) {
  const wall = shuffle(createDeck());
  const n = room.players.length;

  room.players.forEach(p => { p.hand = []; p.melds = []; p.flowers = []; });

  // Deal 13 to each, dealer gets 14
  for (let r = 0; r < 13; r++)
    for (let i = 0; i < n; i++)
      room.players[i].hand.push(wall.pop());
  room.players[0].hand.push(wall.pop());

  room.game = {
    wall,
    discardPile: [],
    currentTurn: 0,
    phase: 'discard', // dealer already has 14
    lastDiscard: null,
    lastDiscardPlayer: null,
    claimDeadline: null,
    claimTimeout: null,
    claims: {},
    passes: new Set(),
    seq: 0,
  };
  room.state = 'playing';

  // Resolve flowers after dealing
  for (let i = 0; i < n; i++) drawFlowers(room, i);

  io.to(room.code).emit('gameStarted');
  broadcast(room);
}

function endGame(room, result) {
  const g = room.game;
  if (g?.claimTimeout) { clearTimeout(g.claimTimeout); g.claimTimeout = null; }
  room.state = 'finished';
  broadcast(room);
  io.to(room.code).emit('gameOver', result);
}

function advanceTurn(room) {
  const g = room.game;
  g.claimTimeout = null;
  g.claims = {};
  g.passes = new Set();
  g.phase = 'draw';
  g.currentTurn = (g.lastDiscardPlayer + 1) % room.players.length;

  if (g.wall.length === 0) {
    endGame(room, { type: 'draw', winner: null });
    return;
  }

  const p = room.players[g.currentTurn];
  p.hand.push(g.wall.pop());
  drawFlowers(room, g.currentTurn);
  g.phase = 'discard';
  g.lastDiscard = null;
  broadcast(room);
}

function processClaims(room) {
  const g = room.game;
  if (g.claimTimeout) { clearTimeout(g.claimTimeout); g.claimTimeout = null; }

  const entries = Object.entries(g.claims);

  // Win > kong > pong > chow
  const win = entries.find(([, c]) => c.type === 'win');
  if (win) {
    const pi = parseInt(win[0]);
    const p = room.players[pi];
    p.hand.push(g.lastDiscard);
    g.discardPile.pop();
    endGame(room, { type: 'ron', winner: pi, winnerName: p.name });
    return;
  }

  const kong = entries.find(([, c]) => c.type === 'kong');
  if (kong) {
    const pi = parseInt(kong[0]);
    const p = room.players[pi];
    const m = p.hand.filter(t => t.suit === g.lastDiscard.suit && t.value === g.lastDiscard.value).slice(0, 3);
    p.hand = p.hand.filter(t => !m.includes(t));
    p.melds.push({ type: 'kong', tiles: [...m, g.lastDiscard] });
    announceAction(room, pi, 'kong', [...m, g.lastDiscard]);
    g.discardPile.pop();
    if (g.wall.length > 0) { p.hand.push(g.wall.pop()); drawFlowers(room, pi); }
    g.currentTurn = pi;
    g.phase = 'discard';
    g.lastDiscard = null;
    g.claims = {};
    g.passes = new Set();
    broadcast(room);
    return;
  }

  const pong = entries.find(([, c]) => c.type === 'pong');
  if (pong) {
    const pi = parseInt(pong[0]);
    const p = room.players[pi];
    const m = p.hand.filter(t => t.suit === g.lastDiscard.suit && t.value === g.lastDiscard.value).slice(0, 2);
    p.hand = p.hand.filter(t => !m.includes(t));
    p.melds.push({ type: 'pong', tiles: [...m, g.lastDiscard] });
    announceAction(room, pi, 'pong', [...m, g.lastDiscard]);
    g.discardPile.pop();
    g.currentTurn = pi;
    g.phase = 'discard';
    g.lastDiscard = null;
    g.claims = {};
    g.passes = new Set();
    broadcast(room);
    return;
  }

  const chow = entries.find(([, c]) => c.type === 'chow');
  if (chow) {
    const pi = parseInt(chow[0]);
    const expected = (g.lastDiscardPlayer + 1) % room.players.length;
    if (pi === expected) {
      const p = room.players[pi];
      const handTileIds = chow[1].tileIds;
      const handTiles = handTileIds.map(id => p.hand.find(t => t.id === id)).filter(Boolean);
      if (handTiles.length === 2) {
        p.hand = p.hand.filter(t => !handTiles.includes(t));
        p.melds.push({ type: 'chow', tiles: [...handTiles, g.lastDiscard] });
        announceAction(room, pi, 'chow', [...handTiles, g.lastDiscard]);
        g.discardPile.pop();
        g.currentTurn = pi;
        g.phase = 'discard';
        g.lastDiscard = null;
        g.claims = {};
        g.passes = new Set();
        broadcast(room);
        return;
      }
    }
  }

  advanceTurn(room);
}

// ── Shared actions (used by both sockets and bots) ──────────────────────────

function doDiscard(room, playerIndex, tileId) {
  const g = room.game;
  if (!g || room.state !== 'playing') return;
  if (g.phase !== 'discard' || g.currentTurn !== playerIndex) return;

  const p = room.players[playerIndex];
  const idx = p.hand.findIndex(t => t.id === tileId);
  if (idx === -1) return;

  const tile = p.hand.splice(idx, 1)[0];
  g.discardPile.push(tile);
  g.lastDiscard = tile;
  g.lastDiscardPlayer = playerIndex;
  g.phase = 'claim';
  g.claims = {};
  g.passes = new Set();
  g.claimDeadline = Date.now() + 8000;

  if (g.claimTimeout) clearTimeout(g.claimTimeout);
  g.claimTimeout = setTimeout(() => {
    if (rooms[room.code] === room && room.game === g && g.phase === 'claim') processClaims(room);
  }, 8000);

  broadcast(room);
}

function registerClaim(room, playerIndex, type, tileIds) {
  const g = room.game;
  if (!g || room.state !== 'playing') return;
  if (g.phase !== 'claim' || playerIndex === g.lastDiscardPlayer) return;

  const p = room.players[playerIndex];
  const isNext = (g.lastDiscardPlayer + 1) % room.players.length === playerIndex;
  const valid = getValidClaims(p.hand, p.melds, g.lastDiscard, isNext);
  if (!valid.includes(type)) return;

  g.claims[playerIndex] = { type, tileIds: tileIds || [] };

  if (type === 'win') {
    processClaims(room);
  } else {
    checkAllResponded(room);
  }
}

function registerPass(room, playerIndex) {
  const g = room.game;
  if (!g || room.state !== 'playing') return;
  if (g.phase !== 'claim' || playerIndex === g.lastDiscardPlayer) return;

  g.passes.add(playerIndex);
  checkAllResponded(room);
}

function checkAllResponded(room) {
  const g = room.game;
  const n = room.players.length;
  const responded = new Set([...Object.keys(g.claims).map(Number), ...g.passes]);
  const allOthers = Array.from({ length: n }, (_, i) => i).filter(i => i !== g.lastDiscardPlayer);
  if (allOthers.every(i => responded.has(i))) {
    processClaims(room);
  }
}

// ── Bots ─────────────────────────────────────────────────────────────────────

const BOT_DELAY = Number(process.env.BOT_DELAY_MS) || 700; // base "thinking" time

function scheduleBots(room) {
  const g = room.game;
  if (!g || room.state !== 'playing') return;
  const seq = g.seq;
  const stillCurrent = () =>
    rooms[room.code] === room && room.game === g && g.seq === seq && room.state === 'playing';

  if (g.phase === 'discard') {
    const p = room.players[g.currentTurn];
    if (p?.isBot) {
      const turn = g.currentTurn;
      setTimeout(() => { if (stillCurrent()) botTakeTurn(room, turn); }, BOT_DELAY + Math.random() * BOT_DELAY);
    }
  } else if (g.phase === 'claim') {
    room.players.forEach((p, i) => {
      if (!p.isBot || i === g.lastDiscardPlayer) return;
      if (g.claims[i] !== undefined || g.passes.has(i)) return;
      setTimeout(() => {
        if (!stillCurrent() || g.phase !== 'claim') return;
        botRespondClaim(room, i);
      }, BOT_DELAY * 0.6 + Math.random() * BOT_DELAY * 0.8);
    });
  }
}

function botTakeTurn(room, playerIndex) {
  const g = room.game;
  const p = room.players[playerIndex];

  if (checkWin(p.hand, p.melds)) {
    endGame(room, { type: 'tsumo', winner: playerIndex, winnerName: p.name });
    return;
  }

  const kongTile = findConcealedKong(p.hand);
  if (kongTile && g.wall.length > 0) {
    const four = p.hand.filter(t => t.suit === kongTile.suit && t.value === kongTile.value);
    p.hand = p.hand.filter(t => !four.includes(t));
    p.melds.push({ type: 'concealed-kong', tiles: four });
    p.hand.push(g.wall.pop());
    drawFlowers(room, playerIndex);
    broadcast(room); // re-schedules this bot to act again
    return;
  }

  const tile = chooseDiscard(p.hand, p.difficulty, g.discardPile);
  if (tile) doDiscard(room, playerIndex, tile.id);
}

function botRespondClaim(room, playerIndex) {
  const g = room.game;
  const p = room.players[playerIndex];
  const isNext = (g.lastDiscardPlayer + 1) % room.players.length === playerIndex;
  const decision = decideClaim(p.hand, p.melds, g.lastDiscard, isNext, p.difficulty);
  if (decision) registerClaim(room, playerIndex, decision.type, decision.tileIds);
  else registerPass(room, playerIndex);
}

// ── Room membership helpers ──────────────────────────────────────────────────

function reindexPlayers(room) {
  room.players.forEach((p, i) => {
    p.seatWind = WINDS[i];
    if (!p.isBot && p.socketId) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.data.playerIndex = i;
      io.to(p.socketId).emit('identityUpdate', { playerIndex: i, isHost: i === 0 });
    }
  });
}

function scheduleRoomCleanup(room) {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    const r = rooms[room.code];
    if (r === room && room.players.every(p => p.isBot || !p.connected)) {
      if (room.game?.claimTimeout) clearTimeout(room.game.claimTimeout);
      delete rooms[room.code];
    }
  }, 60000);
}

// ── Socket handlers ──────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  socket.on('createRoom', ({ playerName }) => {
    let code;
    do { code = genCode(); } while (rooms[code]);

    const token = genToken();
    const player = { socketId: socket.id, token, name: (playerName || 'Player').trim().slice(0, 20) || 'Player', seatWind: 'east', hand: [], melds: [], flowers: [], connected: true, isBot: false };
    rooms[code] = { code, players: [player], state: 'waiting', game: null, cleanupTimer: null, chat: [] };
    socket.join(code);
    socket.data = { code, playerIndex: 0 };
    socket.emit('roomCreated', { code, playerIndex: 0, token });
    io.to(code).emit('roomUpdate', publicRoom(rooms[code]));
  });

  socket.on('joinRoom', ({ code, playerName }) => {
    const c = (code || '').toUpperCase().trim();
    const room = rooms[c];
    if (!room) return socket.emit('joinError', 'Room not found');
    if (room.state !== 'waiting') return socket.emit('joinError', 'Game already in progress');
    if (room.players.length >= 4) return socket.emit('joinError', 'Room is full (max 4 players)');

    const token = genToken();
    const playerIndex = room.players.length;
    const player = { socketId: socket.id, token, name: (playerName || 'Player').trim().slice(0, 20) || 'Player', seatWind: WINDS[playerIndex], hand: [], melds: [], flowers: [], connected: true, isBot: false };
    room.players.push(player);
    socket.join(c);
    socket.data = { code: c, playerIndex };
    socket.emit('roomJoined', { code: c, playerIndex, token });
    socket.emit('chatHistory', room.chat);
    io.to(c).emit('roomUpdate', publicRoom(room));
  });

  // Re-attach a socket to its seat after page navigation / refresh
  socket.on('rejoin', ({ code, token }) => {
    const c = (code || '').toUpperCase().trim();
    const room = rooms[c];
    if (!room) return socket.emit('rejoinError', 'Room no longer exists');

    const playerIndex = room.players.findIndex(p => !p.isBot && p.token === token);
    if (playerIndex === -1) return socket.emit('rejoinError', 'Not a member of this room');

    const p = room.players[playerIndex];
    p.socketId = socket.id;
    p.connected = true;
    socket.join(c);
    socket.data = { code: c, playerIndex };
    socket.emit('rejoined', { code: c, playerIndex, isHost: playerIndex === 0, state: room.state });
    socket.emit('chatHistory', room.chat);
    io.to(c).emit('roomUpdate', publicRoom(room));
    if (room.game) socket.emit('gameUpdate', gameStateFor(room, playerIndex));
  });

  socket.on('addBot', ({ difficulty } = {}) => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || playerIndex !== 0 || room.state !== 'waiting') return;
    if (room.players.length >= 4) return socket.emit('error', 'Room is full');

    const level = ['easy', 'normal', 'hard'].includes(difficulty) ? difficulty : 'normal';
    const name = pickBotName(room.players.map(p => p.name));
    room.players.push({ socketId: null, token: null, name, seatWind: WINDS[room.players.length], hand: [], melds: [], flowers: [], connected: true, isBot: true, difficulty: level });
    io.to(code).emit('roomUpdate', publicRoom(room));
  });

  socket.on('removeBot', ({ index }) => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || playerIndex !== 0 || room.state !== 'waiting') return;
    if (!room.players[index]?.isBot) return;

    room.players.splice(index, 1);
    reindexPlayers(room);
    io.to(code).emit('roomUpdate', publicRoom(room));
  });

  socket.on('leaveRoom', () => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || room.state !== 'waiting' || !room.players[playerIndex]) return;

    room.players.splice(playerIndex, 1);
    socket.leave(code);
    socket.data = {};
    socket.emit('leftRoom');

    if (!room.players.some(p => !p.isBot)) {
      if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
      delete rooms[code];
      return;
    }
    // Keep a human in the host seat
    const firstHuman = room.players.findIndex(p => !p.isBot);
    if (firstHuman > 0) {
      const [h] = room.players.splice(firstHuman, 1);
      room.players.unshift(h);
    }
    reindexPlayers(room);
    io.to(code).emit('roomUpdate', publicRoom(room));
  });

  socket.on('startGame', () => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || playerIndex !== 0 || room.state !== 'waiting') return;
    if (room.players.length < 2) return socket.emit('error', 'Need at least 2 players (add a bot!)');
    startGame(room);
  });

  socket.on('discard', ({ tileId }) => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || playerIndex === undefined) return;
    doDiscard(room, playerIndex, tileId);
  });

  socket.on('claim', ({ type, tileIds }) => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || playerIndex === undefined) return;
    registerClaim(room, playerIndex, type, tileIds);
  });

  socket.on('pass', () => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || playerIndex === undefined) return;
    registerPass(room, playerIndex);
  });

  socket.on('chat', ({ text } = {}) => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || playerIndex === undefined || !room.players[playerIndex]) return;
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean) return;
    const entry = { kind: 'chat', seat: playerIndex, name: room.players[playerIndex].name, text: clean };
    pushChat(room, entry);
    io.to(code).emit('chatMessage', entry);
  });

  socket.on('declareWin', () => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || !room.game) return;
    const g = room.game;
    if (g.phase !== 'discard' || g.currentTurn !== playerIndex) return;

    const p = room.players[playerIndex];
    if (checkWin(p.hand, p.melds)) {
      endGame(room, { type: 'tsumo', winner: playerIndex, winnerName: p.name });
    }
  });

  socket.on('declareKong', ({ tileId }) => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || !room.game) return;
    const g = room.game;
    if (g.phase !== 'discard' || g.currentTurn !== playerIndex) return;

    const p = room.players[playerIndex];
    const tile = p.hand.find(t => t.id === tileId);
    if (!tile) return;
    const matching = p.hand.filter(t => t.suit === tile.suit && t.value === tile.value);
    if (matching.length < 4) return;

    p.hand = p.hand.filter(t => !matching.includes(t));
    p.melds.push({ type: 'concealed-kong', tiles: matching.slice(0, 4) });
    if (g.wall.length > 0) { p.hand.push(g.wall.pop()); drawFlowers(room, playerIndex); }
    broadcast(room);
  });

  socket.on('requestState', () => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (room && playerIndex !== undefined) {
      socket.emit('roomUpdate', publicRoom(room));
      socket.emit('chatHistory', room.chat);
      if (room.game) socket.emit('gameUpdate', gameStateFor(room, playerIndex));
    }
  });

  socket.on('newGame', () => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || playerIndex !== 0) return;
    if (room.game?.claimTimeout) clearTimeout(room.game.claimTimeout);
    // Rotate winds
    room.players.forEach(p => {
      p.seatWind = WINDS[(WINDS.indexOf(p.seatWind) + 1) % 4];
    });
    room.state = 'waiting';
    room.game = null;
    io.to(code).emit('roomUpdate', publicRoom(room));
    io.to(code).emit('backToLobby');
  });

  socket.on('disconnect', () => {
    const { code, playerIndex } = socket.data || {};
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const p = room.players[playerIndex];
    // Only mark disconnected if this socket still owns the seat (rejoin may have replaced it)
    if (p && p.socketId === socket.id) {
      p.connected = false;
      p.socketId = null;
      io.to(code).emit('roomUpdate', publicRoom(room));
      io.to(code).emit('playerDisconnected', { playerIndex, name: p.name });
    }
    scheduleRoomCleanup(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Mahjong running at http://localhost:${PORT}`));
