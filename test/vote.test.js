// Focused tests for the between-hands VOTE flow: advancing to the next hand now
// needs EVERY connected human to agree (mirroring the end-match vote), and the two
// votes are mutually exclusive (choosing one clears the other). 2 humans + 2 bots,
// match locked to 1 round; both humans auto-play each hand to gameOver, then the
// test drives the votes by hand. Spawns its own server (PORT 3103) with fast bots.
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');
const { getValidClaims, getChowOptions, checkWin } = require('../mahjong');
const { chooseDiscard } = require('../bot');

const PORT = process.env.PORT || 3103;
const URL = `http://localhost:${PORT}`;
const serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, BOT_DELAY_MS: '20' },
  stdio: 'ignore',
});
const cleanup = () => { try { serverProc.kill(); } catch {} };
process.on('exit', cleanup);
const fail = m => { console.error('FAIL:', m); cleanup(); process.exit(1); };
const log = m => console.log('  •', m);
const watchdog = setTimeout(() => fail('global timeout'), 120000);

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

// Claim-greedy auto-play so each hand actually ends (win or wall draw).
function act(h, state) {
  const me = state.playerIndex;
  const mine = state.players[me];
  const rs = state.ruleset;
  if (state.phase === 'discard' && state.currentTurn === me) {
    const hand = mine.hand || [];
    if (checkWin(hand, mine.melds, rs)) { h.socket.emit('declareWin'); return; }
    const tile = chooseDiscard(hand, 'normal', state.discardPile) || hand[hand.length - 1];
    if (tile) h.socket.emit('discard', { tileId: tile.id });
  } else if (state.phase === 'claim' && state.lastDiscardPlayer !== me) {
    const hand = mine.hand || [];
    const isNext = (state.lastDiscardPlayer + 1) % state.players.length === me;
    const valid = getValidClaims(hand, mine.melds, state.lastDiscard, isNext, rs);
    if (valid.includes('win')) { h.socket.emit('claim', { type: 'win' }); return; }
    if (valid.includes('kong')) { h.socket.emit('claim', { type: 'kong' }); return; }
    if (valid.includes('pong')) { h.socket.emit('claim', { type: 'pong' }); return; }
    if (valid.includes('chow')) {
      const opts = getChowOptions(hand, state.lastDiscard);
      if (opts.length) {
        const fromHand = opts[0].filter(t => t !== state.lastDiscard);
        h.socket.emit('claim', { type: 'chow', tileIds: fromHand.map(t => t.id) }); return;
      }
    }
    h.socket.emit('pass');
  } else if (state.phase === 'rob' && state.robKong && state.robKong.seat !== me) {
    const hand = mine.hand || [];
    if (checkWin([...hand, state.robKong.tile], mine.melds, rs)) h.socket.emit('claim', { type: 'win' });
    else h.socket.emit('pass');
  }
}

const humans = [
  { name: 'Alice', seat: 0, token: null, socket: null, latest: null, autoplay: false },
  { name: 'Bob', seat: 1, token: null, socket: null, latest: null, autoplay: false },
];

function attach(h) {
  h.socket.on('gameUpdate', state => { h.latest = state; if (h.autoplay) act(h, state); });
}

