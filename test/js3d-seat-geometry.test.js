// Unit tests for the pure seat-geometry core (public/js3d/lib/seat-geometry.js).
//
// This is the dependency-free numeric core extracted out of seats.js so the seat
// ring positions + relative/absolute seat mapping can be tested in Node (seats.js
// itself imports `three`, which is browser-only via the CDN importmap, so it can't
// be required here). seats.js builds its THREE.Vector3 transforms from this core.
const assert = require('assert');

function near(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }
function assertNear(a, b, msg) {
  assert.ok(near(a, b), `${msg}: expected ${b}, got ${a}`);
}
function assertVec(v, e, msg) {
  assertNear(v.x, e.x, `${msg}.x`);
  assertNear(v.y, e.y, `${msg}.y`);
  assertNear(v.z, e.z, `${msg}.z`);
}

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

(async () => {
  const seat = await import('../public/js3d/lib/seat-geometry.js');
  const HALF_PI = Math.PI / 2;

  // ── relative ↔ absolute seat mapping (mirror of game.js pos logic) ──────────
  check('relFromAbs maps absolute server seat to relative (0 = local)', () => {
    assert.strictEqual(seat.relFromAbs(0, 0), 0);
    assert.strictEqual(seat.relFromAbs(2, 0), 2);
    assert.strictEqual(seat.relFromAbs(1, 1), 0); // my own seat is always relative 0
    assert.strictEqual(seat.relFromAbs(0, 1), 3); // ((0-1)%4+4)%4
  });

  check('relFromAbs wraps negatives without going out of range', () => {
    assert.strictEqual(seat.relFromAbs(-1, 0), 3);
  });

  check('absFromRel is the inverse of relFromAbs', () => {
    assert.strictEqual(seat.absFromRel(3, 1), 0); // (1+3)%4
    for (let m = 0; m < 4; m++) {
      for (let abs = 0; abs < 4; abs++) {
        assert.strictEqual(seat.absFromRel(seat.relFromAbs(abs, m), m), abs);
      }
    }
  });

  // ── seat ring geometry (table centre at origin, Y up, metres) ───────────────
  check('seatGeometry(0) — near seat sits at +Z, faces table centre', () => {
    const g = seat.seatGeometry(0);
    assertVec(g.pos, { x: 0, y: 0, z: 0.92 }, 'pos');
    assertNear(g.facing, 0, 'facing');
    assertVec(g.eye, { x: 0, y: 1.25, z: 0.70 }, 'eye');
    assertVec(g.rackOrigin, { x: 0, y: 0.78, z: 0.62 }, 'rackOrigin'); // 0.92 − 0.30 inset
    assertVec(g.discardSlot, { x: 0, y: 0.78, z: 0.37 }, 'discardSlot'); // 0.92 − 0.55 inset
  });

  check('seatGeometry(1) — right seat sits at +X, faces −X (+π/2)', () => {
    const g = seat.seatGeometry(1);
    assertVec(g.pos, { x: 0.92, y: 0, z: 0 }, 'pos');
    assertNear(g.facing, HALF_PI, 'facing');
    assertVec(g.eye, { x: 0.70, y: 1.25, z: 0 }, 'eye');
  });

  check('seatGeometry(2) — across seat sits at −Z, faces +Z (π)', () => {
    const g = seat.seatGeometry(2);
    assertVec(g.pos, { x: 0, y: 0, z: -0.92 }, 'pos');
    assertNear(g.facing, Math.PI, 'facing');
  });

  check('seatGeometry(3) — left seat sits at −X, faces +X (−π/2)', () => {
    const g = seat.seatGeometry(3);
    assertVec(g.pos, { x: -0.92, y: 0, z: 0 }, 'pos');
    assertNear(g.facing, -HALF_PI, 'facing');
  });

  check('seatGeometry normalizes out-of-range seats (4 → 0)', () => {
    const a = seat.seatGeometry(4);
    const b = seat.seatGeometry(0);
    assertVec(a.pos, b.pos, 'pos');
  });

  console.log(`\n${passed} seat-geometry tests passed`);
})();
