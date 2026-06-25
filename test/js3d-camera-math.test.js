// Unit tests for the pure camera-math core (public/js3d/lib/camera-math.js).
//
// The first-person camera's angle math — yaw wrapping, pitch clamping, look
// composition, and the "did the look actually move?" epsilon test — extracted out
// of camera.js (which imports three) so it can be tested in Node. camera.js keeps
// the THREE.Euler/quaternion plumbing and calls into this core.
const assert = require('assert');

function near(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }
function assertNear(a, b, msg) {
  assert.ok(near(a, b), `${msg}: expected ${b}, got ${a}`);
}

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

(async () => {
  const cam = await import('../public/js3d/lib/camera-math.js');
  const PI = Math.PI;

  // ── wrapAngle: fold into (-π, π] while still allowing a full spin ────────────
  check('wrapAngle leaves angles already in (-π, π] unchanged', () => {
    assertNear(cam.wrapAngle(0), 0, 'zero');
    assertNear(cam.wrapAngle(PI), PI, 'π stays π (upper bound inclusive)');
    assertNear(cam.wrapAngle(1), 1, 'arbitrary in-range');
  });

  check('wrapAngle wraps the lower bound −π up to π', () => {
    assertNear(cam.wrapAngle(-PI), PI, '−π → π');
  });

  check('wrapAngle folds angles past a half-turn', () => {
    assertNear(cam.wrapAngle(3 * PI / 2), -PI / 2, '3π/2 → −π/2');
    assertNear(cam.wrapAngle(2 * PI), 0, 'full turn → 0');
    assertNear(cam.wrapAngle(5 * PI), PI, '5π → π');
  });

  // ── clamp ───────────────────────────────────────────────────────────────────
  check('clamp bounds a value to [lo, hi]', () => {
    assertNear(cam.clamp(5, -1.4, 1.4), 1.4, 'above hi');
    assertNear(cam.clamp(-5, -1.4, 1.4), -1.4, 'below lo');
    assertNear(cam.clamp(0.5, -1.4, 1.4), 0.5, 'within range');
  });

  // ── normalizeLook: setLook's body (wrap yaw, clamp pitch to ±PITCH_LIMIT) ────
  check('normalizeLook wraps yaw and clamps pitch to ±PITCH_LIMIT', () => {
    const a = cam.normalizeLook(0.5, -0.3);
    assertNear(a.yaw, 0.5, 'in-range yaw'); assertNear(a.pitch, -0.3, 'in-range pitch');

    const up = cam.normalizeLook(0.5, 5);
    assertNear(up.pitch, cam.PITCH_LIMIT, 'pitch clamped up');
    const down = cam.normalizeLook(0.5, -5);
    assertNear(down.pitch, -cam.PITCH_LIMIT, 'pitch clamped down');

    const spun = cam.normalizeLook(3 * PI / 2, 0);
    assertNear(spun.yaw, -PI / 2, 'yaw wrapped');
  });

  // ── composeLookEuler: applyOrientation's YXZ euler tuple ─────────────────────
  check('composeLookEuler adds free-look yaw onto base facing (pitch on X)', () => {
    const e = cam.composeLookEuler(-0.62, PI / 2, 0.1);
    assertNear(e.x, -0.62, 'pitch on X');
    assertNear(e.y, PI / 2 + 0.1, 'baseFacing + yaw on Y');
    assertNear(e.z, 0, 'no roll');
  });

  // ── lookChanged: reportLook's epsilon gate ───────────────────────────────────
  check('lookChanged reports true on the first look (no previous)', () => {
    assert.strictEqual(cam.lookChanged(null, null, 0, 0), true);
  });

  check('lookChanged ignores sub-epsilon jitter but catches real motion', () => {
    assert.strictEqual(cam.lookChanged(0.5, 0.5, 0.5, 0.5), false, 'no movement');
    assert.strictEqual(cam.lookChanged(0.5, 0.5, 0.5 + 0.0003, 0.5), false, 'sub-eps yaw');
    assert.strictEqual(cam.lookChanged(0.5, 0.5, 0.5 + 0.001, 0.5), true, 'yaw moved');
    assert.strictEqual(cam.lookChanged(0.5, 0.5, 0.5, 0.5 + 0.001), true, 'pitch moved');
  });

  // ── exported tunables stay the single source of truth ────────────────────────
  check('exposes camera tunables (PITCH_LIMIT, DEFAULT_PITCH, CAMERA_CONFIG)', () => {
    assertNear(cam.PITCH_LIMIT, 1.40, 'PITCH_LIMIT');
    assertNear(cam.DEFAULT_PITCH, -0.62, 'DEFAULT_PITCH');
    assert.strictEqual(cam.CAMERA_CONFIG.FOV, 70, 'FOV');
    assert.strictEqual(cam.CAMERA_CONFIG.NEAR, 0.04, 'NEAR');
    assert.strictEqual(cam.CAMERA_CONFIG.FAR, 50, 'FAR');
  });

  console.log(`\n${passed} camera-math tests passed`);
})();
