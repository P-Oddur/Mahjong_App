// tiles.js — tile mesh factory + table layout + per-update reconciliation.
//
// Responsibilities (contract §5.6):
//   • Load /assets/3d/tiles.glb once and cache the whole node per tile TYPE
//     (S_man1.., S_pin1.., S_sou1.., honors, flowers/seasons, and MahjongTile =
//     the blank/back tile); its geometry + materials are shared across instances.
//   • Map a server tile {suit,value,id} to its GLB node name (§3.1). Note the two
//     translations that are easy to get wrong: server suit 'bam' → GLB 'S_sou',
//     and honors carry STRING values.
//   • Build tile meshes by cloning the cached node and SHARING its (immutable)
//     geometry — only highlighted-discard materials are cloned per instance.
//   • Lay out the world each gameUpdate via reconcile(store):
//       - local hand upright on the rack at relative seat 0, faces toward camera,
//       - opponents as `handCount` face-down blank backs,
//       - exposed melds in front of each seat,
//       - the single shared discardPile (last 40) laid flat in the centre,
//       - a small wall stack sized from wallCount.
//   • Simple eased draw/discard tween (no physics).
//
// This module subscribes indirectly: main.js calls reconcile(store) from the
// state subscriber. It imports seat transforms from seats.js and relative-seat
// math from state.js so layout matches game.js's seating exactly.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as seats from '/js3d/seats.js';
import { relativeSeat } from '/js3d/state.js';
import {
  BLANK_NODE,
  tileNodeName,
  hasDrawnTile,
  orderHandTiles,
  handRackXOffsets,
  seatLocalToWorld,
  discardCell,
  dealBreakSeat,
  easeOutCubic,
  TILE_W0, TILE_T0, TILE_H0, TILE_SCALE, TILE_W, TILE_T, TILE_H,
  CORNER_BONUS,
} from '/js3d/lib/tile-math.js';
import { getValidClaims, getChowOptions } from '/shared/rules-client.js';
import { localClaim } from '/shared/indicator-core.js';

// ─────────────────────────────────────────────────────────────────────────────
// ORIENT — all facing/rotation magic numbers live here so they can be flipped
// trivially during browser testing (contract §3.2 / §7.7). DO NOT scatter raw
// rotations through the layout code; tweak them here instead.
//
//   TILE_FACE_ROT : rotation applied so the carved/painted broad face (+Z of the
//                   geometry) points toward the seated viewer at that seat.
//   TILE_BACK_ROT : rotation that turns the jade-green back toward the viewer
//                   (face-down / opponent-hand / wall tiles).
//   RACK_TILT     : slight backward tilt of upright hand tiles so they read like
//                   tiles standing on a rack rather than perfectly vertical.
//   FACING_FIX    : global yaw nudge if the whole asset set faces the wrong way.
//   DISCARD_FLAT  : rotation that lays a tile flat on the table, face up.
//   WALL_FLAT     : rotation that lays a wall tile flat, face down (blank up).
// ─────────────────────────────────────────────────────────────────────────────
export const ORIENT = {
  // Upright hand tile: the carved face is on the geometry's +Z. A seated player sits
  // on the +side of their seat axis and the carved face must point back AT them
  // (their forward/−Z, composed by the seat yaw in placeInSeatFrame), so the tile
  // needs NO extra Y flip here — identity. Flip to (0, π, 0) if a test shows backs.
  TILE_FACE_ROT: new THREE.Euler(0, 0, 0, 'XYZ'),
  // Back toward the viewer: leave the painted face on +Z (away from a −Z viewer).
  TILE_BACK_ROT: new THREE.Euler(0, 0, 0, 'XYZ'),
  // Stand upright with a tiny lean-back so the row is legible from the seat.
  RACK_TILT: -0.08, // radians, rotation about local X (top tips away from viewer)
  // How far IN from the seat (radius 1.0) tiles sit, so they land ON the ~0.46-radius
  // table rather than floating off its edge. Hand near the edge; melds further in.
  HAND_RING_OFFSET: 0.545, // pulled in from the near edge (~half a tile forward + a roomier ~50% gap
                           // to the table edge) so it clears the bottom-left melds and isn't crammed
  MELD_RING_OFFSET: 0.74,  // → radius ~0.26 (just inside the hand, toward centre)
  // Global facing correction applied on top of every seat facing. 0 until a
  // browser test shows the asset is rotated; then nudge by ±Math.PI/2 etc.
  FACING_FIX: 0,
  // Lay flat on the table, painted face up (rotate −90° about X from upright).
  DISCARD_FLAT: new THREE.Euler(-Math.PI / 2, 0, 0, 'XYZ'),
  // Lay flat, blank/back up (face down).
  WALL_FLAT: new THREE.Euler(Math.PI / 2, 0, 0, 'XYZ'),
};

