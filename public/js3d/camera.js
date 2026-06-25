// camera.js — first-person free-look camera for the 3D mahjong client.
//
// The camera is a single PerspectiveCamera FIXED at the local seat's eye position
// (relative seat 0 = "near"). It NEVER translates — only its orientation changes.
// The player free-looks with the mouse: full 360° yaw and clamped pitch.
//
// The yaw/pitch carried here are the exact angles emitted over the NEW `playerLook`
// event (radians), so remote clients can rotate this player's avatar head to match.
//
// Composition (see main.js):
//   cam = camera.createCamera();          // build, positioned at seat eye
//   camera.seatCamera(cam, 0);            // pin to relative seat 0, base facing center
//   camera.onLookChange(net.emitPlayerLook);  // register the throttled look emitter
//   input.js → camera.setLook(yaw, pitch);    // mouse-move drives orientation
//   loop:    camera.update(dt, cam);      // apply look to cam + fire onLookChange
//            const {yaw,pitch} = camera.getLook();  // HUD look-away fallback
//
// net.js owns the actual ~20 Hz / epsilon throttle; this module simply reports
// every look change through onLookChange and lets net.emitPlayerLook decide.

import * as THREE from 'three';
import * as seats from '/js3d/seats.js';
import {
  CAMERA_CONFIG,
  PITCH_LIMIT,
  DEFAULT_PITCH,
  LOOK_REPORT_EPS,
  normalizeLook,
  composeLookEuler,
  lookChanged,
} from '/js3d/lib/camera-math.js';

// The TUNABLES (FOV/clip, pitch clamp, default look, report epsilon) and the pure
// angle helpers live in lib/camera-math.js — the dependency-free, unit-tested core.
// They are re-exported here so existing consumers keep reading them off `camera.*`
// (and stay trivial to flip during browser testing, per the orientation caveat §7.7).
export { CAMERA_CONFIG, PITCH_LIMIT, DEFAULT_PITCH };

// ─────────────────────────────────────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────────────────────────────────────

// Current local head orientation, in radians, relative to the seat's base facing.
//   yaw   = rotation about world +Y (0 = looking straight toward table center)
//   pitch = rotation about the local X (positive = look up)
let yaw = 0;
let pitch = 0;

// The seat's base facing yaw (toward the table center). seatCamera() sets this so
// that yaw=0 means "looking at the table". Free-look yaw is added on top of it.
let baseFacing = 0;

// The relative seat the camera is pinned to (always 0 for the local player, but we
// keep it so identityUpdate re-seats correctly).
let currentRelSeat = 0;
// Whether we've seated at least once. The FIRST seat establishes the default look; a same-seat
// re-seat (a routine reconnect / rejoin) must NOT reset the look, or the view jumps mid-pan.
let seatedOnce = false;

// Cached eye position (THREE.Vector3) for the current seat; the camera sits here.
let eye = new THREE.Vector3(0, 1.2, 1.0);

// Reusable Euler (YXZ = yaw→pitch→roll order gives proper FPS free-look: yaw about
// world Y first, then pitch about the resulting local X, no roll) and the camera ref.
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
let camRef = null;

// onLookChange subscriber (main.js wires this to net.emitPlayerLook). One is enough.
let lookChangeCb = null;

// Last reported angles, so we only fire onLookChange when something actually moved.
let lastReportedYaw = null;
let lastReportedPitch = null;

// ─────────────────────────────────────────────────────────────────────────────
// Public API (named exports matching how main.js / input.js import this module)
// ─────────────────────────────────────────────────────────────────────────────

// createCamera(): build the fixed first-person PerspectiveCamera.
// Positioned at the local seat eye (~1.2 m). Aspect is taken from the window now
// and refreshed by scene.onResize(); orientation is applied by the first update().
export function createCamera() {
  const aspect = (typeof window !== 'undefined' && window.innerHeight)
    ? window.innerWidth / window.innerHeight
    : 16 / 9;
  const cam = new THREE.PerspectiveCamera(
    CAMERA_CONFIG.FOV,
    aspect,
    CAMERA_CONFIG.NEAR,
    CAMERA_CONFIG.FAR,
  );
  camRef = cam;
  // Seat it at the default (near) seat immediately so it is valid before the loop.
  seatCamera(cam, currentRelSeat);
  return cam;
}

