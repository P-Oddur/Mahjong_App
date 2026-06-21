// tiles.js — tile mesh factory + table layout + per-update reconciliation.
//
// Responsibilities (contract §5.6):
//   • Load /assets/3d/tiles.glb once and cache one BufferGeometry + Material per
//     tile TYPE node (S_man1.., S_pin1.., S_sou1.., honors, flowers/seasons,
//     and MahjongTile = the blank/back tile).
//   • Map a server tile {suit,value,id} to its GLB node name (§3.1). Note the two
//     translations that are easy to get wrong: server suit 'bam' → GLB 'S_sou',
//     and honors carry STRING values.
//   • Build tile meshes by CLONING the cached geometry (geometry is immutable to
//     the renderer, but we clone so per-instance work never mutates the cache).
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
  HAND_RING_OFFSET: 0.62, // → radius ~0.38 (on table, near the player's edge)
  MELD_RING_OFFSET: 0.74, // → radius ~0.26 (just inside the hand, toward centre)
  // Global facing correction applied on top of every seat facing. 0 until a
  // browser test shows the asset is rotated; then nudge by ±Math.PI/2 etc.
  FACING_FIX: 0,
  // Lay flat on the table, painted face up (rotate −90° about X from upright).
  DISCARD_FLAT: new THREE.Euler(-Math.PI / 2, 0, 0, 'XYZ'),
  // Lay flat, blank/back up (face down).
  WALL_FLAT: new THREE.Euler(Math.PI / 2, 0, 0, 'XYZ'),
};

// ── Tile geometry constants (metres, per §3.2) ───────────────────────────────
const TILE_W = 0.022; // X — width
const TILE_T = 0.016; // Z — thickness (front-to-back when flat)
const TILE_H = 0.030; // Y — height

const TABLE_TOP_Y = 0.78; // table top surface height (env asset, §7.2)
const TILE_REST_Y = TABLE_TOP_Y + TILE_T / 2; // centre Y of a tile lying flat

const TILES_GLB = '/assets/3d/tiles.glb';
const BLANK_NODE = 'MahjongTile'; // the blank tile used for backs/wall

// Render caps mirroring the 2D client.
const MAX_DISCARDS = 40;

// Scratch objects reused to avoid per-frame allocation in the tween path.
const _q = new THREE.Quaternion();
const _qFrom = new THREE.Quaternion();
const _v = new THREE.Vector3();

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

// ── Loading ──────────────────────────────────────────────────────────────────

// loadTileGeometries(): load the GLB once, cache geometry+material per node name.
// Geometry is cloned per instance in makeTileMesh; materials are shared (the face
// texture/material is identical for every instance of a given tile type).
export async function loadTileGeometries() {
  if (loaded) return;
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.load(TILES_GLB, resolve, undefined, reject);
  });

  // Each tile TYPE is a top-level GROUP named S_man1.. / S_pin.. / MahjongTile /
  // etc., whose children are the carved primitives — ONE mesh per material (ivory
  // body, painted numerals/pips, jade back). We must cache and clone the whole
  // GROUP: caching the child meshes individually (as before) only kept the ivory
  // body and dropped every painted primitive, rendering blank ivory tiles.
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

