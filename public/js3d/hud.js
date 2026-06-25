// hud.js — the 2D DOM overlay for the first-person 3D mahjong client.
//
// Responsibilities (contract §5.10):
//   • Center reticle (a crosshair the camera aims; input.js raycasts through it).
//   • Top status banner + wall counter + round-wind line.
//   • Countdown clock embedded in the shared discard controller panel (claim window + turn clock).
//   • Action button bar (Win / Discard / Pong / Kong / Chow / Pass / added-kong),
//     reticle- and hotkey-driven but ALSO clickable, computed from gameState via the
//     shared rules-client — affordances identical to game.js's renderActions().
//   • The "look-away" 2D hand fallback strip: when the player yaws away from the rack
//     so their physical tiles leave the camera frustum, fade in a bottom hand strip.
//   • Game-over overlay (hand result + faan breakdown + payments) and match standings,
//     with Next Hand (host) / Vote to End / Lobby buttons.
//
// It READS state (the state.store snapshot) and CALLS THE SAME ACTION EMITS that
// game.js used — gameplay actions go straight through net.* (mirroring game.js's
// direct socket.emit), while the three lobby-style buttons (next hand / vote / lobby)
// are routed through the onHudButton callback that main.js owns. This keeps the emit
// vocabulary identical to the 2D client and the orchestrator's routeHudButton.
//
// Imports are limited to the data hub (state), the transport (net), the pure
// rules-client, and audio (WebAudio click feedback) — never Three.js. The HUD
// never touches the WebGL scene directly.

import * as net   from '/js3d/net.js';
import * as state from '/js3d/state.js';
import * as audio from '/js3d/audio.js';
import {
  checkWin,
  getValidClaims,
  getChowOptions,
  tileLabel,
  tileGlyph,
  tileImageSrc,
} from '/shared/rules-client.js';
import { buildHandDock } from '/shared/hand-render.js';
import { liveClock, currentDiscard, localClaim } from '/shared/indicator-core.js';
import { makeDiscardController } from '/shared/indicator-dom.js';

// ── Module constants ─────────────────────────────────────────────────────────
// Seat-position labels in relative order (0 near, 1 right, 2 across, 3 left) — used
// only to roughly anchor 2D action bubbles toward the matching screen edge, since the
// HUD has no access to the 3D projection. Mirrors game.js's posList ordering.
const REL_POS = ['bottom', 'right', 'top', 'left'];

// Wind glyphs / English names for the round-wind line (mirrors game.js).
const WIND_CN = { east: '東', south: '南', west: '西', north: '北' };
const WIND_EN = { east: 'East', south: 'South', west: 'West', north: 'North' };

// Action bubble labels (same set chat.js exposes as ACTION_LABELS).
const ACTION_LABELS = { pong: 'Pong 碰', kong: 'Kong 槓', chow: 'Chow 上' };

const MEDALS = ['🥇', '🥈', '🥉'];

// ── Module state ─────────────────────────────────────────────────────────────
let initialized = false;

// Cached DOM handles (resolved once in initHud).
const dom = {
  reticle: null,
  status: null,
  actionBar: null,
  dock: null,
  gameOver: null,
  magnify: null,
  dice: null,
};

// Sub-elements built inside the containers above.
let el = {};            // map of built widgets keyed by name

// Shared discard controller (reveal + min-dwell + claim upgrade).
let discardCtl = null;

// Between-hands votes (Next Hand / End Match) — mutually-exclusive toggles. The server
// reports authoritative tallies via next/endVoteUpdate; we mirror our own pick so each
// button shows ✓ and the right (voted/needed) ratio. voteSink → main.routeAction.
let myNextVote = false;
let myEndVote = false;
let nextTally = null;
let endTally = null;
let voteSink = null;

// HUD button sink registered by main.js (routeHudButton). Receives a string id for
// the three lobby-style buttons; gameplay buttons emit directly through net.*.
let hudButtonSink = null;

// Id of the hand tile the reticle hover-magnify is currently showing (null = hidden), so
// updateMagnify only touches the DOM when the hovered tile changes.
let lastMagnifyId = null;

// ── Public: registration of the button sink ──────────────────────────────────
// onHudButton(cb): main.js wires this to routeHudButton. Only the 'lobby' button routes
// through it now; the two votes go through onVote (below) and gameplay actions emit direct.
export function onHudButton(cb) {
  hudButtonSink = cb;
}

function fireHudButton(id) {
  if (typeof hudButtonSink === 'function') hudButtonSink(id);
}

// onVote(cb): main.js wires this so the two toggle votes emit with their boolean value.
export function onVote(cb) { voteSink = cb; }
function emitVote(kind, value) { if (typeof voteSink === 'function') voteSink(kind, value); }

// ── initHud(): build/locate the overlay DOM ──────────────────────────────────
// game3d.html ships the empty containers (#hud-reticle, #hud-status,
// #hud-action-bar, #hud-dock, #hud-game-over). We populate each and inject a
// self-contained <style> block (style.css is not loaded by the 3D page, by design).
export function initHud() {
  if (initialized) return;
  initialized = true;

  injectStyles();

  dom.reticle    = document.getElementById('hud-reticle');
  dom.status     = document.getElementById('hud-status');
  dom.actionBar  = document.getElementById('hud-action-bar');
  dom.dock       = document.getElementById('hud-dock');
  dom.gameOver   = document.getElementById('hud-game-over');

  buildReticle();
  buildStatus();
  buildActionBar();
  buildGameOver();
  buildMagnify();
  buildDiscard();
  buildDiceDisplay();
}