// Wait for a tally event with the expected {voted, needed}; fail if it differs/never comes.
function expectTally(s, ev, voted, needed, ms = 4000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout '${ev}' (wanted ${voted}/${needed})`)), ms);
    const h = d => {
      clearTimeout(t); s.off(ev, h);
      if (d.voted !== voted || d.needed !== needed) return rej(new Error(`${ev} = ${d.voted}/${d.needed}, wanted ${voted}/${needed}`));
      res(d);
    };
    s.on(ev, h);
  });
}
// Assert NO occurrence of an event within a window.
function expectNo(s, ev, ms) {
  return new Promise((res, rej) => {
    const h = () => { s.off(ev, h); rej(new Error(`unexpected '${ev}' within ${ms}ms`)); };
    s.on(ev, h);
    setTimeout(() => { s.off(ev, h); res(); }, ms);
  });
}

async function reachGameOver() {
  humans[0].autoplay = true; humans[1].autoplay = true;
  const over = Promise.all([once(humans[0].socket, 'gameOver', 90000), once(humans[1].socket, 'gameOver', 90000)]);
  humans[0].socket.emit('requestState'); humans[1].socket.emit('requestState');
  return over;
}

async function main() {
  console.log('Setup: 2 humans + 2 bots, 1-round match');
  humans[0].socket = await connect();
  humans[0].socket.emit('createRoom', { playerName: humans[0].name });
  const created = await once(humans[0].socket, 'roomCreated');
  const CODE = created.code; humans[0].token = created.token;

  humans[1].socket = await connect();
  humans[1].socket.emit('joinRoom', { code: CODE, playerName: humans[1].name });
  humans[1].token = (await once(humans[1].socket, 'roomJoined')).token;

  const four = new Promise(res => {
    const h = r => { if (r.players.length === 4) { humans[0].socket.off('roomUpdate', h); res(r); } };
    humans[0].socket.on('roomUpdate', h);
  });
  humans[0].socket.emit('addBot'); humans[0].socket.emit('addBot');
  await four;
  humans[0].socket.emit('setMatchLength', { rounds: 1 });

  attach(humans[0]); attach(humans[1]);
  humans[0].socket.emit('startGame');
  await Promise.all([once(humans[0].socket, 'gameStarted'), once(humans[1].socket, 'gameStarted')]);

  console.log('1. Play hand 1 to game over');
  await reachGameOver();
  log('hand 1 over — between-hands screen');

  console.log('2. A single Next-Hand vote does NOT advance (needs both humans)');
  const tally1 = expectTally(humans[0].socket, 'nextVoteUpdate', 1, 2);
  const noStart = expectNo(humans[1].socket, 'gameStarted', 800);
  humans[1].socket.emit('nextHandVote', { value: true });
  await tally1;
  await noStart;
  log('Bob voted Next Hand → tally 1/2, no advance');

  console.log('3. Votes are mutually exclusive (voting End clears Next)');
  // Bob switches to End Match: his Next vote must drop to 0/2 and End rise to 1/2.
  const nextCleared = expectTally(humans[0].socket, 'nextVoteUpdate', 0, 2);
  const endRose = expectTally(humans[0].socket, 'endVoteUpdate', 1, 2);
  humans[1].socket.emit('endMatchVote', { value: true });
  await Promise.all([nextCleared, endRose]);
  log('Bob switched to End Match → Next 0/2, End 1/2');
  // Bob retracts so the next test starts clean.
  const endCleared = expectTally(humans[0].socket, 'endVoteUpdate', 0, 2);
  humans[1].socket.emit('endMatchVote', { value: false });
  await endCleared;

  console.log('4. Both humans vote Next Hand → hand 2 begins');
  const hand2Started = Promise.all([once(humans[0].socket, 'gameStarted'), once(humans[1].socket, 'gameStarted')]);
  humans[0].socket.emit('nextHandVote', { value: true });
  humans[1].socket.emit('nextHandVote', { value: true });
  await hand2Started;
  const h2 = await once(humans[0].socket, 'gameUpdate');
  if (h2.handNumber !== 2) fail(`expected hand 2, got ${h2.handNumber}`);
  log('both voted Next Hand → hand 2 dealt');

  console.log('5. Play hand 2 to game over, then both vote End Match → match over');
  await reachGameOver();
  const matchEnd = once(humans[0].socket, 'matchOver');
  humans[0].socket.emit('endMatchVote', { value: true });
  humans[1].socket.emit('endMatchVote', { value: true });
  const { standings } = await matchEnd;
  if (!Array.isArray(standings) || standings.length !== 4) fail('no final standings after unanimous End Match');
  log(`both voted End Match → match over; standings: ${standings.map(r => `${r.name} ${r.points}(#${r.rank})`).join(', ')}`);

  console.log('\nALL VOTE TESTS PASSED');
  clearTimeout(watchdog);
  humans[0].socket.disconnect(); humans[1].socket.disconnect();
  cleanup();
  process.exit(0);
}

main().catch(e => fail(e.message || String(e)));