// ── Tile geometry constants (metres, per §3.2) ───────────────────────────────
// Native GLB tile dimensions (TILE_W0/T0/H0), the global up-scale (TILE_SCALE,
// applied to every mesh AND to all layout spacing/heights so tiles stay edge-to-edge
// and rest correctly), and the scaled dims (TILE_W/T/H) all live in lib/tile-math.js
// now — imported above so the layout math and the meshes share one source.

const TABLE_TOP_Y = 0.78;  // table FRAME top (= felt slab centre); used for throw-in start height
const FELT_TOP_Y  = 0.791; // TRUE top surface of the 0.02 m felt (furniture.js FELT_TOP). Tiles
                           // rest on THIS, not the frame top, or they sink ~11 mm into the felt.
const TILE_LIFT = 0.0006;  // hair of lift so a tile sits just proud of the felt (no z-fight)
const TILE_REST_Y = FELT_TOP_Y + TILE_T / 2 + TILE_LIFT; // centre Y of a tile lying flat

const TILES_GLB = '/assets/3d/tiles.glb';
// BLANK_NODE ('MahjongTile', the blank tile used for backs/wall) is imported from
// lib/tile-math.js so the node-name mapping and its blank fallback share one source.

// Render caps mirroring the 2D client.
const MAX_DISCARDS = 40;

// Shared fallback geometry + material for missing-node tiles — module-level so the
// degraded path allocates (and leaks) nothing per instance; like the cached GLB
// geometry these are never mutated per instance and live for the page lifetime.
const FALLBACK_GEO = new THREE.BoxGeometry(TILE_W0, TILE_H0, TILE_T0);
const FALLBACK_MAT = new THREE.MeshStandardMaterial({ color: 0xeae6d8, roughness: 0.6 });

// Scratch objects reused to avoid per-frame allocation in the tween/layout path.
const _q = new THREE.Quaternion();
const _qFrom = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);    // reused axis for seat-yaw rotations
const _RIGHT = new THREE.Vector3(1, 0, 0); // reused axis for the upright rack tilt
const _box = new THREE.Box3();             // reused for resting tiles flush on the table top
const _throwTmp = new THREE.Object3D();    // scratch transform for a discard's throw-in start

// ── Caches & scene-graph roots ───────────────────────────────────────────────
// nodeName -> { geometry: THREE.BufferGeometry, material: THREE.Material }
const tileCache = new Map();
let loaded = false;

// A single parent group for everything this module owns, added lazily to the
// scene the first time reconcile() sees a scene handle. main.js passes the store,
// not the scene, so we grab the scene from the first tile mesh's eventual parent;
// instead we keep our own root and attach it on first reconcile via a setter.
const root = new THREE.Group();
root.name = 'TilesRoot';
let attached = false;
let wallBuilt = false; // the wall pinwheel is static (always full) — build it once, not every reconcile

// Sub-groups so we can clear/rebuild each region independently.
const groups = {
  hands: new THREE.Group(),    // all four players' concealed hands
  melds: new THREE.Group(),    // all exposed melds
  discards: new THREE.Group(), // shared centre pool
  wall: new THREE.Group(),     // remaining-wall stack indicator
};
groups.hands.name = 'Hands';
groups.melds.name = 'Melds';
groups.discards.name = 'Discards';
groups.wall.name = 'Wall';
root.add(groups.hands, groups.melds, groups.discards, groups.wall);

// Active tweens, processed by updateTweens(dt) from the render loop (re-exported
// as part of tweenTo's contract). Each: { mesh, fromPos, toPos, fromQuat, toQuat,
// elapsed, duration, onDone }.
const tweens = [];

// Id of the discard whose one-shot drop-in animation has already played, so an
// unrelated gameUpdate re-laying the same pile doesn't re-bounce the last discard.
let lastAnimatedDiscardId = null;

// Accumulated time (seconds) for the claim-glow pulse.
let glowT = 0;
let glowMeshes = []; // discard sub-meshes currently tagged claim-glow (pulsed per frame; see updateTweens)

// ── Loading ──────────────────────────────────────────────────────────────────

// loadTileGeometries(): load the GLB once, caching the whole node per name. Geometry
// AND materials are shared across instances (neither is mutated per instance; only
// the highlighted discard clones its material), so reconcile has no per-tile GPU churn.
export async function loadTileGeometries() {
  if (loaded) return;
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.load(TILES_GLB, resolve, undefined, reject);
  });

  // Each tile TYPE is a top-level node named S_man1.. / S_pin.. / MahjongTile /
  // etc. In the GLB it is a single multi-primitive mesh (one primitive per material:
  // ivory body, painted numerals/pips, jade back) that GLTFLoader expands into a
  // small group of primitive meshes. We cache and clone the WHOLE node so every
  // painted primitive is preserved — caching the child meshes individually (as an
  // earlier version did) kept only the ivory body and rendered blank tiles.
  for (const node of gltf.scene.children) {
    if (!node.name || tileCache.has(node.name)) continue;
    let hasMesh = false;
    node.traverse(o => { if (o.isMesh) { hasMesh = true; applySRGB(o.material); } });
    if (hasMesh) tileCache.set(node.name, { node });
  }

  if (!tileCache.has(BLANK_NODE)) {
    console.warn(`[tiles] GLB missing "${BLANK_NODE}" node — backs will fall back to a box`);
  }
  loaded = true;
}

