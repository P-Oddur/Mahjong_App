// input.js — first-person look control + center-reticle raycast + hotkeys.
//
// Responsibilities (contract §5.9):
//   1. Pointer-lock + mouse-move -> drive camera yaw/pitch (via camera.setLook).
//   2. Per-frame raycast a CENTER reticle into the scene to highlight the current
//      actionable target (own hand tile / 3D HUD button / interactable prop).
//   3. Keyboard hotkeys: number keys select hand tiles, arrows nudge the selection,
//      Enter/Space confirm (discard / claim), and dedicated keys mirror the HUD
//      action buttons (pong/kong/chow/pass/win).
//   4. Compute the local player's affordances each frame from rules-client +
//      gameState (exactly mirroring game.js's renderActions logic), and turn a
//      committed input into one of the EXACT action objects main.js's routeAction
//      understands:
//        { kind:'discard',         tileId }
//        { kind:'declareWin' }
//        { kind:'declareKong',     tileId }
//        { kind:'declareAddedKong',tileId }
//        { kind:'claim', type:'win'|'pong'|'kong'|'chow', tileIds:[...] }
//        { kind:'pass' }
//
// This module owns NO socket and NO Three scene building. It reads:
//   - camera.js   (getLook/setLook) to apply look,
//   - tiles.js    (tileAtReticle) to know which OWN hand tile is under the reticle,
//   - state.js    (store/me/localHand/setClaimResponded) for authoritative state,
//   - rules-client.js (checkWin/getValidClaims/getChowOptions/sortTiles) for
//                  affordance decisions identical to the server's re-validation,
//   - interact.js (handleReticleClick) to let props consume a click first.
//
// It exposes initInput / update / computeAffordances / onAction to main.js.

import * as THREE     from 'three';
import * as camera    from '/js3d/camera.js';
import * as tiles     from '/js3d/tiles.js';
import * as state     from '/js3d/state.js';
import * as interact  from '/js3d/interact.js';
import {
  checkWin,
  getValidClaims,
  getChowOptions,
  sortTiles,
} from '/shared/rules-client.js';

// ── Tunables (labeled so they are trivial to tweak in the browser) ───────────
const MOUSE_SENSITIVITY = 0.0022; // radians of look per pixel of mouse movement
const PITCH_LIMIT       = 1.4;    // ~±80° pitch clamp (camera.setLook also clamps)
const RAYCAST_LAYER     = null;   // null = default layers; reserved for future use
// Cap on how much accumulated mouse motion is applied to the look in ONE frame. Mouse events are
// accumulated and applied per-frame (not per-event), so a buffered BURST of pointer events (e.g.
// after a render hitch) can't snap the view — the excess carries over and slides in over the next
// frames. Generous enough to never hinder a real fast flick (~75° in a single frame here).
const MAX_LOOK_DELTA_PER_FRAME_PX = 600;

// ── Module state ─────────────────────────────────────────────────────────────
let domElement   = null;          // the WebGL canvas (pointer-lock target)
let raycaster    = null;          // reused center-screen raycaster
const reticleNdc = new THREE.Vector2(0, 0); // dead-center of the viewport

// The single sink that converts a committed input into a net.* emit. main.js
// registers this via onAction(); we never import net.js directly.
let actionSink = null;

// Currently-hovered actionable target under the reticle (recomputed each frame).
//   { kind:'tile',        mesh, tileId }
//   { kind:'interactable',mesh }
//   null
let hovered = null;

// The OWN hand tile currently selected (by id) for discard. Mirrors game.js's
// `selectedTileId`. Selection is driven by the reticle (look at a tile) AND by
// number/arrow hotkeys; whichever acted last wins.
let selectedTileId = null;

// Remember the last tile mesh we highlighted so we can clear its highlight when
// the reticle moves off it (tiles.js owns the actual visual; we toggle a flag).
let lastHighlighted = null;