// ── Tile → GLB node name (contract §3.1, reproduced exactly) ─────────────────
export function tileNodeName(tile) {
  // tile = { suit, value, id }; literal 'back' or null → blank tile.
  if (!tile || tile === 'back') return BLANK_NODE;

  switch (tile.suit) {
    case 'man': return 'S_man' + tile.value;          // value 1..9
    case 'pin': return 'S_pin' + tile.value;          // value 1..9
    case 'bam': return 'S_sou' + tile.value;          // server 'bam' → GLB 'sou', 1..9
    case 'wind':
      return { east: 'S_dong', south: 'S_nan', west: 'S_xi', north: 'S_bei' }[tile.value];
    case 'dragon':
      return { red: 'S_zhong', green: 'S_fa', white: 'S_bai' }[tile.value];
    case 'flower':
      // 8 flower tiles, value 1..8. Convention: 1..4 = "flowers" (S_flower1..4),
      // 5..8 = "seasons" (S_season1..4). Single isolated remap point if the
      // carved faces disagree during browser testing.
      return tile.value <= 4 ? ('S_flower' + tile.value)
                             : ('S_season' + (tile.value - 4));
    default:
      return BLANK_NODE; // unknown → blank
  }
}

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
    // Deep-clone the whole tile group (all painted primitives). clone() shares the
    // child geometry + material refs; give each clone its OWN geometry so the
    // per-update clearGroup()/disposeMesh() can dispose it without corrupting the
    // cache. Materials stay shared (identical face for every instance of this type)
    // except where highlightMesh() clones them.
    mesh = cached.node.clone(true);
    // The cached group sits at its packing offset in the GLB; neutralize the group
    // transform so our layout transforms (placeInSeatFrame) position it. The carved
    // geometry is centered on the group's local origin, so this leaves a tile
    // centered at the mesh origin (matching the fallback box).
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
    mesh.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      if (o.geometry) o.geometry = o.geometry.clone();
    });
  } else {
    mesh = new THREE.Mesh(
      new THREE.BoxGeometry(TILE_W, TILE_H, TILE_T),
      new THREE.MeshStandardMaterial({ color: 0xeae6d8, roughness: 0.6 })
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
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
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  // Rotate the seat-local (x,z) offset into world space around +Y.
  // World forward for the seat (toward centre) is (−sinYaw, 0, −cosYaw) at yaw=0
  // pointing −Z; we build the basis so localZ+ = toward centre.
  // Rotate the seat-local offset (x = player's left→right, −z = toward centre) into
  // world space using THREE's +Y-rotation handedness, so the offset direction AGREES
  // with the seat's facing yaw. The previous formula used the opposite handedness,
  // which flung side-seat (left/right) hands out to radius ~1.3 behind the player.
  const seat = seatXform(rel).pos;
  const wx = seat.x + (localX * cos + localZ * sin);
  const wz = seat.z + (-localX * sin + localZ * cos);
  obj.position.set(wx, y, wz);

  // Compose seat yaw with the object's own (face/back/flat) rotation.
  _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  if (extraQuat) _q.multiply(extraQuat);
  obj.quaternion.copy(_q);
  return obj;
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
      layoutHandRack(p.hand, 0);
    } else {
      layoutOpponentHand(p.handCount || 0, rel);
    }
  }

  // --- Melds: exposed groups in front of each seat. ---
  clearGroup(groups.melds);
  for (let abs = 0; abs < n; abs++) {
    const p = gs.players[abs];
    if (!p || !Array.isArray(p.melds) || !p.melds.length) continue;
    layoutMelds(p.melds, relativeSeat(abs), abs);
  }

  // --- Discards: one shared pool, last 40, flat in the centre, last highlighted. ---
  layoutDiscards(gs.discardPile || [], gs.lastDiscard);

  // --- Wall: a small stack sized from wallCount (visual indicator only). ---
  layoutWall(gs.wallCount || 0);
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

// Remove and dispose all children of a group (geometry clones are per-instance).
function clearGroup(group) {
  for (let i = group.children.length - 1; i >= 0; i--) {
    const child = group.children[i];
    group.remove(child);
    disposeMesh(child);
  }
}