// ── DOM builders ─────────────────────────────────────────────────────────────

function buildReticle() {
  // A simple crosshair dot + thin ring. Pointer-events stay off (set in page CSS).
  dom.reticle.innerHTML = '';
  const dot = document.createElement('div');
  dot.className = 'reticle-dot';
  dom.reticle.appendChild(dot);
}

function buildStatus() {
  dom.status.innerHTML = '';
  // Status banner line.
  el.statusLine = document.createElement('div');
  el.statusLine.className = 'hud-status-line waiting';
  // Secondary line: wall counter + round wind.
  el.statusMeta = document.createElement('div');
  el.statusMeta.className = 'hud-status-meta';
  el.wallInfo = document.createElement('span');
  el.wallInfo.className = 'hud-wall';
  el.roundWind = document.createElement('span');
  el.roundWind.className = 'hud-round-wind';
  el.statusMeta.append(el.wallInfo, el.roundWind);
  dom.status.append(el.statusLine, el.statusMeta);
}

function buildActionBar() {
  dom.actionBar.innerHTML = '';
  // Two stacked panels matching game.js: self-panel (own-turn actions) and
  // claim-panel (respond-to-discard actions). Both populated in render().
  el.selfPanel = document.createElement('div');
  el.selfPanel.className = 'hud-panel hud-self-panel hud-interactive';
  el.claimPanel = document.createElement('div');
  el.claimPanel.className = 'hud-panel hud-claim-panel hud-interactive';
  dom.actionBar.append(el.claimPanel, el.selfPanel);
}

function buildGameOver() {
  dom.gameOver.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'hud-over-card hud-interactive';

  el.overTitle = document.createElement('h2');
  el.overTitle.className = 'hud-over-title';
  el.overMsg = document.createElement('p');
  el.overMsg.className = 'hud-over-msg';
  el.overDetail = document.createElement('div');
  el.overDetail.className = 'hud-over-detail';
  el.overStandings = document.createElement('div');
  el.overStandings.className = 'hud-over-standings hidden';

  const btnRow = document.createElement('div');
  btnRow.className = 'hud-over-buttons';

  el.btnNextHand = makeVoteButton('hud-next-hand', 'Next Hand', toggleNextVote);
  el.nextCount = el.btnNextHand.querySelector('.hud-vote-count');

  el.btnVoteEnd = makeVoteButton('hud-vote-end', 'End Match', toggleEndVote);
  el.endCount = el.btnVoteEnd.querySelector('.hud-vote-count');

  el.btnLobby = document.createElement('button');
  el.btnLobby.className = 'hud-over-btn hud-lobby';
  el.btnLobby.textContent = 'Return to Lobby';
  el.btnLobby.addEventListener('click', () => fireHudButton('lobby'));

  btnRow.append(el.btnNextHand, el.btnVoteEnd, el.btnLobby);
  card.append(el.overTitle, el.overMsg, el.overDetail, el.overStandings, btnRow);
  dom.gameOver.appendChild(card);
  dom.gameOver.style.display = 'none';
}

// A game-over vote button: a label stacked over a live "voted/needed" count.
function makeVoteButton(cls, label, onClick) {
  const btn = document.createElement('button');
  btn.className = `hud-over-btn ${cls} hud-vote-btn`;
  const lab = document.createElement('span'); lab.className = 'hud-vote-label'; lab.textContent = label;
  const cnt = document.createElement('span'); cnt.className = 'hud-vote-count';
  btn.append(lab, cnt);
  btn.addEventListener('click', onClick);
  return btn;
}

// Floating large tile-face shown when the reticle is over an own hand tile — an instant
// zoom like holding Alt in Tabletop Simulator (task 6). Driven per-frame by updateMagnify.
function buildMagnify() {
  dom.magnify = document.createElement('img');
  dom.magnify.id = 'hud-magnify';
  dom.magnify.className = 'hud-magnify';
  dom.magnify.alt = '';
  dom.magnify.draggable = false;
  document.getElementById('hud').appendChild(dom.magnify);
}

// ── Discard graphic (shared controller) ──────────────────────────────────────
// Reveal + min-dwell + claim upgrade handled by makeDiscardController from indicator-dom.

function buildDiscard() {
  discardCtl = makeDiscardController();
  document.getElementById('hud').appendChild(discardCtl.el);
}

// ── Dice-roll readout (the dealer's opening roll; deal.js drives it) ──────────
function buildDiceDisplay() {
  dom.dice = document.createElement('div');
  dom.dice.id = 'hud-dice';
  dom.dice.className = 'hud-dice';
  document.getElementById('hud').appendChild(dom.dice);
}

// showDiceRoll(vals): show the dealer's rolled dice + sum on screen (called from deal.js).
export function showDiceRoll(vals) {
  if (!initialized) initHud();
  if (!dom.dice) return;
  const arr = Array.isArray(vals) ? vals : [];
  const sum = arr.reduce((a, b) => a + (b || 0), 0);
  dom.dice.innerHTML =
    '<span class="hud-dice-label">🎲 Dealer rolls</span>' +
    `<span class="hud-dice-vals">${arr.join(' · ')}</span>` +
    `<span class="hud-dice-sum">= ${sum}</span>`;
  dom.dice.style.opacity = '1';
}

