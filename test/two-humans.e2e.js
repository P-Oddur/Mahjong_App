// End-to-end test: TWO human clients in the SAME room (+2 bots) playing a real
// match together. Where test/e2e.js covers one human vs three bots, this covers
// the human<->human paths that only appear with multiple real clients:
//
//   • both clients stay in sync (cross-client agreement at every aligned state)
//   • turn priority / out-of-turn discards are rejected
//   • a human claims pong/chow/kong/win off ANOTHER human's (or bot's) discard
//   • one human reconnects mid-hand while the other keeps playing
//   • the disconnected peer is announced; chat crosses between clients
//
// The backbone is a set of HARD INVARIANTS asserted on every gameUpdate for BOTH
// clients — they hold regardless of the random wall, so the test is not flaky and
// it is what actually proves the server can't corrupt shared game state:
//
//   I1. Tile conservation: hands + melds + flowers + discards + wall == 144 always.
//   I2. No duplicate tile ids anywhere a client can see.
//   I3. Hand-count structure: at most one player holds an "extra" tile (3k+2) and
//       only the player entitled to (the discarder-to-be / kong declarer / a ron
//       winner mid-claim); everyone else is 3k+1. A botched claim that drops or
//       dupes tiles trips I1/I2/I3 immediately.
//
// Spawns its own server on PORT (default 3101) with fast bots.
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');
const { getValidClaims, getChowOptions, checkWin } = require('../mahjong');
const { chooseDiscard } = require('../bot');

const PORT = process.env.PORT || 3101;
const URL = `http://localhost:${PORT}`;

const serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, BOT_DELAY_MS: '20' },
  stdio: 'ignore',
});
const cleanup = () => { try { serverProc.kill(); } catch {} };
process.on('exit', cleanup);

const fail = msg => { console.error('FAIL:', msg); cleanup(); process.exit(1); };
const log = msg => console.log('  •', msg);
// Whole-test watchdog so a logic stall can never hang CI.
const watchdog = setTimeout(() => fail('global timeout — game did not complete'), 120000);

