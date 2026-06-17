const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');
const { createDeck, shuffle, sortTiles, checkWin, getValidClaims } = require('./mahjong');
const { pickBotName, chooseDiscard, findConcealedKong, decideClaim } = require('./bot');
const { scoreWin, computePayments } = require('./scoring');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
// Serve the shared rules engine to the browser; it lives at the project root
// (required by the server too), not under public/.
app.get('/mahjong.js', (req, res) => res.sendFile(path.join(__dirname, 'mahjong.js')));

const rooms = {};
const WINDS = ['east', 'south', 'west', 'north'];

// HK faan scoring rules. Override per-deployment via environment variables.
// MIN_FAAN=3 enforces the traditional "no chicken hand" minimum.
const SCORING = {
  minFaan: Number(process.env.MIN_FAAN) || 0,
  limitFaan: Number(process.env.LIMIT_FAAN) || 13,
  basePoints: Number(process.env.BASE_POINTS) || 1,
};

const CLAIM_WINDOW_MS = 8000; // claim & rob response window (ms)

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
    roundWind: WINDS[room.roundWind || 0],
    dealer: room.dealer || 0,
    matchRounds: room.matchRounds || 4,
    players: room.players.map(p => ({
      name: p.name,
      seatWind: p.seatWind,
      connected: p.connected,
      isBot: !!p.isBot,
      points: p.points || 0,
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
      points: p.points || 0,
    })),
    wallCount: g.wall.length,
    discardPile: g.discardPile,
    currentTurn: g.currentTurn,
    phase: g.phase,
    lastDiscard: g.lastDiscard,
    lastDiscardPlayer: g.lastDiscardPlayer,
    claimDeadline: g.claimDeadline,
    roundWind: WINDS[room.roundWind || 0],
    dealer: room.dealer || 0,
    handNumber: room.handNumber || 0,
    dealerStreak: room.dealerStreak || 0,
    matchRounds: room.matchRounds || 4,
    robKong: g.robKong ? { seat: g.robKong.seat, tile: g.robKong.tile } : null,
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

// Draw a replacement tile after a kong and flag it for 槓上開花 (no-op if the wall is empty).
function drawReplacement(room, playerIndex) {
  const g = room.game;
  if (g.wall.length === 0) return;
  room.players[playerIndex].hand.push(g.wall.pop());
  drawFlowers(room, playerIndex);
  g.kongReplacement = playerIndex;
}

