// parlour/room.js — procedural room shell: floor, walls, ceiling, cornice.
//
// Ported from _from-open-design/js/parlour.js buildRoom() ~line 230
// and buildCeiling(W,H,D) ~line 330.
//
// Dimensions (parlour originals, coordinate-reconciled per Task 3 brief):
//   W = D = 6.4, H = 3.2
//   Inner wall faces at ±3.15 (box centre ±3.2, 0.1 thick → inner face ±3.15)
//   Floor y = 0, ceiling PlaneGeometry at y = H−0.02 ≈ 3.18
//   Table top Y = 0.78 (not used here; carried in lights.js comment for reference)
//
// Front wall (z = +D/2): cast=false, recv=false (player-seat wall; never needs
// to shadow itself and would clip first-person view if it catches shadows).

import * as THREE from 'three';
import { mat, box } from './materials.js';
import { terrazzoTexture, wallTexture, ceilingTexture } from './textures.js';

export function buildRoom(scene) {
  const W = 6.4, H = 3.2, D = 6.4;

  // Floor — polished terrazzo
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshPhysicalMaterial({
      map: terrazzoTexture(),
      roughness: 0.35,
      metalness: 0,
      clearcoat: 0.45,
      clearcoatRoughness: 0.3,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Walls — shared wall material (cream + jade dado)
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTexture(), roughness: 0.72 });

  const back  = box(W, H, 0.1, wallMat,  0,     H / 2, -D / 2);        // back (north)
  const left  = box(0.1, H, D,  wallMat, -W / 2, H / 2,  0);           // left (west)
  const right = box(0.1, H, D,  wallMat,  W / 2, H / 2,  0);           // right (east)
  const front = box(W, H, 0.1, wallMat,  0,     H / 2,  D / 2, false, false); // front (south / player)

  scene.add(back);
  scene.add(left);
  scene.add(right);
  scene.add(front);
}

export function buildCeiling(scene) {
  const W = 6.4, H = 3.2, D = 6.4;

  // Pressed-tin ceiling plane
  const ceil = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({ map: ceilingTexture(), roughness: 0.85 }),
  );
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, H - 0.02, 0);
  ceil.receiveShadow = true;
  scene.add(ceil);

  // Solid slab above the ceiling — blocks any light leak through the plane
  scene.add(box(W, 0.1, D, mat(0x161616, 0.95), 0, H + 0.05, 0, false, false));

  // Cornice / crown molding around the four top edges
  const cm = mat(0xe7e0cf, 0.7, 0.05);
  const cy = H - 0.16, ct = 0.13, cd = 0.1;
  scene.add(box(W, ct, cd, cm,         0,     cy, -D / 2 + cd / 2, false, false)); // back
  scene.add(box(W, ct, cd, cm,         0,     cy,  D / 2 - cd / 2, false, false)); // front
  scene.add(box(cd, ct, D,  cm, -W / 2 + cd / 2, cy,  0,           false, false)); // left
  scene.add(box(cd, ct, D,  cm,  W / 2 - cd / 2, cy,  0,           false, false)); // right
}
