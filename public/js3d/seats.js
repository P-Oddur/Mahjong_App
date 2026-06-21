// seats.js — seat world transforms + relative-seat mapping (pure data/helpers).
//
// This module is the single source of geometric truth for "where the 4 seats are"
// around the table and "how an absolute server seat maps to a relative seat" around
// the local player. It imports nothing but Three (only for THREE.Vector3 value
// objects) and performs NO IO and NO scene mutation — it is consumed by:
//   - camera.js   (eyeForSeat / seatTransform for the fixed FP camera at rel 0),
//   - tiles.js    (rackOrigin / discardSlot / facing to lay out hands & melds),
//   - avatar.js   (pos + facing to place & orient the 4 avatars).
//
// COORDINATES (validated against the real environment.glb asset):
//   - Y-up, real-world meters, table CENTER at the world origin.
//   - Table is ~0.9 m square; its top surface is at Y ≈ 0.78.
//   - The seat ring sits at radius ~1.0 m from center (just outside the table edge).
//   - Seated eye height is Y ≈ 1.2 m; camera near-clip ≈ 0.04 (owned by camera.js).
//
// RELATIVE SEATS (identical to game.js `pos = ['bottom','right','top','left']`):
//   0 = near  (local player, "bottom")  — camera lives here, faces toward center (−Z)
//   1 = right ("right")                 — faces −X
//   2 = across("top")                   — faces +Z
//   3 = left  ("left")                  — faces +X
//
// game.js builds seats as `atPos[pos[i]] = (myIndex + i) % n`, so the relative seat
// of an absolute server seat is `(((abs - myIndex) % n) + n) % n`. We mirror both
// that mapping and its inverse here (state.js exposes the same math for the data
// layer; these copies keep seats.js self-contained for the scene layer).

import * as THREE from 'three';

// ── Tunables (kept as labeled constants per the orientation caveat §7.7) ─────────

// Number of seats around the table. Mahjong is always 4-handed in play.
export const SEAT_COUNT = 4;

// Seat ring radius from table center, in meters. ~1.0 m places a seat just outside
// the ~0.9 m table edge.
const SEAT_RADIUS = 1.0;

// Heights, in meters.
const TABLE_TOP_Y = 0.78; // top surface of the table (for rack/discard layout)
const EYE_Y       = 1.2;  // seated first-person eye height (validated in Blender)

// Where a seat's hand rack sits relative to the seat: pulled IN toward the table a
// little from the seat position, and resting at table-top height. tiles.js uses this
// as the anchor to lay out the upright hand (and offsets melds from it).
const RACK_INSET = 0.30;  // meters toward center from the seat position

// Where a seat's discards land relative to the seat: just inside the table edge,
// laid flat on the table top. tiles.js uses this as the per-seat discard anchor;
// the shared discardPile (§2) is generally pooled near center, but per-seat slots
// are provided for layouts that fan discards out from each player.
const DISCARD_INSET = 0.55; // meters toward center from the seat position

// SEAT_FACING_BASE — the base yaw (radians) each relative seat faces so that the
// avatar/rack/look "forward" points TOWARD the table center. This is the single
// labeled place to nudge facing during browser testing (orientation caveat §7.7).
//
// Convention: yaw is rotation about +Y. A seated player at +Z looks toward −Z
// (toward center). In Three.js a yaw of 0 with -Z forward already faces −Z, so:
//   rel 0 (near, at +Z, looks −Z): yaw 0
//   rel 1 (right, at +X, looks −X): yaw +π/2
//   rel 2 (across, at −Z, looks +Z): yaw π
//   rel 3 (left, at −X, looks +X): yaw −π/2
// FACING_FIX is added to every seat uniformly so a global flip is one edit.
export const SEAT_FACING_BASE = [
  0,                 // rel 0 near  — faces −Z (toward center)
  Math.PI / 2,       // rel 1 right — faces −X
  Math.PI,           // rel 2 across— faces +Z
  -Math.PI / 2,      // rel 3 left  — faces +X
];

// Uniform facing nudge applied to all seats. Keep at 0; flip here if every avatar
// faces the wrong way during browser testing.
export const FACING_FIX = 0;