// Mark any colour map on a material as sRGB so faces aren't washed out.
function applySRGB(material) {
  const mats = Array.isArray(material) ? material : [material];
  for (const m of mats) {
    if (m && m.map && m.map.colorSpace !== THREE.SRGBColorSpace) {
      m.map.colorSpace = THREE.SRGBColorSpace;
      m.map.needsUpdate = true;
    }
  }
}

// ── Tile → GLB node name ─────────────────────────────────────────────────────
// The server-tile → GLB node mapping (contract §3.1, incl. the bam→sou and
// flower/season traps and the warn-once-on-unmapped fallback) lives in
// lib/tile-math.js where it is unit-tested. Re-export it so callers that reach for
// tiles.tileNodeName keep working.
export { tileNodeName };

// ── Mesh factory ─────────────────────────────────────────────────────────────

// makeTileMesh(tile, faceUp): clone the cached geometry for the tile's node and
// return a Mesh tagged with userData {tileId, suit, value}. faceUp=false renders
// the blank back (opponent hands / wall) — we use the blank node and the back
// rotation so no real face is exposed.
export function makeTileMesh(tile, faceUp = true) {
  const nodeName = faceUp ? tileNodeName(tile) : BLANK_NODE;
  const mesh = buildMeshFromCache(nodeName);

  // Default upright orientation: face the local viewer (−Z) when up, back when down.
  mesh.quaternion.setFromEuler(faceUp ? ORIENT.TILE_FACE_ROT : ORIENT.TILE_BACK_ROT);

  mesh.userData.tileId = (tile && typeof tile === 'object') ? tile.id : null;
  mesh.userData.suit = (tile && typeof tile === 'object') ? tile.suit : null;
  mesh.userData.value = (tile && typeof tile === 'object') ? tile.value : null;
  mesh.userData.faceUp = faceUp;
  mesh.userData.isTile = true;
  return mesh;
}

// makeBackMesh(): a blank face-down tile (opponent hands / wall stacks).
export function makeBackMesh() {
  const mesh = buildMeshFromCache(BLANK_NODE);
  mesh.quaternion.setFromEuler(ORIENT.TILE_BACK_ROT);
  mesh.userData.isTile = true;
  mesh.userData.tileId = null;
  mesh.userData.faceUp = false;
  return mesh;
}

// Internal: produce a Mesh for a node name, cloning the cached geometry. Falls
// back to a plain box of the right dimensions if the node is missing (so a partial
// asset still renders something instead of throwing).
function buildMeshFromCache(nodeName) {
  const cached = tileCache.get(nodeName) || tileCache.get(BLANK_NODE);
  let mesh;
  if (cached && cached.node) {
    // Clone the whole tile node (all painted primitives). clone(true) SHARES the
    // child geometry + material refs with the cache. The geometry is never mutated
    // per instance (only highlightMesh() clones a material), so we intentionally keep
    // it shared — cloning ~3-6 geometries per tile every reconcile was pure GC/GPU
    // churn. disposeMesh() therefore disposes only cloned materials, never geometry.
    mesh = cached.node.clone(true);
    // The cached node sits at its packing offset in the GLB; neutralize the node
    // transform so our layout transforms (placeInSeatFrame) position it.
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.setScalar(TILE_SCALE); // global tile up-scale
    mesh.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
    });
  } else {
    // Missing node → a shared fallback box (one geometry + material for the whole
    // module, so the degraded path allocates/leaks nothing per instance).
    mesh = new THREE.Mesh(FALLBACK_GEO, FALLBACK_MAT);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.scale.setScalar(TILE_SCALE); // match the GLB tiles' global up-scale
  }
  return mesh;
}

// ── Seat geometry helpers ────────────────────────────────────────────────────
// We lean on seats.js for transforms but tolerate it not being fully populated
// yet (other agents author it in parallel). These fallbacks mirror the contract's
// seat ring (radius ~1.0 m, table centre origin) so layout is still correct.

const SEAT_RING = 1.0; // metres from table centre

// Fallback seat transform if seats.seatTransform is unavailable. rel: 0..3.
function seatFallback(rel) {
  // rel 0 near (+Z, faces −Z), 1 right (+X, faces −X),
  // 2 across (−Z, faces +Z), 3 left (−X, faces +X).
  const layout = [
    { pos: new THREE.Vector3(0, 0, +SEAT_RING), facing: 0 },
    { pos: new THREE.Vector3(+SEAT_RING, 0, 0), facing: Math.PI / 2 },
    { pos: new THREE.Vector3(0, 0, -SEAT_RING), facing: Math.PI },
    { pos: new THREE.Vector3(-SEAT_RING, 0, 0), facing: -Math.PI / 2 },
  ];
  return layout[rel] || layout[0];
}

