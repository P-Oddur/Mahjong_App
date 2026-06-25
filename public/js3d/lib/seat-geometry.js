// seat-geometry.js — pure numeric core for the 4 seats around the table.
//
// Dependency-free (imports nothing — NOT even three) so it runs identically in the
// browser and in Node unit tests. seats.js wraps these plain numbers into
// THREE.Vector3 transforms; camera.js / tiles.js / avatar.js read the same values.
//
// COORDINATES: Y-up, real-world metres, table CENTRE at the world origin.
// RELATIVE SEATS (identical to game.js `pos = ['bottom','right','top','left']`):
//   0 = near (local player) · 1 = right · 2 = across · 3 = left.

// ── Tunables (single source of truth; seats.js re-exports these) ─────────────
export const SEAT_COUNT  = 4;     // mahjong is always 4-handed in play
export const SEAT_RADIUS = 0.92;  // metres from table centre to a seat
export const TABLE_TOP_Y = 0.78;  // top surface of the table (rack/discard height)
export const EYE_Y       = 1.25;  // seated first-person eye height
export const EYE_RADIUS  = 0.70;  // metres from centre for the local camera eye
export const RACK_INSET    = 0.30; // metres toward centre for the hand rack anchor
export const DISCARD_INSET = 0.55; // metres toward centre for the discard anchor

// Base yaw (radians) each relative seat faces so "forward" points toward centre.
export const SEAT_FACING_BASE = [
  0,            // rel 0 near  — faces −Z (toward centre)
  Math.PI / 2,  // rel 1 right — faces −X
  Math.PI,      // rel 2 across— faces +Z
  -Math.PI / 2, // rel 3 left  — faces +X
];

// Uniform facing nudge applied to all seats. Keep at 0; flip here for a global flip.
export const FACING_FIX = 0;

// Per-relative-seat XZ unit directions (outward from table centre).
export const SEAT_DIR = [
  { x: 0,  z: 1  }, // 0 near   (+Z)
  { x: 1,  z: 0  }, // 1 right  (+X)
  { x: 0,  z: -1 }, // 2 across (−Z)
  { x: -1, z: 0  }, // 3 left   (−X)
];

// normalizeRel(rel): clamp any integer into 0..SEAT_COUNT-1 (handles negatives).
export function normalizeRel(rel) {
  return ((rel % SEAT_COUNT) + SEAT_COUNT) % SEAT_COUNT;
}

// relFromAbs(absSeat, myIndex, n): absolute server seat -> relative seat (0 = near).
//   rel = (((abs - myIndex) % n) + n) % n   — identical to game.js pos logic.
export function relFromAbs(absSeat, myIndex, n = SEAT_COUNT) {
  return (((absSeat - myIndex) % n) + n) % n;
}

// absFromRel(relSeat, myIndex, n): inverse of relFromAbs — relative -> absolute.
//   abs = (myIndex + rel) % n
export function absFromRel(relSeat, myIndex, n = SEAT_COUNT) {
  return (((myIndex + relSeat) % n) + n) % n;
}

// seatGeometry(rel): the full world transform for a relative seat, as plain numbers.
// Returns { pos, facing, eye, rackOrigin, discardSlot } where pos/eye/rackOrigin/
// discardSlot are {x,y,z}. seats.js converts these into THREE.Vector3 instances.
export function seatGeometry(rel) {
  const i = normalizeRel(rel);
  const d = SEAT_DIR[i];
  return {
    pos: { x: d.x * SEAT_RADIUS, y: 0, z: d.z * SEAT_RADIUS },
    facing: SEAT_FACING_BASE[i] + FACING_FIX,
    eye: { x: d.x * EYE_RADIUS, y: EYE_Y, z: d.z * EYE_RADIUS },
    rackOrigin: {
      x: d.x * (SEAT_RADIUS - RACK_INSET),
      y: TABLE_TOP_Y,
      z: d.z * (SEAT_RADIUS - RACK_INSET),
    },
    discardSlot: {
      x: d.x * (SEAT_RADIUS - DISCARD_INSET),
      y: TABLE_TOP_Y,
      z: d.z * (SEAT_RADIUS - DISCARD_INSET),
    },
  };
}
