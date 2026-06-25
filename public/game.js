import { makeTileEl as makeTile, buildHandDock } from '/shared/hand-render.js';
import { TIMING, liveClock, currentDiscard, timerFraction, secondsLeft, rampColor, localClaim } from '/shared/indicator-core.js';
import { buildToken, makeDiscardController, makePerimeterHalo } from '/shared/indicator-dom.js';
import { tileGlyph, tileLabel } from '/shared/rules-client.js';

const socket = io();

// Guarded sessionStorage read — corrupt JSON must never throw on boot / reconnect.
function readSession() {
  try { return JSON.parse(sessionStorage.getItem('mahjong') || '{}') || {}; }
  catch (_) { return {}; }
}

let myIndex = null;
let roomCode = null;
let gameState = null;
let selectedTileId = null;
let claimResponded = false;

const token = buildToken(); token.setSlideMs(TIMING.tokenSlideMs);
const boardHalo = makePerimeterHalo(34, 48, { gap: 3, stroke: 3, radius: 6 }); // .tile.sm size
boardHalo.svg.style.position = 'absolute';
const discardCtl = makeDiscardController({
  onBoardHalo(active, frac, color) {
    if (!active) { boardHalo.svg.remove(); return; }
    placeBoardHalo();              // attach + position over the newest pile tile
    boardHalo.update(frac, color);
  },
});
let tokenTick = null;
let lastDiscardEl = null; // newest discard-pile tile element (captured in renderDiscards for the board halo)
function mountIndicators() {
  const layer = document.getElementById('bubble-layer');
  if (!layer.contains(token.el)) layer.appendChild(token.el);
  if (!document.body.contains(discardCtl.el)) document.body.appendChild(discardCtl.el);
}
function placeBoardHalo() {
  const pile = document.getElementById('discard-pile');
  const last = lastDiscardEl;   // captured in renderDiscards — avoids a querySelectorAll every ~80ms tick
  if (!pile || !last || !last.isConnected) { boardHalo.svg.remove(); return; }
  if (getComputedStyle(pile).position === 'static') pile.style.position = 'relative';
  pile.appendChild(boardHalo.svg);
  boardHalo.svg.style.left = (last.offsetLeft + last.offsetWidth / 2) + 'px';
  boardHalo.svg.style.top  = (last.offsetTop + last.offsetHeight / 2) + 'px';
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
function init() {
  const stored = readSession();
  roomCode = stored.code;

  if (!stored.code || !stored.token) {
    window.location.href = '/';
    return;
  }
  // Re-attach this fresh socket to our seat (also covers reconnects mid-game)
  const doRejoin = () => {
    const s = readSession();
    if (s.code && s.token) socket.emit('rejoin', { code: s.code, token: s.token });
  };
  socket.on('connect', doRejoin);
  if (socket.connected) doRejoin();

  document.getElementById('btn-win').addEventListener('click', () => socket.emit('declareWin'));
  document.getElementById('btn-discard').addEventListener('click', discardSelected);
  document.getElementById('btn-next-hand').addEventListener('click', toggleNextVote);
  document.getElementById('btn-vote-end').addEventListener('click', toggleEndVote);
  document.getElementById('btn-lobby').addEventListener('click', () => socket.emit('returnToLobby'));
  MahjongChat.initChat(socket, { glyph: tileGlyph, onAction: e => showActionBubble(e.seat, e.type, e.tiles) });
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// ── Socket events ────────────────────────────────────────────────────────────
// Between-hands votes: both are mutually-exclusive toggles; the server is the source
// of truth and its tallies are authoritative.
let myNextVote = false; // this client's current "Next Hand" vote
let myEndVote = false;  // this client's current "End Match" vote
let nextTally = null;   // last authoritative {voted, needed} for Next Hand (null = fresh period)
let endTally = null;    // last authoritative {voted, needed} for End Match

socket.on('rejoined', ({ playerIndex, state }) => {
  myIndex = playerIndex;
  const stored = readSession();
  stored.playerIndex = playerIndex;
  sessionStorage.setItem('mahjong', JSON.stringify(stored));
  if (state === 'waiting') window.location.href = '/';
});

socket.on('rejoinError', () => {
  sessionStorage.removeItem('mahjong');
  window.location.href = '/';
});

socket.on('gameUpdate', state => {
  const prevPhase = gameState?.phase;
  // A fresh game state means a new hand is in progress — clear any game-over overlay.
  const over = document.getElementById('game-over');
  if (over && !over.classList.contains('hidden')) { over.classList.add('hidden'); resetVotes(); }
  gameState = state;
  if (state.playerIndex != null) myIndex = state.playerIndex;
  // Reset response tracking when entering/leaving a claim or rob window
  const respondable = ph => ph === 'claim' || ph === 'rob';
  if (respondable(state.phase) !== respondable(prevPhase)) claimResponded = false;
  render();
});

socket.on('gameOver', (result) => {
  resetVotes();   // a fresh hand-over screen starts with no votes cast
  const { type, winnerName, discarderName } = result;
  if (gameState) { gameState.phase = 'over'; render(); }
  const msg = type === 'draw'   ? 'Draw — no more tiles in the wall.' :
              type === 'tsumo'  ? `${winnerName} wins by self-draw! 🎉` :
                                  `${winnerName} wins by Ron${discarderName ? ' off ' + discarderName : ''}! 🎉`;
  document.getElementById('game-over-title').textContent = result.matchOver ? '🏁 Match Complete' : 'Hand Over';
  document.getElementById('game-over-msg').textContent = msg;
  renderScoreDetail(result);
  if (result.matchOver) {
    showFinalStandings(result.standings);
    setOverButtons('matchOver');
  } else {
    showFinalStandings(null);
    setOverButtons('betweenHands');
  }
  document.getElementById('game-over').classList.remove('hidden');
});

// Match ended early by a unanimous vote — no fresh hand result, just standings.
socket.on('matchOver', ({ standings }) => {
  if (gameState) { gameState.phase = 'over'; render(); }
  document.getElementById('game-over-title').textContent = '🏁 Match Complete';
  document.getElementById('game-over-msg').textContent = 'Match ended by vote.';
  document.getElementById('game-over-detail').innerHTML = '';
  showFinalStandings(standings);
  setOverButtons('matchOver');
  document.getElementById('game-over').classList.remove('hidden');
});

socket.on('nextVoteUpdate', ({ voted, needed }) => { nextTally = { voted, needed }; refreshVoteButtons(); });
socket.on('endVoteUpdate',  ({ voted, needed }) => { endTally  = { voted, needed }; refreshVoteButtons(); });

socket.on('backToLobby', () => { window.location.href = '/'; });

socket.on('playerDisconnected', ({ name }) => {
  setStatus(`${name} disconnected`, 'waiting');
});

// Peer came back — clear the stale "disconnected" notice. The room-wide gameUpdate
// that follows re-renders the real turn status over this immediately.
socket.on('playerReconnected', ({ name }) => {
  setStatus(`${name} reconnected`, 'waiting');
});

// Rejected action (e.g. trying to win below the faan minimum).
socket.on('actionError', msg => setStatus(typeof msg === 'string' ? msg : 'Action not allowed', 'waiting'));

// ── Tile helpers ─────────────────────────────────────────────────────────────
// tileGlyph / tileLabel are imported from /shared/rules-client.js (single source of
// truth, shared with the 3D client) — see the import at the top.


// ── Main render ──────────────────────────────────────────────────────────────
function render() {
  if (!gameState) return;
  const s = gameState;
  const n = s.players.length;

  // Seat assignments: me=bottom, +1=right, +2=top, +3=left
  const pos = ['bottom', 'right', 'top', 'left'];
  const atPos = {};
  for (let i = 0; i < 4; i++) {
    if (i < n) atPos[pos[i]] = (myIndex + i) % n;
  }

  // Header
  document.getElementById('wall-info').textContent = `Wall: ${s.wallCount}`;
  updateStatus(s);
  updateRoundWind(s);

  // Local hand → the pinned bottom dock; opponents → their seat areas.
  renderDock(atPos.bottom, s);
  renderArea('right', atPos.right, s);
  renderArea('top',   atPos.top,   s);
  renderArea('left',  atPos.left,  s);

  renderDiscards(s);
  renderActions(s);
  updateTimer(s);
}

function updateStatus(s) {
  if (s.phase === 'over') return;
  const isMe = s.currentTurn === myIndex;
  let text, cls;
  if (s.phase === 'discard') {
    text = isMe ? 'Your turn — select a tile to discard' : `${s.players[s.currentTurn]?.name}'s turn`;
    cls  = isMe ? 'my-turn' : 'waiting';
  } else if (s.phase === 'claim') {
    text = `${s.players[s.lastDiscardPlayer]?.name} discarded`;
    cls  = 'claiming';
  } else if (s.phase === 'rob') {
    const declarer = s.robKong ? s.players[s.robKong.seat]?.name : '';
    text = s.robKong && s.robKong.seat === myIndex
      ? 'Adding kong — others may rob…'
      : `${declarer} is adding a kong — rob?`;
    cls  = 'claiming';
  } else {
    text = '...'; cls = 'waiting';
  }
  setStatus(text, cls);
}

function setStatus(text, cls) {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = `status ${cls}`;
}

// Escape user-controlled text (player names) before putting it in innerHTML.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const WIND_CN = { east: '東', south: '南', west: '西', north: '北' };
const WIND_EN = { east: 'East', south: 'South', west: 'West', north: 'North' };

function updateRoundWind(s) {
  const el = document.getElementById('round-wind');
  if (!el) return;
  if (!s.roundWind) { el.textContent = ''; return; }
  let txt = `${WIND_CN[s.roundWind]} ${WIND_EN[s.roundWind]} Round`;
  if (s.handNumber) txt += ` · Hand ${s.handNumber}`;
  if (s.dealerStreak) txt += ` · 連莊 ×${s.dealerStreak}`;
  el.textContent = txt;
}

// Build the faan breakdown + payment summary on the game-over screen.
function renderScoreDetail(result) {
  const el = document.getElementById('game-over-detail');
  if (!el) return;
  el.innerHTML = '';
  const { score, payments, totals } = result;

  if (score) {
    const head = document.createElement('div');
    head.className = 'score-head';
    // MCR additive has no faan — its value IS points; HK modes show 番 → pts.
    head.innerHTML = score.mode === 'mcr-additive'
      ? `<span class="score-faan">${score.value} pts</span>`
      : `<span class="score-faan">${score.faan} 番</span>` +
        (score.isLimit ? '<span class="score-limit">LIMIT</span>' : '') +
        `<span class="score-points">${score.points} pts</span>`;
    el.appendChild(head);

    if (score.breakdown?.length) {
      const ul = document.createElement('ul');
      ul.className = 'score-breakdown';
      score.breakdown.forEach(b => {
        const cnt = b.count ? ` ×${b.count}` : '';
        const li = document.createElement('li');
        li.innerHTML = `<span>${escapeHtml(b.name)}${cnt} <span class="score-cn">${escapeHtml(b.cn)}</span></span><span class="score-b-faan">${b.limit ? 'LIMIT' : '+' + (b.points != null ? b.points : b.faan)}</span>`;
        ul.appendChild(li);
      });
      el.appendChild(ul);
    }
  }

  // Per-player point change and running session total.
  if (totals && gameState?.players) {
    const tbl = document.createElement('div');
    tbl.className = 'score-totals';
    gameState.players.forEach((p, i) => {
      const delta = payments?.[i] || 0;
      const deltaStr = delta
        ? `<span class="${delta > 0 ? 'pay-plus' : 'pay-minus'}">${delta > 0 ? '+' : ''}${delta}</span>`
        : '<span class="pay-zero">·</span>';
      const row = document.createElement('div');
      row.className = 'score-total-row';
      row.innerHTML = `<span class="st-name">${p.isBot ? '🤖 ' : ''}${escapeHtml(p.name)}</span>${deltaStr}<span class="score-running">${totals[i]}</span>`;
      tbl.appendChild(row);
    });
    el.appendChild(tbl);
  }
}

// ── Match end: standings + the between-hands controls ────────────────────────
const MEDALS = ['🥇', '🥈', '🥉'];

function setOverButtons(mode) {
  const next = document.getElementById('btn-next-hand');
  const vote = document.getElementById('btn-vote-end');
  const lobby = document.getElementById('btn-lobby');
  if (mode === 'matchOver') {
    next.classList.add('hidden');
    vote.classList.add('hidden');
    lobby.classList.remove('hidden');
  } else { // betweenHands — both votes shown; each needs EVERY human to agree
    next.classList.remove('hidden');
    vote.classList.remove('hidden');
    lobby.classList.add('hidden');
    refreshVoteButtons();
  }
}

// Fresh between-hands period: no votes cast yet and no server tallies seen.
function resetVotes() { myNextVote = false; myEndVote = false; nextTally = null; endTally = null; }

// The two votes are mutually exclusive: choosing one clears the other (optimistically;
// the server enforces the same and its tallies are authoritative).
function toggleNextVote() {
  myNextVote = !myNextVote;
  if (myNextVote) myEndVote = false;
  socket.emit('nextHandVote', { value: myNextVote });
  refreshVoteButtons();
}
function toggleEndVote() {
  myEndVote = !myEndVote;
  if (myEndVote) myNextVote = false;
  socket.emit('endMatchVote', { value: myEndVote });
  refreshVoteButtons();
}

function refreshVoteButtons() {
  const humans = (gameState?.players || []).filter(p => !p.isBot).length;
  setVoteBtn('btn-next-hand', 'next-count', myNextVote, nextTally, humans);
  setVoteBtn('btn-vote-end',  'end-count',  myEndVote,  endTally,  humans);
}
// Show the live "voted/needed" count under each button (✓ when it's your pick) and
// outline the option you've chosen. Falls back to a local estimate until a tally lands.
function setVoteBtn(btnId, countId, mine, tally, humans) {
  const btn = document.getElementById(btnId);
  const count = document.getElementById(countId);
  if (!btn || !count) return;
  const voted = tally ? tally.voted : (mine ? 1 : 0);
  const needed = tally ? tally.needed : humans;
  count.textContent = `${mine ? '✓ ' : ''}${voted}/${needed}`;
  btn.classList.toggle('vote-active', mine);
}

function showFinalStandings(standings) {
  const el = document.getElementById('final-standings');
  if (!el) return;
  if (!standings) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = '<div class="standings-title">Final Standings</div>';
  standings.forEach(s => {
    const medal = MEDALS[s.rank - 1] || `#${s.rank}`;
    const row = document.createElement('div');
    row.className = 'standings-row' + (s.rank === 1 ? ' standings-leader' : '');
    row.innerHTML =
      `<span class="st-rank">${medal}</span>` +
      `<span class="st-name">${s.isBot ? '🤖 ' : ''}${escapeHtml(s.name)}</span>` +
      `<span class="st-pts ${s.points >= 0 ? 'pay-plus' : 'pay-minus'}">${s.points > 0 ? '+' : ''}${s.points}</span>`;
    el.appendChild(row);
  });
}

// ── Local player's hand dock (pinned bottom inventory bar) ───────────────────
// Uses the shared buildHandDock with 2D callbacks. Opponents render in renderArea.
function renderDock(pIdx, s) {
  const dock = document.getElementById('dock');
  if (!dock) return;
  if (pIdx === undefined) { dock.replaceChildren(); return; }
  const p = s.players[pIdx];
  dock.replaceChildren(buildHandDock({
    player: p,
    drawnId: s.drawnId ?? null,
    selectedId: selectedTileId,
    canDiscard: s.phase === 'discard' && s.currentTurn === myIndex,
    isTurn: s.currentTurn === pIdx,
    onTileClick: (id) => handleTileClick(id),
    onOrganize: () => socket.emit('organizeHand'),
    onShuffle: () => socket.emit('shuffleHand'),
    layout: 'spread',
  }));
}

// ── Player area ──────────────────────────────────────────────────────────────
function renderArea(position, pIdx, s) {
  const el = document.getElementById(`player-${position}`);
  if (!el) return;
  if (pIdx === undefined) { el.innerHTML = ''; return; }

  const p = s.players[pIdx];

  el.innerHTML = '';
  el.className = `player-area player-${position}`;

  // Name row
  const nameRow = document.createElement('div');
  nameRow.className = 'player-name';
  const windMap = { east:'東', south:'南', west:'西', north:'北' };
  nameRow.innerHTML = `<span>${p.isBot ? '🤖 ' : ''}${escapeHtml(p.name)}</span><span class="seat-wind">${windMap[p.seatWind]}</span><span class="player-points" title="Session score">${p.points ?? 0}</span>`;
  nameRow.innerHTML += `<span class="hand-count">(${p.handCount})</span>`;
  el.appendChild(nameRow);

  // Revealed tiles (flowers + melds) — no face-down hand; the concealed-hand size is
  // the (handCount) number in the name row. The top ('opposite') player lays flowers
  // and melds on ONE shared row so a forming meld joins the existing row rather than
  // adding a new one (which would grow the top cell and push the whole board down).
  // Left/right keep them stacked in their fixed-width rows.
  const tray = position === 'top' ? document.createElement('div') : el;
  if (position === 'top') tray.className = 'player-tray';

  // Flowers
  if (p.flowers?.length) {
    const row = document.createElement('div');
    row.className = 'player-flowers';
    p.flowers.forEach(f => row.appendChild(makeTile(f, { small: true })));
    tray.appendChild(row);
  }

  // Melds
  if (p.melds?.length) {
    const meldsEl = document.createElement('div');
    meldsEl.className = 'player-melds';
    p.melds.forEach(meld => {
      const meldEl = document.createElement('div');
      meldEl.className = 'meld';
      const tiles = (meld.type === 'concealed-kong')
        ? ['back', meld.tiles[1], meld.tiles[2], 'back']
        : meld.tiles;
      tiles.forEach(t => meldEl.appendChild(makeTile(t, { small: true })));
      meldsEl.appendChild(meldEl);
    });
    tray.appendChild(meldsEl);
  }

  // Always attach the tray for the top player (even when empty) so its reserved-height
  // row exists from the start — the first flower/meld then fills it without growing the
  // top cell and pushing the board down.
  if (position === 'top') el.appendChild(tray);
}

// ── Discard pile ─────────────────────────────────────────────────────────────
function renderDiscards(s) {
  const el = document.getElementById('discard-pile');
  el.innerHTML = '';
  lastDiscardEl = null;
  s.discardPile.forEach((tile) => {
    lastDiscardEl = el.appendChild(makeTile(tile, { small: true }));
  });
}

// ── Action bar ───────────────────────────────────────────────────────────────
function renderActions(s) {
  const btnWin     = document.getElementById('btn-win');
  const btnDiscard = document.getElementById('btn-discard');
  const selfPanel  = document.getElementById('self-panel');
  const claimPanel = document.getElementById('claim-panel');

  btnWin.classList.add('hidden');
  btnDiscard.classList.add('hidden');
  selfPanel.innerHTML = '';
  claimPanel.innerHTML = '';

  const me = s.players[myIndex];
  if (!me) return;

  // My discard turn
  if (s.phase === 'discard' && s.currentTurn === myIndex && me.hand) {
    if (selectedTileId !== null) btnDiscard.classList.remove('hidden');

    // Self-draw win check
    if (Mahjong.checkWin(me.hand, me.melds, s.ruleset)) btnWin.classList.remove('hidden');

    // Concealed kong
    const groups = {};
    me.hand.forEach(t => { const k = `${t.suit}:${t.value}`; (groups[k] = groups[k] || []).push(t); });
    Object.values(groups).forEach(grp => {
      if (grp.length === 4) {
        const btn = document.createElement('button');
        btn.className = 'action-btn kong-btn';
        btn.textContent = `Kong ${tileLabel(grp[0])}`;
        btn.onclick = () => socket.emit('declareKong', { tileId: grp[0].id });
        selfPanel.appendChild(btn);
      }
    });

    // Added kong (加槓): upgrade an exposed pong with the matching 4th tile
    me.melds.forEach(meld => {
      if (meld.type !== 'pong') return;
      const t = me.hand.find(h => h.suit === meld.tiles[0].suit && h.value === meld.tiles[0].value);
      if (!t) return;
      const btn = document.createElement('button');
      btn.className = 'action-btn kong-btn';
      btn.textContent = `Kong ➕ ${tileLabel(t)}`;
      btn.onclick = () => socket.emit('declareAddedKong', { tileId: t.id });
      selfPanel.appendChild(btn);
    });
  }

  // Claim window — not my discard
  if (s.phase === 'claim' && s.lastDiscardPlayer !== myIndex && !claimResponded && me.hand) {
    const isNext = (s.lastDiscardPlayer + 1) % s.players.length === myIndex;
    const claims = Mahjong.getValidClaims(me.hand, me.melds, s.lastDiscard, isNext, s.ruleset);

    if (claims.length > 0) {
      claims.forEach(type => {
        if (type === 'chow') {
          Mahjong.getChowOptions(me.hand, s.lastDiscard).forEach(opt => {
            const fromHand = opt.filter(t => t !== s.lastDiscard);
            const btn = document.createElement('button');
            btn.className = 'action-btn chow-btn';
            btn.textContent = `Chow ${fromHand.map(tileLabel).join('+')}`;
            btn.onclick = () => {
              socket.emit('claim', { type: 'chow', tileIds: fromHand.map(t => t.id) });
              markClaimResponded(claimPanel);
            };
            claimPanel.appendChild(btn);
          });
        } else {
          const btn = document.createElement('button');
          btn.className = `action-btn ${type}-btn`;
          btn.textContent = type === 'win' ? '🏆 Win!' : type[0].toUpperCase() + type.slice(1);
          btn.onclick = () => {
            socket.emit('claim', { type });
            markClaimResponded(claimPanel);
          };
          claimPanel.appendChild(btn);
        }
      });
    }

    // Always show Pass
    const passBtn = document.createElement('button');
    passBtn.className = 'action-btn pass-btn';
    passBtn.textContent = 'Pass';
    passBtn.onclick = () => {
      socket.emit('pass');
      markClaimResponded(claimPanel);
    };
    claimPanel.appendChild(passBtn);
  }

  // Robbing-the-kong window — anyone but the declarer may win on the added tile
  if (s.phase === 'rob' && s.robKong && s.robKong.seat !== myIndex && !claimResponded && me.hand) {
    if (Mahjong.checkWin([...me.hand, s.robKong.tile], me.melds, s.ruleset)) {
      const btn = document.createElement('button');
      btn.className = 'action-btn win-btn';
      btn.textContent = '🏆 Rob!';
      btn.onclick = () => { socket.emit('claim', { type: 'win' }); markClaimResponded(claimPanel); };
      claimPanel.appendChild(btn);
    }
    const passBtn = document.createElement('button');
    passBtn.className = 'action-btn pass-btn';
    passBtn.textContent = 'Pass';
    passBtn.onclick = () => { socket.emit('pass'); markClaimResponded(claimPanel); };
    claimPanel.appendChild(passBtn);
  }
}

function markClaimResponded(claimPanel) {
  claimResponded = true;
  const sp = document.getElementById('self-panel');
  const panel = claimPanel || document.getElementById('claim-panel');
  if (panel) panel.innerHTML = '<span class="claim-sent">✓ Response sent</span>';
  if (sp) sp.innerHTML = '';
}

// ── Indicators (token glide + discard reveal + claim halo) ───────────────────
// Place the turn-token inside the discard-pile window (#center), at the midpoint of the
// edge nearest the active player: the bottom edge for me, the top edge for the player
// across (both centred on the screen's width), and the left/right edges for the side
// players. So every token sits over the felt-dark pile area and the near/across ones are
// dead-centre — fully symmetric. 2D only; the 3D client draws its own in-scene puck.
function positionToken(s) {
  const n = s.players.length;
  const rel = (((s.currentTurn - myIndex) % n) + n) % n;   // 0 me · 1 right · 2 top · 3 left
  const center = document.getElementById('center');
  if (!center) return;
  const c = center.getBoundingClientRect();
  const M = 33 + 14;   // inset from the pile-window edge: token-ring radius (33) + margin
  const cx = c.left + c.width / 2, cy = c.top + c.height / 2;
  let x, y;
  if (rel === 0)      { x = cx;          y = c.bottom - M; }  // me → bottom edge, centred
  else if (rel === 2) { x = cx;          y = c.top + M; }     // across → top edge, centred
  else if (rel === 1) { x = c.right - M; y = cy; }            // right → right edge
  else                { x = c.left + M;  y = cy; }            // left → left edge
  token.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
}

function updateTimer(s) { driveIndicators(s); }

function driveIndicators(s) {
  mountIndicators();

  // Token: glide to the active seat; dormant during a reaction window (claim/rob).
  positionToken(s);
  token.setIdle(s.phase === 'claim' || s.phase === 'rob');
  if (tokenTick) { clearInterval(tokenTick); tokenTick = null; }
  const clock = liveClock(s);
  if (clock && clock.kind === 'turn') {
    const tick = () => {
      const left = Math.max(0, clock.deadline - Date.now());
      const frac = timerFraction(left, clock.totalMs);
      token.update({ frac, color: rampColor(frac), seconds: secondsLeft(left) });
      if (left <= 0) { clearInterval(tokenTick); tokenTick = null; }
    };
    tick(); tokenTick = setInterval(tick, 80);
  } else {
    token.update({ frac: 1, color: rampColor(1), seconds: '' }); // bot turn / no clock
  }

  // Reaction panel: reveal every discard; during a claim or rob window upgrade to a
  // countdown + tap-to-act. Hidden outright at game over (no stale tile lingering).
  if (s.phase === 'over') { discardCtl.hide(); return; }
  const me = s.players[myIndex];

  let tile = null, caption = '', claim = null;
  if (s.phase === 'rob' && s.robKong) {
    tile = s.robKong.tile;
    caption = `${s.players[s.robKong.seat]?.name || ''} kong`;
    const canRob = s.robKong.seat !== myIndex && !claimResponded && me?.hand
      && Mahjong.checkWin([...me.hand, s.robKong.tile], me.melds, s.ruleset);
    claim = canRob
      ? { clock, action: { type: 'win', tileIds: [] }, onClaim: () => sendClaim({ type: 'win', tileIds: [] }) }
      : { clock };   // everyone sees the countdown; only the eligible seat can act
  } else {
    tile = currentDiscard(s);
    const who = (s.lastDiscardPlayer != null) ? (s.players[s.lastDiscardPlayer]?.name || '') : '';
    caption = tile ? `${who} discarded` : '';
    if (tile && !claimResponded && me?.hand) {
      const lc = localClaim(s, myIndex, Mahjong.getValidClaims, Mahjong.getChowOptions);
      if (lc.action)         claim = { clock, action: lc.action, onClaim: () => sendClaim(lc.action) };
      else if (lc.ambiguous) claim = { clock, ambiguous: true };  // tap → flare; use the chow buttons
    }
  }
  discardCtl.update({ tile, tileId: tile ? tile.id : null, caption, claim });
}

function sendClaim(action) {
  if (claimResponded) return;   // already answered this window (e.g. via a claim button) — no double-emit
  socket.emit('claim', { type: action.type, tileIds: action.tileIds });
  markClaimResponded();   // existing helper used by the claim panel buttons
}

// ── Tile selection & discard ─────────────────────────────────────────────────
function handleTileClick(tileId) {
  if (selectedTileId === tileId) {
    discardSelected();
  } else {
    selectedTileId = tileId;
    render();
  }
}

function discardSelected() {
  if (selectedTileId == null) return;
  socket.emit('discard', { tileId: selectedTileId });
  selectedTileId = null;
}

// Win/claim button logic uses the shared rules engine (window.Mahjong, served
// from mahjong.js) — see Mahjong.checkWin / getValidClaims / getChowOptions above.

// ── Action bubbles (chat itself is handled by the shared chat.js / window.MahjongChat) ──
// Float a short-lived bubble over the acting player's seat. Lives in a separate
// overlay layer so the next board render() (which clears player areas) can't wipe it.
function showActionBubble(seat, type, tiles) {
  if (gameState == null || myIndex == null) return;
  const n = gameState.players.length;
  const posList = ['bottom', 'right', 'top', 'left'];
  const rel = (((seat - myIndex) % n) + n) % n;
  // The local seat (rel 0) no longer has a #player-bottom cell — its hand lives in the
  // #dock, so anchor our own action bubble there. Opponents still anchor to their seat.
  const area = document.getElementById(`player-${posList[rel]}`) || document.getElementById('dock');
  const layer = document.getElementById('bubble-layer');
  if (!area || !layer) return;

  const r = area.getBoundingClientRect();
  const bubble = document.createElement('div');
  bubble.className = 'action-bubble';
  const glyphs = (tiles || []).map(tileGlyph).join('');
  bubble.textContent = `${MahjongChat.ACTION_LABELS[type] || type} ${glyphs}`;
  bubble.style.left = (r.left + r.width / 2) + 'px';
  bubble.style.top = (r.top + 8) + 'px';
  layer.appendChild(bubble);
  setTimeout(() => bubble.remove(), 2500);
}
