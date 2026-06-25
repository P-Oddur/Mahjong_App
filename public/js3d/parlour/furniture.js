// parlour/furniture.js — procedural mahjong table + four chairs.
//
// Ported from _from-open-design/js/parlour.js:
//   buildTableAndChairs() ~line 404
//   makeChair(x, z, ry)  ~line 436
//
// Coordinate facts (matches js3d seats.js SEAT_RADIUS = 1.0):
//   TABLE_TOP  = 0.78  — frame top / felt slab centre height
//   FELT_TOP   = 0.791 — true top of the 0.02-thick felt
//   Chairs at ±1.0 on each axis.  Local player: z=1.0, ry=π (backrest behind camera).
//
// All meshes cast and receive shadows so the key SpotLight pools on the felt.

import * as THREE from 'three';
import { mat, box } from './materials.js';

// Palette — subset of parlour COL used by furniture only
const COL = {
  wood:      0x2a1a11,
  woodLight: 0x3c2718,
  felt:      0x0e5a39,
};

const TABLE_TOP  = 0.78;

// physMat — like mat() but MeshPhysicalMaterial for clearcoat support
function physMat(color, rough, metal, extra = {}) {
  return new THREE.MeshPhysicalMaterial({ color, roughness: rough, metalness: metal, ...extra });
}

// ── internal helper ───────────────────────────────────────────────────────────
function makeChair(x, z, ry) {
  const g = new THREE.Group();
  const m = physMat(COL.wood, 0.55, 0.04, { clearcoat: 0.2 });
  const seatH = 0.46;

  // seat pad
  g.add(box(0.42, 0.05, 0.42, m, 0, seatH, 0));
  // backrest — offset -0.18 along local Z so it sits behind the seat
  g.add(box(0.42, 0.5, 0.05, m, 0, seatH + 0.27, -0.18));
  // four legs
  [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]].forEach(([lx, lz]) => {
    g.add(box(0.05, seatH, 0.05, m, lx, seatH / 2, lz));
  });

  g.position.set(x, 0, z);
  g.rotation.y = ry;
  return g;
}

// ── exported entry point ──────────────────────────────────────────────────────
export function buildTableAndChairs(scene) {
  const table = new THREE.Group();

  // wood skirt / frame
  const frameMat = physMat(COL.wood, 0.5, 0.05, { clearcoat: 0.3 });
  table.add(box(1.0, 0.1, 1.0, frameMat, 0, TABLE_TOP - 0.05, 0));

  // green felt top
  const felt = box(0.92, 0.02, 0.92, mat(COL.felt, 0.96), 0, TABLE_TOP + 0.001, 0);
  table.add(felt);

  // inlaid wood border strips (four sides) — 0.47 = felt half-extent (0.46) + 0.01
  const borderMat = mat(COL.woodLight, 0.45, 0.1);
  table.add(box(1.0,  0.012, 0.06, borderMat,  0,    TABLE_TOP + 0.012,  0.47));
  table.add(box(1.0,  0.012, 0.06, borderMat,  0,    TABLE_TOP + 0.012, -0.47));
  table.add(box(0.06, 0.012, 1.0,  borderMat,  0.47, TABLE_TOP + 0.012,  0));
  table.add(box(0.06, 0.012, 1.0,  borderMat, -0.47, TABLE_TOP + 0.012,  0));

  // four legs (inner corners, clear of the skirt edge)
  const legMat = mat(COL.wood, 0.5);
  [[-0.42, -0.42], [0.42, -0.42], [-0.42, 0.42], [0.42, 0.42]].forEach(([lx, lz]) => {
    table.add(box(0.08, TABLE_TOP - 0.1, 0.08, legMat, lx, (TABLE_TOP - 0.1) / 2, lz));
  });

  scene.add(table);

  // four chairs — each at SEAT_RADIUS = 1.0, backrest rotated away from the table
  const seats = [
    { x:  0,    z:  1.0, ry:  Math.PI },      // local player — backrest behind camera
    { x:  0,    z: -1.0, ry:  0 },             // across — backrest away from table
    { x:  1.0,  z:  0,   ry: -Math.PI / 2 },  // right
    { x: -1.0,  z:  0,   ry:  Math.PI / 2 },  // left
  ];
  seats.forEach((s) => scene.add(makeChair(s.x, s.z, s.ry)));
}
