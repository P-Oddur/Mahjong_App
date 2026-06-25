const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const { createDeck, shuffle, sortTiles, checkWin, getValidClaims, getChowOptions } = require('./mahjong');
const { pickBotName, chooseDiscard, findConcealedKong, decideClaim } = require('./bot');
const { scoreWin, computePayments, analyzeWait, WINDS } = require('./scoring');
const { sanitizeRuleset, PRESETS } = require('./rulesets');
const { probeScore } = require('./probe');
const accounts = require('./accounts');
accounts.open(); // create/open the SQLite account store (data/mahjong.db)

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
// Serve the shared rules engine to the browser; it lives at the project root
// (required by the server too), not under public/.
app.get('/mahjong.js', (req, res) => res.sendFile(path.join(__dirname, 'mahjong.js')));

// Scoring-rules catalogue for the lobby editor + sandbox: pattern metadata,
// built-in presets, and the payout modes. `allowFlag` marks patterns gated by
// the ruleset's `allow.*` flags (special / knitted hands) rather than
// `patterns[id].enabled`. Static for the process lifetime.
const { PATTERNS: PATTERN_LIB } = require('./scoring');
const PATTERN_CATALOG = [
  ...PATTERN_LIB.map(p => ({
    id: p.id, name: p.name, cn: p.cn, mcrRef: p.mcrRef ?? null,
    mcrPoints: p.mcrPoints ?? 0, hkFaan: p.hkFaan ?? 0,
    defaultEnabled: p.defaultEnabled !== false, limit: !!p.limit, ctxOnly: !!p.ctxOnly,
  })),
  { id: 'seven-pairs', name: 'Seven Pairs', cn: '七對', mcrRef: 19, mcrPoints: 24, hkFaan: 4, defaultEnabled: true, allowFlag: 'sevenPairs', special: true },
  { id: 'thirteen-orphans', name: 'Thirteen Orphans', cn: '十三幺', mcrRef: 7, mcrPoints: 88, hkFaan: 13, defaultEnabled: true, allowFlag: 'thirteenOrphans', special: true },
  { id: 'greater-knitted', name: 'Greater Honours & Knitted', cn: '七星不靠', mcrRef: 20, mcrPoints: 24, hkFaan: 10, defaultEnabled: false, allowFlag: 'greaterKnitted', knitted: true },
  { id: 'lesser-knitted', name: 'Lesser Honours & Knitted', cn: '全不靠', mcrRef: 34, mcrPoints: 12, hkFaan: 6, defaultEnabled: false, allowFlag: 'lesserKnitted', knitted: true },
  { id: 'knitted-straight', name: 'Knitted Straight', cn: '組合龍', mcrRef: 35, mcrPoints: 12, hkFaan: 6, defaultEnabled: false, allowFlag: 'knittedStraight', knitted: true },
];
const CATALOG = {
  patterns: PATTERN_CATALOG,
  presets: PRESETS,
  modes: [
    { id: 'hk-doubling', name: 'HK Doubling', desc: 'points = base × 2^faan, capped at the limit' },
    { id: 'hk-grouped', name: 'HK Grouped', desc: 'faan compressed into tiers, then base × 2^tier' },
    { id: 'mcr-additive', name: 'MCR Additive', desc: 'sum of points, 8-point minimum, MCR payments' },
  ],
};
app.get('/api/catalog', (req, res) => res.json(CATALOG));
// Canonical example hands (shared with the test suite) for the sandbox.
app.get('/canonical-examples.js', (req, res) => res.sendFile(path.join(__dirname, 'canonical-examples.js')));

const rooms = {};

// HK faan scoring rules. Override per-deployment via environment variables.
// MIN_FAAN=3 enforces the traditional "no chicken hand" minimum.
const SCORING = {
  minFaan: Number(process.env.MIN_FAAN) || 0,
  limitFaan: Number(process.env.LIMIT_FAAN) || 13,
  basePoints: Number(process.env.BASE_POINTS) || 1,
};

// Each room starts on HK Standard (carrying any env-var overrides so existing
// deployments keep their tuning). Hosts can swap/retune it in the lobby; once a
// match starts it is locked. A fresh sanitized copy is handed to every room.
const defaultRuleset = () => sanitizeRuleset({
  id: 'hk-standard',
  hk: { minFaan: SCORING.minFaan, limitFaan: SCORING.limitFaan, basePoints: SCORING.basePoints },
});

// Mode-aware "below the minimum" message for a rejected win.
function winFloorMessage(ruleset, score) {
  if (ruleset.mode === 'mcr-additive') return `Not enough points to win (${score.value}/${ruleset.mcr.minPoints}).`;
  return `Not enough faan to win (${score.faan}/${ruleset.hk.minFaan}).`;
}

// Replay the ephemeral first-person scene state (head looks + interactable props)
// to a single (re)joining socket via the same events live updates use, so a
// late-joiner sees current head orientations / prop states instead of defaults.
// Looks skip the joiner's own seat. The 2D client ignores these events and the
// 3D prop handler is a no-op until props ship, so this is forward-compatible.
function sendSceneSnapshot(socket, room, selfIndex) {
  if (!room) return;
  room.players.forEach((p, i) => {
    if (i === selfIndex || !p.look) return;
    if (!Number.isFinite(p.look.yaw) || !Number.isFinite(p.look.pitch)) return;
    socket.emit('playerLook', { playerIndex: i, yaw: p.look.yaw, pitch: p.look.pitch });
  });
  for (const key in (room.props || {})) socket.emit('interactState', room.props[key]);
}

// Response/turn timing. Both the "react to a discard" window (pong/kong/chow/rob)
// and the per-turn discard clock are host-configurable per room (see setTimers);
// these are the defaults and bounds. turnTimer 0 = off.
const DEFAULT_TURN_TIMER = 15;            // seconds; 0 = off
const DEFAULT_REACT_TIMER = 15;           // seconds (claim/rob window)
const TURN_TIMER_MIN = 3, TURN_TIMER_MAX = 60;
const REACT_TIMER_MIN = 1, REACT_TIMER_MAX = 15;
// With the turn clock OFF, a DISCONNECTED player on their turn is still
// auto-discarded after this fallback so a hand can never stall indefinitely.
// Present players are never rushed while the clock is off. Env-tunable (tests lower it).
const DISCONNECT_FALLBACK_MS = Number(process.env.DISCONNECT_FALLBACK_MS) || 30000;

