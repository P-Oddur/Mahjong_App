// avatar.js — per-seat seated avatars with first-person hide + look-sync.
//
// Responsibilities (contract §5.7):
//   • Load /assets/3d/avatar.glb once (the seated upper-body rig).
//   • Instance one avatar per occupied seat at the seat transforms from seats.js.
//   • Recolor each instance via the 'Avatar_Accent' material per seat colour.
//   • HIDE the local player's own avatar from the first-person camera (validated
//     FP rule — otherwise the own head/shoulders clip the view at ~180° look).
//   • Drive each REMOTE head node (Avatar_Head) yaw/pitch from received playerLook
//     using smoothed slerp toward a target orientation.
//
// This module talks to:
//   • seats.js  — seat world transforms (pos / facing) and the relative<->absolute
//                 seat mapping helpers.
//   • state.js  — store.myIndex (who is local) + relativeSeat() so placement and
//                 the look-skip-self rule match the rest of the client exactly.
//
// It imports Three from the import map and SkeletonUtils for correct rig cloning.

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { store, relativeSeat } from '/js3d/state.js';
import { SEAT_COUNT, seatTransform } from '/js3d/seats.js';
import * as scene from '/js3d/scene.js';

// One representative environment node used only to discover the live scene to
// attach avatars to (avatar.js is never handed the scene directly by main.js).
const SCENE_ANCHOR_NODE = 'Floor';

// ── ORIENTATION CAVEAT (mandatory labeled constant, contract §7.7) ───────────
// Exact avatar facing may need a small runtime tweak. AVATAR_FACING_FIX is added
// on top of each seat's `facing` yaw so the body squarely faces the table centre.
// HEAD_FACING_FIX is a separate base offset applied to the head node before the
// per-look yaw/pitch, in case the head's neutral pose isn't dead-ahead.
// Flip these here during browser testing rather than hunting magic numbers inline.
export const AVATAR_FACING_FIX = 0;   // radians, body base-yaw correction
export const HEAD_FACING_FIX   = 0;   // radians, head base-yaw correction

// Pitch clamp for remote heads (mirror the camera's ~±80° look clamp so a remote
// head never bends past a believable range even if a bad value arrives).
const HEAD_PITCH_MIN = -1.4;          // ~ -80°
const HEAD_PITCH_MAX =  1.4;          // ~ +80°

// Head smoothing: higher = snappier. Frame-rate-independent exponential smoothing
// is applied in update(dt) so the slerp factor is derived from this per second.
const HEAD_SMOOTH_PER_SEC = 12;

// Per-seat accent colours (index = RELATIVE seat: 0 near/local, 1 right, 2 across,
// 3 left). The local avatar is hidden, but it still gets a colour for consistency
// and in case a future debug view re-enables it. Warm parlour-friendly hues.
const SEAT_ACCENT_COLORS = [
  0x3b6ea5, // rel 0 near  — blue
  0xb5483a, // rel 1 right — red
  0x4a8c5a, // rel 2 across— green
  0xb59a3a, // rel 3 left  — gold
];

// ── Module state ─────────────────────────────────────────────────────────────
let gltfTemplate = null;     // the loaded gltf.scene used as the clone template
let loaded = false;          // true once loadAvatar() resolves

let localRelSeat = 0;        // relative seat that is local (always 0 here, but set
                             // explicitly by setLocalSeat for clarity / re-seats)

// One entry per ABSOLUTE seat index. Created/updated lazily by placeAvatars().
//   { root, head, accentMats:[mat,...], absSeat,
//     targetQuat:THREE.Quaternion, isBot, hasLook }
const avatars = new Array(SEAT_COUNT).fill(null);

// Scratch objects reused every frame to avoid per-frame allocation.
const _euler = new THREE.Euler(0, 0, 0, 'YXZ'); // yaw(Y) then pitch(X) ordering

// ── Loading ──────────────────────────────────────────────────────────────────

// loadAvatar(): GLTFLoader '/assets/3d/avatar.glb'; cache the rig template.
// Idempotent — a second call resolves immediately once loaded.
export async function loadAvatar() {
  if (loaded) return;
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.load('/assets/3d/avatar.glb', resolve, undefined, reject);
  });
  gltfTemplate = gltf.scene;
  // Avatars should both cast and receive the parlour lighting/shadows.
  gltfTemplate.traverse(obj => {
    if (obj.isMesh) { obj.castShadow = true; obj.receiveShadow = true; }
  });
  loaded = true;
}

// ── Placement ────────────────────────────────────────────────────────────────