// True for exactly one mousemove after (re)acquiring pointer lock or regaining window focus,
// so the first (bogus, OS-accumulated) delta is dropped instead of flicking the camera.
let justLocked = false;
// Mouse motion is ACCUMULATED here and applied once per frame in update(), so a burst of buffered
// pointer events (delivered together after a render hitch) can't over-rotate / snap the camera.
let pendingDx = 0;
let pendingDy = 0;

// ── Public: register the action sink ─────────────────────────────────────────
// main.js calls input.onAction(routeAction). The callback receives one of the
// action objects documented at the top of this file.
export function onAction(cb) {
  actionSink = cb;
}

function emitAction(action) {
  if (actionSink) actionSink(action);
}

// ── Public: initialize pointer-lock, mouse-look, and hotkeys ─────────────────
let initialized = false;
export function initInput(cam, dom) {
  if (initialized) return; // listeners are bound once; guard against double-init
  initialized = true;
  domElement = dom;
  raycaster  = new THREE.Raycaster();
  if (RAYCAST_LAYER != null) raycaster.layers.set(RAYCAST_LAYER);

  // Pointer lock: clicking the canvas captures the mouse for free-look. Once
  // locked, mousemove deltas drive yaw/pitch. Esc (browser) releases the lock.
  domElement.addEventListener('click', onCanvasClick);
  document.addEventListener('pointerlockchange', () => {
    // On (re)acquiring the lock the first mousemove carries a large OS-accumulated delta
    // (movement while unlocked) that would jump the camera ~90-120°. Flag it so onMouseMove
    // drops that one event. (MAX_LOOK_DELTA_PX also clamps any other single-event spike.)
    if (document.pointerLockElement === domElement) justLocked = true;
  });
  // Regaining window focus can likewise deliver a stale first delta — drop it as well, and clear
  // any motion buffered during the blur so it doesn't "slide in" as an auto-pan when focus returns.
  window.addEventListener('blur', () => { justLocked = true; pendingDx = 0; pendingDy = 0; });
  document.addEventListener('mousemove', onMouseMove);

  // Keyboard hotkeys (number/arrow/enter/space + dedicated action keys).
  window.addEventListener('keydown', onKeyDown);
}

// Request pointer lock on first canvas click. If a prop interactable is under the
// reticle, the click acts on the prop instead of (re)acquiring the lock.
function onCanvasClick() {
  // If already locked and an interactable is targeted, let props consume it.
  if (document.pointerLockElement === domElement && hovered && hovered.kind === 'interactable') {
    if (interact.handleReticleClick && interact.handleReticleClick(hovered.mesh)) return;
  }
  // If locked and an own tile is targeted, a click commits a discard (when legal).
  if (document.pointerLockElement === domElement && hovered && hovered.kind === 'tile') {
    commitReticleTile();
    return;
  }
  // Otherwise acquire / refresh the pointer lock so free-look works.
  if (document.pointerLockElement !== domElement && domElement.requestPointerLock) {
    // Request RAW mouse input (unadjustedMovement) so OS pointer ACCELERATION can't amplify fast
    // pans — that amplification is what made quick movements over-rotate/snap while slow pans were
    // always fine. Fall back to the default (accelerated) lock where unadjustedMovement is
    // unsupported. (Chromium also rejects during the post-Esc cooldown — harmlessly ignored.)
    const p = domElement.requestPointerLock({ unadjustedMovement: true });
    if (p && typeof p.then === 'function') {
      p.catch(() => {
        const p2 = domElement.requestPointerLock();
        if (p2 && typeof p2.catch === 'function') p2.catch(() => {});
      });
    }
  }
}

// Mouse-look: accumulate yaw/pitch onto the camera's current look. Only while the
// pointer is locked to our canvas so the HUD remains clickable when unlocked.
// NOTE: look is desktop-only (Pointer Lock + mousemove). Touch devices fall back to
// the tappable 2D HUD buttons (claims/win/kong/discard) for gameplay; a dedicated
// touch-look path is intentionally out of scope for v1.
function onMouseMove(e) {
  if (document.pointerLockElement !== domElement) return;
  // Drop the first delta after (re)locking / refocus — it is the OS-accumulated jump.
  if (justLocked) { justLocked = false; return; }
  // Accumulate the raw deltas; update() applies them ONCE per frame (see pendingDx/Dy). Applying
  // per-event let a buffered burst of events over-rotate the camera all at once.
  pendingDx += e.movementX || 0;
  pendingDy += e.movementY || 0;
}