const reactWindowMs = room => (room.reactTimer || DEFAULT_REACT_TIMER) * 1000;

function clampTurnTimer(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;                  // off
  return Math.min(TURN_TIMER_MAX, Math.max(TURN_TIMER_MIN, n)); // else 3..60
}
function clampReactTimer(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_REACT_TIMER;
  return Math.min(REACT_TIMER_MAX, Math.max(REACT_TIMER_MIN, n)); // 1..15
}

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
    turnTimer: room.turnTimer ?? DEFAULT_TURN_TIMER,
    reactTimer: room.reactTimer ?? DEFAULT_REACT_TIMER,
    pace: room.pace || 'realistic',
    ruleset: room.ruleset,
    players: room.players.map(p => ({
      name: p.name,
      seatWind: p.seatWind,
      connected: p.connected,
      isBot: !!p.isBot,
      points: p.points || 0,
      difficulty: p.isBot ? (p.difficulty || 'normal') : null,
      account: !!p.account,
      balance: p.account ? accounts.balanceOf(p.account) : null,
    })),
  };
}

// Order a player's OWN hand for sending: auto-sorted by default, or — once they've hit Shuffle — in
// their saved custom order, with any tiles not in that order (e.g. a freshly drawn tile) kept on the
// right. The client additionally gaps the just-drawn tile (drawnId) on the far right.
function orderedHandFor(p) {
  if (!p.handOrder) return sortTiles(p.hand);
  const pos = new Map(p.handOrder.map((id, i) => [id, i]));
  return [...p.hand].sort((a, b) =>
    (pos.has(a.id) ? pos.get(a.id) : Infinity) - (pos.has(b.id) ? pos.get(b.id) : Infinity));
}

function gameStateFor(room, playerIndex) {
  const g = room.game;
  if (!g) return null;
  return {
    playerIndex,
    // The local player's freshly-drawn tile id, shown GAPPED on the right of their hand. Only set
    // for the player whose turn it is to discard; everyone else gets null.
    drawnId: (g.currentTurn === playerIndex && g.phase === 'discard') ? (g.drawnGapId || null) : null,
    players: room.players.map((p, i) => ({
      name: p.name,
      seatWind: p.seatWind,
      isBot: !!p.isBot,
      handCount: p.hand.length,
      hand: i === playerIndex ? orderedHandFor(p) : null,
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
    turnDeadline: g.turnDeadline || null,
    turnTotal: g.turnTotalMs || null,
    turnTimer: room.turnTimer ?? DEFAULT_TURN_TIMER,
    reactTimer: room.reactTimer ?? DEFAULT_REACT_TIMER,
    roundWind: WINDS[room.roundWind || 0],
    dealer: room.dealer || 0,
    handNumber: room.handNumber || 0,
    dealerStreak: room.dealerStreak || 0,
    matchRounds: room.matchRounds || 4,
    robKong: g.robKong ? { seat: g.robKong.seat, tile: g.robKong.tile } : null,
    ruleset: room.ruleset,
  };
}

// ── Per-turn discard clock (host-configurable; see maybeArmTurnTimer) ─────────
function clearTurnTimer(g) {
  if (!g) return;
  if (g.turnTimeout) { clearTimeout(g.turnTimeout); g.turnTimeout = null; }
  g.turnDeadline = null; g.turnSeat = null; g.turnTotalMs = null;
}

// Choose a tile to auto-discard on a turn timeout: the just-drawn tile (tsumogiri)
// when it's in hand and not a flower, otherwise the player's VISIBLE rightmost tile
// (covers a pong/chow pickup that owes a discard without having drawn). Flowers are
// auto-extracted on draw so the hand normally has none; the last-tile fallback is a
// defensive guard so a turn can never stall on a degenerate all-flower hand.
function autoDiscardTile(room, seat) {
  const p = room.players[seat];
  let tile = room.game.drawnGapId ? p.hand.find(t => t.id === room.game.drawnGapId) : null;
  if (!tile || tile.suit === 'flower') {
    const ordered = orderedHandFor(p).filter(t => t.suit !== 'flower'); // display order, as the player sees it
    tile = ordered.length ? ordered[ordered.length - 1] : (p.hand[p.hand.length - 1] || null);
  }
  return tile;
}

// Arm the discard clock for the current turn when one applies. Clock ON ⇒ bounds
// EVERY human turn identically, connected or not. Clock OFF ⇒ only a DISCONNECTED
// player gets the no-stall fallback. Bots self-schedule well within any limit, so
// they're never armed. On expiry the just-drawn tile is auto-discarded.
function maybeArmTurnTimer(room) {
  const g = room.game;
  if (!g) return;
  clearTurnTimer(g);
  if (g.phase !== 'discard' || room.state !== 'playing') return;
  const seat = g.currentTurn;
  const p = room.players[seat];
  if (!p || p.isBot) return;
  let ms = null;
  if (room.turnTimer > 0) ms = room.turnTimer * 1000;
  else if (!p.connected) ms = DISCONNECT_FALLBACK_MS;
  if (ms == null) return;
  g.turnSeat = seat;
  g.turnTotalMs = ms; // full window length, so the client's countdown bar is calibrated
  g.turnDeadline = Date.now() + ms;
  g.turnTimeout = setTimeout(() => {
    if (rooms[room.code] !== room || room.game !== g || room.state !== 'playing') return;
    if (g.phase !== 'discard' || g.currentTurn !== seat) return;
    const tile = autoDiscardTile(room, seat);
    if (tile) doDiscard(room, seat, tile.id);
  }, ms);
}

function broadcast(room) {
  const g = room.game;
  if (g) {
    g.seq = (g.seq || 0) + 1;
    // (Re)arm the discard clock at most once per turn, keyed on the turn identity
    // (seat + freshly-drawn tile) so mid-turn rebroadcasts (organize/shuffle hand)
    // never reset it. Any non-discard phase clears it.
    if (g.phase === 'discard' && room.state === 'playing') {
      const key = `${g.currentTurn}:${g.drawnGapId}`;
      if (g.armedKey !== key) { g.armedKey = key; maybeArmTurnTimer(room); }
    } else { g.armedKey = null; clearTurnTimer(g); }
  }
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
        if (g.wall.length > 0) {
          const repl = g.wall.pop();
          p.hand.push(repl);
          // A bonus flower drawn on your turn is auto-replaced; the REPLACEMENT is now your freshly
          // drawn tile, so it must show gapped on the right (not silently sorted into the hand) AND
          // becomes the player's last-drawn tile — otherwise a self-draw completed by the replacement
          // is mis-scored with the flower (not in hand) as the winning tile.
          if (g.currentTurn === playerIndex) g.drawnGapId = repl.id;
          if (g.lastDraw && g.lastDraw.seat === playerIndex) g.lastDraw = { seat: playerIndex, tile: repl };
        }
        found = true;
      }
    }
  }
}