// hideDiceRoll(): fade the dice readout away (called when the roll animation ends / is skipped).
export function hideDiceRoll() {
  if (dom.dice) dom.dice.style.opacity = '0';
}

// updateDiscardGraphic(store): called from render() each gameUpdate. Drives the shared
// discard controller (reveal + min-dwell + claim/rob upgrade). The reaction-window
// affordance (win > kong > pong > unambiguous chow) is the shared localClaim helper.
function updateDiscardGraphic(store) {
  if (!discardCtl) return;
  const s = store.gameState; if (!s) return;
  if (s.phase === 'over') { discardCtl.hide(); return; }   // no stale tile at game over

  const me = (store.myIndex != null && s.players) ? s.players[store.myIndex] : null;
  let tile = null, caption = '', claim = null;
  if (s.phase === 'rob' && s.robKong) {
    tile = s.robKong.tile;
    caption = `${nameAt(s, s.robKong.seat) || ''} kong`;
    const canRob = s.robKong.seat !== store.myIndex && !store.claimResponded && me?.hand
      && checkWin([...me.hand, s.robKong.tile], me.melds, s.ruleset);
    claim = canRob
      ? { clock: liveClock(s), action: { type: 'win', tileIds: [] },
          onClaim: () => { net.emitClaim('win', []); audio.playTileClick(); respond(); } }
      : { clock: liveClock(s) };   // everyone sees the countdown; only the eligible seat can act
  } else {
    tile = currentDiscard(s);
    const who = (s.lastDiscardPlayer === store.myIndex) ? 'You'
              : (s.lastDiscardPlayer != null ? nameAt(s, s.lastDiscardPlayer) : '');
    caption = tile ? `${who} discarded` : '';
    if (tile && !store.claimResponded && me?.hand) {
      const lc = localClaim(s, store.myIndex, getValidClaims, getChowOptions);
      if (lc.action) claim = { clock: liveClock(s), action: lc.action,
        onClaim: () => { net.emitClaim(lc.action.type, lc.action.tileIds); audio.playTileClick(); respond(); } };
      else if (lc.ambiguous) claim = { clock: liveClock(s), ambiguous: true };  // tap → flare; use buttons
    }
  }
  discardCtl.update({ tile, tileId: tile ? tile.id : null, caption, claim });
}

// ── render(store): per-update HUD refresh ────────────────────────────────────
// Called by main.js's state.subscribe after every applyGameUpdate. Reads the live
// store (gameState + myIndex + claimResponded) and rebuilds status / wall /
// action buttons. A fresh gameUpdate also means a new hand is in progress → clear any
// leftover game-over overlay (mirrors game.js's gameUpdate handler).
export function render(store) {
  if (!initialized) initHud();
  const s = store.gameState;
  if (!s) return;

  // A live gameState (and not the client-only 'over' phase) means play resumed —
  // hide the game-over overlay if it was showing and reset our local vote mirror.
  if (s.phase !== 'over' && dom.gameOver.style.display !== 'none') {
    dom.gameOver.style.display = 'none';
    resetVotes();
  }

  updateStatus(store);
  updateWallAndWind(s);
  renderActions(store);
  updateDiscardGraphic(store);
  renderDock(store);
}

// Status banner text/colour, identical wording to game.js's updateStatus().
function updateStatus(store) {
  const s = store.gameState;
  const myIndex = store.myIndex;
  if (s.phase === 'over') return;

  const isMe = s.currentTurn === myIndex;
  let text, cls;
  if (s.phase === 'discard') {
    text = isMe ? 'Your turn — aim at a tile and discard' : `${nameAt(s, s.currentTurn)}'s turn`;
    cls  = isMe ? 'my-turn' : 'waiting';
  } else if (s.phase === 'claim') {
    text = `${nameAt(s, s.lastDiscardPlayer)} discarded`;
    cls  = 'claiming';
  } else if (s.phase === 'rob') {
    const declarer = s.robKong ? nameAt(s, s.robKong.seat) : '';
    text = s.robKong && s.robKong.seat === myIndex
      ? 'Adding kong — others may rob…'
      : `${declarer} is adding a kong — rob?`;
    cls  = 'claiming';
  } else {
    text = '…'; cls = 'waiting';
  }
  setStatus(text, cls);
}

// setStatus(text[, cls]): set the banner. Exposed for main.js (disconnect/error banners).
export function setStatus(text, cls = 'waiting') {
  if (!initialized) initHud();
  el.statusLine.textContent = text;
  el.statusLine.className = `hud-status-line ${cls}`;
}

function updateWallAndWind(s) {
  el.wallInfo.textContent = `Wall: ${s.wallCount}`;
  if (!s.roundWind) { el.roundWind.textContent = ''; return; }
  let txt = `${WIND_CN[s.roundWind]} ${WIND_EN[s.roundWind]} Round`;
  if (s.handNumber) txt += ` · Hand ${s.handNumber}`;
  if (s.dealerStreak) txt += ` · 連莊 ×${s.dealerStreak}`;
  el.roundWind.textContent = txt;
}