// ── Public: per-frame reticle raycast + highlight ────────────────────────────
// Called by main.js's render loop every frame. Determines what's under the
// center reticle and highlights it. Pure read of the scene + state; no emits.
export function update(cam) {
  if (!raycaster) return;

  // Apply accumulated mouse-look ONCE per frame (events were summed in onMouseMove). Capped per
  // frame with carry-over, so a buffered burst slides in over a few frames instead of snapping;
  // with unadjustedMovement the deltas are raw (no OS acceleration), so it tracks the mouse 1:1.
  if (pendingDx !== 0 || pendingDy !== 0) {
    const cap = MAX_LOOK_DELTA_PER_FRAME_PX;
    const dx = Math.max(-cap, Math.min(cap, pendingDx));
    const dy = Math.max(-cap, Math.min(cap, pendingDy));
    pendingDx -= dx;
    pendingDy -= dy;
    const look = camera.getLook();
    // Yaw decreases when moving the mouse right -> turn right (standard FP feel).
    let yaw   = look.yaw   - dx * MOUSE_SENSITIVITY;
    let pitch = look.pitch - dy * MOUSE_SENSITIVITY;
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
    camera.setLook(yaw, pitch);
  }

  // Reticle hover only matters while the pointer is locked (free-look). When the
  // pointer is unlocked the player is using the 2D HUD, so skip the per-frame
  // raycasts entirely — just clear any stale hover and bridge the selection.
  if (document.pointerLockElement !== domElement) {
    if (hovered) { applyHighlight(null); hovered = null; }
    pendingDx = 0; pendingDy = 0;   // discard any motion accumulated right up to an unlock
    // Do NOT touch __hud_selectedTileId here: while unlocked the player is using the 2D
    // dock, which owns the selection. Overwriting it every frame with the reticle's (null)
    // selection wiped a dock tap before the second tap/Discard button could commit.
    window.__hud_hoverTileId = null;
    return;
  }

  // 1) Cast the center-screen ray from the camera.
  raycaster.setFromCamera(reticleNdc, cam);

  // 2) Ask tiles.js whether an OWN hand tile is under the reticle. tiles.js owns
  //    the hand-rack meshes and returns the mesh whose userData.tileId is set.
  let tileMesh = null;
  if (tiles.tileAtReticle) {
    tileMesh = tiles.tileAtReticle(raycaster);
  }

  // 3) Decide the hovered target. A targeted own tile takes precedence; otherwise
  //    let interact.js report an interactable (best-effort, optional).
  let next = null;
  if (tileMesh && tileMesh.userData && tileMesh.userData.tileId != null) {
    next = { kind: 'tile', mesh: tileMesh, tileId: tileMesh.userData.tileId };
  } else if (interact.objectAtReticle) {
    const obj = interact.objectAtReticle(raycaster);
    if (obj) next = { kind: 'interactable', mesh: obj };
  }

  // 4) Update highlight flags (tiles.js renders the actual visual; we just tag).
  applyHighlight(next);
  hovered = next;
  // Publish the hovered own-hand tile id so hud.js can show an instant hover-magnify (task 6).
  window.__hud_hoverTileId = (next && next.kind === 'tile') ? next.tileId : null;

  // Bridge the current discard selection to the HUD (hud.js reads this global to
  // decide whether to show the Discard button).
  window.__hud_selectedTileId = selectedTileId;
}

