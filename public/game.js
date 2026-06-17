const socket = io();

let myIndex = null;
let roomCode = null;
let gameState = null;
let selectedTileId = null;
let claimTimerInterval = null;
let claimResponded = false;

// ── Bootstrap ────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const stored = JSON.parse(sessionStorage.getItem('mahjong') || '{}');
  roomCode = stored.code;

  if (!stored.code || !stored.token) {
    window.location.href = '/';
    return;
  }

  // Re-attach this fresh socket to our seat (also covers reconnects mid-game)
  const doRejoin = () => {
    const s = JSON.parse(sessionStorage.getItem('mahjong') || '{}');
    if (s.code && s.token) socket.emit('rejoin', { code: s.code, token: s.token });
  };
  socket.on('connect', doRejoin);
  if (socket.connected) doRejoin();

  document.getElementById('btn-win').addEventListener('click', () => socket.emit('declareWin'));
  document.getElementById('btn-discard').addEventListener('click', discardSelected);
  document.getElementById('btn-new-game').addEventListener('click', () => socket.emit('newGame'));
  document.getElementById('btn-lobby').addEventListener('click', () => { window.location.href = '/'; });
  initChat();
});

// ── Socket events ────────────────────────────────────────────────────────────
socket.on('rejoined', ({ playerIndex, state }) => {
  myIndex = playerIndex;
  const stored = JSON.parse(sessionStorage.getItem('mahjong') || '{}');
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
  gameState = state;
  if (state.playerIndex != null) myIndex = state.playerIndex;
  // Reset response tracking when entering/leaving a claim or rob window
  const respondable = ph => ph === 'claim' || ph === 'rob';
  if (respondable(state.phase) !== respondable(prevPhase)) claimResponded = false;
  render();
});

socket.on('gameOver', (result) => {
  const { type, winner, winnerName, discarderName } = result;
  if (gameState) { gameState.phase = 'over'; render(); }
  const msg = type === 'draw'   ? 'Draw — no more tiles in the wall.' :
              type === 'tsumo'  ? `${winnerName} wins by self-draw! 🎉` :
                                  `${winnerName} wins by Ron${discarderName ? ' off ' + discarderName : ''}! 🎉`;
  document.getElementById('game-over-msg').textContent = msg;
  renderScoreDetail(result);
  document.getElementById('game-over').classList.remove('hidden');
  document.getElementById('btn-new-game').classList.toggle('hidden', winner === null);
});

socket.on('backToLobby', () => { window.location.href = '/'; });

socket.on('playerDisconnected', ({ name }) => {
  setStatus(`${name} disconnected`, 'waiting');
});

// Rejected action (e.g. trying to win below the faan minimum).
socket.on('actionError', msg => setStatus(typeof msg === 'string' ? msg : 'Action not allowed', 'waiting'));

// ── Tile helpers ─────────────────────────────────────────────────────────────
function tileGlyph(tile) {
  if (!tile || tile === 'back') return '🀫'; // 🀫
  if (tile.suit === 'man')    return String.fromCodePoint(0x1F007 + tile.value - 1);
  if (tile.suit === 'bam')    return String.fromCodePoint(0x1F010 + tile.value - 1);
  if (tile.suit === 'pin')    return String.fromCodePoint(0x1F019 + tile.value - 1);
  if (tile.suit === 'wind')   return { east:'🀀', south:'🀁', west:'🀂', north:'🀃' }[tile.value];
  if (tile.suit === 'dragon') return { red:'🀄', green:'🀅', white:'🀆' }[tile.value];
  if (tile.suit === 'flower') return ['🀢','🀣','🀤','🀥','🀦','🀧','🀨','🀩'][tile.value - 1];
  return '?';
}

function tileLabel(tile) {
  if (!tile || tile === 'back') return '';
  if (tile.suit === 'man')    return tile.value + 'm';
  if (tile.suit === 'pin')    return tile.value + 'p';
  if (tile.suit === 'bam')    return tile.value + 'b';
  if (tile.suit === 'wind')   return { east:'東', south:'南', west:'西', north:'北' }[tile.value];
  if (tile.suit === 'dragon') return { red:'中', green:'發', white:'白' }[tile.value];
  if (tile.suit === 'flower') return 'F' + tile.value;
  return '';
}

function tileCssClass(tile) {
  if (!tile || tile === 'back') return 'tile-back';
  if (tile.suit === 'man')    return 'tile-man';
  if (tile.suit === 'pin')    return 'tile-pin';
  if (tile.suit === 'bam')    return 'tile-bam';
  if (tile.suit === 'wind')   return 'tile-wind';
  if (tile.suit === 'dragon') return `tile-dragon-${tile.value}`;
  if (tile.suit === 'flower') return 'tile-flower';
  return '';
}