// placeAvatars(playersMeta): instance one avatar per occupied seat.
//   • playersMeta is the gameState.players array, indexed by ABSOLUTE seat.
//   • Maps each absolute seat -> relative seat -> seat transform.
//   • Recolours 'Avatar_Accent' per RELATIVE seat colour.
//   • Hides the local player's avatar (relative seat 0) from the FP camera.
// Called from main.js on every state update; it creates missing avatars and keeps
// existing ones (only metadata like name/isBot/visibility is refreshed cheaply).
export function placeAvatars(playersMeta) {
  if (!loaded || !gltfTemplate) return;          // assets not ready yet
  if (!Array.isArray(playersMeta)) playersMeta = [];

  // Attach any avatars created before the scene was discoverable.
  ensureAttached();

  for (let abs = 0; abs < SEAT_COUNT; abs++) {
    const meta = playersMeta[abs];

    // No player in this absolute seat -> remove any stale avatar.
    if (!meta) { removeAvatar(abs); continue; }

    const rel = (store.myIndex != null) ? relativeSeat(abs) : abs;

    // Create the avatar instance once, then keep it.
    let entry = avatars[abs];
    if (!entry) {
      entry = createAvatar(abs, rel);
      avatars[abs] = entry;
    } else {
      // Seat mapping can change after an identityUpdate reshuffle; re-place &
      // re-tint so the same absolute seat lands at its new relative position.
      positionAvatar(entry, rel);
      applyAccentColor(entry, SEAT_ACCENT_COLORS[rel % SEAT_ACCENT_COLORS.length]);
    }

    entry.isBot = !!meta.isBot;

    // Local avatar (relative seat 0) must NOT render to the FP camera.
    const isLocal = (rel === localRelSeat);
    entry.root.visible = !isLocal;
  }
}