// Get {pos, facing} for a relative seat, preferring seats.js when available.
function seatXform(rel) {
  if (seats && typeof seats.seatTransform === 'function') {
    const t = seats.seatTransform(rel);
    if (t && t.pos) {
      return {
        pos: t.pos,
        facing: (typeof t.facing === 'number' ? t.facing : seatFallback(rel).facing),
      };
    }
  }
  return seatFallback(rel);
}

// Seat facing yaw, with the global FACING_FIX folded in.
function seatYaw(rel) {
  return seatXform(rel).facing + ORIENT.FACING_FIX;
}

// Place `obj` at a position expressed in a seat's local frame (x = along the
// player's left→right, z = toward/away from the table centre, y = up from the
// table top), then add it to `parent`. Returns the obj for chaining.
function placeInSeatFrame(obj, rel, localX, localZ, y, extraQuat) {
  const yaw = seatYaw(rel);
  // Rotate the seat-local offset (x = player's left→right, −z = toward centre) into world
  // XZ via the pure core, which uses THREE's +Y-rotation handedness so the offset direction
  // AGREES with the seat's facing yaw. (An earlier opposite-handedness formula flung the
  // side-seat hands out to radius ~1.3 behind the player — see lib/tile-math.js.)
  const w = seatLocalToWorld(seatXform(rel).pos, yaw, localX, localZ);
  obj.position.set(w.x, y, w.z);

  // Compose seat yaw with the object's own (face/back/flat) rotation.
  _q.setFromAxisAngle(_UP, yaw);
  if (extraQuat) _q.multiply(extraQuat);
  obj.quaternion.copy(_q);
  return obj;
}

// restOnTable(mesh): after a tile's transform is set, shift it vertically so its LOWEST
// point sits exactly on the table top (+ a tiny lift). This is robust to the GLB tile's
// pivot/offset, so neither upright nor flat tiles sink into the felt — it fixes tile faces
// being clipped below the surface. The Tiles root + sub-groups sit at the world origin, so
// the mesh's local transform already equals its world transform here.
function restOnTable(mesh, lift = TILE_LIFT) {
  mesh.updateMatrixWorld(true);
  _box.setFromObject(mesh);
  if (Number.isFinite(_box.min.y)) mesh.position.y += (FELT_TOP_Y + lift) - _box.min.y;
}

// ── Reconcile (the per-update entry point) ───────────────────────────────────
// main.js wires: state.subscribe(store => tiles.reconcile(store)). We rebuild the
// dynamic regions from the authoritative snapshot. v1 does a clear-and-rebuild
// (cheap at this tile count); draw/discard motion is conveyed by tweenTo on the
// freshly placed discard/draw tile via the diff below.
export function reconcile(store) {
  if (!loaded) return;            // geometry not ready yet; main loads before subscribe
  ensureAttached(store);

  const gs = store && store.gameState;
  if (!gs || !gs.players) return;

  const n = gs.players.length;

  // --- Hands: own hand upright + face-up; opponents = handCount blank backs. ---
  clearGroup(groups.hands);
  for (let abs = 0; abs < n; abs++) {
    const p = gs.players[abs];
    if (!p) continue;
    const rel = relativeSeat(abs);
    if (rel === 0 && Array.isArray(p.hand)) {
      layoutHandRack(p.hand, 0, gs.drawnId);
    } else {
      layoutOpponentHand(p.handCount || 0, rel);
    }
  }

  // --- Melds + bonus flowers: in front of each seat. ---
  clearGroup(groups.melds);
  for (let abs = 0; abs < n; abs++) {
    const p = gs.players[abs];
    if (!p) continue;
    const rel = relativeSeat(abs);
    const hasBonus = (Array.isArray(p.melds) && p.melds.length) ||
                     (Array.isArray(p.flowers) && p.flowers.length);
    if (hasBonus) layoutCornerBonus(p.melds || [], p.flowers || [], rel, abs);
  }

  // --- Discards: one shared pool, last 40, flat in the centre, last highlighted. ---
  // Glow the live discard only when the local player can claim it. localClaim is the
  // shared, memoised affordance the HUD reaction panel also reads, so getValidClaims
  // runs once per gameUpdate rather than once per consumer.
  const canClaim = localClaim(gs, store.myIndex, getValidClaims, getChowOptions).valid.length > 0;
  layoutDiscards(gs.discardPile || [], gs.lastDiscard, gs.lastDiscardPlayer, canClaim);

  // --- Wall: the full static pinwheel (a visual indicator; the live count shows in the HUD).
  // It never changes between deals, so build it ONCE — rebuilding 144 meshes every gameUpdate
  // was pure churn.
  if (!wallBuilt) { layoutWall(); wallBuilt = true; }

  // If an opening deal-in jump is queued and the hand is now laid, play it.
  applyDealInIfReady();
}

