// Tests for game-pace behavior:
//   • single-player (1 human) ALWAYS auto-passes no-claim discards + runs bots at
//     the locked ~300ms, so a passive solo human's game still flies along;
//   • multiplayer host toggle: 'fast' auto-passes no-claim players, 'realistic'
//     makes a non-responding player block the window (manual passing);
//   • setPace config round-trips.
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');
const { getValidClaims } = require('../mahjong');

const PORT = process.env.PORT || 3103;
const URL = `http://localhost:${PORT}`;
const serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, BOT_DELAY_MS: '20' }, // multiplayer bots fast; solo bots are locked 300ms in code
  stdio: 'ignore',
});
const cleanup = () => { try { serverProc.kill(); } catch {} };
process.on('exit', cleanup);
const fail = m => { console.error('FAIL:', m); cleanup(); process.exit(1); };
const log = m => console.log('  •', m);
const watchdog = setTimeout(() => fail('global timeout'), 90000);

function connect() {
  return new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'] });
    s.on('connect', () => res(s));
    setTimeout(() => rej(new Error('connect timeout')), 8000);
  });
}
function once(s, ev, ms = 8000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout '${ev}'`)), ms);
    s.once(ev, d => { clearTimeout(t); res(d); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function waitForPlayers(s, n, action) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { s.off('roomUpdate', h); rej(new Error(`never reached ${n} players`)); }, 8000);
    const h = r => { if (r.players.length === n) { clearTimeout(t); s.off('roomUpdate', h); res(r); } };
    s.on('roomUpdate', h); action();
  });
}
function waitField(s, field, val, action) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { s.off('roomUpdate', h); rej(new Error(`${field} never became ${val}`)); }, 6000);
    const h = r => { if (r[field] === val) { clearTimeout(t); s.off('roomUpdate', h); res(r); } };
    s.on('roomUpdate', h); action();
  });
}
// Discards the first hand tile on your turn; passes any claim window you're in.
function driver(sock) {
  sock.on('gameUpdate', s => {
    const me = s.playerIndex;
    if (s.phase === 'discard' && s.currentTurn === me) {
      const t = s.players[me].hand && s.players[me].hand[0];
      if (t) sock.emit('discard', { tileId: t.id });
    } else if (s.phase === 'claim' && s.lastDiscardPlayer !== me) {
      sock.emit('pass');
    }
  });
}
// Discards on your own turn, but NEVER responds to a claim window (passive).
function passiveOnClaims(sock) {
  sock.on('gameUpdate', s => {
    const me = s.playerIndex;
    if (s.phase === 'discard' && s.currentTurn === me) {
      const t = s.players[me].hand && s.players[me].hand[0];
      if (t) sock.emit('discard', { tileId: t.id });
    }
  });
}
// Discards on your own turn; on a claim window PASSES when it actually has a claim (so
// those windows never confound the timing) but does NOTHING when it has no claim — which
// fast mode must auto-pass and realistic/broken must stall on. Isolates the auto-pass signal.
function passWhenCanClaim(sock) {
  sock.on('gameUpdate', s => {
    const me = s.playerIndex;
    if (s.phase === 'discard' && s.currentTurn === me) {
      const t = s.players[me].hand && s.players[me].hand[0];
      if (t) sock.emit('discard', { tileId: t.id });
    } else if (s.phase === 'claim' && s.lastDiscardPlayer !== me) {
      const mine = s.players[me];
      const isNext = (s.lastDiscardPlayer + 1) % s.players.length === me;
      if (getValidClaims(mine.hand, mine.melds, s.lastDiscard, isNext, s.ruleset).length > 0) sock.emit('pass');
    }
  });
}

async function singlePlayer() {
  console.log('T1. Solo game: human never passes, yet no-claim windows auto-pass + bots run ~300ms');
  const a = await connect();
  a.emit('createRoom', { playerName: 'Solo' });
  await once(a, 'roomCreated');
  await waitForPlayers(a, 4, () => { for (let i = 0; i < 3; i++) a.emit('addBot'); });

  // Human discards on its own turns but NEVER passes a claim window. In a solo game
  // the server must auto-pass those no-claim windows; otherwise each would wait the
  // default 5s react timeout and 6 discards would take ~20s+. (Count discards, not
  // wall draws — pong/chow claims advance the game without drawing.)
  const discards = new Set(); let resolveDone;
  const done = new Promise(r => resolveDone = r);
  a.on('gameUpdate', s => {
    if (s.lastDiscard) discards.add(s.lastDiscard.id);
    const me = s.playerIndex;
    if (s.phase === 'discard' && s.currentTurn === me) {
      const t = s.players[me].hand && s.players[me].hand[0];
      if (t) a.emit('discard', { tileId: t.id });
    }
    if (discards.size >= 6) resolveDone();
  });
  a.emit('startGame');
  await once(a, 'gameStarted');
  const t0 = Date.now();
  const ok = await Promise.race([done.then(() => true), sleep(7000).then(() => false)]);
  if (!ok) fail(`solo stalled — single-player auto-pass not working (${discards.size} discards in 7s)`);
  log(`solo: 6 discards in ${((Date.now() - t0) / 1000).toFixed(1)}s, human never passed ✓`);
  a.disconnect(); await sleep(100);
}

async function config() {
  console.log('T2. Host pace toggle round-trips');
  const a = await connect();
  a.emit('createRoom', { playerName: 'Host' });
  await once(a, 'roomCreated');
  let r = await waitField(a, 'pace', 'fast', () => a.emit('setPace', { pace: 'fast' }));
  if (r.pace !== 'fast') fail('setPace fast not applied');
  r = await waitField(a, 'pace', 'realistic', () => a.emit('setPace', { pace: 'realistic' }));
  if (r.pace !== 'realistic') fail('setPace realistic not applied');
  log('pace realistic↔fast round-trips ✓');
  a.disconnect(); await sleep(100);
}

async function multiplayer(pace, reactTimer, wireB) {
  const A = await connect();
  A.emit('createRoom', { playerName: 'A' });
  const ra = await once(A, 'roomCreated');
  const code = ra.code;
  const B = await connect();
  B.emit('joinRoom', { code, playerName: 'B' });
  await once(B, 'roomJoined');
  await waitForPlayers(A, 4, () => { A.emit('addBot'); A.emit('addBot'); });
  await waitField(A, 'pace', pace, () => A.emit('setPace', { pace }));
  await waitField(A, 'reactTimer', reactTimer, () => A.emit('setTimers', { reactTimer }));
  driver(A);   // A drives the game (discards on turn, passes on claims)
  wireB(B);    // caller picks B's behavior
  return { A, B };
}

async function multiplayerRealistic() {
  console.log('T3. Multiplayer REALISTIC: a non-responding player blocks the window');
  const { A, B } = await multiplayer('realistic', 2, passiveOnClaims); // B blocks every window
  const discards = new Set(); let secondAt = null, resolveSecond;
  const got2 = new Promise(r => resolveSecond = r);
  A.on('gameUpdate', s => {
    if (s.lastDiscard && !discards.has(s.lastDiscard.id)) {
      discards.add(s.lastDiscard.id);
      if (discards.size === 2 && secondAt === null) { secondAt = Date.now(); resolveSecond(); }
    }
  });
  A.emit('startGame');
  await Promise.all([once(A, 'gameStarted'), once(B, 'gameStarted')]);
  const tStart = Date.now();
  await Promise.race([got2, sleep(6000)]);
  if (secondAt === null) fail('realistic game never reached a 2nd discard');
  const waited = secondAt - tStart;
  if (waited < 1500) fail(`realistic mode auto-passed a passive player (2nd discard after ${waited}ms; should wait ~react timer)`);
  log(`realistic: passive player blocked the window — 2nd discard after ${waited}ms (no auto-pass) ✓`);
  A.disconnect(); B.disconnect(); await sleep(100);
}

async function multiplayerFast() {
  console.log('T4. Multiplayer FAST: a no-claim player is auto-passed (resolves far below the react timeout)');
  // reactTimer = 4s: WITH auto-pass each of B's no-claim windows resolves at bot speed
  // (~ms); WITHOUT it each waits the full 4s, so 6 discards take ~16s+. B passes the
  // claims it really has, so only the no-claim auto-pass drives the timing difference.
  const { A, B } = await multiplayer('fast', 4, passWhenCanClaim);
  const discards = new Set(); let sixAt = null, resolveAdv;
  const advanced = new Promise(r => resolveAdv = r);
  A.on('gameUpdate', s => {
    if (s.lastDiscard) discards.add(s.lastDiscard.id);
    if (discards.size >= 6 && sixAt === null) { sixAt = Date.now(); resolveAdv(); }
  });
  A.emit('startGame');
  await Promise.all([once(A, 'gameStarted'), once(B, 'gameStarted')]);
  const t0 = Date.now();
  await Promise.race([advanced, sleep(7000)]);
  if (sixAt === null) fail(`fast mode stalled past a no-claim player (${discards.size} discards in 7s) — auto-pass broken`);
  const elapsed = sixAt - t0;
  if (elapsed > 3500) fail(`fast mode too slow: 6 discards took ${elapsed}ms (>3.5s) — no-claim windows are waiting the react timer instead of auto-passing`);
  log(`fast: 6 discards in ${(elapsed / 1000).toFixed(1)}s — no-claim windows auto-passed (≈16s+ without) ✓`);
  A.disconnect(); B.disconnect(); await sleep(100);
}

async function main() {
  await singlePlayer();
  await config();
  await multiplayerRealistic();
  await multiplayerFast();
  console.log('\nALL PACE TESTS PASSED');
  clearTimeout(watchdog);
  cleanup();
  process.exit(0);
}
main().catch(e => fail(e.message || String(e)));