// Draw a replacement tile after a kong and flag it for 槓上開花 (no-op if the wall is empty).
function drawReplacement(room, playerIndex) {
  const g = room.game;
  if (g.wall.length === 0) return;
  const tile = g.wall.pop();
  room.players[playerIndex].hand.push(tile);
  g.lastDraw = { seat: playerIndex, tile };
  g.drawnGapId = tile.id; // the kong replacement is a fresh draw — gap it on the right
  drawFlowers(room, playerIndex);
  g.kongReplacement = playerIndex;
}

function startGame(room) {
  const wall = shuffle(createDeck());
  const n = room.players.length;
  if (room.dealer == null || room.dealer >= n) room.dealer = 0;
  assignSeatWinds(room);

  room.players.forEach(p => { p.hand = []; p.melds = []; p.flowers = []; p.handOrder = null; });

  // Deal 13 to each, dealer (East) gets 14
  for (let r = 0; r < 13; r++)
    for (let i = 0; i < n; i++)
      room.players[i].hand.push(wall.pop());
  const dealerTile = wall.pop();
  room.players[room.dealer].hand.push(dealerTile);

  room.game = {
    wall,
    discardPile: [],
    currentTurn: room.dealer,
    phase: 'discard', // dealer already has 14
    lastDiscard: null,
    lastDiscardPlayer: null,
    lastDraw: { seat: room.dealer, tile: dealerTile }, // most recent draw (for wait/last-tile analysis)
    drawnGapId: dealerTile.id, // the just-"drawn" tile to show gapped on the right of its owner's hand
    claimDeadline: null,
    claimTimeout: null,
    turnDeadline: null,    // per-turn discard clock (see maybeArmTurnTimer)
    turnTotalMs: null,     // full window length of the armed clock (for the client bar)
    turnTimeout: null,
    turnSeat: null,
    armedKey: null,        // turn identity the clock is currently armed for
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
  clearTurnTimer(g);
  room.state = 'finished';

  // Apply point transfers to the running session scoreboard.
  if (result.payments) {
    result.payments.forEach((amt, i) => {
      room.players[i].points = (room.players[i].points || 0) + amt;
      if (room.players[i].account && amt) accounts.addToBalance(room.players[i].account, amt); // per-hand persistence
    });
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
  room.nextVotes = new Set();
  room.lastResult = null;
  startGame(room);
}

// End the match (rounds complete or a unanimous vote) and broadcast standings.
function finishMatch(room) {
  if (room.game?.claimTimeout) { clearTimeout(room.game.claimTimeout); room.game.claimTimeout = null; }
  clearTurnTimer(room.game);
  room.matchOver = true;
  room.state = 'finished';
  room.game = null;
  room.endVotes = new Set();
  room.nextVotes = new Set();
  io.to(room.code).emit('matchOver', { standings: computeStandings(room), rounds: room.matchRounds || 4 });
}

// Connected humans eligible to vote between hands (bots + disconnected seats excluded).
function votingHumans(room) {
  return room.players.map((pl, i) => ({ pl, i })).filter(x => !x.pl.isBot && x.pl.connected).map(x => x.i);
}
// Broadcast both between-hands tallies together so the two mutually-exclusive vote
// buttons (Next Hand / End Match) always update in lockstep on every client.
function broadcastVoteTallies(room) {
  const humans = votingHumans(room);
  const count = set => humans.filter(i => set && set.has(i)).length;
  io.to(room.code).emit('nextVoteUpdate', { voted: count(room.nextVotes), needed: humans.length });
  io.to(room.code).emit('endVoteUpdate', { voted: count(room.endVotes), needed: humans.length });
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
  const drawn = g.wall.pop();
  p.hand.push(drawn);
  g.lastDraw = { seat: g.currentTurn, tile: drawn };
  g.drawnGapId = drawn.id; // gap this freshly drawn tile on the right of the owner's hand
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
    const score = winClaim.score || scoreWin(ronContext(room, pi), room.ruleset);
    p.hand.push(g.lastDiscard);
    g.discardPile.pop();
    const payments = computePayments(score, pi, room.players.length, false, g.lastDiscardPlayer, room.ruleset);
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
    g.drawnGapId = null; // picked up a discard to meld — no freshly drawn tile to gap
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
      const handTileIds = chow[1].tileIds || [];
      const handTiles = handTileIds.map(id => p.hand.find(t => t.id === id)).filter(Boolean);
      // Re-validate the claimed tiles actually form a run with the discard (don't trust the
      // client's tileIds): the two supplied hand tiles must match a real chow option.
      const chowIds = new Set(handTileIds);
      const validChow = handTiles.length === 2 &&
        getChowOptions(p.hand, g.lastDiscard).some(opt =>
          opt.every(t => t.id === g.lastDiscard.id || chowIds.has(t.id)));
      if (validChow) {
        p.hand = p.hand.filter(t => !handTiles.includes(t));
        p.melds.push({ type: 'chow', tiles: [...handTiles, g.lastDiscard] });
        announceAction(room, pi, 'chow', [...handTiles, g.lastDiscard]);
        g.discardPile.pop();
        g.currentTurn = pi;
        g.phase = 'discard';
        g.drawnGapId = null; // picked up a discard to meld — no freshly drawn tile to gap
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

// Count publicly-visible copies of a tile's kind (discards + exposed melds,
// excluding face-down concealed kongs and the winning tile itself) — for 和絕張.
function countVisibleCopies(room, tile, winnerIndex) {
  const g = room.game;
  const match = t => t && t.suit === tile.suit && t.value === tile.value && t.id !== tile.id;
  let n = 0;
  for (const t of g.discardPile) if (match(t)) n++;
  for (const pl of room.players) {
    for (const m of pl.melds) {
      if (m.type === 'concealed-kong') continue; // face-down, not public
      for (const t of m.tiles) if (match(t)) n++;
    }
  }
  return n;
}

// Build a scoreWin() context. `hand` already includes the winning tile;
// `winningTile` identifies which tile completed the hand (for wait shape,
// last-of-kind and melded-hand).
function winContext(room, winnerIndex, hand, selfDraw, winningTile) {
  const p = room.players[winnerIndex];
  const ruleset = room.ruleset;
  const hand13 = winningTile ? hand.filter(t => t.id !== winningTile.id) : hand;
  const wait = winningTile
    ? analyzeWait(hand13.filter(t => t.suit !== 'flower'), p.melds, winningTile, ruleset)
    : { single: false, shape: null };
  return {
    hand,
    melds: p.melds,
    seatWind: p.seatWind,
    roundWind: WINDS[room.roundWind || 0],
    selfDraw,
    flowers: p.flowers,
    lastTile: room.game.wall.length === 0,
    kongReplacement: selfDraw && room.game.kongReplacement === winnerIndex,
    winningTile,
    wait,
    lastOfKind: winningTile ? countVisibleCopies(room, winningTile, winnerIndex) === 3 : false,
    meldedHand: !selfDraw && !!winningTile && p.melds.length === 4
      && p.melds.every(m => m.type !== 'concealed-kong')
      && wait.single && wait.shape === 'pair',
    ruleset,
  };
}
const ronContext = (room, i) => winContext(room, i, [...room.players[i].hand, room.game.lastDiscard], false, room.game.lastDiscard);
const selfDrawContext = (room, i) => winContext(room, i, room.players[i].hand, true, room.game.lastDraw ? room.game.lastDraw.tile : null);
// Robbing the kong: winner takes the tile a player just added to an exposed pong.
function robContext(room, i) {
  const ctx = winContext(room, i, [...room.players[i].hand, room.game.robKong.tile], false, room.game.robKong.tile);
  ctx.robbingKong = true;
  return ctx;
}

// End the game on a self-draw, if the hand meets the win minimum. Returns
// whether the win was awarded (false = below minimum, keep playing).
function finishSelfDraw(room, playerIndex) {
  const score = scoreWin(selfDrawContext(room, playerIndex), room.ruleset);
  if (!score.legal) return false;
  const p = room.players[playerIndex];
  const payments = computePayments(score, playerIndex, room.players.length, true, null, room.ruleset);
  endGame(room, { type: 'tsumo', winner: playerIndex, winnerName: p.name, score, payments });
  return true;
}

// ── Added kong (加槓) & robbing the kong (搶槓) ───────────────────────────────

// Open the react window (room.reactTimer) in which any other player may win on the
// tile being added to an exposed pong. (Concealed kongs are NOT robbable.)
function openRobWindow(room, seat, tile, meldIndex) {
  const g = room.game;
  g.phase = 'rob';
  g.robKong = { seat, tile, meldIndex };
  g.claims = {};
  g.passes = new Set();
  g.claimDeadline = Date.now() + reactWindowMs(room);
  if (g.claimTimeout) clearTimeout(g.claimTimeout);
  g.claimTimeout = setTimeout(() => {
    if (rooms[room.code] === room && room.game === g && g.phase === 'rob') resolveRob(room);
  }, reactWindowMs(room));
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
    const score = robClaim.score || scoreWin(robContext(room, pi), room.ruleset);
    // Move the added tile from the declarer to the robber.
    const declarerHand = room.players[declarer].hand;
    const had = declarerHand.some(t => t.id === tile.id);
    room.players[declarer].hand = declarerHand.filter(t => t.id !== tile.id);
    if (had) robber.hand.push(tile); // conserve tiles: only move the kong tile if it was actually there
    const payments = computePayments(score, pi, room.players.length, false, declarer, room.ruleset);
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

const connectedHumans = room => room.players.filter(p => !p.isBot && p.connected).length;

// Auto-pass is on when ≤1 human is actually CONNECTED — a solo game, or the lone
// player left after others dropped (who shouldn't wait on absent seats) — and for
// multiplayer rooms the host set to 'fast'. 'realistic' with ≥2 present keeps manual passing.
const autoPassOn = room => connectedHumans(room) <= 1 || room.pace === 'fast';

// Pass, on their behalf, every non-discarder human who has no possible claim, so
// the window resolves at the actors' pace instead of waiting on a needless click.
function autoPassNoClaimHumans(room) {
  const g = room.game;
  if (!g || g.phase !== 'claim') return;
  const n = room.players.length;
  room.players.forEach((p, i) => {
    if (p.isBot || i === g.lastDiscardPlayer) return;
    if (g.claims[i] !== undefined || g.passes.has(i)) return;
    const isNext = (g.lastDiscardPlayer + 1) % n === i;
    if (getValidClaims(p.hand, p.melds, g.lastDiscard, isNext, room.ruleset).length === 0) {
      registerPass(room, i);
    }
  });
}

function doDiscard(room, playerIndex, tileId) {
  const g = room.game;
  if (!g || room.state !== 'playing') return;
  if (g.phase !== 'discard' || g.currentTurn !== playerIndex) return;

  const p = room.players[playerIndex];
  const idx = p.hand.findIndex(t => t.id === tileId);
  if (idx === -1) return;
  clearTurnTimer(g); // the player acted (or was auto-acted) — stop their turn clock

  const tile = p.hand.splice(idx, 1)[0];
  g.drawnGapId = null; // the player has discarded — nothing is "freshly drawn" now
  g.kongReplacement = null; // discarding ends any pending kong-replacement win
  g.discardPile.push(tile);
  g.lastDiscard = tile;
  g.lastDiscardPlayer = playerIndex;
  g.phase = 'claim';
  g.claims = {};
  g.passes = new Set();
  g.claimDeadline = Date.now() + reactWindowMs(room);

  if (g.claimTimeout) clearTimeout(g.claimTimeout);
  g.claimTimeout = setTimeout(() => {
    if (rooms[room.code] === room && room.game === g && g.phase === 'claim') processClaims(room);
  }, reactWindowMs(room));

  // Fast / solo: auto-pass anyone who can't claim this tile BEFORE broadcasting, so a
  // window that resolves immediately (everyone auto-passed) never flashes a stale claim
  // countdown to clients. If it stays open (someone can claim, or bots must respond),
  // broadcast the live claim state and schedule the bots as usual.
  if (autoPassOn(room)) autoPassNoClaimHumans(room);
  if (g.phase === 'claim') broadcast(room);
}

function registerClaim(room, playerIndex, type, tileIds) {
  const g = room.game;
  if (!g || room.state !== 'playing') return;

  // Robbing-the-kong window: only a winning claim on the added-kong tile counts.
  if (g.phase === 'rob') {
    if (type !== 'win' || !g.robKong || playerIndex === g.robKong.seat) return;
    const p = room.players[playerIndex];
    if (!checkWin([...p.hand, g.robKong.tile], p.melds, room.ruleset)) return;
    const score = scoreWin(robContext(room, playerIndex), room.ruleset);
    if (!score.legal) {
      if (p.socketId) io.to(p.socketId).emit('actionError', winFloorMessage(room.ruleset, score));
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
  const valid = getValidClaims(p.hand, p.melds, g.lastDiscard, isNext, room.ruleset);
  if (!valid.includes(type)) return;

  if (type === 'win') {
    const score = scoreWin(ronContext(room, playerIndex), room.ruleset);
    if (!score.legal) {
      if (p.socketId) io.to(p.socketId).emit('actionError', winFloorMessage(room.ruleset, score));
      registerPass(room, playerIndex); // treat a below-minimum win attempt as a pass so the window still resolves
      return;
    }
    g.claims[playerIndex] = { type, tileIds: [], score };
    // Wait for every eligible responder before resolving (like the rob window), so a
    // nearer-the-discarder player isn't locked out of a multi-ron by a faster winner.
    checkAllResponded(room);
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

// Per-room bot pacing. With ≤1 human actually connected (a solo game, or the only
// player left after others dropped) the bots run at a locked, snappy ~300ms so the
// lone player isn't kept waiting; multiplayer keeps the natural BOT_DELAY thinking
// time. Not host-configurable.
function botTiming(room) {
  const oneHuman = connectedHumans(room) <= 1;
  return oneHuman ? { base: 300, jit: 120 } : { base: BOT_DELAY, jit: BOT_DELAY };
}

function scheduleBots(room) {
  const g = room.game;
  if (!g || room.state !== 'playing') return;
  const { base, jit } = botTiming(room);
  const seq = g.seq;
  const stillCurrent = () =>
    rooms[room.code] === room && room.game === g && g.seq === seq && room.state === 'playing';

  if (g.phase === 'discard') {
    const p = room.players[g.currentTurn];
    if (p?.isBot) {
      const turn = g.currentTurn;
      setTimeout(() => { if (stillCurrent()) botTakeTurn(room, turn); }, base + Math.random() * jit);
    }
  } else if (g.phase === 'claim') {
    room.players.forEach((p, i) => {
      if (!p.isBot || i === g.lastDiscardPlayer) return;
      if (g.claims[i] !== undefined || g.passes.has(i)) return;
      setTimeout(() => {
        if (!stillCurrent() || g.phase !== 'claim') return;
        botRespondClaim(room, i);
      }, base * 0.6 + Math.random() * jit * 0.8);
    });
  } else if (g.phase === 'rob') {
    room.players.forEach((p, i) => {
      if (!p.isBot || !g.robKong || i === g.robKong.seat) return;
      if (g.claims[i] !== undefined || g.passes.has(i)) return;
      setTimeout(() => {
        if (!stillCurrent() || g.phase !== 'rob') return;
        botRespondRob(room, i);
      }, base * 0.6 + Math.random() * jit * 0.8);
    });
  }
}

function botTakeTurn(room, playerIndex) {
  const g = room.game;
  const p = room.players[playerIndex];

  if (checkWin(p.hand, p.melds, room.ruleset) && finishSelfDraw(room, playerIndex)) return;

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
  const decision = decideClaim(p.hand, p.melds, g.lastDiscard, isNext, p.difficulty, room.ruleset);
  if (decision) registerClaim(room, playerIndex, decision.type, decision.tileIds);
  else registerPass(room, playerIndex);
}

function botRespondRob(room, playerIndex) {
  const g = room.game;
  const p = room.players[playerIndex];
  if (g.robKong && checkWin([...p.hand, g.robKong.tile], p.melds, room.ruleset)) {
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
      clearTurnTimer(room.game);
      delete rooms[room.code];
    }
  }, 60000);
}

// Lobby host-gate shared by the addBot/removeBot/startGame/set* handlers: returns the
// room only if this socket is the host (seat 0) and the room is still in the lobby.
function requireHostWaiting(socket) {
  const { code, playerIndex } = socket.data || {};
  const room = rooms[code];
  if (!room || playerIndex !== 0 || room.state !== 'waiting') return null;
  return room;
}

// True when it's `playerIndex`'s turn to act on their own hand (declareWin/Kong/AddedKong).
function isOwnTurn(room, playerIndex) {
  const g = room && room.game;
  return !!(g && g.phase === 'discard' && g.currentTurn === playerIndex);
}

// ── Socket handlers ──────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  // ── Accounts (optional username + 4-digit PIN; guests skip this) ──────────────
  socket.on('login', async ({ name, pin } = {}) => {
    const res = await accounts.loginOrRegister(name, pin);
    if (res.ok) socket.data.account = { username: res.username, name: res.name };
    socket.emit('loginResult', res);
  });
  socket.on('authToken', ({ token } = {}) => {
    const u = accounts.verifyToken(token);
    if (u) {
      socket.data.account = { username: u.username, name: u.name };
      socket.emit('loginResult', { ok: true, token, username: u.username, name: u.name, balance: u.balance });
    } else {
      socket.emit('loginResult', { ok: false, error: 'Session expired — log in again.' });
    }
  });
  socket.on('logout', ({ token } = {}) => { if (token) accounts.logout(token); socket.data.account = null; });

  // ── Saved rulesets (logged-in users) ─────────────────────────────────────────
  socket.on('listRulesets', () => {
    const acct = socket.data.account;
    if (!acct) return socket.emit('rulesetList', { ok: false, error: 'Log in to use saved rulesets.', rulesets: [] });
    socket.emit('rulesetList', { ok: true, rulesets: accounts.listRulesets(acct.username) });
  });
  socket.on('saveRuleset', ({ name, ruleset } = {}) => {
    const acct = socket.data.account;
    if (!acct) return socket.emit('rulesetSaved', { ok: false, error: 'Log in to save rulesets.' });
    const res = accounts.saveRuleset(acct.username, name, JSON.stringify(sanitizeRuleset(ruleset)));
    socket.emit('rulesetSaved', res);
    if (res.ok) socket.emit('rulesetList', { ok: true, rulesets: accounts.listRulesets(acct.username) });
  });
  socket.on('deleteRuleset', ({ id } = {}) => {
    const acct = socket.data.account;
    if (!acct) return;
    accounts.deleteRuleset(acct.username, id);
    socket.emit('rulesetList', { ok: true, rulesets: accounts.listRulesets(acct.username) });
  });

  // Stateless scoring probe for the ruleset sandbox.
  socket.on('scoreProbe', ({ ruleset, ctx } = {}) => {
    try { socket.emit('scoreProbeResult', probeScore(ruleset, ctx)); }
    catch (e) { socket.emit('scoreProbeResult', { error: 'Could not score that hand.' }); }
  });

  socket.on('createRoom', ({ playerName }) => {
    let code;
    do { code = genCode(); } while (rooms[code]);

    const token = genToken();
    const acct = socket.data.account || null;
    const name = acct ? acct.name : ((playerName || 'Player').trim().slice(0, 20) || 'Player');
    const player = { socketId: socket.id, token, name, account: acct ? acct.username : null, seatWind: 'east', hand: [], melds: [], flowers: [], connected: true, isBot: false, points: 0 };
    rooms[code] = { code, players: [player], state: 'waiting', game: null, cleanupTimer: null, dealer: 0, roundWind: 0, dealerPasses: 0, lastResult: null, chat: [], matchRounds: 4, handNumber: 0, dealerStreak: 0, matchOver: false, endVotes: new Set(), nextVotes: new Set(), turnTimer: DEFAULT_TURN_TIMER, reactTimer: DEFAULT_REACT_TIMER, pace: 'fast', ruleset: defaultRuleset() };
    socket.join(code);
    socket.data.code = code; socket.data.playerIndex = 0;
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
    const acct = socket.data.account || null;
    const name = acct ? acct.name : ((playerName || 'Player').trim().slice(0, 20) || 'Player');
    const player = { socketId: socket.id, token, name, account: acct ? acct.username : null, seatWind: WINDS[playerIndex], hand: [], melds: [], flowers: [], connected: true, isBot: false, points: 0 };
    room.players.push(player);
    assignSeatWinds(room);
    socket.join(c);
    socket.data.code = c; socket.data.playerIndex = playerIndex;
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
    socket.data.code = c; socket.data.playerIndex = playerIndex;
    // Re-attach the account so a reconnected logged-in user keeps saved-ruleset access
    // (else the ruleset handlers treat them as a guest). p.account = username key, p.name = display.
    if (p.account) socket.data.account = { username: p.account, name: p.name };
    // Off-clock mode: a returning player is present again, so cancel any no-stall
    // fallback armed for their seat (present players aren't rushed while the clock is off).
    if (room.game && !room.turnTimer && room.game.turnSeat === playerIndex && room.game.turnTimeout) {
      clearTurnTimer(room.game);
    }
    socket.emit('rejoined', { code: c, playerIndex, isHost: playerIndex === 0, state: room.state });
    socket.emit('chatHistory', room.chat);
    io.to(c).emit('roomUpdate', publicRoom(room));
    io.to(c).emit('playerReconnected', { playerIndex, name: p.name });
    // Room-wide refresh so peers immediately clear any stale "disconnected" status
    // (rejoin used to update only the rejoining socket). Also re-sends this player's hand.
    if (room.game) broadcast(room);
    sendSceneSnapshot(socket, room, playerIndex);
  });

  socket.on('addBot', ({ difficulty } = {}) => {
    const room = requireHostWaiting(socket);
    if (!room) return;
    const code = room.code;
    if (room.players.length >= 4) return socket.emit('error', 'Room is full');

    const level = ['easy', 'normal', 'hard'].includes(difficulty) ? difficulty : 'normal';
    const name = pickBotName(room.players.map(p => p.name));
    room.players.push({ socketId: null, token: null, name, seatWind: WINDS[room.players.length], hand: [], melds: [], flowers: [], connected: true, isBot: true, points: 0, difficulty: level });
    assignSeatWinds(room);
    io.to(code).emit('roomUpdate', publicRoom(room));
  });

  socket.on('removeBot', ({ index }) => {
    const room = requireHostWaiting(socket);
    if (!room) return;
    const code = room.code;
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
    socket.data.code = undefined; socket.data.playerIndex = undefined;
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
    const room = requireHostWaiting(socket);
    if (!room) return;
    const code = room.code;
    if (room.players.length < 4) return socket.emit('error', 'Need 4 players — add bots to fill the table');
    startMatch(room);
  });

  socket.on('setMatchLength', ({ rounds } = {}) => {
    const room = requireHostWaiting(socket);
    if (!room) return;
    const code = room.code;
    if ([1, 2, 4].includes(rounds)) {
      room.matchRounds = rounds;
      io.to(code).emit('roomUpdate', publicRoom(room));
    }
  });

  // Host sets the per-turn discard clock + the react-to-discard window (waiting only).
  socket.on('setTimers', ({ turnTimer, reactTimer } = {}) => {
    const room = requireHostWaiting(socket);
    if (!room) return;
    const code = room.code;
    if (turnTimer !== undefined) room.turnTimer = clampTurnTimer(turnTimer);
    if (reactTimer !== undefined) room.reactTimer = clampReactTimer(reactTimer);
    io.to(code).emit('roomUpdate', publicRoom(room));
  });

  // Host sets the multiplayer pace: 'fast' auto-passes players with no claim,
  // 'realistic' keeps manual passing. (Solo games always run fast regardless.)
  socket.on('setPace', ({ pace } = {}) => {
    const room = requireHostWaiting(socket);
    if (!room) return;
    const code = room.code;
    if (pace === 'realistic' || pace === 'fast') {
      room.pace = pace;
      io.to(code).emit('roomUpdate', publicRoom(room));
    }
  });

  // Host sets the room's scoring ruleset (only while waiting; locked at start).
  socket.on('setRuleset', ({ ruleset } = {}) => {
    const room = requireHostWaiting(socket);
    if (!room) return;
    const code = room.code;
    room.ruleset = sanitizeRuleset(ruleset);
    io.to(code).emit('roomUpdate', publicRoom(room));
  });

  socket.on('discard', ({ tileId }) => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || playerIndex === undefined) return;
    doDiscard(room, playerIndex, tileId);
  });

  // Hand-order controls — a player's OWN concealed hand only (invisible to opponents, no fairness
  // impact). 'organizeHand' reverts to the deterministic auto-sort; 'shuffleHand' saves a random
  // fixed order that persists until the next Organize / new hand.
  socket.on('organizeHand', () => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || playerIndex === undefined || !room.players[playerIndex]) return;
    room.players[playerIndex].handOrder = null;
    if (room.game) broadcast(room);
  });

  socket.on('shuffleHand', () => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || playerIndex === undefined || !room.players[playerIndex]) return;
    const p = room.players[playerIndex];
    p.handOrder = shuffle(p.hand.map(t => t.id));
    if (room.game) broadcast(room);
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

  // Per-socket chat rate gate: a server-side backstop so a client can't flood the
  // room with chatMessage broadcasts (mirrors the playerLook/interactState gates below).
  let lastChatAt = 0;
  const CHAT_MIN_MS = 500;
  socket.on('chat', ({ text } = {}) => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || playerIndex === undefined || !room.players[playerIndex]) return;
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean) return;
    const now = Date.now();
    if (now - lastChatAt < CHAT_MIN_MS) return; // drop floods
    lastChatAt = now;
    const entry = { kind: 'chat', seat: playerIndex, name: room.players[playerIndex].name, text: clean };
    pushChat(room, entry);
    io.to(code).emit('chatMessage', entry);
  });

  socket.on('declareWin', () => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!isOwnTurn(room, playerIndex)) return;
    const g = room.game;

    const p = room.players[playerIndex];
    if (checkWin(p.hand, p.melds, room.ruleset) && !finishSelfDraw(room, playerIndex)) {
      socket.emit('actionError', winFloorMessage(room.ruleset, scoreWin(selfDrawContext(room, playerIndex), room.ruleset)));
    }
  });

  socket.on('declareKong', ({ tileId }) => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!isOwnTurn(room, playerIndex)) return;
    const g = room.game;

    const p = room.players[playerIndex];
    const tile = p.hand.find(t => t.id === tileId);
    if (!tile) return;
    const matching = p.hand.filter(t => t.suit === tile.suit && t.value === tile.value);
    if (matching.length < 4) return;
    if (g.wall.length === 0) return; // no replacement tile to draw — kong not allowed (matches declareAddedKong/bots)

    p.hand = p.hand.filter(t => !matching.includes(t));
    p.melds.push({ type: 'concealed-kong', tiles: matching.slice(0, 4) });
    drawReplacement(room, playerIndex);
    broadcast(room);
  });

  // Upgrade an exposed pong to a kong (加槓) — opens a robbing window first.
  socket.on('declareAddedKong', ({ tileId }) => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!isOwnTurn(room, playerIndex)) return;
    const g = room.game;
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
      sendSceneSnapshot(socket, room, playerIndex);
    }
  });

  // Advance to the next hand — requires EVERY connected human to agree (mirrors the
  // end-match vote). Mutually exclusive with the end-match vote: casting this clears
  // the same player's end-match vote. Bots don't vote; a lone human is unanimous.
  socket.on('nextHandVote', ({ value } = {}) => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || room.state !== 'finished' || room.matchOver) return;
    const p = room.players[playerIndex];
    if (!p || p.isBot) return;
    if (!room.nextVotes) room.nextVotes = new Set();
    if (!room.endVotes) room.endVotes = new Set();
    if (value === false) room.nextVotes.delete(playerIndex);
    else { room.nextVotes.add(playerIndex); room.endVotes.delete(playerIndex); } // mutually exclusive
    broadcastVoteTallies(room);
    const humans = votingHumans(room);
    const voted = humans.filter(i => room.nextVotes.has(i)).length;
    if (humans.length > 0 && voted >= humans.length) {
      advanceDealer(room);
      room.handNumber = (room.handNumber || 0) + 1;
      room.nextVotes = new Set();
      room.endVotes = new Set();
      room.lastResult = null;
      startGame(room);
    }
  });

  // End the match early — also a unanimous vote, mutually exclusive with the
  // next-hand vote (casting this clears the same player's next-hand vote).
  socket.on('endMatchVote', ({ value } = {}) => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || room.state !== 'finished' || room.matchOver) return;
    const p = room.players[playerIndex];
    if (!p || p.isBot) return;
    if (!room.nextVotes) room.nextVotes = new Set();
    if (!room.endVotes) room.endVotes = new Set();
    if (value === false) room.endVotes.delete(playerIndex);
    else { room.endVotes.add(playerIndex); room.nextVotes.delete(playerIndex); } // mutually exclusive
    broadcastVoteTallies(room);
    const humans = votingHumans(room);
    const voted = humans.filter(i => room.endVotes.has(i)).length;
    if (humans.length > 0 && voted >= humans.length) finishMatch(room);
  });

  // From the final-standings screen: reset the room to the lobby for a new match.
  socket.on('returnToLobby', () => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || room.state !== 'finished') return;
    const me = room.players[playerIndex];
    if (!me || me.isBot) return; // only a seated human may reset the room (mirrors nextHand)
    if (room.game?.claimTimeout) clearTimeout(room.game.claimTimeout);
    clearTurnTimer(room.game);
    room.state = 'waiting';
    room.game = null;
    room.matchOver = false;
    room.lastResult = null;
    room.endVotes = new Set();
    room.nextVotes = new Set();
    io.to(code).emit('roomUpdate', publicRoom(room));
    io.to(code).emit('backToLobby');
  });

  // ── Ephemeral first-person relays (additive; no game-logic impact, so the
  //    turn-based protocol and test/e2e.js are unaffected) ──────────────────────
  // Lightweight per-socket relay rate gates: a server-side backstop so a client
  // that bypasses net.js's client-side throttle can't flood the room with
  // broadcasts. Ignore events arriving faster than these minimum intervals.
  let lastLookAt = 0, lastInteractAt = 0;
  const LOOK_MIN_MS = 40;     // ~25 Hz cap (the client emits ~20 Hz)
  const INTERACT_MIN_MS = 50;

  // Head look-direction, broadcast ~20 Hz to the rest of the room for avatar
  // head-sync in the 3D client. Last value is stored for late joiners.
  socket.on('playerLook', ({ yaw, pitch } = {}) => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || playerIndex === undefined || !room.players[playerIndex]) return;
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return; // drop malformed look packets (NaN/strings)
    const now = Date.now();
    if (now - lastLookAt < LOOK_MIN_MS) return; // server-side rate gate
    lastLookAt = now;
    room.players[playerIndex].look = { yaw, pitch };
    socket.to(code).emit('playerLook', { playerIndex, yaw, pitch });
  });

  // Interactable prop state (e.g. teacup/lamp); relayed and stored on the room
  // so a joiner/rejoiner can be sent the current state (see PROP_SNAPSHOT below).
  const MAX_ROOM_PROPS = 64;
  const MAX_PROP_KEY_LEN = 32; // toy ids are short ('tubes'/'dice'/'opensign'/…)
  socket.on('interactState', (data = {}) => {
    const { code, playerIndex } = socket.data || {};
    const room = rooms[code];
    if (!room || playerIndex === undefined) return;
    if (!data || typeof data !== 'object' || typeof data.object !== 'string') return;
    if (data.object.length > MAX_PROP_KEY_LEN) return; // cap key length (memory/bandwidth)
    const now = Date.now();
    if (now - lastInteractAt < INTERACT_MIN_MS) return; // server-side rate gate
    lastInteractAt = now;
    // Null-proto map: inherited names (constructor/toString/__proto__/…) can't
    // bypass the `in` cap check or hit a prototype setter.
    const props = room.props || (room.props = Object.create(null));
    if (!(data.object in props) && Object.keys(props).length >= MAX_ROOM_PROPS) return; // bound the stored set
    // Build a WHITELISTED payload instead of spreading arbitrary client fields:
    // only the known small toggle booleans are relayed, and the server owns
    // playerIndex (so a client can't spoof it or inflate per-room memory/bandwidth).
    const payload = { object: data.object, playerIndex };
    if (typeof data.on === 'boolean') payload.on = data.on;
    if (typeof data.open === 'boolean') payload.open = data.open;
    props[data.object] = payload;
    socket.to(code).emit('interactState', payload);
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
      // Off-clock mode: if the absent player owes a discard and no clock is running,
      // start the no-stall fallback so the hand can't freeze waiting on them.
      if (room.game && room.state === 'playing' && room.game.phase === 'discard'
          && room.game.currentTurn === playerIndex && !room.turnTimer && !room.game.turnTimeout) {
        maybeArmTurnTimer(room);
        broadcast(room);
      }
    }
    scheduleRoomCleanup(room);
  });
});