function disposeMesh(obj) {
  obj.traverse(o => {
    if (!o.isMesh) return;
    // Dispose the per-instance cloned geometry; the cache keeps its own copy.
    if (o.geometry) o.geometry.dispose();
    // Materials are shared from the cache and must NOT be disposed — EXCEPT the
    // per-instance clone we made for the highlighted discard.
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
export function layoutHandRack(handTiles, relSeat) {
  const tiles = handTiles || [];
  const count = tiles.length;
  const gap = TILE_W + 0.004;                // small spacing between tiles
  const totalW = count > 0 ? (count - 1) * gap : 0;
  const startX = -totalW / 2;

  // Upright tile: the geometry is ALREADY height-up (width X, height Y, face on +Z),
  // so we do NOT rotate it onto its back — we only turn the carved face toward the
  // seated viewer (TILE_FACE_ROT) and lean it back slightly (RACK_TILT). The seat
  // yaw is composed on top inside placeInSeatFrame.
  const faceRot = new THREE.Quaternion().setFromEuler(ORIENT.TILE_FACE_ROT);
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), ORIENT.RACK_TILT);
  const upright = new THREE.Quaternion().multiplyQuaternions(tilt, faceRot);

  // z just in front of the player toward the centre; y so the tile stands on the top.
  const localZ = -ORIENT.HAND_RING_OFFSET;    // toward table centre; lands on the table
  const standY = TABLE_TOP_Y + TILE_H / 2;

  for (let i = 0; i < count; i++) {
    const mesh = makeTileMesh(tiles[i], true);
    placeInSeatFrame(mesh, relSeat, startX + i * gap, localZ, standY, upright);
    groups.hands.add(mesh);
  }
}

// layoutOpponentHand(count, relSeat): `count` blank backs standing upright at the
// seat, faces away from us (toward that opponent). Same upright stand as the rack.
function layoutOpponentHand(count, relSeat) {
  const gap = TILE_W + 0.004;
  const totalW = count > 0 ? (count - 1) * gap : 0;
  const startX = -totalW / 2;
  // Upright blank backs (jade back toward the table centre), matching the local rack.
  const upright = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), ORIENT.RACK_TILT);
  const localZ = -ORIENT.HAND_RING_OFFSET;
  const standY = TABLE_TOP_Y + TILE_H / 2;

  for (let i = 0; i < count; i++) {
    const mesh = makeBackMesh();
    placeInSeatFrame(mesh, relSeat, startX + i * gap, localZ, standY, upright);
    groups.hands.add(mesh);
  }
}

// ── Meld layout ──────────────────────────────────────────────────────────────