function makeTile(tile, { small = false, selected = false, clickable = false, highlight = false, onClick = null } = {}) {
  const el = document.createElement('div');
  el.className = ['tile', tileCssClass(tile), small && 'sm', selected && 'selected', clickable && 'clickable', highlight && 'last-discard'].filter(Boolean).join(' ');
  if (tile !== 'back' && tile) el.title = tileLabel(tile);

  const g = document.createElement('span');
  g.className = 'tile-glyph';
  g.textContent = tileGlyph(tile);
  el.appendChild(g);

  if (tile && tile !== 'back') {
    const l = document.createElement('span');
    l.className = 'tile-label';
    l.textContent = tileLabel(tile);
    el.appendChild(l);
  }

  if (onClick) el.addEventListener('click', onClick);
  return el;
}

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

  // Player areas
  renderArea('bottom', atPos.bottom, s, true);
  renderArea('right',  atPos.right,  s, false);
  renderArea('top',    atPos.top,    s, false);
  renderArea('left',   atPos.left,   s, false);

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
  el.textContent = s.roundWind ? `Round: ${WIND_CN[s.roundWind]} ${WIND_EN[s.roundWind]}` : '';
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
    head.innerHTML =
      `<span class="score-faan">${score.faan} 番</span>` +
      (score.isLimit ? '<span class="score-limit">LIMIT</span>' : '') +
      `<span class="score-points">${score.points} pts</span>`;
    el.appendChild(head);

    if (score.breakdown?.length) {
      const ul = document.createElement('ul');
      ul.className = 'score-breakdown';
      score.breakdown.forEach(b => {
        const cnt = b.count ? ` ×${b.count}` : '';
        const li = document.createElement('li');
        li.innerHTML = `<span>${b.name}${cnt} <span class="score-cn">${b.cn}</span></span><span class="score-b-faan">${b.limit ? 'LIMIT' : '+' + b.faan}</span>`;
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

// ── Player area ──────────────────────────────────────────────────────────────
function renderArea(position, pIdx, s, isMe) {
  const el = document.getElementById(`player-${position}`);
  if (!el) return;
  if (pIdx === undefined) { el.innerHTML = ''; return; }

  const p = s.players[pIdx];
  const isTurn = s.currentTurn === pIdx;

  el.innerHTML = '';
  el.className = `player-area player-${position}${isTurn ? ' active-turn' : ''}`;

  // Name row
  const nameRow = document.createElement('div');
  nameRow.className = 'player-name';
  const windMap = { east:'東', south:'南', west:'西', north:'北' };
  nameRow.innerHTML = `<span>${p.isBot ? '🤖 ' : ''}${escapeHtml(p.name)}</span><span class="seat-wind">${windMap[p.seatWind]}</span><span class="player-points" title="Session score">${p.points ?? 0}</span>`;
  if (isTurn) nameRow.innerHTML += '<span class="turn-indicator">▶</span>';
  if (!isMe) nameRow.innerHTML += `<span class="hand-count">(${p.handCount})</span>`;
  el.appendChild(nameRow);

  // Flowers
  if (p.flowers?.length) {
    const row = document.createElement('div');
    row.className = 'player-flowers';
    p.flowers.forEach(f => row.appendChild(makeTile(f, { small: true })));
    el.appendChild(row);
  }

  // Melds
  if (p.melds?.length) {
    const meldsEl = document.createElement('div');
    meldsEl.className = 'player-melds';
    p.melds.forEach(meld => {
      const meldEl = document.createElement('div');
      meldEl.className = 'meld';
      const tiles = (meld.type === 'concealed-kong' && !isMe)
        ? ['back', meld.tiles[1], meld.tiles[2], 'back']
        : meld.tiles;
      tiles.forEach(t => meldEl.appendChild(makeTile(t, { small: true })));
      meldsEl.appendChild(meldEl);
    });
    el.appendChild(meldsEl);
  }

  // Hand tiles
  const handEl = document.createElement('div');
  handEl.className = 'player-hand';

  if (isMe && p.hand) {
    const canDiscard = s.phase === 'discard' && s.currentTurn === myIndex;
    p.hand.forEach(tile => {
      handEl.appendChild(makeTile(tile, {
        selected:  tile.id === selectedTileId,
        clickable: canDiscard,
        onClick:   canDiscard ? () => handleTileClick(tile.id) : null,
      }));
    });
  } else {
    // Show backs
    for (let i = 0; i < p.handCount; i++) handEl.appendChild(makeTile('back', { small: position !== 'top' }));
  }

  el.appendChild(handEl);
}

// ── Discard pile ─────────────────────────────────────────────────────────────
function renderDiscards(s) {
  const el = document.getElementById('discard-pile');
  el.innerHTML = '';
  s.discardPile.slice(-40).forEach((tile, i, arr) => {
    const isLast = i === arr.length - 1 && s.phase === 'claim';
    el.appendChild(makeTile(tile, { small: true, highlight: isLast }));
  });
  // Last action label
  const la = document.getElementById('last-action');
  la.textContent = s.lastDiscard ? `Last: ${tileLabel(s.lastDiscard)}` : '';
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
    if (Mahjong.checkWin(me.hand, me.melds)) btnWin.classList.remove('hidden');

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
    const claims = Mahjong.getValidClaims(me.hand, me.melds, s.lastDiscard, isNext);

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
    if (Mahjong.checkWin([...me.hand, s.robKong.tile], me.melds)) {
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
  claimPanel.innerHTML = '<span class="claim-sent">✓ Response sent</span>';
  if (sp) sp.innerHTML = '';
}

// ── Claim timer ──────────────────────────────────────────────────────────────
function updateTimer(s) {
  if (claimTimerInterval) { clearInterval(claimTimerInterval); claimTimerInterval = null; }
  const wrap = document.getElementById('claim-timer');
  const bar  = document.getElementById('claim-timer-bar');
  if ((s.phase !== 'claim' && s.phase !== 'rob') || !s.claimDeadline) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  const total = 8000;
  const tick = () => {
    const left = Math.max(0, s.claimDeadline - Date.now());
    bar.style.width = (left / total * 100) + '%';
    bar.style.background = left < 2000 ? '#f44336' : left < 4000 ? '#ff9800' : '#f0c040';
    if (left <= 0) { clearInterval(claimTimerInterval); claimTimerInterval = null; }
  };
  tick();
  claimTimerInterval = setInterval(tick, 80);
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

// ── Chat & action bubbles ─────────────────────────────────────────────────────
const CHAT_EMOJIS = ['👍','😂','🎉','😮','😢','🔥','👏','🤔','🙏','🀄'];
const ACTION_LABELS = { pong: 'Pong 碰', kong: 'Kong 槓', chow: 'Chow 上' };

function chatLineEl(entry) {
  const div = document.createElement('div');
  if (entry.kind === 'action') {
    div.className = 'chat-msg chat-action';
    const tiles = (entry.tiles || []).map(tileGlyph).join('');
    div.textContent = `${entry.name}: ${ACTION_LABELS[entry.type] || entry.type} ${tiles}`;
  } else {
    div.className = 'chat-msg';
    const nm = document.createElement('span');
    nm.className = 'chat-name';
    nm.textContent = entry.name + ': ';
    const tx = document.createElement('span');
    tx.textContent = entry.text; // textContent → no HTML injection from chat
    div.append(nm, tx);
  }
  return div;
}

function appendChat(entry) {
  const log = document.getElementById('chat-log');
  if (!log) return;
  log.appendChild(chatLineEl(entry));
  log.scrollTop = log.scrollHeight;
}

function sendChat() {
  const input = document.getElementById('chat-input');
  if (input.value.trim()) socket.emit('chat', { text: input.value });
  input.value = '';
}

// Float a short-lived bubble over the acting player's seat. Lives in a separate
// overlay layer so the next board render() (which clears player areas) can't wipe it.
function showActionBubble(seat, type, tiles) {
  if (gameState == null || myIndex == null) return;
  const n = gameState.players.length;
  const posList = ['bottom', 'right', 'top', 'left'];
  const rel = (((seat - myIndex) % n) + n) % n;
  const area = document.getElementById(`player-${posList[rel]}`);
  const layer = document.getElementById('bubble-layer');
  if (!area || !layer) return;

  const r = area.getBoundingClientRect();
  const bubble = document.createElement('div');
  bubble.className = 'action-bubble';
  const glyphs = (tiles || []).map(tileGlyph).join('');
  bubble.textContent = `${ACTION_LABELS[type] || type} ${glyphs}`;
  bubble.style.left = (r.left + r.width / 2) + 'px';
  bubble.style.top = (r.top + 8) + 'px';
  layer.appendChild(bubble);
  setTimeout(() => bubble.remove(), 2500);
}

function initChat() {
  const bar = document.getElementById('emoji-bar');
  CHAT_EMOJIS.forEach(e => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emoji-btn';
    b.textContent = e;
    b.addEventListener('click', () => socket.emit('chat', { text: e }));
    bar.appendChild(b);
  });
  document.getElementById('chat-send').addEventListener('click', sendChat);
  document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
  const widget = document.getElementById('chat-widget');
  document.getElementById('chat-toggle').addEventListener('click', () => widget.classList.toggle('collapsed'));
}

socket.on('chatHistory', (msgs) => {
  const log = document.getElementById('chat-log');
  if (!log) return;
  log.innerHTML = '';
  (msgs || []).forEach(appendChat);
});
socket.on('chatMessage', appendChat);
socket.on('playerAction', (entry) => {
  appendChat(entry);
  showActionBubble(entry.seat, entry.type, entry.tiles);
});
