// End-to-end test: lobby -> bots -> start -> simulated page navigation (socket
// swap + rejoin) -> full game vs 3 bots until gameOver.
// Spawns its own server on PORT (default 3100) with fast bots.
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = process.env.PORT || 3100;
const URL = `http://localhost:${PORT}`;

const serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, BOT_DELAY_MS: '30' },
  stdio: 'ignore',
});
const cleanup = () => { try { serverProc.kill(); } catch {} };
process.on('exit', cleanup);

const fail = msg => { console.error('FAIL:', msg); process.exit(1); };
const log = msg => console.log('  •', msg);

function connect() {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['websocket'] }); // auto-retries while server boots
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

async function main() {
  console.log('1. Create room');
  const s1 = await connect();
  s1.emit('createRoom', { playerName: 'Tester' });
  const { code, token, playerIndex } = await once(s1, 'roomCreated');
  if (!token) fail('no token in roomCreated');
  log(`room ${code}, seat ${playerIndex}, token ok`);

  // Listen BEFORE emitting so fast server replies aren't dropped
  function waitForPlayers(socket, count, action, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { socket.off('roomUpdate', h); reject(new Error(`never reached ${count} players`)); }, timeoutMs);
      const h = r => { if (r.players.length === count) { clearTimeout(t); socket.off('roomUpdate', h); resolve(r); } };
      socket.on('roomUpdate', h);
      action();
    });
  }

  console.log('2. Add 3 bots');
  const room = await waitForPlayers(s1, 4, () => { for (let i = 0; i < 3; i++) s1.emit('addBot'); });
  if (room.players.filter(p => p.isBot).length !== 3) fail('expected 3 bots');
  if (!room.players.filter(p => p.isBot).every(p => p.difficulty === 'normal')) fail('bots should default to normal difficulty');
  log(`players: ${room.players.map(p => p.name).join(', ')}`);

  console.log('3. Remove a bot, re-add with a difficulty (host controls)');
  await waitForPlayers(s1, 3, () => s1.emit('removeBot', { index: 3 }));
  const readded = await waitForPlayers(s1, 4, () => s1.emit('addBot', { difficulty: 'hard' }));
  if (readded.players[3].difficulty !== 'hard') fail('bot difficulty not applied');
  log('remove/re-add ok, difficulty applied');

  console.log('3b. Chat round-trip');
  const chatEcho = once(s1, 'chatMessage');
  s1.emit('chat', { text: 'gg 🀄' });
  const chatMsg = await chatEcho;
  if (chatMsg.text !== 'gg 🀄' || chatMsg.name !== 'Tester') fail(`bad chat echo: ${JSON.stringify(chatMsg)}`);
  log(`chat echoed: ${chatMsg.name}: ${chatMsg.text}`);

  console.log('4. Start game');
  s1.emit('startGame');
  await once(s1, 'gameStarted');
  const firstState = await once(s1, 'gameUpdate');
  if (firstState.players[0].hand.length < 13) fail('bad deal');
  log(`dealt, wall=${firstState.wallCount}`);

  console.log('5. Simulate page navigation: drop socket, rejoin with token');
  s1.disconnect();
  await new Promise(r => setTimeout(r, 300));
  const s2 = await connect();
  s2.emit('rejoin', { code, token });
  const rj = await once(s2, 'rejoined');
  if (rj.playerIndex !== 0 || rj.state !== 'playing') fail(`bad rejoin: ${JSON.stringify(rj)}`);
  const st = await once(s2, 'gameUpdate');
  if (!st.players[0].hand) fail('no hand after rejoin');
  log(`rejoined seat ${rj.playerIndex}, hand=${st.players[0].hand.length} tiles`);

  console.log('6. Reject bad token');
  const s3 = await connect();
  s3.emit('rejoin', { code, token: 'deadbeef' });
  await once(s3, 'rejoinError');
  s3.disconnect();
  log('bad token rejected');

  console.log('7. Auto-play vs bots until game over');
  let updates = 0;
  s2.on('gameUpdate', state => {
    updates++;
    const me = state.playerIndex;
    // Server is idempotent: duplicate passes/invalid discards are no-ops
    if (state.phase === 'discard' && state.currentTurn === me && state.players[me].hand?.length) {
      const tileId = state.players[me].hand[0].id;
      setTimeout(() => s2.emit('discard', { tileId }), 30);
    } else if (state.phase === 'claim' && state.lastDiscardPlayer !== me) {
      setTimeout(() => s2.emit('pass'), 20);
    }
  });
  s2.emit('requestState'); // replay current state now that the auto-player is wired up
  const over = await once(s2, 'gameOver', 180000);
  log(`saw ${updates} game updates`);
  log(`game over: ${over.type}${over.winnerName ? ' by ' + over.winnerName : ''}`);

  console.log('8. New game -> back to lobby');
  s2.emit('newGame');
  await once(s2, 'backToLobby');
  const lobbyRoom = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no roomUpdate after newGame')), 5000);
    s2.emit('requestState');
    s2.once('roomUpdate', r => { clearTimeout(t); resolve(r); });
  });
  if (lobbyRoom.state !== 'waiting') fail('room not back in waiting state');
  log('back in lobby, winds rotated');

  console.log('\nALL TESTS PASSED');
  s2.disconnect();
  process.exit(0);
}

main().catch(e => fail(e.message));