const PORT = process.env.PORT || 3000;

// Every URL this server answers on (default / all-interfaces mode).
function listenUrls() {
  const urls = [{ url: `http://localhost:${PORT}`, label: 'this machine' }];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if ((ni.family === 'IPv4' || ni.family === 4) && !ni.internal) {
        urls.push({ url: `http://${ni.address}:${PORT}`, label: name });
      }
    }
  }
  return urls;
}

// This machine's Tailscale IPv4: an interface named "Tailscale", or failing that
// any address in Tailscale's 100.64.0.0/10 (CGNAT) range. null if Tailscale is down.
function tailscaleIPv4() {
  const ifaces = os.networkInterfaces();
  const isV4 = ni => (ni.family === 'IPv4' || ni.family === 4) && !ni.internal;
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!/tailscale/i.test(name)) continue;
    for (const ni of addrs || []) if (isV4(ni)) return ni.address;
  }
  for (const addrs of Object.values(ifaces)) {
    for (const ni of addrs || []) {
      if (!isV4(ni)) continue;
      const o = ni.address.split('.').map(Number);
      if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return ni.address;
    }
  }
  return null;
}

// Bind mode. `--tailscale` (or TAILSCALE_ONLY=1) binds ONLY to the Tailscale
// interface: reachable by your tailnet devices, NOT by the physical LAN — so no
// firewall rule or open port is needed, and it can't accidentally become
// LAN-exposed later. Otherwise bind every interface (the dev/test default).
const tailscaleOnly = process.argv.includes('--tailscale') || /^(1|true|yes)$/i.test(process.env.TAILSCALE_ONLY || '');