// Attach our root to the scene exactly once. We discover the scene by walking up
// from any existing object the store may carry; main.js doesn't hand us the scene
// directly, so we accept a scene attached via setScene() OR fall back to grabbing
// it from the first reconcile if the store exposes it.
let sceneRef = null;
export function setScene(scene) { sceneRef = scene; }
function ensureAttached(store) {
  if (attached) return;
  // Prefer an explicitly-set scene; otherwise look for one on the store.
  const scene = sceneRef || (store && store.scene) || null;
  if (scene) { scene.add(root); attached = true; }
}

// Remove and dispose all children of a group. Any active tween targeting a removed
// child is dropped first so updateTweens never animates a detached mesh.
function clearGroup(group) {
  for (let i = group.children.length - 1; i >= 0; i--) {
    const child = group.children[i];
    group.remove(child);
    dropTweensFor(child);
    disposeMesh(child);
  }
}

// Drop any active tween whose target mesh is being removed.
function dropTweensFor(mesh) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    if (tweens[i].mesh === mesh) tweens.splice(i, 1);
  }
}

function disposeMesh(obj) {
  obj.traverse(o => {
    if (!o.isMesh) return;
    // Geometry is shared from the module-level cache (and the shared fallback) and
    // is never mutated per instance, so it must NOT be disposed here — only the
    // per-instance material clone we make for the highlighted discard is owned by
    // the instance.
    if (o.userData && o.userData.clonedMaterial && o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m.dispose();
    }
  });
}

// ── Hand layout ──────────────────────────────────────────────────────────────

// layoutHandRack(handTiles, relSeat): place sorted own-hand tiles upright on the
// rack at relSeat (0 for the local player), faces toward the camera. The hand is
// centred along the seat's left→right axis just in front of the player.
export function layoutHandRack(handTiles, relSeat, drawnId = null) {
  const src = handTiles || [];
  // Pull the freshly-drawn tile to the FAR RIGHT (with an extra gap) so it's obvious which tile was
  // just drawn (server marks it via drawnId). The rest keep their sent (sorted/shuffled) order.
  const hasDrawn = hasDrawnTile(src, drawnId);
  const tiles = orderHandTiles(src, drawnId);
  const count = tiles.length;
  const gap = TILE_W;                // edge-to-edge spacing between tiles
  const DRAWN_GAP = TILE_W * 0.9;    // extra space inserted before the drawn tile on the right

  // Per-tile x offsets along the rack (drawn tile pushed right by DRAWN_GAP); the row stays centred.
  const { xs, startX } = handRackXOffsets(count, hasDrawn, gap, DRAWN_GAP);

  // Upright tile: the geometry is ALREADY height-up (width X, height Y, face on +Z),
  // so we do NOT rotate it onto its back — we only turn the carved face toward the
  // seated viewer (TILE_FACE_ROT) and lean it back slightly (RACK_TILT). The seat
  // yaw is composed on top inside placeInSeatFrame.
  const faceRot = new THREE.Quaternion().setFromEuler(ORIENT.TILE_FACE_ROT);
  const tilt = new THREE.Quaternion().setFromAxisAngle(_RIGHT, ORIENT.RACK_TILT);
  const upright = new THREE.Quaternion().multiplyQuaternions(tilt, faceRot);

  // z just in front of the player toward the centre; y so the tile stands on the top.
  const localZ = -ORIENT.HAND_RING_OFFSET;    // toward table centre; lands on the table
  const standY = TABLE_TOP_Y + TILE_H / 2;

  for (let i = 0; i < count; i++) {
    const mesh = makeTileMesh(tiles[i], true);
    placeInSeatFrame(mesh, relSeat, startX + xs[i], localZ, standY, upright);
    restOnTable(mesh);
    groups.hands.add(mesh);
  }
}

// layoutOpponentHand(count, relSeat): `count` blank backs standing upright at the
// seat, faces away from us (toward that opponent). Same upright stand as the rack.
function layoutOpponentHand(count, relSeat) {
  const gap = TILE_W;
  const totalW = count > 0 ? (count - 1) * gap : 0;
  const startX = -totalW / 2;
  // Upright blank backs (jade back toward the table centre), matching the local rack.
  const upright = new THREE.Quaternion().setFromAxisAngle(_RIGHT, ORIENT.RACK_TILT);
  const localZ = -ORIENT.HAND_RING_OFFSET;
  const standY = TABLE_TOP_Y + TILE_H / 2;

  for (let i = 0; i < count; i++) {
    const mesh = makeBackMesh();
    placeInSeatFrame(mesh, relSeat, startX + i * gap, localZ, standY, upright);
    restOnTable(mesh);
    groups.hands.add(mesh);
  }
}

// ── Meld layout ──────────────────────────────────────────────────────────────