// Toggle a userData.reticleHover flag on the hovered tile mesh so tiles.js can
// render a subtle highlight, clearing the previous one. Cheap and side-effect
// scoped — no material churn here.
function applyHighlight(next) {
  const nextMesh = next && next.mesh ? next.mesh : null;
  if (lastHighlighted === nextMesh) return;
  // Only clear the previous flag if that mesh is still in the scene — tiles.reconcile
  // may have disposed/rebuilt the hand on a gameUpdate, detaching the old mesh.
  if (lastHighlighted && lastHighlighted.parent && lastHighlighted.userData) {
    lastHighlighted.userData.reticleHover = false;
  }
  if (nextMesh && nextMesh.userData) nextMesh.userData.reticleHover = true;
  lastHighlighted = nextMesh;
}

// ── Affordances (mirrors game.js renderActions exactly) ──────────────────────
// computeAffordances(store): what may the local player do THIS frame? Used by
// hotkey handling here and re-usable by hud.js for button rendering. Gated on
// phase + currentTurn/lastDiscardPlayer + claimResponded, exactly like game.js.
export function computeAffordances(s) {
  const result = {
    canSelfWin: false,
    concealedKongs: [],   // [tileId] — group[0].id of each length-4 hand group
    addedKongs: [],       // [tileId] — the hand tile.id matching an exposed pong
    claimWindow: { active: false, isNext: false, claims: [], chowOptions: [] },
    robWindow:   { active: false, canWin: false },
  };

  const gs = s && s.gameState;
  if (!gs) return result;
  const myIndex = s.myIndex;
  if (myIndex == null) return result;
  const me = gs.players[myIndex];
  if (!me) return result;
  const n = gs.players.length;
  const hand  = me.hand || null;     // present only for self
  const melds = me.melds || [];

  // ── Own discard turn: self-win / concealed kong / added kong / discard ──
  if (gs.phase === 'discard' && gs.currentTurn === myIndex && hand) {
    // Self-draw win (tsumo) — declareWin.
    if (checkWin(hand, melds, gs.ruleset)) result.canSelfWin = true;

    // Concealed kong: any suit:value group of length 4 in hand -> group[0].id.
    const groups = {};
    hand.forEach(t => {
      const k = `${t.suit}:${t.value}`;
      (groups[k] = groups[k] || []).push(t);
    });
    Object.values(groups).forEach(grp => {
      if (grp.length === 4) result.concealedKongs.push(grp[0].id);
    });

    // Added kong (加槓): a hand tile matching an exposed pong's tiles[0].
    melds.forEach(meld => {
      if (meld.type !== 'pong') return;
      const t = hand.find(h => h.suit === meld.tiles[0].suit && h.value === meld.tiles[0].value);
      if (t) result.addedKongs.push(t.id);
    });
  }

  // ── Claim window (a discard by someone else) ──
  if (gs.phase === 'claim' && gs.lastDiscardPlayer !== myIndex && !s.claimResponded && hand) {
    const isNext = (gs.lastDiscardPlayer + 1) % n === myIndex;
    const claims = getValidClaims(hand, melds, gs.lastDiscard, isNext, gs.ruleset);
    result.claimWindow.active = true;
    result.claimWindow.isNext = isNext;
    result.claimWindow.claims = claims;
    // Pre-compute chow options as {tileIds:[...]} where tileIds are the two
    // FROM-HAND tile ids (the discard excluded), in chow-option order.
    if (claims.includes('chow')) {
      result.claimWindow.chowOptions = getChowOptions(hand, gs.lastDiscard).map(opt => {
        const fromHand = opt.filter(t => t !== gs.lastDiscard);
        return { tileIds: fromHand.map(t => t.id) };
      });
    }
  }

  // ── Rob-the-kong window (someone is adding a kong; anyone else may win) ──
  if (gs.phase === 'rob' && gs.robKong && gs.robKong.seat !== myIndex && !s.claimResponded && hand) {
    result.robWindow.active = true;
    result.robWindow.canWin = checkWin([...hand, gs.robKong.tile], melds, gs.ruleset);
  }

  return result;
}

// ── Commit helpers (the only places that call emitAction) ────────────────────