function startGame(room) {
  const wall = shuffle(createDeck());
  const n = room.players.length;
  if (room.dealer == null || room.dealer >= n) room.dealer = 0;
  assignSeatWinds(room);

  room.players.forEach(p => { p.hand = []; p.melds = []; p.flowers = []; });

  // Deal 13 to each, dealer (East) gets 14
  for (let r = 0; r < 13; r++)
    for (let i = 0; i < n; i++)
      room.players[i].hand.push(wall.pop());
  room.players[room.dealer].hand.push(wall.pop());

  room.game = {
    wall,
    discardPile: [],
    currentTurn: room.dealer,
    phase: 'discard', // dealer already has 14
    lastDiscard: null,
    lastDiscardPlayer: null,
    claimDeadline: null,
    claimTimeout: null,
    claims: {},
    passes: new Set(),
    seq: 0,
    kongReplacement: null, // seat that just drew a kong replacement (for 槓上開花)
    robKong: null,         // active added-kong rob window (for 搶槓)
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

  // Apply point transfers to the running session scoreboard.
  if (result.payments) {
    result.payments.forEach((amt, i) => { room.players[i].points = (room.players[i].points || 0) + amt; });
  }
  result.totals = room.players.map(p => p.points || 0);
  result.roundWind = WINDS[room.roundWind || 0];
  room.lastResult = result;

  // Match progress: which hand/round this was, and whether the match is now
  // complete (so the client shows final standings instead of "Next Hand").
  result.handNumber = room.handNumber || 0;
  result.dealerStreak = room.dealerStreak || 0;
  result.matchRounds = room.matchRounds || 4;
  result.matchOver = matchWillEndAfter(room, result);
  if (result.matchOver) { room.matchOver = true; result.standings = computeStandings(room); }

  broadcast(room);
  io.to(room.code).emit('gameOver', result);
}

// ── Match flow: rounds, dealer rotation, standings ───────────────────────────

// Would the match be complete once this hand's dealer-pass is applied? Dealer
// keeps the deal on a win or draw (連莊), so those don't advance the round.
function matchWillEndAfter(room, result) {
  const n = room.players.length;
  const dealerRepeats = result.type === 'draw' || result.winner === room.dealer;
  const passes = (room.dealerPasses || 0) + (dealerRepeats ? 0 : 1);
  return passes >= (room.matchRounds || 4) * n;
}

// Rotate the deal between hands. On a non-dealer win the deal passes to the next
// seat and a full lap advances the prevailing wind (E→S→W→N); on a win/draw by
// the dealer it stays put and the 連莊 streak grows.
function advanceDealer(room) {
  const n = room.players.length;
  const res = room.lastResult;
  const dealerRepeats = !res || res.type === 'draw' || res.winner === room.dealer;
  if (dealerRepeats) {
    room.dealerStreak = (room.dealerStreak || 0) + 1;
  } else {
    room.dealer = (room.dealer + 1) % n;
    room.dealerStreak = 0;
    room.dealerPasses = (room.dealerPasses || 0) + 1;
    if (room.dealerPasses % n === 0) room.roundWind = ((room.roundWind || 0) + 1) % 4;
  }
  assignSeatWinds(room);
}

// Session scoreboard, ranked high→low; tied players share a rank.
function computeStandings(room) {
  const rows = room.players
    .map((p, i) => ({ name: p.name, isBot: !!p.isBot, points: p.points || 0, seat: i }))
    .sort((a, b) => b.points - a.points);
  let rank = 0, prevPts = null;
  rows.forEach((r, idx) => {
    if (prevPts === null || r.points !== prevPts) { rank = idx + 1; prevPts = r.points; }
    r.rank = rank;
  });
  return rows;
}

// Begin a brand-new match from a zeroed scoreboard.
function startMatch(room) {
  room.players.forEach(p => { p.points = 0; });
  room.dealer = 0;
  room.roundWind = 0;
  room.dealerPasses = 0;
  room.dealerStreak = 0;
  room.handNumber = 1;
  room.matchOver = false;
  room.endVotes = new Set();
  room.lastResult = null;
  startGame(room);
}

// End the match (rounds complete or a unanimous vote) and broadcast standings.
function finishMatch(room) {
  if (room.game?.claimTimeout) { clearTimeout(room.game.claimTimeout); room.game.claimTimeout = null; }
  room.matchOver = true;
  room.state = 'finished';
  room.game = null;
  room.endVotes = new Set();
  io.to(room.code).emit('matchOver', { standings: computeStandings(room), rounds: room.matchRounds || 4 });
}

function advanceTurn(room) {
  const g = room.game;
  g.claimTimeout = null;
  g.claims = {};
  g.passes = new Set();
  g.kongReplacement = null;
  g.robKong = null;
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

  // Win > kong > pong > chow. Multiple players can ron the same discard; the one
  // nearest the discarder in turn order takes it.
  const winEntries = entries.filter(([, c]) => c.type === 'win');
  if (winEntries.length) {
    const n = room.players.length;
    winEntries.sort(([a], [b]) =>
      ((+a - g.lastDiscardPlayer - 1 + n) % n) - ((+b - g.lastDiscardPlayer - 1 + n) % n));
    const [winKey, winClaim] = winEntries[0];
    const pi = parseInt(winKey);
    const p = room.players[pi];
    const score = winClaim.score || scoreWin(ronContext(room, pi), SCORING);
    p.hand.push(g.lastDiscard);
    g.discardPile.pop();
    const payments = computePayments(score, pi, room.players.length, false, g.lastDiscardPlayer, SCORING);
    endGame(room, {
      type: 'ron', winner: pi, winnerName: p.name, score, payments,
      discarder: g.lastDiscardPlayer, discarderName: room.players[g.lastDiscardPlayer].name,
    });
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
    drawReplacement(room, pi);
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

// ── Scoring helpers ──────────────────────────────────────────────────────────

// Build a scoreWin() context. `hand` must already include the winning tile.
function winContext(room, winnerIndex, hand, selfDraw) {
  const p = room.players[winnerIndex];
  return {
    hand,
    melds: p.melds,
    seatWind: p.seatWind,
    roundWind: WINDS[room.roundWind || 0],
    selfDraw,
    flowers: p.flowers,
    lastTile: room.game.wall.length === 0,
    kongReplacement: selfDraw && room.game.kongReplacement === winnerIndex,
  };
}
const ronContext = (room, i) => winContext(room, i, [...room.players[i].hand, room.game.lastDiscard], false);
const selfDrawContext = (room, i) => winContext(room, i, room.players[i].hand, true);
// Robbing the kong: winner takes the tile a player just added to an exposed pong.
function robContext(room, i) {
  const ctx = winContext(room, i, [...room.players[i].hand, room.game.robKong.tile], false);
  ctx.robbingKong = true;
  return ctx;
}

// End the game on a self-draw, if the hand meets the faan minimum. Returns
// whether the win was awarded (false = below minimum, keep playing).
function finishSelfDraw(room, playerIndex) {
  const score = scoreWin(selfDrawContext(room, playerIndex), SCORING);
  if (score.faan < SCORING.minFaan) return false;
  const p = room.players[playerIndex];
  const payments = computePayments(score, playerIndex, room.players.length, true, null, SCORING);
  endGame(room, { type: 'tsumo', winner: playerIndex, winnerName: p.name, score, payments });
  return true;
}

// ── Added kong (加槓) & robbing the kong (搶槓) ───────────────────────────────

// Open an 8s window in which any other player may win on the tile being added to
// an exposed pong. (Concealed kongs are NOT robbable.)
function openRobWindow(room, seat, tile, meldIndex) {
  const g = room.game;
  g.phase = 'rob';
  g.robKong = { seat, tile, meldIndex };
  g.claims = {};
  g.passes = new Set();
  g.claimDeadline = Date.now() + CLAIM_WINDOW_MS;
  if (g.claimTimeout) clearTimeout(g.claimTimeout);
  g.claimTimeout = setTimeout(() => {
    if (rooms[room.code] === room && room.game === g && g.phase === 'rob') resolveRob(room);
  }, CLAIM_WINDOW_MS);
  broadcast(room);
}

// Resolve the rob window: award the robber if someone won, else complete the kong.
function resolveRob(room) {
  const g = room.game;
  if (g.claimTimeout) { clearTimeout(g.claimTimeout); g.claimTimeout = null; }
  if (!g.robKong) return;
  const { seat: declarer, tile, meldIndex } = g.robKong;

  // Among everyone who can rob, the player nearest the declarer (in turn order) wins.
  const robEntries = Object.entries(g.claims).filter(([, c]) => c.type === 'win');
  if (robEntries.length) {
    const n = room.players.length;
    robEntries.sort(([a], [b]) =>
      ((+a - declarer - 1 + n) % n) - ((+b - declarer - 1 + n) % n));
    const [robKey, robClaim] = robEntries[0];
    const pi = parseInt(robKey);
    const robber = room.players[pi];
    const score = robClaim.score || scoreWin(robContext(room, pi), SCORING);
    // Move the added tile from the declarer to the robber.
    room.players[declarer].hand = room.players[declarer].hand.filter(t => t.id !== tile.id);
    robber.hand.push(tile);
    const payments = computePayments(score, pi, room.players.length, false, declarer, SCORING);
    g.robKong = null;
    endGame(room, {
      type: 'ron', winner: pi, winnerName: robber.name, score, payments,
      discarder: declarer, discarderName: room.players[declarer].name, robbed: true,
    });
    return;
  }

  // Nobody robbed — complete the added kong and draw a replacement.
  const p = room.players[declarer];
  p.hand = p.hand.filter(t => t.id !== tile.id);
  const meld = p.melds[meldIndex];
  meld.type = 'kong';
  meld.tiles = [...meld.tiles, tile];
  g.robKong = null;
  g.claims = {};
  g.passes = new Set();
  g.phase = 'discard';
  g.currentTurn = declarer;
  drawReplacement(room, declarer);
  broadcast(room);
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
  g.kongReplacement = null; // discarding ends any pending kong-replacement win
  g.discardPile.push(tile);
  g.lastDiscard = tile;
  g.lastDiscardPlayer = playerIndex;
  g.phase = 'claim';
  g.claims = {};
  g.passes = new Set();
  g.claimDeadline = Date.now() + CLAIM_WINDOW_MS;

  if (g.claimTimeout) clearTimeout(g.claimTimeout);
  g.claimTimeout = setTimeout(() => {
    if (rooms[room.code] === room && room.game === g && g.phase === 'claim') processClaims(room);
  }, CLAIM_WINDOW_MS);

  broadcast(room);
}

function registerClaim(room, playerIndex, type, tileIds) {
  const g = room.game;
  if (!g || room.state !== 'playing') return;

  // Robbing-the-kong window: only a winning claim on the added-kong tile counts.
  if (g.phase === 'rob') {
    if (type !== 'win' || !g.robKong || playerIndex === g.robKong.seat) return;
    const p = room.players[playerIndex];
    if (!checkWin([...p.hand, g.robKong.tile], p.melds)) return;
    const score = scoreWin(robContext(room, playerIndex), SCORING);
    if (score.faan < SCORING.minFaan) {
      if (p.socketId) io.to(p.socketId).emit('actionError', `Not enough faan to rob (${score.faan}/${SCORING.minFaan}).`);
      registerPass(room, playerIndex); // treat as a pass so the rob window can resolve
      return;
    }
    g.claims[playerIndex] = { type: 'win', score };
    checkAllRespondedRob(room); // collect every response, then resolveRob picks by seat priority
    return;
  }

  if (g.phase !== 'claim' || playerIndex === g.lastDiscardPlayer) return;

  const p = room.players[playerIndex];
  const isNext = (g.lastDiscardPlayer + 1) % room.players.length === playerIndex;
  const valid = getValidClaims(p.hand, p.melds, g.lastDiscard, isNext);
  if (!valid.includes(type)) return;

  if (type === 'win') {
    const score = scoreWin(ronContext(room, playerIndex), SCORING);
    if (score.faan < SCORING.minFaan) {
      if (p.socketId) io.to(p.socketId).emit('actionError', `Not enough faan to win (${score.faan}/${SCORING.minFaan}).`);
      registerPass(room, playerIndex); // treat a below-minimum win attempt as a pass so the window still resolves
      return;
    }
    g.claims[playerIndex] = { type, tileIds: [], score };
    processClaims(room);
  } else {
    g.claims[playerIndex] = { type, tileIds: tileIds || [] };
    checkAllResponded(room);
  }
}

function registerPass(room, playerIndex) {
  const g = room.game;
  if (!g || room.state !== 'playing') return;

  if (g.phase === 'rob') {
    if (!g.robKong || playerIndex === g.robKong.seat) return;
    g.passes.add(playerIndex);
    checkAllRespondedRob(room);
    return;
  }

  if (g.phase !== 'claim' || playerIndex === g.lastDiscardPlayer) return;

  g.passes.add(playerIndex);
  checkAllResponded(room);
}

// True once every player except `excludedSeat` (the discarder, or the kong
// declarer) has either claimed or passed in the current response window.
function allResponded(room, excludedSeat) {
  const g = room.game;
  const responded = new Set([...Object.keys(g.claims).map(Number), ...g.passes]);
  return room.players.every((_, i) => i === excludedSeat || responded.has(i));
}

function checkAllResponded(room) {
  if (allResponded(room, room.game.lastDiscardPlayer)) processClaims(room);
}

function checkAllRespondedRob(room) {
  if (room.game.robKong && allResponded(room, room.game.robKong.seat)) resolveRob(room);
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
  } else if (g.phase === 'rob') {
    room.players.forEach((p, i) => {
      if (!p.isBot || !g.robKong || i === g.robKong.seat) return;
      if (g.claims[i] !== undefined || g.passes.has(i)) return;
      setTimeout(() => {
        if (!stillCurrent() || g.phase !== 'rob') return;
        botRespondRob(room, i);
      }, BOT_DELAY * 0.6 + Math.random() * BOT_DELAY * 0.8);
    });
  }
}

function botTakeTurn(room, playerIndex) {
  const g = room.game;
  const p = room.players[playerIndex];

  if (checkWin(p.hand, p.melds) && finishSelfDraw(room, playerIndex)) return;

  const kongTile = findConcealedKong(p.hand);
  if (kongTile && g.wall.length > 0) {
    const four = p.hand.filter(t => t.suit === kongTile.suit && t.value === kongTile.value);
    p.hand = p.hand.filter(t => !four.includes(t));
    p.melds.push({ type: 'concealed-kong', tiles: four });
    drawReplacement(room, playerIndex);
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

function botRespondRob(room, playerIndex) {
  const g = room.game;
  const p = room.players[playerIndex];
  if (g.robKong && checkWin([...p.hand, g.robKong.tile], p.melds)) {
    registerClaim(room, playerIndex, 'win');
  } else {
    registerPass(room, playerIndex);
  }
}

// ── Room membership helpers ──────────────────────────────────────────────────

// Seat winds are relative to the dealer (East). Player at the dealer seat is
// East, the next is South, and so on.
function assignSeatWinds(room) {
  const n = room.players.length;
  if (room.dealer == null || room.dealer >= n) room.dealer = 0;
  room.players.forEach((p, i) => {
    p.seatWind = WINDS[(i - room.dealer + 4) % 4];
  });
}

function reindexPlayers(room) {
  assignSeatWinds(room);
  room.players.forEach((p, i) => {
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
    const player = { socketId: socket.id, token, name: (playerName || 'Player').trim().slice(0, 20) || 'Player', seatWind: 'east', hand: [], melds: [], flowers: [], connected: true, isBot: false, points: 0 };
    rooms[code] = { code, players: [player], state: 'waiting', game: null, cleanupTimer: null, dealer: 0, roundWind: 0, dealerPasses: 0, lastResult: null, chat: [], matchRounds: 4, handNumber: 0, dealerStreak: 0, matchOver: false, endVotes: new Set() };
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
    const player = { socketId: socket.id, token, name: (playerName || 'Player').trim().slice(0, 20) || 'Player', seatWind: WINDS[playerIndex], hand: [], melds: [], flowers: [], connected: true, isBot: false, points: 0 };
    room.players.push(player);
    assignSeatWinds(room);
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
    room.players.push({ socketId: null, token: null, name, seatWind: WINDS[room.players.length], hand: [], melds: [], flowers: [], connected: true, isBot: true, points: 0, difficulty: level });
    assignSeatWinds(room);
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
    if (room.players.length < 4) return socket.emit('error', 'Need 4 players — add bots to fill the table');
    startMatch(room);
  });

  socket.on('setMatchLength', ({ rounds } = {}) => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || playerIndex !== 0 || room.state !== 'waiting') return;
    if ([1, 2, 4].includes(rounds)) {
      room.matchRounds = rounds;
      io.to(code).emit('roomUpdate', publicRoom(room));
    }
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
    if (checkWin(p.hand, p.melds) && !finishSelfDraw(room, playerIndex)) {
      socket.emit('actionError', `Not enough faan to win (need ${SCORING.minFaan}).`);
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
    drawReplacement(room, playerIndex);
    broadcast(room);
  });

  // Upgrade an exposed pong to a kong (加槓) — opens a robbing window first.
  socket.on('declareAddedKong', ({ tileId }) => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || !room.game) return;
    const g = room.game;
    if (g.phase !== 'discard' || g.currentTurn !== playerIndex) return;
    if (g.wall.length === 0) return; // no replacement tile available — kong not allowed

    const p = room.players[playerIndex];
    const tile = p.hand.find(t => t.id === tileId);
    if (!tile) return;
    const meldIndex = p.melds.findIndex(m =>
      m.type === 'pong' && m.tiles[0].suit === tile.suit && m.tiles[0].value === tile.value);
    if (meldIndex === -1) return;

    openRobWindow(room, playerIndex, tile, meldIndex);
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

  // Deal the next hand of the match directly (no lobby round-trip).
  socket.on('nextHand', () => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || playerIndex !== 0 || room.state !== 'finished' || room.matchOver) return;
    advanceDealer(room);
    room.handNumber = (room.handNumber || 0) + 1;
    room.endVotes = new Set();
    room.lastResult = null;
    startGame(room);
  });

  // Players unanimously vote (between hands) to end the match early.
  socket.on('endMatchVote', ({ value } = {}) => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || room.state !== 'finished' || room.matchOver) return;
    const p = room.players[playerIndex];
    if (!p || p.isBot) return;
    if (!room.endVotes) room.endVotes = new Set();
    if (value === false) room.endVotes.delete(playerIndex);
    else room.endVotes.add(playerIndex);
    const humans = room.players.map((pl, i) => ({ pl, i })).filter(x => !x.pl.isBot && x.pl.connected).map(x => x.i);
    const voted = humans.filter(i => room.endVotes.has(i)).length;
    io.to(code).emit('endVoteUpdate', { voted, needed: humans.length });
    if (humans.length > 0 && voted >= humans.length) finishMatch(room);
  });

  // From the final-standings screen: reset the room to the lobby for a new match.
  socket.on('returnToLobby', () => {
    const { code } = socket.data || {};
    const room = rooms[code];
    if (!room || room.state !== 'finished') return;
    if (room.game?.claimTimeout) clearTimeout(room.game.claimTimeout);
    room.state = 'waiting';
    room.game = null;
    room.matchOver = false;
    room.lastResult = null;
    room.endVotes = new Set();
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
