// camera-math.js — pure angle math for the first-person camera.
//
// Dependency-free (imports nothing) so it runs identically in the browser and in
// Node unit tests. camera.js keeps the THREE.PerspectiveCamera / Euler / quaternion
// plumbing and the module state (current yaw/pitch, base facing); it calls into this
// core for every numeric decision so the math is testable in isolation.

// ── Tunables (single source of truth; camera.js re-exports these) ────────────
export const CAMERA_CONFIG = {
  FOV: 70,    // vertical field of view (degrees)
  NEAR: 0.04, // near clip (m) — small so the rack right in front doesn't clip
  FAR: 50,    // far clip (m) — the room is only ~5 m
};

// Pitch clamp: look up/down but never flip past straight up/down (~±80°).
// Yaw is intentionally UNCLAMPED (full 360° spin via wrapAngle).
export const PITCH_LIMIT = 1.40; // radians (~80°)

// Default downward look applied on (re)seat so the player's own tiles are framed.
export const DEFAULT_PITCH = -0.62; // radians (~ -36°)

// Below this delta a look change isn't worth reporting (net.js applies the real
// ~20 Hz + 0.01 rad throttle; this just avoids firing on identical frames).
export const LOOK_REPORT_EPS = 0.0005;

// wrapAngle(a): fold an angle into (-π, π] without losing the ability to spin a
// full turn. The upper bound is inclusive (π stays π); the lower bound wraps (−π → π).
export function wrapAngle(a) {
  const twoPi = Math.PI * 2;
  let x = a % twoPi;
  if (x > Math.PI) x -= twoPi;
  else if (x <= -Math.PI) x += twoPi;
  return x;
}

// clamp(v, lo, hi): bound v to [lo, hi].
export function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// normalizeLook(yaw, pitch): the body of setLook — yaw spins freely (wrapped into
// (-π, π]) while pitch is clamped to ±PITCH_LIMIT so the view never flips over.
export function normalizeLook(yaw, pitch) {
  return { yaw: wrapAngle(yaw), pitch: clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT) };
}

// composeLookEuler(pitch, baseFacing, yaw): the YXZ euler tuple applyOrientation
// feeds the camera — yaw added on top of the seat's base facing about world +Y,
// pitch about the resulting local X, no roll.
export function composeLookEuler(pitch, baseFacing, yaw) {
  return { x: pitch, y: baseFacing + yaw, z: 0 };
}

// lookChanged(prevYaw, prevPitch, yaw, pitch, eps): reportLook's gate — true when
// there is no previous report, or either angle moved by at least `eps`.
export function lookChanged(prevYaw, prevPitch, yaw, pitch, eps = LOOK_REPORT_EPS) {
  if (prevYaw === null || prevYaw === undefined) return true;
  return Math.abs(yaw - prevYaw) >= eps || Math.abs(pitch - prevPitch) >= eps;
}