// createAvatar(abs, rel): clone the rig, parent it, position + tint it, and grab
// the head node + accent materials for later look-sync / recolour.
function createAvatar(abs, rel) {
  const root = SkeletonUtils.clone(gltfTemplate);

  // Find the head node (separate node per the asset spec) so it can be rotated
  // independently for look-sync. Fall back to the root if the head is missing.
  const head = root.getObjectByName('Avatar_Head') || root;

  // Collect & clone the accent material(s) so each avatar can be tinted without
  // mutating the shared template material. There may be more than one mesh using
  // 'Avatar_Accent'; clone each occurrence and track them for recolouring.
  const accentMats = [];
  root.traverse(obj => {
    if (!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (let i = 0; i < mats.length; i++) {
      const m = mats[i];
      if (m && m.name === 'Avatar_Accent') {
        const clone = m.clone();
        accentMats.push(clone);
        if (Array.isArray(obj.material)) obj.material[i] = clone;
        else obj.material = clone;
      }
    }
  });

  const entry = {
    root,
    head,
    accentMats,
    absSeat: abs,
    // Head look target: start at neutral (identity-ish, base head fix only).
    targetQuat: new THREE.Quaternion(),
    isBot: false,
    hasLook: false,
  };

  // Neutral head target = base head facing fix, no look yet.
  _euler.set(0, HEAD_FACING_FIX, 0, 'YXZ');
  entry.targetQuat.setFromEuler(_euler);
  head.quaternion.copy(entry.targetQuat);

  positionAvatar(entry, rel);
  applyAccentColor(entry, SEAT_ACCENT_COLORS[rel % SEAT_ACCENT_COLORS.length]);

  // Add to the scene graph via the seat's parent. seatTransform gives world-space
  // pos/facing; we add the root straight to the shared scene root through the head's
  // eventual parent. We add to the current scene by attaching to seatTransform's
  // implied world frame — main.js owns the scene, so we add to the avatar's own
  // root which is then added to the scene by the caller chain. To keep avatar.js
  // self-contained, parent under the THREE scene found via the template's parent if
  // present; otherwise the caller (main) added the template to a scene we can reuse.
  attachToScene(root);

  return entry;
}

// positionAvatar(entry, rel): place + orient the avatar root at the seat's world
// transform for relative seat `rel`, facing the table centre (+ AVATAR_FACING_FIX).
function positionAvatar(entry, rel) {
  const t = seatTransform(rel);
  if (!t) return;
  const p = t.pos;
  entry.root.position.set(p.x, p.y, p.z);
  // seatTransform.facing is the yaw toward the table centre; add the labeled fix.
  entry.root.rotation.set(0, (t.facing || 0) + AVATAR_FACING_FIX, 0);
}

// applyAccentColor(entry, hex): tint every cloned 'Avatar_Accent' material.
function applyAccentColor(entry, hex) {
  for (const m of entry.accentMats) {
    if (m.color) m.color.setHex(hex);
  }
}

// removeAvatar(abs): detach + forget a seat's avatar (player left the seat).
function removeAvatar(abs) {
  const entry = avatars[abs];
  if (!entry) return;
  if (entry.root.parent) entry.root.parent.remove(entry.root);
  avatars[abs] = null;
}

// attachToScene(obj): add an avatar root to the live scene. The avatar template is
// loaded standalone (not in a scene) and main.js never hands us the scene, so we
// discover it from a known environment node (scene.getNode) and walk up to the
// THREE.Scene. If the scene isn't ready yet, the root stays detached and is
// re-attached on the next placeAvatars() call (which fires on every state update).
let _sceneRef = null;
// Optional explicit wire if a future caller wants to hand us the scene directly.
export function setSceneRoot(s) { _sceneRef = s; }
function findScene() {
  if (_sceneRef) return _sceneRef;
  // From any already-parented avatar, climb to the top scene.
  for (const e of avatars) {
    if (e && e.root.parent) {
      const top = topScene(e.root);
      if (top) { _sceneRef = top; return top; }
    }
  }
  // Otherwise discover via a known environment node loaded by scene.buildScene.
  const node = scene.getNode && scene.getNode(SCENE_ANCHOR_NODE);
  if (node) {
    const top = topScene(node);
    if (top) { _sceneRef = top; return top; }
  }
  return null;
}
function attachToScene(obj) {
  const s = findScene();
  if (s) s.add(obj);   // else: stays detached; re-attached next placeAvatars()
}
// Re-attach any avatar that was created before the scene was discoverable.
function ensureAttached() {
  const s = findScene();
  if (!s) return;
  for (const e of avatars) {
    if (e && !e.root.parent) s.add(e.root);
  }
}
function topScene(obj) {
  let o = obj;
  while (o.parent) o = o.parent;
  return o.isScene ? o : null;
}

// ── First-person local-seat hide ─────────────────────────────────────────────

// setLocalSeat(relSeat): record which relative seat is local and refresh
// visibility so the local avatar is hidden (and a previously-local one, after a
// re-seat, becomes visible again).
export function setLocalSeat(relSeat) {
  localRelSeat = relSeat;
  for (let abs = 0; abs < SEAT_COUNT; abs++) {
    const entry = avatars[abs];
    if (!entry) continue;
    const rel = (store.myIndex != null) ? relativeSeat(abs) : abs;
    entry.root.visible = (rel !== localRelSeat);
  }
}

// ── Look-sync ────────────────────────────────────────────────────────────────

// applyLook(absSeat, yaw, pitch): set the TARGET head orientation for a remote
// seat. Skips the local seat (we never render our own head, and never want our own
// look snapshotted back onto a phantom avatar). The target is interpolated toward
// in update(); yaw is full-range, pitch is clamped to a believable neck range.
export function applyLook(absSeat, yaw, pitch) {
  if (absSeat == null) return;
  if (absSeat === store.myIndex) return;          // never drive the local avatar
  const entry = avatars[absSeat];
  if (!entry) return;                             // avatar not placed yet

  const p = Math.max(HEAD_PITCH_MIN, Math.min(HEAD_PITCH_MAX, pitch || 0));
  // YXZ order: apply yaw about Y, then pitch about X — matches the camera's look
  // composition so a remote head mirrors how the sender's camera turned.
  _euler.set(p, (yaw || 0) + HEAD_FACING_FIX, 0, 'YXZ');
  entry.targetQuat.setFromEuler(_euler);
  entry.hasLook = true;
}

// update(dt): per-frame smoothing of each remote head toward its target look.
// Uses exponential smoothing so the result is frame-rate independent. Bots and
// any seat that hasn't sent a look stay at their neutral target (no jitter).
export function update(dt) {
  if (!loaded) return;
  // Convert the per-second smoothing into a slerp t for this frame's dt.
  const t = 1 - Math.exp(-HEAD_SMOOTH_PER_SEC * Math.max(0, dt || 0));
  for (let abs = 0; abs < SEAT_COUNT; abs++) {
    const entry = avatars[abs];
    if (!entry) continue;
    // The local avatar is hidden; skipping its slerp saves a tiny bit of work.
    if (!entry.root.visible) continue;
    entry.head.quaternion.slerp(entry.targetQuat, t);
  }
}

// ── Optional nameplate (contract lists this; kept minimal/no-op-safe) ────────

// setSeatLabel(absSeat, name, isBot, points): optional floating nameplate. v1
// keeps this as a safe no-op hook (HUD renders names in 2D); the signature exists
// so main.js / future code can call it without guarding.
export function setSeatLabel(absSeat, name, isBot, points) {
  const entry = avatars[absSeat];
  if (!entry) return;
  entry.label = { name, isBot, points };  // stored for a future 3D nameplate pass
}