// layoutCornerBonus(melds, flowers, relSeat, absSeat): exposed FLOWERS then MELDS laid flat, face up,
// in ONE row tucked into the seat's bottom-LEFT felt corner (meeting the left edge). Flowers always
// come first from the far corner — in their reveal order — then the melds in their reveal order, so a
// late flower still sorts ahead of an earlier meld. Opponent concealed-kongs hide their end tiles.
function layoutCornerBonus(melds, flowers, relSeat, absSeat) {
  const isLocal = relSeat === 0;
  // Placement (leftX/localZ/gaps) lives in lib/tile-math.js CORNER_BONUS, chosen so the
  // flat row clears the raised inlaid border (else it clips into it — see the tile-math
  // cornerBonusClearance test). The row tucks into the seat's bottom-left, growing right.
  const gap = CORNER_BONUS.gap;
  const meldGap = CORNER_BONUS.meldGap;
  const CORNER_X = CORNER_BONUS.leftX;
  const localZ = CORNER_BONUS.localZ;
  const faceFlat = new THREE.Quaternion().setFromEuler(ORIENT.DISCARD_FLAT);
  let cursorX = CORNER_X;

  // Flowers first (oldest at the far corner), in reveal order.
  for (const t of (flowers || [])) {
    const mesh = makeTileMesh(t, true);
    placeInSeatFrame(mesh, relSeat, cursorX, localZ, TILE_REST_Y, faceFlat);
    restOnTable(mesh);
    groups.melds.add(mesh);
    cursorX += gap;
  }
  if ((flowers || []).length && (melds || []).length) cursorX += meldGap; // small break before melds

  // Then melds (oldest first), in reveal order.
  for (const meld of (melds || [])) {
    const concealed = meld.type === 'concealed-kong';
    meld.tiles.forEach((t, idx) => {
      const faceUp = isLocal || !concealed || (idx === 1 || idx === 2);
      const mesh = faceUp ? makeTileMesh(t, true) : makeBackMesh();
      const q = faceUp ? faceFlat : new THREE.Quaternion().setFromEuler(ORIENT.WALL_FLAT);
      placeInSeatFrame(mesh, relSeat, cursorX, localZ, TILE_REST_Y, q);
      restOnTable(mesh);
      groups.melds.add(mesh);
      cursorX += gap;
    });
    cursorX += meldGap;
  }
}

// ── Discard layout ───────────────────────────────────────────────────────────

// layoutDiscards(pile, lastDiscard): render the last MAX_DISCARDS tiles of the
// shared pool laid flat, face up, in a centre grid. The most recent discard
// (lastDiscard, matched by .id) is nudged up slightly and tweened into place.
function layoutDiscards(pile, lastDiscard, lastDiscardPlayer, canClaim) {
  clearGroup(groups.discards);
  glowMeshes.length = 0; // the prior glow tiles were just disposed; highlightMesh repopulates below

  const shown = pile.length > MAX_DISCARDS ? pile.slice(pile.length - MAX_DISCARDS) : pile;
  const perRow = 10;                 // 10 across × up to 4 rows
  const stepX = TILE_W;
  const stepZ = TILE_H;      // when flat, the tile's height extends along Z
  const flat = new THREE.Quaternion().setFromEuler(ORIENT.DISCARD_FLAT);
  let discardRestY = null; // every discard is the same flat tile, so its felt-rest Y is identical — compute once

  const lastId = lastDiscard && typeof lastDiscard === 'object' ? lastDiscard.id : null;

  shown.forEach((t, i) => {
    const { x, z } = discardCell(i, perRow, stepX, stepZ);

    const mesh = makeTileMesh(t, true);
    mesh.position.set(x, TILE_REST_Y, z);
    mesh.quaternion.copy(flat);
    if (discardRestY === null) { restOnTable(mesh); discardRestY = mesh.position.y; }
    else mesh.position.y = discardRestY; // reuse the cached felt-rest Y (mirrors the wall)

    // Highlight + tween the just-discarded tile: start a touch above and ease down.
    if (lastId != null && t && t.id === lastId) {
      mesh.userData.isLastDiscard = true;
      // Play the drop-in only the first time this tile becomes the newest discard —
      // re-laying the same pile on an unrelated gameUpdate must not re-bounce it.
      if (lastId !== lastAnimatedDiscardId) {
        lastAnimatedDiscardId = lastId;
        const target = mesh.position.clone();
        // Throw the tile IN from the discarder's hand area, arcing to the centre pool, so a
        // discard reads as a toss onto the table rather than a tile blinking into place.
        if (lastDiscardPlayer != null) {
          const rel = relativeSeat(lastDiscardPlayer);
          placeInSeatFrame(_throwTmp, rel, 0, -ORIENT.HAND_RING_OFFSET, TABLE_TOP_Y + 0.05);
          mesh.position.copy(_throwTmp.position);
          tweenTo(mesh, target, flat, 360, 0.07); // 0.07 m arc hop
        } else {
          const start = target.clone();
          start.y += 0.06; // drop-in fallback height
          mesh.position.copy(start);
          tweenTo(mesh, target, flat, 220);
        }
      }
      // The emissive highlight is a persistent "live discard" marker, so it is
      // re-applied on every rebuild (the mesh is recreated each reconcile).
      if (canClaim) highlightMesh(mesh);
    }

    groups.discards.add(mesh);
  });
}

