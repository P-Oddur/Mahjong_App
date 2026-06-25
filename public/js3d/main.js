// main.js — the orchestrator for the 3D mahjong client.
//
// This is the ONLY module with broad imports. It:
//   1. reads sessionStorage and guards the page (same contract as game.js),
//   2. connects the socket via net.js and performs the rejoin handshake,
//   3. builds scene / seats / avatars / tiles / camera / input / hud / audio,
//   4. wires gameUpdate -> state.applyGameUpdate -> subscribers (reconcile/render),
//   5. runs the requestAnimationFrame render loop, including the ~20 Hz look emit.
//
// Sibling modules (scene, seats, tiles, avatar, camera, input, hud, audio,
// interact) are authored by other agents to satisfy the interfaces imported here.
// main.js's imports therefore DEFINE the export contract those modules must meet.

import * as net      from '/js3d/net.js';
import * as state    from '/js3d/state.js';
import * as scene    from '/js3d/scene.js';
import * as seats    from '/js3d/seats.js';
import * as tiles    from '/js3d/tiles.js';
import * as avatar   from '/js3d/avatar.js';
import * as camera   from '/js3d/camera.js';
import * as input    from '/js3d/input.js';
import * as hud      from '/js3d/hud.js';
import * as audio    from '/js3d/audio.js';
import * as interact from '/js3d/interact.js';
import * as deal     from '/js3d/deal.js';
import * as token    from '/js3d/token.js';

// Local boot scalars. The authoritative seat/host live in state.store; these are
// convenience mirrors used during the bootstrap guard.
let roomCode = null;
let cam = null;          // THREE.PerspectiveCamera
let sceneHandles = null; // { scene, renderer, clock, root }
let lastTime = 0;        // ms timestamp of previous frame (for dt)
let revealed = false;    // true once the first frame has fully rendered (splash hidden)
let frameErrors = 0;     // consecutive caught render-loop errors (for fail-surfacing)
let resizePending = false; // rAF-coalesce guard for window resize

// ── sessionStorage helpers (identical contract to game.js / index.html) ──────
function readSession() {
  try { return JSON.parse(sessionStorage.getItem('mahjong') || '{}') || {}; }
  catch (_) { return {}; } // corrupt storage must not throw the bootstrap guard
}
// Persist a new playerIndex while preserving code/token (rejoined / identityUpdate).
function persistPlayerIndex(playerIndex) {
  const s = readSession();
  s.playerIndex = playerIndex;
  sessionStorage.setItem('mahjong', JSON.stringify(s));
}

// ── Entry point ──────────────────────────────────────────────────────────────
export async function start() {
  // 1) Bootstrap guard — both code and token are required to stay on the page.
  const stored = readSession();
  roomCode = stored.code;
  if (!stored.code || !stored.token) {
    window.location.href = '/';
    return;
  }

  // 2) Socket + rejoin handshake. Register handlers BEFORE connecting so we never
  //    miss the first events, then bind doRejoin to connect (and fire immediately
  //    if already connected — matches game.js behavior).
  net.connect();
  registerNetHandlers();
  net.onEvent('connect', net.doRejoin);
  net.doRejoin(); // safe if not yet connected (emit is a no-op until socket ready)

  // 3) Build the static world. The canvas is the full-screen element in game3d.html.
  const canvas = document.getElementById('game3d-canvas');
  sceneHandles = await scene.buildScene(canvas);
  tiles.setScene(sceneHandles.scene); // attach the tile root into the scene graph
  token.initToken(scene.scene);

  // 4) Camera fixed at the local seat eye (relative seat 0 = near). Never translates.
  cam = camera.createCamera();
  camera.seatCamera(cam, 0);

  // 5) Load dynamic asset geometry/rigs in the BACKGROUND (fire-and-forget) so the
  //    near-18 MB tiles.glb never blocks first paint or the reveal (INTEGRATION
  //    gotcha #9). reconcile()/placeAvatars() no-op until their `loaded` flag flips,
  //    so a state update before the assets arrive is safe; when each load resolves
  //    we lay it out against the current store so it "pops in".
  tiles.loadTileGeometries()
    .then(() => tiles.reconcile(state.store))
    .catch(err => console.error('[main] tile geometry load failed', err));
  avatar.loadAvatar()
    .then(() => avatar.placeAvatars(state.store.gameState ? state.store.gameState.players : []))
    .catch(err => console.error('[main] avatar load failed', err));

  // 6) Initialize subsystems: HUD overlay, input (pointer-lock + reticle),
  //    audio (lazy WebAudio), and interactables (teacup/lamp; may be a stub).
  hud.initHud();
  input.initInput(cam, canvas);
  // Any click / keypress skips the opening dice-roll + deal-in animation (no-op when idle).
  window.addEventListener('pointerdown', () => deal.skip());
  window.addEventListener('keydown', () => deal.skip());
  audio.initAudio();
  interact.initInteractables(sceneHandles.scene);

  // 7) Reconcile/render fan-out: every applyGameUpdate notifies these subscribers.
  state.subscribe(store => {
    tiles.reconcile(store);   // diff & lay out hands / melds / discards / wall
    hud.render(store);        // status, wall counter, action buttons, claim timer
    avatar.placeAvatars(store.gameState ? store.gameState.players : []); // counts/labels
    deal.onGameUpdate(store); // opening dice roll + deal-in jump on a fresh hand
    token.onUpdate(store);
  });

  // 8) Look-sync OUT: camera reports yaw/pitch changes; net throttles the emit.
  camera.onLookChange((yaw, pitch) => net.emitPlayerLook(yaw, pitch));

  // 9) Action sink IN: input + HUD buttons funnel committed actions to net.* emits.
  input.onAction(routeAction);
  hud.onHudButton(routeHudButton);
  hud.onVote((kind, value) => routeAction({ kind, value }));   // Next Hand / End Match toggle votes

  // 10) Start the loop. The loading splash is hidden by frame() after the FIRST
  //     fully-rendered frame (so the splash covers WebGPU pipeline/shader compile
  //     instead of a blank canvas), or replaced with an error if rendering fails.
  window.addEventListener('resize', onWindowResize);

  lastTime = performance.now();
  requestAnimationFrame(frame);
}