// Discard the OWN hand tile currently under the reticle, when it's a legal
// discard turn. Mirrors game.js handleTileClick/discardSelected.
function commitReticleTile() {
  const gs = state.store.gameState;
  if (!gs) return;
  const myIndex = state.store.myIndex;
  const canDiscard = gs.phase === 'discard' && gs.currentTurn === myIndex && state.me() && state.me().hand;
  if (!canDiscard || !hovered || hovered.kind !== 'tile') return;
  selectedTileId = hovered.tileId;
  emitAction({ kind: 'discard', tileId: selectedTileId });
  selectedTileId = null;
}

// Discard the currently selected tile (hotkey path). No-op if nothing selected
// or if it's not a legal discard turn.
function commitSelectedDiscard() {
  const gs = state.store.gameState;
  if (!gs || selectedTileId == null) return;
  const myIndex = state.store.myIndex;
  const me = state.me();
  const canDiscard = gs.phase === 'discard' && gs.currentTurn === myIndex && me && me.hand;
  if (!canDiscard) return;
  // Validate the selected id still exists in hand.
  if (!me.hand.some(t => t.id === selectedTileId)) { selectedTileId = null; return; }
  emitAction({ kind: 'discard', tileId: selectedTileId });
  selectedTileId = null;
}

// ── Keyboard hotkeys ─────────────────────────────────────────────────────────
// Number keys (1-9, 0) quick-select the 1st-10th tile in the sorted own hand; a
// 13-14 tile hand's remaining tiles are reached with the arrows (which walk/wrap the
// whole hand) or the reticle.
// Arrow Left/Right nudge the selection; Up/Down do the same (single-row hand).
// Enter / Space confirm: discard the selected tile, OR — during a claim/rob
// window — confirm the single highest-priority claim if exactly one is offered.
// Dedicated keys mirror the HUD action buttons:
//   P = pong, K = kong, C = chow (first option), W = win, Escape/Backspace = pass.
function onKeyDown(e) {
  // Ignore typing into inputs (e.g. chat box) — never hijack text fields.
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;

  const s   = state.store;
  const gs  = s.gameState;
  if (!gs) return;
  const aff = computeAffordances(s);

  // Number keys -> select Nth sorted hand tile (only on own discard turn).
  if (/^[0-9]$/.test(e.key)) {
    selectHandByNumber(e.key === '0' ? 10 : parseInt(e.key, 10));
    e.preventDefault();
    return;
  }

  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      nudgeSelection(-1); e.preventDefault(); return;
    case 'ArrowRight':
    case 'ArrowDown':
      nudgeSelection(+1); e.preventDefault(); return;

    case 'Enter':
    case ' ': // Space
      onConfirm(aff); e.preventDefault(); return;

    // Dedicated action keys (case-insensitive).
    default: break;
  }

  const k = e.key.toLowerCase();
  if (k === 'w') {                       // Win (self-draw OR claim/rob)
    onWin(aff); e.preventDefault(); return;
  }
  if (k === 'p') {                       // Pong (claim window)
    if (aff.claimWindow.active && aff.claimWindow.claims.includes('pong')) {
      respondClaim({ kind: 'claim', type: 'pong', tileIds: [] });
    }
    e.preventDefault(); return;
  }
  if (k === 'k') {                       // Kong: claim-kong, else concealed/added
    onKong(aff); e.preventDefault(); return;
  }
  if (k === 'c') {                       // Chow (first available option)
    if (aff.claimWindow.active && aff.claimWindow.chowOptions.length) {
      respondClaim({ kind: 'claim', type: 'chow', tileIds: aff.claimWindow.chowOptions[0].tileIds });
    }
    e.preventDefault(); return;
  }
  if (k === 'x' || e.key === 'Backspace') { // Pass
    if (aff.claimWindow.active || aff.robWindow.active) {
      respondClaim({ kind: 'pass' });
    }
    e.preventDefault(); return;
  }
  if (k === 'o') {                       // Organize own hand (deterministic sort)
    emitAction({ kind: 'organizeHand' }); e.preventDefault(); return;
  }
  if (k === 'u') {                       // shUffle own hand (random order)
    emitAction({ kind: 'shuffleHand' }); e.preventDefault(); return;
  }
}