// Give a mesh a soft emissive highlight (clones the material so we don't tint the
// shared cache material). Used for the latest discard.
function highlightMesh(mesh) {
  // The tile is a group of carved primitives; clone each child's material(s) so the
  // shared cache material isn't tinted, and mark each child for disposal.
  const apply = m => { if (m && m.emissive) { m.emissive.setHex(0xf0c040); m.emissiveIntensity = 1.0; } };
  mesh.traverse(o => {
    if (!o.isMesh || !o.material) return;
    const mat = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone();
    if (Array.isArray(mat)) mat.forEach(apply); else apply(mat);
    o.material = mat;
    o.userData.clonedMaterial = true;
    o.userData.claimGlow = true;
    glowMeshes.push(o); // track for the per-frame pulse (reset in layoutDiscards)
  });
}

// ── Wall layout ──────────────────────────────────────────────────────────────

// layoutWall(): the undrawn wall as the classic mahjong PINWHEEL — four 2-high rows, one per side,
// each offset so its HEAD sits at a corner and meets the NEXT wall at its 13TH tile while its TAIL
// (the last 5 tiles) trails past the corner by itself on the felt. That offset (NOT removing stacks)
// is what makes the small slanted square. The whole pinwheel is SLANTED ~20° about the table centre
// (reference look) and is ALWAYS rendered FULL — 18 stacks/side, 2 high — with the live remaining
// count shown in the HUD text. Plain back meshes; perf is well within the ~557-mesh @144 FPS budget.
function layoutWall() {
  clearGroup(groups.wall);
  const WALL_SLANT = 0.35;             // radians (~20°) — slant the whole pinwheel (reference)
  groups.wall.rotation.y = WALL_SLANT; // (clearGroup keeps the group, so re-set the rotation each build)
  const flatBack = new THREE.Quaternion().setFromEuler(ORIENT.WALL_FLAT);
  const stepX = TILE_W;
  const seatR = Math.hypot(seatXform(0).pos.x, seatXform(0).pos.z) || 0.92;

  // ALWAYS the FULL wall: 18 stacks/side. The head meets the adjacent wall at its 13th tile
  // (connectStack = 12 → R = 6 tile-widths), leaving a 5-tile tail trailing past the corner.
  const STACKS_PER_SIDE = 18;
  const connectStack = 12;
  const R = (connectStack / 2) * stepX;
  const localZ = -(seatR - R);
  let baseRestY = null; // all wall tiles are identical blanks at the same orientation/scale

  for (let side = 0; side < 4; side++) {
    for (let s = 0; s < STACKS_PER_SIDE; s++) {
      const localX = R - s * stepX;    // s=0 head at the corner; increasing s -> tail trailing past it
      for (let layer = 0; layer < 2; layer++) {
        const mesh = makeBackMesh();
        placeInSeatFrame(mesh, side, localX, localZ, TILE_REST_Y, flatBack);
        // The felt-rest Y is identical for every wall tile, so compute it ONCE and reuse it.
        if (baseRestY === null) { restOnTable(mesh); baseRestY = mesh.position.y; }
        else mesh.position.y = baseRestY;
        mesh.position.y += layer * TILE_T; // stack the second layer above the first
        groups.wall.add(mesh);
      }
    }
  }
}

// ── Tweening (simple eased transform; no physics) ────────────────────────────

// tweenTo(mesh, targetPos, targetQuat, ms): ease a mesh's position+rotation to a
// target over `ms`. targetQuat may be a Quaternion or Euler. Replaces any active
// tween already running on the same mesh.
export function tweenTo(mesh, targetPos, targetQuat, ms = 250, arc = 0, delay = 0) {
  // Drop an existing tween on this mesh.
  for (let i = tweens.length - 1; i >= 0; i--) {
    if (tweens[i].mesh === mesh) tweens.splice(i, 1);
  }
  const toQuat = (targetQuat instanceof THREE.Quaternion)
    ? targetQuat.clone()
    : new THREE.Quaternion().setFromEuler(targetQuat);
  tweens.push({
    mesh,
    fromPos: mesh.position.clone(),
    toPos: targetPos.clone ? targetPos.clone() : new THREE.Vector3().copy(targetPos),
    fromQuat: mesh.quaternion.clone(),
    toQuat,
    elapsed: 0,
    duration: Math.max(1, ms),
    arc,
    delay: Math.max(0, delay), // ms to wait at the start pose before animating (deal stagger)
  });
}

