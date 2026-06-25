// Focused tests for feature A: the host-configurable per-turn discard clock and
// the no-stall disconnect fallback. Spawns its own server with a LOW disconnect
// fallback (800ms) so the off-mode safety net is observable quickly, and fast bots.
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = process.env.PORT || 3102;
const URL = `http://localhost:${PORT}`;
const serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, BOT_DELAY_MS: '20', DISCONNECT_FALLBACK_MS: '800' },
  stdio: 'ignore',
});
const cleanup = () => { try { serverProc.kill(); } catch {} };
process.on('exit', cleanup);
const fail = m => { console.error('FAIL:', m); cleanup(); process.exit(1); };
const log = m => console.log('  •', m);
const watchdog = setTimeout(() => fail('global timeout'), 60000);

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
function waitTimers(s, turnTimer, reactTimer, action) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { s.off('roomUpdate', h); rej(new Error('setTimers not reflected')); }, 8000);
    const h = r => { if (r.turnTimer === turnTimer && r.reactTimer === reactTimer) { clearTimeout(t); s.off('roomUpdate', h); res(r); } };
    s.on('roomUpdate', h); action();
  });
}

async function main() {
  // ── T1: the turn clock auto-discards the just-drawn tile when a player idles ──
  console.log('T1. Turn clock auto-discards an idle player');
  const a = await connect();
  a.emit('createRoom', { playerName: 'Idler' });
  const { code } = await once(a, 'roomCreated');
  await waitForPlayers(a, 4, () => { for (let i = 0; i < 3; i++) a.emit('addBot'); });
  await waitTimers(a, 3, 1, () => a.emit('setTimers', { turnTimer: 3, reactTimer: 1 })); // 3s clock, 1s react
  a.emit('startGame');
  await once(a, 'gameStarted');
  const first = await once(a, 'gameUpdate');
  if (first.currentTurn !== 0 || first.phase !== 'discard') fail('dealer should be on the clock first');
  if (first.players[0].handCount !== 14) fail('dealer should hold 14');
  const drawn = first.drawnId; // the gapped just-drawn tile the clock should auto-discard
  if (drawn == null) fail('no drawnId for the dealer');
  if (!first.turnDeadline) fail('no turnDeadline broadcast for the active player');

  let autoDiscarded = false;
  a.on('gameUpdate', s => { if (s.discardPile.some(t => t.id === drawn)) autoDiscarded = true; });
  const t0 = Date.now();
  for (let i = 0; i < 45 && !autoDiscarded; i++) await sleep(150);
  if (!autoDiscarded) fail('turn clock never auto-discarded the idle dealer');
  const elapsed = Date.now() - t0;
  if (elapsed < 2000) fail(`auto-discard fired at ${elapsed}ms — clock (3s) not honoured`);
  log(`idle dealer auto-discarded their drawn tile after ~${(elapsed / 1000).toFixed(1)}s (clock = 3s)`);
  a.disconnect();
  await sleep(100);

  // ── T2: clock OFF — a present player is never rushed; a disconnected one is ───
  console.log('T2. Clock OFF: present player not rushed, disconnected player force-discarded');
  const A = await connect();
  A.emit('createRoom', { playerName: 'HostA' });
  const r2 = await once(A, 'roomCreated');
  const code2 = r2.code;
  const B = await connect();
  B.emit('joinRoom', { code: code2, playerName: 'PeerB' });
  await once(B, 'roomJoined');
  await waitForPlayers(A, 4, () => { A.emit('addBot'); A.emit('addBot'); });
  await waitTimers(A, 0, 1, () => A.emit('setTimers', { turnTimer: 0, reactTimer: 1 })); // clock OFF
  A.emit('startGame');
  await once(A, 'gameStarted');
  const s1 = await once(A, 'gameUpdate');
  if (s1.currentTurn !== 0 || s1.phase !== 'discard') fail('A should be the dealer on turn');
  if (s1.turnDeadline) fail('clock OFF + present player should have NO turn deadline');

  // Present + idle + clock OFF → must NOT be auto-discarded (wait past the 800ms fallback).
  await sleep(1300);
  const peek = await new Promise(res => { B.emit('requestState'); B.once('gameUpdate', res); });
  if (peek.players[0].handCount !== 14) fail('present idle player was wrongly auto-discarded while clock OFF');
  log('clock OFF + present + idle: not rushed (still 14 tiles after 1.3s)');

  // A disconnects on their turn → fallback (~800ms) force-discards; B observes the progress.
  let fallbackFired = false;
  B.on('gameUpdate', s => { if (s.players[0].handCount === 13 || s.discardPile.length > 0) fallbackFired = true; });
  A.disconnect();
  const t1 = Date.now();
  for (let i = 0; i < 30 && !fallbackFired; i++) await sleep(150);
  if (!fallbackFired) fail('disconnect fallback never fired — the hand would stall indefinitely');
  log(`disconnected player force-discarded after ~${Date.now() - t1}ms fallback (no stall)`);
  B.disconnect();

  console.log('\nALL TIMER TESTS PASSED');
  clearTimeout(watchdog);
  cleanup();
  process.exit(0);
}
main().catch(e => fail(e.message || String(e)));