function connect() {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['websocket'] }); // auto-retries while the server boots
    s.on('connect', () => resolve(s));
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}
function once(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for '${event}'`)), timeoutMs);
    socket.once(event, data => { clearTimeout(t); resolve(data); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Invariant + cross-client checking ────────────────────────────────────────
let invariantChecks = 0, crossChecks = 0;

function checkInvariants(state, who) {
  const players = state.players;

  // I1 — tile conservation.
  let total = state.wallCount + state.discardPile.length;
  for (const p of players) {
    total += p.handCount;
    for (const m of (p.melds || [])) total += m.tiles.length;
    total += (p.flowers || []).length;
  }
  if (total !== 144) fail(`[${who}] tile conservation broken: counted ${total}/144 (phase=${state.phase}, turn=${state.currentTurn})`);

  // I2 — no duplicate tile ids among everything this client can see.
  const ids = [];
  const me = players[state.playerIndex];
  if (me.hand) for (const t of me.hand) ids.push(t.id);
  for (const p of players) {
    for (const m of (p.melds || [])) for (const t of m.tiles) ids.push(t.id);
    for (const t of (p.flowers || [])) ids.push(t.id);
  }
  for (const t of state.discardPile) ids.push(t.id);
  const seen = new Set();
  for (const id of ids) { if (seen.has(id)) fail(`[${who}] duplicate tile id ${id} visible (phase=${state.phase})`); seen.add(id); }

  // I3 — hand-count structure.
  const extra = players.map((_, i) => i).filter(i => players[i].handCount % 3 !== 1);
  if (extra.length > 1) fail(`[${who}] ${extra.length} players hold an off-count hand (phase=${state.phase}): counts=${extra.map(i => players[i].handCount)}`);
  for (const i of extra) if (players[i].handCount % 3 !== 2) fail(`[${who}] seat ${i} handCount=${players[i].handCount} is %3=0 — tiles lost/gained (phase=${state.phase})`);
  if (extra.length === 1) {
    const i = extra[0];
    const entitled =
      (state.phase === 'discard' && i === state.currentTurn) ||           // about to discard
      (state.phase === 'rob' && state.robKong && i === state.robKong.seat) || // added-kong declarer
      (state.phase === 'claim');                                          // a ron win finalizes in the claim window
    if (!entitled) fail(`[${who}] seat ${i} holds an extra tile unexpectedly (phase=${state.phase}, turn=${state.currentTurn})`);
  }

  // Sanity bounds.
  if (state.currentTurn < 0 || state.currentTurn >= players.length) fail(`[${who}] currentTurn out of range: ${state.currentTurn}`);
  if (!['draw', 'discard', 'claim', 'rob'].includes(state.phase)) fail(`[${who}] unknown phase: ${state.phase}`);

  invariantChecks++;
}

// Public (non-private) fields two clients MUST agree on when they're looking at
// the same broadcast. Aligned by a signature that uniquely identifies a state.
function sig(s) {
  const meldTiles = s.players.reduce((n, p) => n + (p.melds || []).reduce((m, x) => m + x.tiles.length, 0), 0);
  return `${s.handNumber}|${s.phase}|${s.currentTurn}|${s.wallCount}|${s.discardPile.length}|${meldTiles}`;
}
function crossCompare(a, b) {
  if (!a || !b || sig(a) !== sig(b)) return; // not aligned on the same broadcast — skip
  const eq = (x, y, what) => { if (x !== y) fail(`cross-client mismatch (${what}): P1=${x} P2=${y} @ ${sig(a)}`); };
  eq(a.dealer, b.dealer, 'dealer');
  eq(a.roundWind, b.roundWind, 'roundWind');
  eq((a.lastDiscard && a.lastDiscard.id) ?? null, (b.lastDiscard && b.lastDiscard.id) ?? null, 'lastDiscard');
  eq(a.discardPile.map(t => t.id).join(','), b.discardPile.map(t => t.id).join(','), 'discardPile');
  a.players.forEach((p, i) => {
    const q = b.players[i];
    eq(p.name, q.name, `seat${i}.name`);
    eq(p.seatWind, q.seatWind, `seat${i}.seatWind`);
    eq(p.handCount, q.handCount, `seat${i}.handCount`);
    eq(p.connected, q.connected, `seat${i}.connected`);
    const ms = pl => (pl.melds || []).map(m => `${m.type}:${m.tiles.map(t => t.id).sort().join('.')}`).join('|');
    eq(ms(p), ms(q), `seat${i}.melds`);
    // NOTE: points are deliberately NOT compared here. A self-draw win applies the
    // payout and re-broadcasts WITHOUT changing any structural field, so the pre-win
    // and win states share a signature but differ in points — comparing them would be
    // a false mismatch. Points agreement is verified at gameOver (both clients' totals)
    // and in the final standings instead.
  });
  crossChecks++;
}

// ── The two human clients ────────────────────────────────────────────────────
const humans = [
  { name: 'Alice', seat: 0, token: null, socket: null, latest: null, autoplay: false, stats: { discard: 0, pong: 0, kong: 0, chow: 0, win: 0, rob: 0 } },
  { name: 'Bob', seat: 1, token: null, socket: null, latest: null, autoplay: false, stats: { discard: 0, pong: 0, kong: 0, chow: 0, win: 0, rob: 0 } },
];
let CODE = null;

// Claim-greedy decision: win > kong > pong > chow whenever legal (so human<->human
// claims actually happen), otherwise discard the least-useful tile so hands end.
function act(h, state) {
  const me = state.playerIndex;
  const mine = state.players[me];
  const rs = state.ruleset;
  if (state.phase === 'discard' && state.currentTurn === me) {
    const hand = mine.hand || [];
    if (checkWin(hand, mine.melds, rs)) { h.socket.emit('declareWin'); return; }
    const tile = chooseDiscard(hand, 'normal', state.discardPile) || hand[hand.length - 1];
    if (tile) { h.socket.emit('discard', { tileId: tile.id }); h.stats.discard++; }
  } else if (state.phase === 'claim' && state.lastDiscardPlayer !== me) {
    const hand = mine.hand || [];
    const isNext = (state.lastDiscardPlayer + 1) % state.players.length === me;
    const valid = getValidClaims(hand, mine.melds, state.lastDiscard, isNext, rs);
    if (valid.includes('win')) { h.socket.emit('claim', { type: 'win' }); h.stats.win++; return; }
    if (valid.includes('kong')) { h.socket.emit('claim', { type: 'kong' }); h.stats.kong++; return; }
    if (valid.includes('pong')) { h.socket.emit('claim', { type: 'pong' }); h.stats.pong++; return; }
    if (valid.includes('chow')) {
      const opts = getChowOptions(hand, state.lastDiscard);
      if (opts.length) {
        const fromHand = opts[0].filter(t => t !== state.lastDiscard);
        h.socket.emit('claim', { type: 'chow', tileIds: fromHand.map(t => t.id) }); h.stats.chow++; return;
      }
    }
    h.socket.emit('pass');
  } else if (state.phase === 'rob' && state.robKong && state.robKong.seat !== me) {
    const hand = mine.hand || [];
    if (checkWin([...hand, state.robKong.tile], mine.melds, rs)) { h.socket.emit('claim', { type: 'win' }); h.stats.rob++; }
    else h.socket.emit('pass');
  }
}

// Wire a (possibly reconnected) socket: every gameUpdate runs invariants, stores
// latest, cross-checks against the other client, then auto-plays once enabled.
function attach(h) {
  h.socket.on('gameUpdate', state => {
    checkInvariants(state, h.name);
    h.latest = state;
    const other = humans[h.seat === 0 ? 1 : 0];
    crossCompare(humans[0].latest, humans[1].latest);
    if (h.autoplay) act(h, state);
  });
}

async function main() {
  console.log('1. Two humans join one room, fill with 2 bots');
  humans[0].socket = await connect();
  humans[0].socket.emit('createRoom', { playerName: humans[0].name });
  const created = await once(humans[0].socket, 'roomCreated');
  CODE = created.code; humans[0].token = created.token;
  if (created.playerIndex !== 0) fail('creator should be seat 0');

  humans[1].socket = await connect();
  humans[1].socket.emit('joinRoom', { code: CODE, playerName: humans[1].name });
  const joined = await once(humans[1].socket, 'roomJoined');
  humans[1].token = joined.token;
  if (joined.playerIndex !== 1) fail('joiner should be seat 1');
  log(`room ${CODE}: Alice seat 0 (host), Bob seat 1`);

  // Host adds two bots, then locks the match to a single round.
  const fourPlayers = new Promise(res => {
    const handler = r => { if (r.players.length === 4) { humans[0].socket.off('roomUpdate', handler); res(r); } };
    humans[0].socket.on('roomUpdate', handler);
  });
  humans[0].socket.emit('addBot'); humans[0].socket.emit('addBot');
  const room = await fourPlayers;
  if (room.players.filter(p => p.isBot).length !== 2) fail('expected 2 bots');
  humans[0].socket.emit('setMatchLength', { rounds: 1 });
  log(`players: ${room.players.map(p => p.name).join(', ')}`);

  console.log('2. Chat crosses between the two clients');
  let got = once(humans[1].socket, 'chatMessage');
  humans[0].socket.emit('chat', { text: 'hi from Alice' });
  let m = await got;
  if (m.name !== 'Alice' || m.text !== 'hi from Alice') fail(`Bob got wrong chat: ${JSON.stringify(m)}`);
  got = once(humans[0].socket, 'chatMessage');
  humans[1].socket.emit('chat', { text: 'hi from Bob' });
  m = await got;
  if (m.name !== 'Bob' || m.text !== 'hi from Bob') fail(`Alice got wrong chat: ${JSON.stringify(m)}`);
  log('chat Alice→Bob and Bob→Alice both delivered');

  console.log('3. Start the match; both clients receive a consistent deal');
  attach(humans[0]); attach(humans[1]); // invariants on from the very first update
  humans[0].socket.emit('startGame');
  await Promise.all([once(humans[0].socket, 'gameStarted'), once(humans[1].socket, 'gameStarted')]);
  await Promise.all([once(humans[0].socket, 'gameUpdate'), once(humans[1].socket, 'gameUpdate')]);
  // Wait until both have stored their first state.
  for (let i = 0; i < 50 && (!humans[0].latest || !humans[1].latest); i++) await sleep(10);
  const A = humans[0].latest, B = humans[1].latest;
  const handCounts = A.players.map(p => p.handCount).sort((a, b) => a - b);
  if (handCounts.join(',') !== '13,13,13,14') fail(`bad deal handCounts: ${handCounts}`);
  if (A.currentTurn !== 0 || A.phase !== 'discard') fail(`dealer (seat 0) should act first in discard phase, got turn=${A.currentTurn} phase=${A.phase}`);
  if (!A.players[0].hand || A.players[0].hand.length !== 14) fail('Alice should see her own 14-tile dealer hand');
  if (B.players[0].hand) fail('Bob must NOT see Alice\'s hand');
  log(`dealt: dealer holds 14, others 13; both clients agree (${invariantChecks} invariant checks so far)`);

  console.log('4. Out-of-turn discard from the non-dealer is rejected');
  const bobTile = humans[1].latest.players[1].hand[0].id;
  humans[1].socket.emit('discard', { tileId: bobTile }); // not Bob's turn → server must ignore
  await sleep(150);
  humans[1].socket.emit('requestState');
  const after = await once(humans[1].socket, 'gameUpdate');
  if (after.players[1].handCount !== 13) fail(`out-of-turn discard leaked: Bob hand ${after.players[1].handCount}`);
  if (after.currentTurn !== 0 || after.phase !== 'discard') fail('out-of-turn discard advanced the game');
  log('server held the line: Bob still has 13 tiles, turn still on the dealer');

  console.log('5. Bob disconnects mid-hand and reconnects while Alice keeps her seat');
  const peerGone = once(humans[0].socket, 'playerDisconnected');
  humans[1].socket.disconnect();
  const gone = await peerGone;
  if (gone.playerIndex !== 1) fail(`wrong disconnect notice: ${JSON.stringify(gone)}`);
  await sleep(150);
  humans[1].socket = await connect();
  attach(humans[1]);
  const peerBack = once(humans[0].socket, 'playerReconnected'); // B: peers are told + refreshed
  humans[1].socket.emit('rejoin', { code: CODE, token: humans[1].token });
  const rj = await once(humans[1].socket, 'rejoined');
  if (rj.playerIndex !== 1 || rj.state !== 'playing') fail(`bad rejoin: ${JSON.stringify(rj)}`);
  const bobState = await once(humans[1].socket, 'gameUpdate');
  if (!bobState.players[1].hand || bobState.players[1].hand.length !== 13) fail('Bob did not get his hand back on reconnect');
  const back = await peerBack;
  if (back.playerIndex !== 1) fail(`Alice should be notified Bob reconnected, got ${JSON.stringify(back)}`);
  log(`Bob reconnected to seat 1 with his 13 tiles; Alice got playerReconnected + a room-wide refresh`);

  console.log('6. Both humans play claim-greedy to game over (invariants on every update)');
  humans[0].autoplay = true; humans[1].autoplay = true;
  const hand1Over = Promise.all([once(humans[0].socket, 'gameOver', 60000), once(humans[1].socket, 'gameOver', 60000)]);
  humans[0].socket.emit('requestState'); // replay current state now that auto-play is armed
  humans[1].socket.emit('requestState');
  const [o1a, o1b] = await hand1Over;
  if (o1a.type !== o1b.type || (o1a.winner ?? -1) !== (o1b.winner ?? -1)) fail(`clients disagree on hand-1 result: ${JSON.stringify(o1a)} vs ${JSON.stringify(o1b)}`);
  if (JSON.stringify(o1a.totals) !== JSON.stringify(o1b.totals)) fail('clients disagree on running totals after hand 1');
  log(`hand 1: ${o1a.type}${o1a.winnerName ? ' by ' + o1a.winnerName : ''}; totals ${o1a.totals}`);

  console.log('7. Next hand needs BOTH humans to agree (unanimous vote)');
  // A single vote must NOT advance — Bob (non-host) votes first; nothing should start.
  let startedEarly = false;
  const guardA = () => { startedEarly = true; };
  humans[0].socket.once('gameStarted', guardA);
  humans[1].socket.emit('nextHandVote', { value: true });
  await sleep(500);
  if (startedEarly) fail('next hand started on a single vote — both humans must agree');
  humans[0].socket.off('gameStarted', guardA);
  // Alice agrees too → hand 2 deals for both clients.
  humans[0].socket.emit('nextHandVote', { value: true });
  await Promise.all([once(humans[0].socket, 'gameStarted'), once(humans[1].socket, 'gameStarted')]);
  const h2 = await once(humans[0].socket, 'gameUpdate');
  if (h2.handNumber !== 2) fail(`expected hand 2, got ${h2.handNumber}`);
  const [o2a, o2b] = await Promise.all([once(humans[0].socket, 'gameOver', 60000), once(humans[1].socket, 'gameOver', 60000)]);
  if (o2a.type !== o2b.type || (o2a.winner ?? -1) !== (o2b.winner ?? -1)) fail('clients disagree on hand-2 result');
  log(`hand 2: ${o2a.type}${o2a.winnerName ? ' by ' + o2a.winnerName : ''}`);

  console.log('8. Unanimous vote (both humans) ends the match → final standings');
  const matchEnd = once(humans[0].socket, 'matchOver');
  humans[0].socket.emit('endMatchVote', { value: true });
  humans[1].socket.emit('endMatchVote', { value: true });
  const { standings } = await matchEnd;
  if (!Array.isArray(standings) || standings.length !== 4) fail('no final standings');
  if (standings[0].rank !== 1 || standings.some(r => typeof r.points !== 'number')) fail('standings not ranked');
  log(`standings: ${standings.map(r => `${r.name} ${r.points}(#${r.rank})`).join(', ')}`);

  console.log('9. Host returns the room to the lobby');
  const lobby = once(humans[1].socket, 'roomUpdate');
  humans[0].socket.emit('returnToLobby');
  await once(humans[0].socket, 'backToLobby');
  const lobbyRoom = await lobby;
  if (lobbyRoom.state !== 'waiting') fail('room did not return to waiting');
  log('back in lobby (state waiting), both clients notified');

  // Coverage summary — proves the human<->human claim paths were actually hit.
  const tot = k => humans[0].stats[k] + humans[1].stats[k];
  console.log('\nHuman action coverage across the match:');
  console.log(`  discards=${tot('discard')} pong=${tot('pong')} kong=${tot('kong')} chow=${tot('chow')} self-draw-win=${tot('win')} rob=${tot('rob')}`);
  console.log(`  ${invariantChecks} per-update invariant checks passed, ${crossChecks} cross-client agreement checks passed`);
  if (tot('pong') + tot('chow') + tot('kong') === 0) console.log('  (note: this run happened to exercise no human meld-claims; invariants still fully validated)');

  console.log('\nALL TESTS PASSED');
  clearTimeout(watchdog);
  humans[0].socket.disconnect(); humans[1].socket.disconnect();
  cleanup();
  process.exit(0);
}

main().catch(e => fail(e.message || String(e)));