// updateTweens(dt): advance all active tweens. Call once per frame. (Exported so
// the render loop can drive it; main.js's loop comment references "tiles tweens".)
export function updateTweens(dt) {
  // Pulse the claim-glow emissive on the (at most one) tagged discard. Tracked in a small
  // array by highlightMesh, so the common no-glow frame doesn't traverse the whole pile.
  glowT += dt;
  if (glowMeshes.length) {
    const pulse = 0.9 + 0.3 * Math.sin(glowT * 4);
    for (const o of glowMeshes) {
      const m = o.material;
      if (Array.isArray(m)) m.forEach(x => { if (x && x.emissive) x.emissiveIntensity = pulse; });
      else if (m && m.emissive) m.emissiveIntensity = pulse;
    }
  }

  if (!tweens.length) return;
  const dtMs = dt * 1000;
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    if (tw.delay > 0) { tw.delay -= dtMs; continue; } // hold at the start pose until the delay elapses
    tw.elapsed += dtMs;
    const t = Math.min(1, tw.elapsed / tw.duration);
    const e = easeOutCubic(t);
    _v.copy(tw.fromPos).lerp(tw.toPos, e);
    tw.mesh.position.copy(_v);
    if (tw.arc) tw.mesh.position.y += tw.arc * Math.sin(Math.PI * e); // parabolic throw hop
    _qFrom.copy(tw.fromQuat).slerp(tw.toQuat, e);
    tw.mesh.quaternion.copy(_qFrom);
    if (t >= 1) tweens.splice(i, 1);
  }
}


// ── Opening deal-in animation (driven by deal.js) ────────────────────────────
// startDealIn(dealer, diceVals): make every freshly-laid hand tile "jump" in from the
// dice-determined wall break to its laid slot, staggered, so the opening reads as tiles
// being dealt out. Cosmetic only — the tiles' final identities/positions are unchanged
// (HK dealing is animation-only). Call AFTER reconcile() has laid the new hand.
// Pending deal-in params, set by startDealIn and applied once reconcile has laid the hand meshes
// — the fresh-deal gameUpdate can arrive BEFORE the async tiles.glb finishes loading.
let _pendingDealIn = null;

export function startDealIn(dealer, diceVals) {
  _pendingDealIn = { dealer, diceVals };
  applyDealInIfReady();
}

// applyDealInIfReady(): run the queued deal-in jump once the hand meshes exist. Called from
// startDealIn AND at the end of reconcile(), so it fires whether the deal was triggered before or
// after the tiles loaded (fixes the first hand's jump silently no-op'ing on a cold load).
function applyDealInIfReady() {
  if (!_pendingDealIn) return;
  const hands = groups.hands.children;
  if (!hands.length) return;          // wait for reconcile to lay the hand
  const { dealer, diceVals } = _pendingDealIn;
  _pendingDealIn = null;
  const start = computeDealStart(dealer, diceVals);
  for (let i = 0; i < hands.length; i++) {
    const mesh = hands[i];
    const finalPos = mesh.position.clone();
    const finalQuat = mesh.quaternion.clone();
    // Start at the broken wall side, with a little spread so they don't stack on one point.
    mesh.position.set(
      start.x + (((i * 37) % 9) - 4) * 0.012,
      start.y,
      start.z + (((i * 53) % 9) - 4) * 0.012,
    );
    tweenTo(mesh, finalPos, finalQuat, 300, 0.05, i * 8); // staggered jump-in
  }
}

// snapDealIn(): immediately finish any in-flight hand deal-in tween (skip the animation).
export function snapDealIn() {
  _pendingDealIn = null;               // cancel a queued (not-yet-applied) deal-in too
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    if (tw.mesh && tw.mesh.parent === groups.hands) {
      tw.mesh.position.copy(tw.toPos);
      tw.mesh.quaternion.copy(tw.toQuat);
      tweens.splice(i, 1);
    }
  }
}

// computeDealStart(dealer, diceVals): the world point the deal-in tiles fly FROM — the wall
// side the dice "break". Standard HK: the dice sum counts seats counter-clockwise from the
// dealer to pick which player's wall is opened; we start the tiles from that wall side.
function computeDealStart(dealer, diceVals) {
  const dealerRel = relativeSeat(dealer == null ? 0 : dealer);
  const breakRel = dealBreakSeat(dealerRel, diceVals); // wall in front of the dice-counted seat
  const seatR = Math.hypot(seatXform(0).pos.x, seatXform(0).pos.z) || 0.92;
  placeInSeatFrame(_throwTmp, breakRel, 0, -(seatR - 0.40), TABLE_TOP_Y + 0.06);
  return _throwTmp.position.clone();
}

// ── Reticle hit-test ─────────────────────────────────────────────────────────

// tileAtReticle(raycaster): return the local-hand tile mesh currently under the
// reticle (for select/discard), or null. Only the local player's face-up hand
// tiles are selectable (they carry a numeric tileId from a real tile object).
export function tileAtReticle(raycaster) {
  if (!raycaster) return null;
  // Tiles are GROUPS (a holder per tile, with carved primitive children), so we must
  // raycast recursively and walk each hit up to the holder carrying the tile userData.
  const hits = raycaster.intersectObjects(groups.hands.children, true);
  for (const hit of hits) {
    let m = hit.object;
    while (m && !(m.userData && m.userData.isTile)) m = m.parent;
    if (m && m.userData.isTile && m.userData.faceUp && m.userData.tileId != null) {
      return m;
    }
  }
  return null;
}