// seatCamera(camera, relSeat=0): pin the camera at the eye of `relSeat` and set the
// base facing toward the table center. The local player always uses relSeat 0; this
// is also called on identityUpdate to re-seat after a seat reshuffle.
// Free-look yaw/pitch are reset to 0 (look straight at the table) on (re)seat.
export function seatCamera(camera, relSeat = 0) {
  camRef = camera || camRef;
  // A genuine (re)seat to a DIFFERENT seat resets the free-look; a same-seat call — a routine
  // reconnect / rejoin / identityUpdate that keeps the player where they already are — must
  // PRESERVE the current orientation. Otherwise the view snaps back to centre mid-pan, which is
  // the long-standing random "camera jump" (it fired on every socket reconnect: connect → rejoin
  // → rejoined → reseatCamera). The jump magnitude was exactly how far the player had panned.
  const seatChanged = !seatedOnce || relSeat !== currentRelSeat;
  currentRelSeat = relSeat;
  seatedOnce = true;

  // Eye position from seats.js (FP eye for that relative seat).
  const e = seats.eyeForSeat(relSeat);
  if (e) eye.copy(e);
  if (camRef) camRef.position.copy(eye);

  // Base facing yaw toward the table center, also from seats.js.
  baseFacing = resolveBaseFacing(relSeat);

  if (seatChanged) {
    // Look at the table with a default downward tilt so the player's own tiles are framed.
    yaw = 0;
    pitch = DEFAULT_PITCH;
  }

  applyOrientation();          // orient the camera right away
  // Report the look so avatars sync. Force only on a real seat change; a same-seat reseat
  // (e.g. a reconnect that preserved the orientation) goes through the delta gate so it
  // doesn't spam a redundant look emit each time seatCamera runs.
  reportLook(seatChanged);
}

// setLook(yaw, pitch): set the free-look angles (radians). input.js calls this on
// mouse-move (pointer-lock deltas accumulated into absolute yaw/pitch).
//   - yaw is wrapped into (-π, π] but spins freely (full 360°).
//   - pitch is clamped to ±PITCH_LIMIT so the view never flips over.
export function setLook(nextYaw, nextPitch) {
  const n = normalizeLook(nextYaw, nextPitch); // wrap yaw into (-π,π], clamp pitch to ±PITCH_LIMIT
  yaw = n.yaw;
  pitch = n.pitch;
  applyOrientation();
}

// getLook(): current free-look angles { yaw, pitch } in radians. Used for the
// playerLook emit AND for main.js's look-away (rack off-screen) heuristic.
export function getLook() {
  return { yaw, pitch };
}

// update(dt, camera): per-frame hook. The camera is already oriented by setLook(),
// but we re-apply here so the camera stays correct even if it was reseated/moved by
// another system, and we fire the throttle-friendly onLookChange when the look has
// changed since the last report. `dt` is unused (no inertia in v1) but kept for the
// main.js call signature `camera.update(dt, cam)`.
export function update(dt, camera) {
  if (camera && camera !== camRef) camRef = camera;
  applyOrientation();
  reportLook(false);
}

// onLookChange(cb): register the look emitter. main.js wires this to
// net.emitPlayerLook(yaw, pitch); net.js applies the real ~20 Hz + epsilon throttle.
export function onLookChange(cb) {
  lookChangeCb = (typeof cb === 'function') ? cb : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

// Compose base facing + free-look into the camera quaternion (YXZ order).
function applyOrientation() {
  if (!camRef) return;
  const e = composeLookEuler(pitch, baseFacing, yaw); // baseFacing + free-look yaw, pitch on X
  _euler.set(e.x, e.y, e.z, 'YXZ');
  camRef.quaternion.setFromEuler(_euler);
}

// Fire onLookChange when the look actually moved (or when forced on (re)seat).
// We report the RAW free-look yaw/pitch (relative to base facing) — that is the
// contract's playerLook payload, and avatars on remote clients add their own seat
// base facing back in.
function reportLook(force) {
  if (!lookChangeCb) return;
  if (!force && !lookChanged(lastReportedYaw, lastReportedPitch, yaw, pitch, LOOK_REPORT_EPS)) {
    return;
  }
  lastReportedYaw = yaw;
  lastReportedPitch = pitch;
  lookChangeCb(yaw, pitch);
}

// Resolve the seat's base facing yaw from whichever shape seats.js exposes.
function resolveBaseFacing(relSeat) {
  // Preferred: a labeled SEAT_FACING_BASE array (contract §7.7).
  if (Array.isArray(seats.SEAT_FACING_BASE) && seats.SEAT_FACING_BASE[relSeat] != null) {
    return seats.SEAT_FACING_BASE[relSeat];
  }
  // Alternative: seatTransform(relSeat).facing (contract §5.5).
  if (typeof seats.seatTransform === 'function') {
    const t = seats.seatTransform(relSeat);
    if (t && typeof t.facing === 'number') return t.facing;
  }
  // Fallback: relative seat 0 (near) looks toward −Z (table center) → yaw 0 in a
  // camera that defaults to looking down −Z. Keeps the camera valid even if seats.js
  // hasn't loaded a facing yet.
  return 0;
}

// wrapAngle / clamp now live in lib/camera-math.js (imported above) so the angle
// math is shared with the unit tests and the rest of the client.