if (tailscaleOnly) {
  // Bind ONLY to the Tailscale interface (plus loopback, so localhost still works
  // on this machine — loopback is never network-exposed). At login the server may
  // start before Tailscale has assigned its address, so wait for it to appear.
  (async () => {
    const deadline = Date.now() + 60000;
    let ip = tailscaleIPv4();
    while (!ip && Date.now() < deadline) {
      console.log('Tailscale-only mode: waiting for the Tailscale interface to come up…');
      await new Promise(r => setTimeout(r, 2000));
      ip = tailscaleIPv4();
    }
    if (!ip) {
      console.error('No Tailscale interface appeared after 60s. Is Tailscale running and logged in? Exiting.');
      process.exit(1);
    }
    server.listen(PORT, ip, () => {
      console.log('Mahjong running — Tailscale-only. Not listening on your LAN; no open ports needed.');
      console.log(`  Open on any device in your tailnet (including this one):  http://${ip}:${PORT}`);
      console.log(`  (also available locally at http://localhost:${PORT})`);
    });
    const loopback = http.createServer(app); // localhost convenience on this machine
    io.attach(loopback);
    loopback.listen(PORT, '127.0.0.1');
  })();
} else {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Mahjong running. Open locally, or share a LAN URL with players on the same network:');
    for (const { url, label } of listenUrls()) console.log(`  ${url}  (${label})`);
  });
}