// ── Action buttons (affordances identical to game.js renderActions) ──────────
// Computed from gameState via the shared rules-client so the panel always matches the
// server's re-validation. Gameplay actions emit straight through net.* (mirroring
// game.js's direct socket.emit) and lock the claim panel via state.setClaimResponded.
function renderActions(store) {
  const s = store.gameState;
  const myIndex = store.myIndex;
  el.selfPanel.innerHTML = '';
  el.claimPanel.innerHTML = '';

  const me = (myIndex != null && s.players) ? s.players[myIndex] : null;
  if (!me) return;

  // ── My own discard turn: Win / Discard / concealed-kong / added-kong ──
  if (s.phase === 'discard' && s.currentTurn === myIndex && me.hand) {
    // Self-draw win (tsumo).
    if (checkWin(me.hand, me.melds, s.ruleset)) {
      el.selfPanel.appendChild(actionButton('🏆 Win!', 'win', () => {
        net.emitDeclareWin();
      }));
    }

    // Discard the currently-selected hand tile (the reticle/hotkey selection lives in
    // input.js; we expose a Discard button that targets whatever input has selected).
    // We read the selection from input via a custom event hook set on the document by
    // input.js (window.__hud_selectedTileId), falling back to a no-op if unset. This
    // keeps HUD decoupled from input.js's internals while still offering a click path.
    const selId = getSelectedTileId();
    if (selId != null) {
      const selTile = me.hand.find(t => t.id === selId);
      const lbl = selTile ? `Discard ${tileLabel(selTile)}` : 'Discard';
      el.selfPanel.appendChild(actionButton(lbl, 'discard', () => {
        // Read the selection LIVE at click time — input.js updates it every frame
        // without re-rendering the HUD — and re-validate it is still in hand, so a
        // stale render-time capture can't discard the wrong (or a gone) tile.
        const liveId = getSelectedTileId();
        const hand = state.localHand();
        if (liveId == null || !hand.some(t => t.id === liveId)) return;
        net.emitDiscard(liveId);
        audio.playTileClick();
      }));
    }

    // Concealed kong: any suit:value group of 4 in hand → declareKong {group[0].id}.
    const groups = {};
    me.hand.forEach(t => { const k = `${t.suit}:${t.value}`; (groups[k] = groups[k] || []).push(t); });
    Object.values(groups).forEach(grp => {
      if (grp.length === 4) {
        el.selfPanel.appendChild(actionButton(`Kong ${tileLabel(grp[0])}`, 'kong', () => {
          net.emitDeclareKong(grp[0].id);
        }));
      }
    });

    // Added kong (加槓): upgrade an exposed pong with the matching 4th hand tile.
    (me.melds || []).forEach(meld => {
      if (meld.type !== 'pong') return;
      const t = me.hand.find(h => h.suit === meld.tiles[0].suit && h.value === meld.tiles[0].value);
      if (!t) return;
      el.selfPanel.appendChild(actionButton(`Kong ➕ ${tileLabel(t)}`, 'kong', () => {
        net.emitDeclareAddedKong(t.id);
      }));
    });
  }

  // ── Claim window (someone else discarded) ──
  if (s.phase === 'claim' && s.lastDiscardPlayer !== myIndex && !store.claimResponded && me.hand) {
    const n = s.players.length;
    const isNext = (s.lastDiscardPlayer + 1) % n === myIndex;
    const claims = getValidClaims(me.hand, me.melds, s.lastDiscard, isNext, s.ruleset);

    claims.forEach(type => {
      if (type === 'chow') {
        // One button per chow option; tileIds = the two FROM-HAND tiles (discard excluded).
        getChowOptions(me.hand, s.lastDiscard).forEach(opt => {
          const fromHand = opt.filter(t => t !== s.lastDiscard);
          el.claimPanel.appendChild(actionButton(
            `Chow ${fromHand.map(tileLabel).join('+')}`, 'chow', () => {
              net.emitClaim('chow', fromHand.map(t => t.id));
              respond();
            }));
        });
      } else {
        const label = type === 'win' ? '🏆 Win!' : type[0].toUpperCase() + type.slice(1);
        el.claimPanel.appendChild(actionButton(label, type, () => {
          net.emitClaim(type, []);
          respond();
        }));
      }
    });

    // Always offer Pass.
    el.claimPanel.appendChild(actionButton('Pass', 'pass', () => {
      net.emitPass();
      respond();
    }));
  }

  // ── Rob-the-kong window ──
  if (s.phase === 'rob' && s.robKong && s.robKong.seat !== myIndex && !store.claimResponded && me.hand) {
    if (checkWin([...me.hand, s.robKong.tile], me.melds, s.ruleset)) {
      el.claimPanel.appendChild(actionButton('🏆 Rob!', 'win', () => {
        net.emitClaim('win', []);
        respond();
      }));
    }
    el.claimPanel.appendChild(actionButton('Pass', 'pass', () => {
      net.emitPass();
      respond();
    }));
  }
}

// Lock the claim panel after a claim/pass/rob response (mirrors game.js's
// markClaimResponded → claimResponded=true). main.js's routeAction also sets this when
// the same action arrives via input.onAction, so a double-set is harmless/idempotent.
function respond() {
  state.setClaimResponded(true);
  el.claimPanel.innerHTML = '<span class="hud-claim-sent">✓ Response sent</span>';
  el.selfPanel.innerHTML = '';
}