// layoutMelds(melds, relSeat, absSeat): lay exposed melds flat, face up, in a row
// in front of the seat (further toward centre than the hand). Concealed-kong shows
// only the two middle tiles for opponents (ends face-down).
function layoutMelds(melds, relSeat, absSeat) {
  const gap = TILE_W + 0.004;
  const meldGap = 0.02;

  const isLocal = relSeat === 0;
  const localZ = -ORIENT.MELD_RING_OFFSET; // beyond the hand row, toward centre (on table)

  // Pre-compute total width so the meld block is centred in front of the seat.
  let totalW = 0;
  for (const meld of melds) totalW += meld.tiles.length * gap + meldGap;
  totalW -= meldGap;
  let cursorX = -totalW / 2;

  for (const meld of melds) {
    const concealed = meld.type === 'concealed-kong';
    meld.tiles.forEach((t, idx) => {
      // For an opponent's concealed kong, only the inner two tiles are face-up.
      const faceUp = isLocal || !concealed || (idx === 1 || idx === 2);
      const mesh = faceUp ? makeTileMesh(t, true) : makeBackMesh();
      // The flat orientation (face up or down) is composed with the seat yaw inside
      // placeInSeatFrame, which sets the final quaternion.
      const flatQuat = new THREE.Quaternion().setFromEuler(
        faceUp ? ORIENT.DISCARD_FLAT : ORIENT.WALL_FLAT);
      placeInSeatFrame(mesh, relSeat, cursorX, localZ, TILE_REST_Y, flatQuat);
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
function layoutDiscards(pile, lastDiscard) {
  clearGroup(groups.discards);

  const shown = pile.length > MAX_DISCARDS ? pile.slice(pile.length - MAX_DISCARDS) : pile;
  const perRow = 10;                 // 10 across × up to 4 rows
  const stepX = TILE_W + 0.004;
  const stepZ = TILE_H + 0.004;      // when flat, the tile's height extends along Z
  const flat = new THREE.Quaternion().setFromEuler(ORIENT.DISCARD_FLAT);

  const lastId = lastDiscard && typeof lastDiscard === 'object' ? lastDiscard.id : null;

  shown.forEach((t, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const x = (col - (perRow - 1) / 2) * stepX;
    const z = (row - 1.5) * stepZ;   // centre the (up to) 4 rows around origin

    const mesh = makeTileMesh(t, true);
    mesh.position.set(x, TILE_REST_Y, z);
    mesh.quaternion.copy(flat);

    // Highlight + tween the just-discarded tile: start a touch above and ease down.
    if (lastId != null && t && t.id === lastId) {
      mesh.userData.isLastDiscard = true;
      const target = mesh.position.clone();
      const start = target.clone();
      start.y += 0.06; // drop-in height
      mesh.position.copy(start);
      tweenTo(mesh, target, flat, 220);
      // Subtle emissive nudge so the latest discard reads as "live".
      highlightMesh(mesh);
    }

    groups.discards.add(mesh);
  });
}

// Give a mesh a soft emissive highlight (clones the material so we don't tint the
// shared cache material). Used for the latest discard.
function highlightMesh(mesh) {
  // The tile is a group of carved primitives; clone each child's material(s) so the
  // shared cache material isn't tinted, and mark each child for disposal.
  const apply = m => { if (m && m.emissive) { m.emissive.setHex(0x332b14); m.emissiveIntensity = 0.6; } };
  mesh.traverse(o => {
    if (!o.isMesh || !o.material) return;
    const mat = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone();
    if (Array.isArray(mat)) mat.forEach(apply); else apply(mat);
    o.material = mat;
    o.userData.clonedMaterial = true;
  });
}

// ── Wall layout ──────────────────────────────────────────────────────────────

// layoutWall(count): a compact two-high stack along one edge sized from wallCount.
// Purely a visual indicator; the HUD shows the exact number. We cap the rendered
// stack so a full wall (~144) doesn't carpet the table.
function layoutWall(count) {
  clearGroup(groups.wall);
  const n = Math.min(count, 36);     // render at most 36 as a stand-in stack
  const perRow = 18;
  const stepX = TILE_T + 0.001;      // tiles lie on their side, thickness along X
  const flatBack = new THREE.Quaternion().setFromEuler(ORIENT.WALL_FLAT);

  for (let i = 0; i < n; i++) {
    const col = i % perRow;
    const layer = Math.floor(i / perRow); // 0 or 1 → two-high
    const x = (col - (perRow - 1) / 2) * stepX;
    const mesh = makeBackMesh();
    // Push the wall toward the far edge (still ON the ~0.46-radius table) so it
    // doesn't overlap the central discard grid.
    mesh.position.set(x, TILE_REST_Y + layer * TILE_T, -0.40);
    mesh.quaternion.copy(flatBack);
    groups.wall.add(mesh);
  }
}

// ── Tweening (simple eased transform; no physics) ────────────────────────────

// tweenTo(mesh, targetPos, targetQuat, ms): ease a mesh's position+rotation to a
// target over `ms`. targetQuat may be a Quaternion or Euler. Replaces any active
// tween already running on the same mesh.
export function tweenTo(mesh, targetPos, targetQuat, ms = 250) {
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
  });
}

// updateTweens(dt): advance all active tweens. Call once per frame. (Exported so
// the render loop can drive it; main.js's loop comment references "tiles tweens".)
export function updateTweens(dt) {
  if (!tweens.length) return;
  const dtMs = dt * 1000;
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    tw.elapsed += dtMs;
    const t = Math.min(1, tw.elapsed / tw.duration);
    const e = easeOutCubic(t);
    _v.copy(tw.fromPos).lerp(tw.toPos, e);
    tw.mesh.position.copy(_v);
    _qFrom.copy(tw.fromQuat).slerp(tw.toQuat, e);
    tw.mesh.quaternion.copy(_qFrom);
    if (t >= 1) tweens.splice(i, 1);
  }
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

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
