// parlour/materials.js — geometry and material helpers for the procedural parlour room.
//
// Ported from _from-open-design/js/parlour.js (mat ~line 225, box ~line 220).
// Adjusted for the js3d module layout (THREE imported from the import map, not
// a local vendor bundle). MeshStandardMaterial/MeshPhysicalMaterial APIs are
// unchanged in r0.184.

import * as THREE from 'three';

// mat(color, rough, metal, extra?) — thin wrapper around MeshStandardMaterial.
// `extra` is spread in, allowing emissive, clearcoat, alphaMap, side, etc.
export function mat(color, rough = 0.8, metal = 0, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
}

// box(w,h,d, material, x,y,z, cast,recv) — BoxGeometry mesh at (x,y,z).
// cast/recv default true so room geometry self-shadows; front wall and
// purely decorative elements override both to false.
export function box(w, h, d, material, x = 0, y = 0, z = 0, cast = true, recv = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = cast;
  m.receiveShadow = recv;
  return m;
}

// neonMaterial(glyphTex, emissiveIntensity, emissiveColor) — a glowing neon-tube
// material driven by a glyph canvas texture. Ported from buildNeonSign
// (parlour.js ~line 537) and neonBoard (~688).
//
// CRITICAL: base color MUST be 0x000000 AND emissive MUST be set (default
// 0xffffff). The emissiveMap multiplies against `emissive`, so a black emissive
// would multiply to black and never glow. The same texture also feeds alphaMap
// so only the painted glyph is opaque — the canvas black background reads as
// fully transparent, leaving just the floating tube glyph. Emissive texels are
// picked up by the emissive-MRT bloom pipeline (scene.js), which is the glow.
//
// Two conventions both use this helper:
//   • single-colour tube (麻雀/香港 signs, neonBoard): glyph painted WHITE,
//     pass the tube colour as `emissiveColor` so emissive·emissiveMap tints it.
//   • multi-colour painted board (faan chart): colours painted INTO the canvas,
//     leave emissiveColor = white (0xffffff) so the painted colours pass through.
//
// `emissiveIntensity` is the per-sign baked brightness (the master dimmer).
// depthWrite:false + DoubleSide so the transparent plane composites cleanly and
// reads from both sides.
export function neonMaterial(glyphTex, emissiveIntensity = 1.0, emissiveColor = 0xffffff) {
  return new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: new THREE.Color(emissiveColor),
    emissiveIntensity,
    emissiveMap: glyphTex,
    // alphaMap reuses the same (SRGB) glyph texture: three samples alpha from the
    // green channel and ignores colorSpace for alphaMap, so the cut-out is correct.
    // (Don't copy this reuse for a COLOURED alpha source — it would need NoColorSpace.)
    alphaMap: glyphTex,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
