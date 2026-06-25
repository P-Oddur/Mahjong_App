// Unit tests for the pure tile-math core (public/js3d/lib/tile-math.js).
//
// The layout/animation arithmetic extracted out of tiles.js (which imports three +
// GLTFLoader) so it runs in Node: the server-tile → GLB node-name mapping (the
// "easy to get wrong" part the tiles.js comments flag), hand-rack ordering/spacing,
// the seat-frame → world transform (a past handedness bug), the discard grid, the
// opening deal-in break seat, and the tween easing.
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
  const tm = await import('../public/js3d/lib/tile-math.js');
  const seat = await import('../public/js3d/lib/seat-geometry.js');
  const PI = Math.PI;

  // ── tileNodeName: server tile → GLB node (the bam→sou / flower-season traps) ──
  check('tileNodeName maps the numeric suits, incl. bam → sou', () => {
    assert.strictEqual(tm.tileNodeName({ suit: 'man', value: 5 }), 'S_man5');
    assert.strictEqual(tm.tileNodeName({ suit: 'pin', value: 9 }), 'S_pin9');
    assert.strictEqual(tm.tileNodeName({ suit: 'bam', value: 3 }), 'S_sou3');
  });

  check('tileNodeName maps winds and dragons', () => {
    assert.strictEqual(tm.tileNodeName({ suit: 'wind', value: 'east' }), 'S_dong');
    assert.strictEqual(tm.tileNodeName({ suit: 'wind', value: 'south' }), 'S_nan');
    assert.strictEqual(tm.tileNodeName({ suit: 'wind', value: 'west' }), 'S_xi');
    assert.strictEqual(tm.tileNodeName({ suit: 'wind', value: 'north' }), 'S_bei');
    assert.strictEqual(tm.tileNodeName({ suit: 'dragon', value: 'red' }), 'S_zhong');
    assert.strictEqual(tm.tileNodeName({ suit: 'dragon', value: 'green' }), 'S_fa');
    assert.strictEqual(tm.tileNodeName({ suit: 'dragon', value: 'white' }), 'S_bai');
  });

  check('tileNodeName splits flowers (1–4) from seasons (5–8)', () => {
    assert.strictEqual(tm.tileNodeName({ suit: 'flower', value: 1 }), 'S_flower1');
    assert.strictEqual(tm.tileNodeName({ suit: 'flower', value: 4 }), 'S_flower4');
    assert.strictEqual(tm.tileNodeName({ suit: 'flower', value: 5 }), 'S_season1');
    assert.strictEqual(tm.tileNodeName({ suit: 'flower', value: 8 }), 'S_season4');
  });

  check('tileNodeName falls back to the blank node for back/null/unknown', () => {
    assert.strictEqual(tm.tileNodeName(null), tm.BLANK_NODE);
    assert.strictEqual(tm.tileNodeName('back'), tm.BLANK_NODE);
    assert.strictEqual(tm.tileNodeName({ suit: 'bogus', value: 1 }), tm.BLANK_NODE);
    // Unmapped honor values warn once then fall back — suppress the warn to keep output pristine.
    const realWarn = console.warn; let warned = 0; console.warn = () => { warned++; };
    try {
      assert.strictEqual(tm.tileNodeName({ suit: 'wind', value: 'nope' }), tm.BLANK_NODE);
    } finally { console.warn = realWarn; }
    assert.ok(warned >= 1, 'unmapped honor should warn');
  });

  // ── hand rack: pull the drawn tile to the far right, keep the row centred ─────
  check('hasDrawnTile detects the freshly-drawn tile by id', () => {
    const hand = [{ id: 1 }, { id: 2 }, { id: 3 }];
    assert.strictEqual(tm.hasDrawnTile(hand, 2), true);
    assert.strictEqual(tm.hasDrawnTile(hand, 99), false);
    assert.strictEqual(tm.hasDrawnTile(hand, null), false);
  });

  check('orderHandTiles moves the drawn tile to the end (else unchanged)', () => {
    const hand = [{ id: 1 }, { id: 2 }, { id: 3 }];
    assert.deepStrictEqual(tm.orderHandTiles(hand, 2).map(t => t.id), [1, 3, 2]);
    assert.deepStrictEqual(tm.orderHandTiles(hand, 99).map(t => t.id), [1, 2, 3]);
    assert.deepStrictEqual(tm.orderHandTiles(hand, null).map(t => t.id), [1, 2, 3]);
  });

  check('handRackXOffsets spaces tiles edge-to-edge and centres the row', () => {
    const a = tm.handRackXOffsets(3, false, 1, 0.5);
    assert.deepStrictEqual(a.xs, [0, 1, 2]);
    assertNear(a.startX, -1, 'startX centres the row');

    const b = tm.handRackXOffsets(3, true, 1, 0.5); // drawn tile gets an extra gap
    assert.deepStrictEqual(b.xs, [0, 1, 2.5]);
    assertNear(b.startX, -1.25, 'startX accounts for the drawn gap');

    const empty = tm.handRackXOffsets(0, false, 1, 0.5);
    assert.deepStrictEqual(empty.xs, []);
    assertNear(empty.startX, 0, 'empty hand → no offset');
  });

  // ── seat-frame → world (the handedness that once flung side seats out) ────────
  check('seatLocalToWorld places a forward offset toward table centre', () => {
    const near0 = tm.seatLocalToWorld({ x: 0, z: 0.92 }, 0, 0, -0.545); // near seat, hand ring
    assertNear(near0.x, 0, 'x'); assertNear(near0.z, 0.375, 'z pulled toward centre');

    const right = tm.seatLocalToWorld({ x: 0.92, z: 0 }, PI / 2, 0, -0.545); // right seat
    assertNear(right.x, 0.375, 'x pulled toward centre'); assertNear(right.z, 0, 'z');
  });

  check('seatLocalToWorld rotates a left/right offset by the seat yaw', () => {
    const w = tm.seatLocalToWorld({ x: 0, z: 0 }, PI / 2, 1, 0); // +x at yaw π/2 → −z
    assertNear(w.x, 0, 'x'); assertNear(w.z, -1, 'z');
  });

  // ── discard grid (10 across, centred, up to 4 rows) ──────────────────────────
  check('discardCell lays the shared pool out in a centred grid', () => {
    assert.deepStrictEqual(tm.discardCell(0, 10, 1, 1), { x: -4.5, z: -1.5 });
    assert.deepStrictEqual(tm.discardCell(9, 10, 1, 1), { x: 4.5, z: -1.5 });
    assert.deepStrictEqual(tm.discardCell(10, 10, 1, 1), { x: -4.5, z: -0.5 }); // next row
  });

  // ── opening deal-in: which wall the dice break ────────────────────────────────
  check('dealBreakSeat counts the dice sum around from the dealer', () => {
    assert.strictEqual(tm.dealBreakSeat(0, [3, 4]), 2);  // sum 7 → (0+6)%4
    assert.strictEqual(tm.dealBreakSeat(0, []), 2);      // empty dice → default sum 7
    assert.strictEqual(tm.dealBreakSeat(1, [1, 1]), 2);  // sum 2 → (1+1)%4
    assert.strictEqual(tm.dealBreakSeat(2, [6, 6]), 1);  // sum 12 → (2+11)%4
  });

  // ── corner-bonus row must sit FLUSH against the raised rail (clear, no overlap) ─
  check('corner-bonus row sits flush against the rail, and clipping is detected', () => {
    const base = {
      seatRadius: seat.SEAT_RADIUS,
      leftX: tm.CORNER_BONUS.leftX,
      localZ: tm.CORNER_BONUS.localZ,
      tileW: tm.TILE_W,
      tileH: tm.TILE_H,
      feltClear: tm.FELT_CLEAR,
    };
    const c = tm.cornerBonusClearance(base);
    // The derived CORNER_BONUS placement leaves exactly one RAIL_SETBACK of clearance on the
    // near and left edges — flush against the rail's inner edge with no overlap.
    assertNear(c.zClear, tm.RAIL_SETBACK, 'near edge flush at one setback');
    assertNear(c.xClear, tm.RAIL_SETBACK, 'left edge flush at one setback');
    // Independent of the tuned constants: the function must actually DETECT a clip. Shoving the
    // row outward / leftward past the rail must yield negative clearance; pulling it inward must
    // yield more. (The old test fed back the derived constants, so it only ever re-proved
    // zClear/xClear === RAIL_SETBACK regardless of the geometry.)
    assert.ok(tm.cornerBonusClearance({ ...base, localZ: base.localZ + 0.01 }).zClear < 0, 'outward overhang clips');
    assert.ok(tm.cornerBonusClearance({ ...base, leftX: base.leftX - 0.01 }).xClear < 0, 'leftward overhang clips');
    assert.ok(tm.cornerBonusClearance({ ...base, localZ: base.localZ - 0.01 }).zClear > c.zClear, 'inward → more clearance');
  });

  // ── tween easing ──────────────────────────────────────────────────────────────
  check('easeOutCubic eases from 0 to 1', () => {
    assertNear(tm.easeOutCubic(0), 0, 'start');
    assertNear(tm.easeOutCubic(1), 1, 'end');
    assertNear(tm.easeOutCubic(0.5), 0.875, 'eased midpoint');
  });

  console.log(`\n${passed} tile-math tests passed`);
})();