// rAF-coalesced resize: collapse a burst of resize events into one onResize per
// frame so render-target reallocation doesn't thrash during a window drag.
function onWindowResize() {
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(() => { resizePending = false; scene.onResize(cam); });
}

// ── Loading-splash helpers ───────────────────────────────────────────────────
function hideLoader() {
  const el = document.getElementById('loading');
  if (el) el.classList.add('hidden');
}
// Surface a visible message on the splash instead of hanging on "Loading…".
function showLoaderError(msg) {
  const el = document.getElementById('loading');
  if (!el) return;
  el.classList.remove('hidden');
  el.textContent = '';
  const line = document.createElement('div');
  line.textContent = msg; // textContent — never inject markup
  el.appendChild(line);
}
// Map a startup failure to a user-facing reason (GPU-blocked vs generic).
function showStartupError(err) {
  const s = String((err && (err.message || err)) || '');
  const gpu = /webgpu|webgl|adapter|gpudevice|requestdevice|\binit\b/i.test(s);
  showLoaderError(gpu
    ? '3D unavailable — your browser blocked or lacks WebGPU and WebGL2.'
    : '3D failed to load — please refresh. (See console for details.)');
}

// ── Inbound socket handlers (contract §1.2 + the two NEW events) ─────────────
function registerNetHandlers() {
  // Authoritative per-frame state -> the single mirror -> subscribers.
  net.onEvent('gameUpdate', s => state.applyGameUpdate(s));

  // Rejoin confirmation: set seat/host, persist playerIndex, re-seat camera.
  // state==='waiting' means the room is back in the lobby -> bounce to '/'.
  net.onEvent('rejoined', ({ playerIndex, state: roomState }) => {
    state.setMyIndex(playerIndex);
    persistPlayerIndex(playerIndex);
    reseatCamera();
    if (roomState === 'waiting') window.location.href = '/';
  });

  // Bad/expired credentials -> clear and return to lobby.
  net.onEvent('rejoinError', () => {
    sessionStorage.removeItem('mahjong');
    window.location.href = '/';
  });

  // Seat reshuffle: update seat/host, persist, re-seat the camera.
  net.onEvent('identityUpdate', ({ playerIndex }) => {
    state.setMyIndex(playerIndex);
    persistPlayerIndex(playerIndex);
    reseatCamera();
  });

  // Navigation.
  net.onEvent('backToLobby', () => { window.location.href = '/'; });

  // Overlays / banners.
  net.onEvent('gameOver',    result => hud.showGameOver(result));
  net.onEvent('matchOver',   payload => hud.showStandings(payload));
  net.onEvent('nextVoteUpdate', ({ voted, needed }) => hud.applyNextVote(voted, needed));
  net.onEvent('endVoteUpdate',  ({ voted, needed }) => hud.applyEndVote(voted, needed));
  net.onEvent('playerDisconnected', ({ name }) => hud.setStatus(`${name} disconnected`));
  net.onEvent('playerReconnected', ({ name }) => hud.setStatus(`${name} reconnected`));

  // Rejected action: surface it and unlock the claim panel so the player can retry.
  net.onEvent('actionError', msg => {
    hud.setStatus(typeof msg === 'string' ? msg : 'Action not allowed');
    state.setClaimResponded(false);
  });

  // Action bubble over a seat (pong/kong/chow).
  net.onEvent('playerAction', e => hud.showActionBubble(e.seat, e.type, e.tiles));

  // NEW: drive remote avatar head rotation (skip self handled inside avatar.applyLook).
  net.onEvent('playerLook', ({ playerIndex, yaw, pitch }) => avatar.applyLook(playerIndex, yaw, pitch));

  // NEW: apply received prop state (no-op-safe stub in v1).
  net.onEvent('interactState', ({ object, ...st }) => interact.applyInteractState(object, st));

  // roomUpdate / chatHistory / chatMessage are optional in-game; ignored here.
}

