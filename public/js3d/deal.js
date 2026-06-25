// deal.js — opening dice roll + deal-in trigger (client-side, cosmetic, multiplayer-consistent).
//
// On each new hand the current dealer "rolls" 3 dice. The values are derived deterministically
// from the hand number, so EVERY client shows the SAME roll without any server round-trip. The
// sum is shown on screen, the 3D dice tumble on the table near the dealer and then disappear, and
// the freshly-dealt hand tiles jump in from the dice-broken wall side (tiles.startDealIn).
//
// Nothing here changes game state — standard HK dealing is ANIMATION-ONLY over the server's
// random deal (locked decision), so fairness is untouched and the dice are purely ceremonial.

import * as THREE from 'three';
import * as scene from '/js3d/scene.js';
import * as seats from '/js3d/seats.js';
import * as tiles from '/js3d/tiles.js';
import * as hud   from '/js3d/hud.js';
import { pipTexture } from '/js3d/parlour/textures.js';
import { relativeSeat } from '/js3d/state.js';

const FELT_TOP_Y = 0.791;     // felt surface (matches tiles.js / furniture.js)
const DIE = 0.026;            // die edge length (m) — the small parlour bowl-dice size that was removed
// Shared geometry + pip-face materials for the dice — created ONCE and reused for every roll so a
// long multi-hand session never leaks GPU buffers (the 3 dice are identical each time).
const DIE_GEO = new THREE.BoxGeometry(DIE, DIE, DIE);
// Six real pip faces (1..6) so the dice read as dice, not blank white cubes. BoxGeometry group
// order is +X,-X,+Y,-Y,+Z,-Z → values 1,6,2,5,3,4 (opposite faces sum to 7), the same mapping the
// parlour bowl used. Built lazily on first roll (pipTexture paints a canvas → needs the document).
let DIE_MATS = null;
function dieMaterials() {
  if (!DIE_MATS) {
    const pip = v => new THREE.MeshStandardMaterial({ map: pipTexture(v), roughness: 0.4 });
    DIE_MATS = [pip(1), pip(6), pip(2), pip(5), pip(3), pip(4)];
  }
  return DIE_MATS;
}
const ROLL_MS = 1000;         // tumble duration
const SHOW_MS = 1400;         // how long the settled dice + on-screen number linger before clearing
const WINDS = ['east', 'south', 'west', 'north'];

let group = null;             // holder for the 3 dice meshes (added to the scene during a roll)
let dice = [];                // [{ mesh, spin:THREE.Vector3 }]
let diceVals = [0, 0, 0];
let phase = 'idle';           // 'idle' | 'rolling' | 'showing'
let timer = 0;                // ms within the current phase
// wallCount seen last update; a big jump UP = a fresh deal. PERSISTED across reloads
// (sessionStorage) so a mid-hand page refresh / reconnect — which resets this module's
// state — doesn't look like a fresh deal and spuriously replay the opening roll (the wall
// hasn't jumped since we last saw it). A brand-new tab falls back to -1, where rolling is fine.
const DEAL_WALL_KEY = 'mj_deal_wall';
function loadLastWall() {
  try { const v = Number(sessionStorage.getItem(DEAL_WALL_KEY)); return Number.isFinite(v) && v > 0 ? v : -1; }
  catch (_) { return -1; }
}
let lastWall = loadLastWall();

// Deterministic [0,1) hash so all clients derive the SAME dice from the same hand number.
function hash01(n) { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); }
function deriveDice(handNumber, windIdx) {
  const base = (handNumber || 1) * 7.13 + (windIdx + 1) * 101.7 + 3.1;
  return [0, 1, 2].map(k => 1 + Math.floor(hash01(base + k * 17.77) * 6));
}

// onGameUpdate(store): called from the state subscriber after each gameUpdate. Detects the start
// of a fresh hand (new handNumber, no discards, full hands, no melds) and kicks off the roll.
export function onGameUpdate(s) {
  const gs = s && s.gameState;
  if (!gs || gs.phase === 'over' || !gs.players) return;
  // A fresh DEAL refills the wall by ~80 tiles; ordinary draws only drop it 1-2. Triggering on a
  // wall JUMP (rather than handNumber) rolls exactly once per new deal, fires correctly on a
  // rematch (handNumber resets to 1 but the wall still refills), and does NOT re-fire on a mid-hand
  // reconnect (discards present → freshDeal false). A roll already in flight is never interrupted.
  const wc = gs.wallCount || 0;
  const refilled = wc > lastWall + 20;
  lastWall = wc;
  try { sessionStorage.setItem(DEAL_WALL_KEY, String(wc)); } catch (_) {} // survive a reload (see above)
  const freshDeal =
    (gs.discardPile || []).length === 0 &&
    gs.players.every(p => p && (p.handCount || 0) >= 13) &&
    gs.players.every(p => !(p.melds && p.melds.length));
  if (refilled && freshDeal && phase === 'idle') startRoll(gs);
}

