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

// Local boot scalars. The authoritative seat/host live in state.store; these are
// convenience mirrors used during the bootstrap guard.
let roomCode = null;
let cam = null;          // THREE.PerspectiveCamera
let sceneHandles = null; // { scene, renderer, clock, root }
let lastTime = 0;        // ms timestamp of previous frame (for dt)

// ── sessionStorage helpers (identical contract to game.js / index.html) ──────
function readSession() {
  return JSON.parse(sessionStorage.getItem('mahjong') || '{}');
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

  // 4) Camera fixed at the local seat eye (relative seat 0 = near). Never translates.
  cam = camera.createCamera();
  camera.seatCamera(cam, 0);

  // 5) Load dynamic asset geometry/rigs in parallel (tiles + avatars).
  await Promise.all([
    tiles.loadTileGeometries(),
    avatar.loadAvatar(),
  ]);

  // 6) Initialize subsystems: HUD overlay, input (pointer-lock + reticle),
  //    audio (lazy WebAudio), and interactables (teacup/lamp; may be a stub).
  hud.initHud();
  input.initInput(cam, canvas);
  audio.initAudio();
  interact.initInteractables(sceneHandles.scene);

  // 7) Reconcile/render fan-out: every applyGameUpdate notifies these subscribers.
  state.subscribe(store => {
    tiles.reconcile(store);   // diff & lay out hands / melds / discards / wall
    hud.render(store);        // status, wall counter, action buttons, claim timer
    avatar.placeAvatars(store.gameState ? store.gameState.players : []); // counts/labels
  });

  // 8) Look-sync OUT: camera reports yaw/pitch changes; net throttles the emit.
  camera.onLookChange((yaw, pitch) => net.emitPlayerLook(yaw, pitch));

  // 9) Action sink IN: input + HUD buttons funnel committed actions to net.* emits.
  input.onAction(routeAction);
  hud.onHudButton(routeHudButton);

  // 10) Hide the loading splash and start the loop.
  const loading = document.getElementById('loading');
  if (loading) loading.classList.add('hidden');

  window.addEventListener('resize', () => scene.onResize(cam));

  lastTime = performance.now();
  requestAnimationFrame(frame);
}

// ── Inbound socket handlers (contract §1.2 + the two NEW events) ─────────────
function registerNetHandlers() {
  // Authoritative per-frame state -> the single mirror -> subscribers.
  net.onEvent('gameUpdate', s => state.applyGameUpdate(s));

  // Rejoin confirmation: set seat/host, persist playerIndex, re-seat camera.
  // state==='waiting' means the room is back in the lobby -> bounce to '/'.
  net.onEvent('rejoined', ({ playerIndex, isHost, state: roomState }) => {
    state.setMyIndex(playerIndex);
    state.setAmHost(isHost);
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
  net.onEvent('identityUpdate', ({ playerIndex, isHost }) => {
    state.setMyIndex(playerIndex);
    state.setAmHost(isHost);
    persistPlayerIndex(playerIndex);
    reseatCamera();
  });

  // Navigation.
  net.onEvent('backToLobby', () => { window.location.href = '/'; });

  // Overlays / banners.
  net.onEvent('gameOver',    result => hud.showGameOver(result));
  net.onEvent('matchOver',   payload => hud.showStandings(payload));
  net.onEvent('endVoteUpdate', ({ voted, needed }) => hud.updateVoteButton(voted, needed));
  net.onEvent('playerDisconnected', ({ name }) => hud.setStatus(`${name} disconnected`));

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
      // type ∈ win|pong|kong|chow. chow carries tileIds (the two from-hand .ids).
      net.emitClaim(a.type, a.tileIds || []);
      state.setClaimResponded(true);
      break;
    case 'pass':
      net.emitPass();
      state.setClaimResponded(true);
      break;
    case 'nextHand':
      net.emitNextHand();
      break;
    case 'endMatchVote':
      net.emitEndMatchVote(a.value);
      break;
    case 'returnToLobby':
      net.emitReturnToLobby();
      break;
    case 'interact':
      net.emitInteractState(a.object, a.state || {});
      break;
    default:
      console.warn('[main] unknown action kind', a.kind);
  }
}

// HUD buttons emit a string id; map it to the same action vocabulary as routeAction.
function routeHudButton(buttonId) {
  switch (buttonId) {
    case 'next-hand':  routeAction({ kind: 'nextHand' }); break;
    case 'vote-end':   routeAction({ kind: 'endMatchVote', value: true }); break;
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

  // Per-frame: reticle raycast + hotkeys, then apply look to the camera (which
  // also fires the throttled playerLook via the onLookChange callback), then
  // smooth remote avatar heads.
  input.update(cam);
  camera.update(dt, cam);
  avatar.update(dt);
  tiles.updateTweens(dt); // advance draw/discard tweens

  // HUD look-away fallback: if the local rack leaves the camera frustum, hud.js
  // fades in the 2D hand strip. We hand it the current look so it can decide.
  if (hud.showLookAwayHand) {
    const look = camera.getLook();
    // hud.render already drew the hand; this just toggles the fallback visibility.
    // The "visible" decision is computed inside hud from look + rack bounds, but we
    // pass the local hand so it has the tiles to show.
    hud.showLookAwayHand(state.localHand(), isLookingAwayFromRack(look));
  }

  scene.render(cam);
  requestAnimationFrame(frame);
}

// Rough heuristic: the rack sits in front of the seated player (toward table
// center, i.e. base facing). If the player has yawed roughly past ±100° the rack
// is off-screen and the 2D fallback should show. hud.js may refine this; this is
// a safe default that keeps the loop self-contained.
function isLookingAwayFromRack(look) {
  if (!look) return false;
  const yaw = Math.abs(look.yaw);
  return yaw > 1.75; // ~100° from forward
}

// Auto-start on module load (the page imports this module as the entry point).
start().catch(err => {
  console.error('[main] failed to start 3D client', err);
});