// Select the Nth (1-based) tile in the SORTED own hand for discard. Sorting via
// rules-client.sortTiles matches the on-rack visual order tiles.js lays out.
function selectHandByNumber(n) {
  const me = state.me();
  const gs = state.store.gameState;
  if (!me || !me.hand || !gs) return;
  if (!(gs.phase === 'discard' && gs.currentTurn === state.store.myIndex)) return;
  const sorted = sortTiles(me.hand);
  if (n < 1 || n > sorted.length) return;
  selectedTileId = sorted[n - 1].id;
}

// Move the discard selection left/right within the sorted hand (wraps).
function nudgeSelection(dir) {
  const me = state.me();
  const gs = state.store.gameState;
  if (!me || !me.hand || !gs) return;
  if (!(gs.phase === 'discard' && gs.currentTurn === state.store.myIndex)) return;
  const sorted = sortTiles(me.hand);
  if (!sorted.length) return;
  let idx = sorted.findIndex(t => t.id === selectedTileId);
  if (idx < 0) idx = dir > 0 ? -1 : 0; // start before first / at first
  idx = (idx + dir + sorted.length) % sorted.length;
  selectedTileId = sorted[idx].id;
}

// Enter/Space confirm. Priority: an open claim/rob window resolves first (a
// single offered claim auto-confirms), otherwise commit the selected discard.
function onConfirm(aff) {
  // During a claim window with exactly one non-pass option, confirm it.
  if (aff.claimWindow.active) {
    const claims = aff.claimWindow.claims;
    if (claims.length === 1 && claims[0] !== 'chow') {
      respondClaim({ kind: 'claim', type: claims[0], tileIds: [] });
      return;
    }
    if (claims.length === 1 && claims[0] === 'chow' && aff.claimWindow.chowOptions.length === 1) {
      respondClaim({ kind: 'claim', type: 'chow', tileIds: aff.claimWindow.chowOptions[0].tileIds });
      return;
    }
    // Ambiguous (multiple claims/options) — leave to explicit keys/HUD. Fall through.
  }
  // Rob window: Enter wins if a win is available.
  if (aff.robWindow.active && aff.robWindow.canWin) {
    respondClaim({ kind: 'claim', type: 'win', tileIds: [] });
    return;
  }
  // Otherwise: commit a discard (reticle target preferred, else selection).
  if (hovered && hovered.kind === 'tile') {
    commitReticleTile();
  } else {
    commitSelectedDiscard();
  }
}

// W key: self-draw win on own turn, claim-win in a claim window, or rob-win.
function onWin(aff) {
  if (aff.robWindow.active && aff.robWindow.canWin) {
    respondClaim({ kind: 'claim', type: 'win', tileIds: [] });
    return;
  }
  if (aff.claimWindow.active && aff.claimWindow.claims.includes('win')) {
    respondClaim({ kind: 'claim', type: 'win', tileIds: [] });
    return;
  }
  if (aff.canSelfWin) {
    emitAction({ kind: 'declareWin' });
  }
}

// K key: prefer a claim-kong (on a discard); otherwise on own turn declare the
// first concealed kong, else the first added kong.
function onKong(aff) {
  if (aff.claimWindow.active && aff.claimWindow.claims.includes('kong')) {
    respondClaim({ kind: 'claim', type: 'kong', tileIds: [] });
    return;
  }
  if (aff.concealedKongs.length) {
    emitAction({ kind: 'declareKong', tileId: aff.concealedKongs[0] });
    return;
  }
  if (aff.addedKongs.length) {
    emitAction({ kind: 'declareAddedKong', tileId: aff.addedKongs[0] });
  }
}

// Resolve a claim/rob response: emit it and lock the panel (matches game.js
// markClaimResponded). main.js's routeAction also flips claimResponded for the
// 'claim'/'pass' kinds, but we set it here too so repeated hotkeys before the
// next gameUpdate don't double-fire.
function respondClaim(action) {
  emitAction(action);
  state.setClaimResponded(true);
}