function startRoll(gs) {
  const windIdx = Math.max(0, WINDS.indexOf(gs.roundWind));
  diceVals = deriveDice(gs.handNumber, windIdx);
  buildDice(gs.dealer);
  phase = 'rolling';
  timer = 0;
  tiles.startDealIn(gs.dealer, diceVals);   // tiles jump in from the dice-broken wall side
  if (hud.showDiceRoll) hud.showDiceRoll(diceVals);
}

function buildDice(dealer) {
  clear();
  if (!scene.scene) return;
  group = new THREE.Group();
  // Dice land a little toward the current dealer from the table centre.
  const t = seats.seatTransform(relativeSeat(dealer == null ? 0 : dealer));
  const dir = t ? new THREE.Vector3(t.pos.x, 0, t.pos.z) : new THREE.Vector3(0, 0, 1);
  if (dir.lengthSq() > 0) dir.normalize();
  const cx = dir.x * 0.14, cz = dir.z * 0.14;
  for (let k = 0; k < 3; k++) {
    const m = new THREE.Mesh(DIE_GEO, dieMaterials()); // shared geo+mats — no per-roll allocation/leak
    m.castShadow = true; m.receiveShadow = true;
    m.position.set(cx + (k - 1) * 0.04, FELT_TOP_Y + DIE / 2, cz);
    group.add(m);
    dice.push({ mesh: m, spin: new THREE.Vector3(
      (Math.random() * 2 - 1) * 18, (Math.random() * 2 - 1) * 18, (Math.random() * 2 - 1) * 18) });
  }
  scene.scene.add(group);
}

// update(dt): per-frame; tumble the dice, then settle + linger, then clear. Called from main.js.
export function update(dt) {
  if (phase === 'idle') return;
  timer += dt * 1000;
  if (phase === 'rolling') {
    const k = Math.min(1, timer / ROLL_MS); // 0..1 progress (bounce decays toward the end)
    for (let i = 0; i < dice.length; i++) {
      const d = dice[i];
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      d.mesh.position.y = FELT_TOP_Y + DIE / 2 + Math.abs(Math.sin(timer * 0.02 + i)) * 0.03 * (1 - k);
    }
    if (timer >= ROLL_MS) { settle(); phase = 'showing'; timer = 0; }
  } else if (phase === 'showing') {
    if (timer >= SHOW_MS) finish();
  }
}

function settle() {
  // Snap each die flat AND rotate it so its rolled value ends up on the top (+Y) face, so the
  // settled dice actually display the numbers shown on the HUD.
  for (let i = 0; i < dice.length; i++) {
    dice[i].mesh.position.y = FELT_TOP_Y + DIE / 2;
    orientDieToValue(dice[i].mesh, diceVals[i]);
  }
}

// Rotation (radians) that brings each die value onto the top face, given the
// +X,-X,+Y,-Y,+Z,-Z = 1,6,2,5,3,4 face layout used by dieMaterials() above.
const VALUE_UP_ROT = {
  2: [0, 0, 0],
  5: [Math.PI, 0, 0],
  1: [0, 0, Math.PI / 2],
  6: [0, 0, -Math.PI / 2],
  3: [-Math.PI / 2, 0, 0],
  4: [Math.PI / 2, 0, 0],
};
function orientDieToValue(mesh, value) {
  const r = VALUE_UP_ROT[value] || [0, 0, 0];
  mesh.rotation.set(r[0], r[1], r[2]);
}

function finish() {
  clear();
  phase = 'idle';
  if (hud.hideDiceRoll) hud.hideDiceRoll();
}

// skip(): snap the opening away — remove the dice, hide the number, finish the deal-in jump.
export function skip() {
  if (phase === 'idle') return;
  finish();
  if (tiles.snapDealIn) tiles.snapDealIn();
}

function clear() {
  if (group && scene.scene) scene.scene.remove(group);
  group = null;
  dice = [];
}