// ── Per-relative-seat XZ unit directions (outward from table center) ─────────────
// Index = relative seat. Each is the outward direction the seat sits along.
// rel 0 near: +Z ; rel 1 right: +X ; rel 2 across: −Z ; rel 3 left: −X.
const SEAT_DIR = [
  { x: 0,  z: 1  }, // 0 near   (+Z, "bottom")
  { x: 1,  z: 0  }, // 1 right  (+X)
  { x: 0,  z: -1 }, // 2 across (−Z, "top")
  { x: -1, z: 0  }, // 3 left   (−X)
];

// Build the immutable SEATS table once. Each entry is the full world transform for
// one RELATIVE seat (0 = near/local). Consumers read pos/facing/eye/rackOrigin/
// discardSlot directly; they should treat these Vector3s as read-only (clone before
// mutating).
//
// Each seat:
//   pos         — THREE.Vector3 ground-plane seat position (Y=0) at the seat ring.
//   facing      — number, yaw (rad) toward table center (SEAT_FACING_BASE + FACING_FIX).
//   eye         — THREE.Vector3 first-person eye position (seat XZ at EYE_Y).
//   rackOrigin  — THREE.Vector3 anchor for the hand rack (inset toward center, table-top Y).
//   discardSlot — THREE.Vector3 anchor for this seat's discards (further inset, table-top Y).
function buildSeats() {
  const seats = [];
  for (let rel = 0; rel < SEAT_COUNT; rel++) {
    const d = SEAT_DIR[rel];
    const sx = d.x * SEAT_RADIUS;
    const sz = d.z * SEAT_RADIUS;
    seats.push({
      pos: new THREE.Vector3(sx, 0, sz),
      facing: SEAT_FACING_BASE[rel] + FACING_FIX,
      eye: new THREE.Vector3(sx, EYE_Y, sz),
      rackOrigin: new THREE.Vector3(
        d.x * (SEAT_RADIUS - RACK_INSET),
        TABLE_TOP_Y,
        d.z * (SEAT_RADIUS - RACK_INSET),
      ),
      discardSlot: new THREE.Vector3(
        d.x * (SEAT_RADIUS - DISCARD_INSET),
        TABLE_TOP_Y,
        d.z * (SEAT_RADIUS - DISCARD_INSET),
      ),
    });
  }
  return seats;
}

// SEATS[rel] — index 0..3 is the RELATIVE seat (0 near, 1 right, 2 across, 3 left).
export const SEATS = buildSeats();

// ── Accessors ────────────────────────────────────────────────────────────────

// seatTransform(relSeat): the full world transform for a relative seat.
// Returns { pos, facing, eye, rackOrigin, discardSlot } (the SEATS entry).
// relSeat is normalized into 0..SEAT_COUNT-1 so callers can't index out of range.
export function seatTransform(relSeat) {
  const rel = ((relSeat % SEAT_COUNT) + SEAT_COUNT) % SEAT_COUNT;
  return SEATS[rel];
}

// eyeForSeat(relSeat): the first-person eye position (THREE.Vector3) for a seat.
// The local player always uses relSeat 0. Returned vector is the shared SEATS eye;
// clone it before mutating.
export function eyeForSeat(relSeat) {
  return seatTransform(relSeat).eye;
}

// ── Relative <-> absolute seat mapping (mirror of state.js / game.js) ─────────
// These are pure functions taking myIndex explicitly so seats.js stays free of the
// state store. state.js exposes store-bound versions (relativeSeat/absSeatAtRelative)
// for the data layer; these mirror them for the scene layer.

// relFromAbs(absSeat, myIndex, n): absolute server seat -> relative seat (0=near).
//   rel = (((abs - myIndex) % n) + n) % n   — identical to game.js pos logic.
export function relFromAbs(absSeat, myIndex, n = SEAT_COUNT) {
  return (((absSeat - myIndex) % n) + n) % n;
}

// absFromRel(relSeat, myIndex, n): inverse of relFromAbs — relative -> absolute.
//   abs = (myIndex + rel) % n
export function absFromRel(relSeat, myIndex, n = SEAT_COUNT) {
  return (((myIndex + relSeat) % n) + n) % n;
}