// Build a styled action button. `kind` becomes a CSS modifier class for colour.
function actionButton(label, kind, onClick) {
  const btn = document.createElement('button');
  btn.className = `hud-action-btn hud-action-${kind}`;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

// Read the currently reticle/hotkey-selected hand tile id, if input.js published one.
// input.js (parallel module) sets window.__hud_selectedTileId; we tolerate its absence.
function getSelectedTileId() {
  const v = window.__hud_selectedTileId;
  return (v === undefined || v === null) ? null : v;
}

// ── Always-on hand dock ──────────────────────────────────────────────────────
// Replaces the look-away strip: a permanent bottom inventory bar built by the SAME
// shared buildHandDock + /shared/hand-dock.css the 2D client uses, so the look and
// the lift+spread hover are identical. Clicking a tile publishes the same
// window.__hud_selectedTileId input.js uses; a second click — or the Discard button —
// commits. Rebuilt from the store on each gameUpdate (the cadence the hand changes at).
function renderDock(store) {
  if (!dom.dock) return;
  const s = store.gameState;
  const myIndex = store.myIndex;
  const p = (s && s.players && myIndex != null) ? s.players[myIndex] : null;
  if (!p) { dom.dock.replaceChildren(); return; }
  const selId = (window.__hud_selectedTileId === undefined) ? null : window.__hud_selectedTileId;
  dom.dock.replaceChildren(buildHandDock({
    player: p,
    drawnId: s.drawnId ?? null,
    selectedId: selId,
    canDiscard: s.phase === 'discard' && s.currentTurn === myIndex,
    isTurn: s.currentTurn === myIndex,
    onTileClick: (id) => {
      const st = state.store.gameState, mi = state.store.myIndex;
      const can = st && st.phase === 'discard' && st.currentTurn === mi;
      if (!can) return;
      if (window.__hud_selectedTileId === id) {
        net.emitDiscard(id);
        audio.playTileClick();
        window.__hud_selectedTileId = null;
      } else {
        window.__hud_selectedTileId = id;
      }
      render(state.store); // reflect the new selection in the dock + action bar
    },
    layout: 'bare',   // 3D shows only the hand-tile bar; organize/shuffle live on the o/s keys
  }));
}

// updateMagnify(): per-frame. Show a large floating copy of whatever own hand tile the
// reticle is currently over (window.__hud_hoverTileId, published by input.js) — an instant
// zoom (task 6). Hidden when nothing is hovered. Only touches the DOM on a hovered change.
export function updateMagnify() {
  if (!initialized || !dom.magnify) return;
  const id = (window.__hud_hoverTileId === undefined) ? null : window.__hud_hoverTileId;
  if (id === lastMagnifyId) {
    // Same hovered id — but if that tile just left the hand (e.g. was discarded while the
    // reticle id is briefly stale), stop magnifying it instead of lingering on a gone tile.
    if (id == null) return;
    const h = state.localHand();
    if (h && h.some(t => t.id === id)) return;   // still in hand → nothing to update
    dom.magnify.style.opacity = '0'; lastMagnifyId = null; return;
  }
  if (id == null) { dom.magnify.style.opacity = '0'; lastMagnifyId = null; return; }
  const hand = state.localHand();
  const tile = hand && hand.find(t => t.id === id);
  const src = tile ? tileImageSrc(tile) : null;
  if (!src) { dom.magnify.style.opacity = '0'; lastMagnifyId = null; return; }
  dom.magnify.src = src;
  dom.magnify.style.opacity = '1';
  lastMagnifyId = id;
}

// ── Game-over overlay (hand result) ──────────────────────────────────────────
// showGameOver(result): from the separate gameOver event (contract §2.3). Renders the
// result message + faan breakdown + per-player payments/totals, and shows the right
// buttons (Next Hand for host between hands; Lobby when the match is over).
export function showGameOver(result) {
  if (!initialized) initHud();
  if (!result) return;
  resetVotes();   // a fresh hand-over screen starts with no votes cast

  const { type, winnerName, discarderName } = result;
  const msg =
    type === 'draw'  ? 'Draw — no more tiles in the wall.' :
    type === 'tsumo' ? `${winnerName} wins by self-draw! 🎉` :
                       `${winnerName} wins by Ron${discarderName ? ' off ' + discarderName : ''}!${result.robbed ? ' (robbed the kong)' : ''} 🎉`;

  el.overTitle.textContent = result.matchOver ? '🏁 Match Complete' : 'Hand Over';
  el.overMsg.textContent = msg;
  renderScoreDetail(result);

  if (result.matchOver) {
    renderStandings(result.standings);
    setOverButtons('matchOver');
  } else {
    renderStandings(null);
    setOverButtons('betweenHands');
  }
  dom.gameOver.style.display = 'flex';
}

// showStandings(payload): match ended early by a unanimous vote — { standings, rounds }.
// No fresh hand result, just the final standings + Lobby button.
export function showStandings(payload) {
  if (!initialized) initHud();
  const standings = payload && payload.standings;
  el.overTitle.textContent = '🏁 Match Complete';
  el.overMsg.textContent = 'Match ended by vote.';
  el.overDetail.innerHTML = '';
  renderStandings(standings || null);
  setOverButtons('matchOver');
  dom.gameOver.style.display = 'flex';
}

// Build the faan breakdown + payment summary (mirrors game.js renderScoreDetail).
function renderScoreDetail(result) {
  const root = el.overDetail;
  root.innerHTML = '';
  const { score, payments, totals } = result;
  const players = (state.store.gameState && state.store.gameState.players) || [];

  if (score) {
    const head = document.createElement('div');
    head.className = 'hud-score-head';
    // MCR additive has no faan — its value IS points; HK modes show 番 → pts.
    head.innerHTML = score.mode === 'mcr-additive'
      ? `<span class="hud-score-faan">${score.value} pts</span>`
      : `<span class="hud-score-faan">${score.faan} 番</span>` +
        (score.isLimit ? '<span class="hud-score-limit">LIMIT</span>' : '') +
        `<span class="hud-score-points">${score.points} pts</span>`;
    root.appendChild(head);

    if (score.breakdown && score.breakdown.length) {
      const ul = document.createElement('ul');
      ul.className = 'hud-score-breakdown';
      score.breakdown.forEach(b => {
        const cnt = b.count ? ` ×${b.count}` : '';
        const li = document.createElement('li');
        li.innerHTML =
          `<span>${escapeHtml(b.name)}${cnt} <span class="hud-score-cn">${escapeHtml(b.cn)}</span></span>` +
          `<span class="hud-score-b-faan">${b.limit ? 'LIMIT' : '+' + (b.points != null ? b.points : b.faan)}</span>`;
        ul.appendChild(li);
      });
      root.appendChild(ul);
    }
  }

  // Per-player point change + running session total.
  if (totals && players.length) {
    const tbl = document.createElement('div');
    tbl.className = 'hud-score-totals';
    players.forEach((p, i) => {
      const delta = (payments && payments[i]) || 0;
      const deltaStr = delta
        ? `<span class="${delta > 0 ? 'hud-pay-plus' : 'hud-pay-minus'}">${delta > 0 ? '+' : ''}${delta}</span>`
        : '<span class="hud-pay-zero">·</span>';
      const row = document.createElement('div');
      row.className = 'hud-score-total-row';
      row.innerHTML =
        `<span class="hud-st-name">${p.isBot ? '🤖 ' : ''}${escapeHtml(p.name)}</span>` +
        deltaStr +
        `<span class="hud-score-running">${totals[i]}</span>`;
      tbl.appendChild(row);
    });
    root.appendChild(tbl);
  }
}

// Final standings list (mirrors game.js showFinalStandings).
function renderStandings(standings) {
  const root = el.overStandings;
  if (!standings) { root.classList.add('hidden'); root.innerHTML = ''; return; }
  root.classList.remove('hidden');
  root.innerHTML = '<div class="hud-standings-title">Final Standings</div>';
  standings.forEach(s => {
    const medal = MEDALS[s.rank - 1] || `#${s.rank}`;
    const row = document.createElement('div');
    row.className = 'hud-standings-row' + (s.rank === 1 ? ' hud-standings-leader' : '');
    row.innerHTML =
      `<span class="hud-st-rank">${medal}</span>` +
      `<span class="hud-st-name">${s.isBot ? '🤖 ' : ''}${escapeHtml(s.name)}</span>` +
      `<span class="hud-st-pts ${s.points >= 0 ? 'hud-pay-plus' : 'hud-pay-minus'}">${s.points > 0 ? '+' : ''}${s.points}</span>`;
    root.appendChild(row);
  });
}

// Toggle which game-over buttons are visible (mirrors game.js setOverButtons).
function setOverButtons(mode) {
  if (mode === 'matchOver') {
    el.btnNextHand.classList.add('hidden');
    el.btnVoteEnd.classList.add('hidden');
    el.btnLobby.classList.remove('hidden');
  } else { // betweenHands — both votes shown; each needs EVERY human to agree
    el.btnNextHand.classList.remove('hidden');
    el.btnVoteEnd.classList.remove('hidden');
    el.btnLobby.classList.add('hidden');
    refreshVoteButtons();
  }
}

// Fresh between-hands period: clear our local picks + the cached tallies.
function resetVotes() { myNextVote = false; myEndVote = false; nextTally = null; endTally = null; }

// The two votes are mutually exclusive: picking one clears the other (optimistically;
// the server enforces the same and its tallies are authoritative).
function toggleNextVote() {
  myNextVote = !myNextVote;
  if (myNextVote) myEndVote = false;
  emitVote('nextHandVote', myNextVote);
  refreshVoteButtons();
}
function toggleEndVote() {
  myEndVote = !myEndVote;
  if (myEndVote) myNextVote = false;
  emitVote('endMatchVote', myEndVote);
  refreshVoteButtons();
}

// Authoritative tallies from the server (next/endVoteUpdate).
export function applyNextVote(voted, needed) { if (!initialized) initHud(); nextTally = { voted, needed }; refreshVoteButtons(); }
export function applyEndVote(voted, needed)  { if (!initialized) initHud(); endTally  = { voted, needed }; refreshVoteButtons(); }

function refreshVoteButtons() {
  const players = (state.store.gameState && state.store.gameState.players) || [];
  const humans = players.filter(p => !p.isBot).length;
  setVoteBtn(el.btnNextHand, el.nextCount, myNextVote, nextTally, humans);
  setVoteBtn(el.btnVoteEnd,  el.endCount,  myEndVote,  endTally,  humans);
}
// Show "voted/needed" under each button (✓ when it's your pick) + outline your choice.
function setVoteBtn(btn, countEl, mine, tally, humans) {
  if (!btn || !countEl) return;
  const voted = tally ? tally.voted : (mine ? 1 : 0);
  const needed = tally ? tally.needed : humans;
  countEl.textContent = `${mine ? '✓ ' : ''}${voted}/${needed}`;
  btn.classList.toggle('hud-vote-active', mine);
}

// ── Action bubble over an acting seat (pong/kong/chow) ───────────────────────
// The HUD can't project a 3D point, so we anchor a short-lived bubble toward the screen
// edge matching the actor's RELATIVE seat (near=bottom, right, across=top, left).
// One live bubble per screen edge — a burst replaces rather than stacks overlapping
// nodes, and each bubble's removal timer is tracked so it can be cancelled on replace.
const actionBubbles = {};

export function showActionBubble(absSeat, type, tiles) {
  if (!initialized) initHud();
  if (state.store.myIndex == null) return;

  const rel = state.relativeSeat(absSeat);          // 0 near .. 3 left
  const where = REL_POS[rel] || 'top';
  const glyphs = (tiles || []).map(tileGlyph).join('');

  // Replace any live bubble at this edge (cancel its pending removal first).
  const prev = actionBubbles[where];
  if (prev) { clearTimeout(prev.timer); prev.node.remove(); }

  const bubble = document.createElement('div');
  bubble.className = `hud-action-bubble hud-bubble-${where}`;
  bubble.textContent = `${ACTION_LABELS[type] || type} ${glyphs}`;
  document.getElementById('hud').appendChild(bubble);
  // Fade in then remove (CSS handles the transition; we just toggle a class).
  requestAnimationFrame(() => bubble.classList.add('show'));
  const timer = setTimeout(() => {
    bubble.remove();
    if (actionBubbles[where] && actionBubbles[where].node === bubble) delete actionBubbles[where];
  }, 2500);
  actionBubbles[where] = { node: bubble, timer };
}

// ── Small helpers ─────────────────────────────────────────────────────────────

// Player name at an absolute seat (safe lookups).
function nameAt(s, seat) {
  return (s.players && s.players[seat] && s.players[seat].name) || '';
}

// Escape user-controlled text before innerHTML (player names, score names). Same as game.js.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Styles ────────────────────────────────────────────────────────────────────
// Injected once. style.css is NOT loaded by game3d.html (by design), so the HUD owns
// its own look here. Kept dark/parlor-toned to match the 3D scene and game.html palette.
function injectStyles() {
  if (document.getElementById('hud-styles')) return;
  if (!document.getElementById('hand-dock-css')) {
    const link = document.createElement('link');
    link.id = 'hand-dock-css';
    link.rel = 'stylesheet';
    link.href = '/shared/hand-dock.css';
    document.head.appendChild(link);
  }
  const css = `
  /* ── Reticle ── */
  #hud-reticle .reticle-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: rgba(255,255,255,0.85);
    box-shadow: 0 0 0 2px rgba(0,0,0,0.55), 0 0 6px rgba(0,0,0,0.6);
    position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
  }
  #hud-reticle::before, #hud-reticle::after {
    content: ''; position: absolute; background: rgba(255,255,255,0.45);
    box-shadow: 0 0 2px rgba(0,0,0,0.7);
  }
  #hud-reticle::before { top: 50%; left: 50%; width: 14px; height: 2px; transform: translate(-50%,-50%); }
  #hud-reticle::after  { top: 50%; left: 50%; width: 2px; height: 14px; transform: translate(-50%,-50%); }

  /* ── Status banner ── */
  .hud-status-line {
    font-size: 1.05rem; font-weight: 600;
    padding: 6px 16px; border-radius: 20px;
    background: rgba(0,0,0,0.5); display: inline-block;
    text-shadow: 0 1px 2px rgba(0,0,0,0.8);
  }
  .hud-status-line.my-turn  { color: #b6f0a0; box-shadow: 0 0 0 2px rgba(120,220,90,0.6); }
  .hud-status-line.claiming { color: #ffd27a; box-shadow: 0 0 0 2px rgba(240,180,60,0.6); }
  .hud-status-line.waiting  { color: #d8d2c2; }
  .hud-status-meta {
    margin-top: 6px; font-size: 0.85rem; color: #cabf9f;
    display: flex; gap: 14px; justify-content: center;
    text-shadow: 0 1px 2px rgba(0,0,0,0.8);
  }
  .hud-wall { font-weight: 600; }

  /* ── Action bar ── */
  #hud-action-bar { gap: 8px; padding-bottom: 14px; }
  .hud-panel { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; max-width: 90vw; }
  .hud-action-btn {
    font-size: 0.95rem; font-weight: 700; cursor: pointer;
    padding: 10px 18px; border: none; border-radius: 10px;
    color: #1a1410; background: #e8dcc0;
    box-shadow: 0 2px 6px rgba(0,0,0,0.5);
  }
  .hud-action-btn:hover { filter: brightness(1.08); }
  .hud-action-btn:active { transform: translateY(1px); }
  .hud-action-win   { background: #f0c040; }
  .hud-action-pong  { background: #f0a060; }
  .hud-action-kong  { background: #e08850; }
  .hud-action-chow  { background: #90c0e0; }
  .hud-action-pass  { background: #b8b0a0; }
  .hud-action-discard { background: #a8d890; }
  .hud-claim-sent { color: #b6f0a0; font-weight: 600; padding: 8px 12px; }

  /* Reticle hover-magnify: large floating tile above centre while aiming at an own hand tile. */
  .hud-magnify {
    position: absolute; top: 15%; left: 50%; transform: translateX(-50%);
    width: 132px; height: auto; pointer-events: none; opacity: 0; z-index: 25;
    filter: drop-shadow(0 6px 18px rgba(0,0,0,0.8));
    transition: opacity 0.05s linear;
  }

  /* ── Dice roll readout ── */
  .hud-dice {
    position: absolute; top: 22%; left: 50%; transform: translateX(-50%);
    display: flex; gap: 12px; align-items: baseline;
    padding: 8px 18px; border-radius: 14px;
    background: rgba(20,17,13,0.82); color: #f0e9d8; font-weight: 700;
    box-shadow: 0 4px 16px rgba(0,0,0,0.6);
    opacity: 0; transition: opacity 0.15s ease; pointer-events: none; z-index: 26;
  }
  .hud-dice-vals { font-size: 1.3rem; color: #f0c040; letter-spacing: 2px; }
  .hud-dice-sum { font-size: 1.1rem; color: #b6f0a0; }

  /* ── Game-over / standings overlay ── */
  #hud-game-over { pointer-events: auto; }
  .hud-over-card {
    background: #14110d; color: #f0e9d8;
    border: 1px solid #3a3228; border-radius: 14px;
    padding: 24px 28px; min-width: 320px; max-width: 92vw;
    max-height: 88vh; overflow-y: auto; text-align: center;
    box-shadow: 0 10px 40px rgba(0,0,0,0.7);
  }
  .hud-over-title { font-size: 1.5rem; margin-bottom: 6px; }
  .hud-over-msg { font-size: 1.05rem; margin-bottom: 14px; color: #e8dcc0; }
  .hud-over-detail { text-align: left; margin: 0 auto 14px; max-width: 360px; }
  .hud-score-head { display: flex; gap: 12px; align-items: baseline; justify-content: center; margin-bottom: 10px; }
  .hud-score-faan { font-size: 1.3rem; font-weight: 700; color: #f0c040; }
  .hud-score-limit { font-size: 0.8rem; font-weight: 700; color: #f44336; letter-spacing: 1px; }
  .hud-score-points { font-size: 1rem; color: #cabf9f; }
  .hud-score-breakdown { list-style: none; margin: 0 0 12px; padding: 0; }
  .hud-score-breakdown li { display: flex; justify-content: space-between; padding: 3px 0; font-size: 0.9rem; border-bottom: 1px solid rgba(255,255,255,0.06); }
  .hud-score-cn { color: #b09a6a; }
  .hud-score-b-faan { color: #b6f0a0; font-weight: 600; }
  .hud-score-totals { margin-top: 8px; }
  .hud-score-total-row { display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; padding: 4px 0; font-size: 0.92rem; }
  .hud-score-running { color: #cabf9f; min-width: 40px; text-align: right; }
  .hud-pay-plus { color: #6fd96f; font-weight: 600; }
  .hud-pay-minus { color: #f06f6f; font-weight: 600; }
  .hud-pay-zero { color: #777; }
  .hud-over-standings { margin-bottom: 14px; }
  .hud-standings-title { font-weight: 700; margin-bottom: 8px; color: #f0c040; }
  .hud-standings-row { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; padding: 5px 8px; border-radius: 8px; }
  .hud-standings-leader { background: rgba(240,192,64,0.12); }
  .hud-st-rank { font-size: 1.1rem; }
  .hud-st-name { text-align: left; }
  .hud-over-buttons { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 6px; }
  .hud-over-btn {
    font-size: 0.95rem; font-weight: 700; cursor: pointer;
    padding: 10px 18px; border: none; border-radius: 10px;
    color: #1a1410; background: #e8dcc0;
  }
  .hud-over-btn:hover { filter: brightness(1.08); }
  .hud-next-hand { background: #a8d890; }
  .hud-vote-end { background: #e8dcc0; }
  .hud-lobby { background: #b8b0a0; }
  .hud-vote-btn { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.12; gap: 1px; }
  .hud-vote-btn .hud-vote-count { font-size: 0.72rem; font-weight: 800; opacity: 0.85; font-variant-numeric: tabular-nums; }
  .hud-vote-btn.hud-vote-active { outline: 3px solid #fff; outline-offset: 2px; }

  /* ── Action bubbles ── */
  .hud-action-bubble {
    position: absolute; left: 50%; transform: translateX(-50%) translateY(6px);
    padding: 6px 12px; border-radius: 16px;
    background: rgba(20,17,13,0.92); color: #f0c040;
    font-weight: 700; font-size: 0.95rem; white-space: nowrap;
    box-shadow: 0 2px 8px rgba(0,0,0,0.6);
    opacity: 0; transition: opacity 0.2s ease, transform 0.2s ease;
    pointer-events: none; z-index: 20;
  }
  .hud-action-bubble.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  .hud-bubble-bottom { bottom: 120px; left: 50%; }
  .hud-bubble-top    { top: 80px; left: 50%; }
  .hud-bubble-right  { top: 50%; right: 24px; left: auto; transform: translateY(-50%) translateX(6px); }
  .hud-bubble-right.show { transform: translateY(-50%) translateX(0); }
  .hud-bubble-left   { top: 50%; left: 24px; transform: translateY(-50%) translateX(-6px); }
  .hud-bubble-left.show { transform: translateY(-50%) translateX(0); }

  /* shared hidden helper (HUD-scoped to avoid clashing with page CSS) */
  #hud .hidden { display: none !important; }
  `;
  const style = document.createElement('style');
  style.id = 'hud-styles';
  style.textContent = css;
  document.head.appendChild(style);
}
