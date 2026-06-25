// seats.js — seat world transforms + relative-seat mapping (THREE wrapper).
//
// This module is the single source of geometric truth for "where the 4 seats are"
// around the table and "how an absolute server seat maps to a relative seat" around
// the local player. The pure numeric core lives in lib/seat-geometry.js (dependency-
// free, unit-tested in Node); this module wraps those plain numbers into the
// THREE.Vector3 value objects the scene layer consumes. It performs NO IO and NO
// scene mutation — it is consumed by:
//   - camera.js   (eyeForSeat / seatTransform for the fixed FP camera at rel 0),
//   - tiles.js    (rackOrigin / discardSlot / facing to lay out hands & melds),
//   - avatar.js   (pos + facing to place & orient the 4 avatars).
//
// COORDINATES (Y-up, real-world metres, table CENTRE at world origin) and the
// relative-seat convention (0 = near, 1 = right, 2 = across, 3 = left) are
// documented alongside the constants in lib/seat-geometry.js.

import * as THREE from 'three';
import {
  SEAT_COUNT,
  SEAT_FACING_BASE,
  FACING_FIX,
  seatGeometry,
  relFromAbs as relFromAbsCore,
  absFromRel as absFromRelCore,
  normalizeRel,
} from '/js3d/lib/seat-geometry.js';

// Re-export the tunables/constants other scene modules read off `seats.*`, so the
// pure core stays the single source of truth (camera.js reads SEAT_FACING_BASE).
export { SEAT_COUNT, SEAT_FACING_BASE, FACING_FIX };

// Build the immutable SEATS table once from the pure core, converting each plain
// {x,y,z} into a THREE.Vector3. Consumers read pos/facing/eye/rackOrigin/
// discardSlot directly; treat the Vector3s as read-only (clone before mutating).
function buildSeats() {
  const seats = [];
  for (let rel = 0; rel < SEAT_COUNT; rel++) {
    const g = seatGeometry(rel);
    seats.push({
      pos: new THREE.Vector3(g.pos.x, g.pos.y, g.pos.z),
      facing: g.facing,
      eye: new THREE.Vector3(g.eye.x, g.eye.y, g.eye.z),
      rackOrigin: new THREE.Vector3(g.rackOrigin.x, g.rackOrigin.y, g.rackOrigin.z),
      discardSlot: new THREE.Vector3(g.discardSlot.x, g.discardSlot.y, g.discardSlot.z),
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
  return SEATS[normalizeRel(relSeat)];
}

// eyeForSeat(relSeat): the first-person eye position (THREE.Vector3) for a seat.
// The local player always uses relSeat 0. Returned vector is the shared SEATS eye;
// clone it before mutating.
export function eyeForSeat(relSeat) {
  return seatTransform(relSeat).eye;
}

// ── Relative <-> absolute seat mapping (mirror of state.js / game.js) ─────────
// Pure functions taking myIndex explicitly so seats.js stays free of the state
// store. Re-exported from the numeric core; state.js exposes store-bound versions
// (relativeSeat/absSeatAtRelative) for the data layer.
export const relFromAbs = relFromAbsCore;
export const absFromRel = absFromRelCore;