// Re-seat the local camera to relative seat 0 and tell avatar.js which seat is
// local so the local avatar can be hidden from the first-person camera.
function reseatCamera() {
  if (cam) camera.seatCamera(cam, 0);
  if (avatar.setLocalSeat) avatar.setLocalSeat(0);
}

// ── Action routing: committed input/HUD -> net emits (contract §5.13) ────────
// Both input.onAction and hud.onHudButton converge here so the emit mapping lives
// in one place. `a` is { kind, ...fields }; recognized kinds mirror game.js.
function routeAction(a) {
  if (!a || !a.kind) return;
  switch (a.kind) {
    case 'discard':
      net.emitDiscard(a.tileId);
      audio.playTileClick();
      break;
    case 'declareWin':
      net.emitDeclareWin();
      break;
    case 'declareKong':
      net.emitDeclareKong(a.tileId);
      break;
    case 'declareAddedKong':
      net.emitDeclareAddedKong(a.tileId);
      break;
    case 'claim':
      if (state.store.claimResponded) break; // already answered — no double-emit (reveal-panel tap after a button)
      // type ∈ win|pong|kong|chow. chow carries tileIds (the two from-hand .ids).
      net.emitClaim(a.type, a.tileIds || []);
      state.setClaimResponded(true);
      break;
    case 'pass':
      if (state.store.claimResponded) break;
      net.emitPass();
      state.setClaimResponded(true);
      break;
    case 'nextHandVote':
      net.emitNextHandVote(a.value);
      break;
    case 'endMatchVote':
      net.emitEndMatchVote(a.value);
      break;
    case 'returnToLobby':
      net.emitReturnToLobby();
      break;
    case 'organizeHand':
      net.emitOrganizeHand();
      break;
    case 'shuffleHand':
      net.emitShuffleHand();
      break;
    default:
      console.warn('[main] unknown action kind', a.kind);
  }
}

// HUD buttons emit a string id; map it to the same action vocabulary as routeAction.
function routeHudButton(buttonId) {
  switch (buttonId) {
    // 'next-hand' / 'end-match' are mutually-exclusive toggle votes — they flow through
    // hud.onVote (carrying a value), not through this string-id sink.
    case 'lobby':      routeAction({ kind: 'returnToLobby' }); break;
    default:
      // Buttons that are really actions (win/discard/pong/...) should already be
      // delivered through input.onAction; ignore anything unrecognized here.
      console.warn('[main] unhandled HUD button', buttonId);
  }
}

// ── Render loop ──────────────────────────────────────────────────────────────
function frame(now) {
  const dt = Math.min(0.1, (now - lastTime) / 1000); // seconds, clamped on stalls
  lastTime = now;

  // The whole per-frame body is wrapped so a single throw (a transient GPU /
  // device-lost error, a malformed store, a NaN tween) cannot tear down the rAF
  // chain and silently freeze the client — requestAnimationFrame is always
  // re-armed in `finally`.
  try {
    // Per-frame: reticle raycast + hotkeys, then apply look to the camera (which
    // also fires the throttled playerLook via the onLookChange callback), then
    // smooth remote avatar heads.
    input.update(cam);
    hud.updateMagnify?.();          // reticle hover-magnify of the aimed own hand tile
    camera.update(dt, cam);
    avatar.update(dt);
    tiles.updateTweens(dt); // advance draw/discard tweens
    token.update(dt, state.store);
    deal.update(dt);        // opening dice-roll tumble + clear

    scene.updateParlour?.(dt);
    scene.render(cam);

    // Reveal only after the first frame has fully rendered (pipeline built + drawn),
    // so the splash covers the WebGPU pipeline/shader compile rather than a blank
    // black canvas (INTEGRATION gotcha #9).
    if (!revealed) { revealed = true; hideLoader(); }
    frameErrors = 0;
  } catch (err) {
    // Throttle logging so a persistent per-frame failure can't flood the console.
    if (frameErrors < 3 || frameErrors % 120 === 0) console.error('[main] render frame error', err);
    frameErrors++;
    // If the very first frames never render, don't hang on "Loading…" — surface it.
    if (!revealed && frameErrors >= 30) { revealed = true; showLoaderError('3D rendering failed — see console for details.'); }
  } finally {
    requestAnimationFrame(frame);
  }
}

// Auto-start on module load (the page imports this module as the entry point).
start().catch(err => {
  console.error('[main] failed to start 3D client', err);
  showStartupError(err);
});
