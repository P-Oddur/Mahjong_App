// parlour/lights.js — baked parlour lighting constants + buildLights().
//
// Ported from _from-open-design/js/parlour.js:
//   TUNE.def ~line 86   — source of truth for every baked value
//   buildLights() ~line 375
//
// Task 3 scope: ambient + hemisphere + key SpotLight + warm fill PointLight.
// The cool fluorescent fill is owned by buildFluorescentTubes() in decor.js so
// the tube on/off toggle dims it; it is NOT duplicated here. Neon-spill
// PointLights likewise belong with the neon signs in Task 4 — NOT added here.
//
// PARLOUR is exported so scene.js can wire bloom strength/radius/threshold
// from these baked values (instead of the old BLOOM constants block).

import * as THREE from 'three';

// Baked look values — direct paste of TUNE.def from the parlour reference.
// All live-tuning is deliberately omitted here; this is the static baked state.
export const PARLOUR = Object.freeze({
  // Global grade
  exposure:       0.26,

  // Ambient / hemisphere
  ambientColor:   0x2b3a3a,
  ambientIntensity: 0.32,
  hemiSky:        0x24343c,
  hemiGround:     0x120a08,
  hemiIntensity:  0.28,

  // Key SpotLight — pendant lamp over the table (~0,2.78,0) aimed at table top
  keyColor:       0xffd49a,   // COL.tungsten from parlour.js
  keyIntensity:   80.5,       // TUNE.def.keySpot
  keyDistance:    9,
  keyAngle:       0.95,       // radians (~54°)
  keyPenumbra:    1.0,
  keyDecay:       2,
  keyPos:         [0, 2.78, 0],
  keyTargetPos:   [0, 0.78, 0], // TABLE_TOP from parlour.js
  shadowMapSize:  1024,
  shadowNear:     0.4,
  shadowFar:      6,
  shadowBias:    -0.0006,
  shadowNormalBias: 0.02,

  // Warm fill PointLight — gentle tungsten fill under the shade
  fillColor:      0xffd49a,   // COL.tungsten
  fillIntensity:  18.35,      // TUNE.def.warmFill
  fillDistance:   4.5,
  fillDecay:      2,
  fillPos:        [0, 2.37, 0],

  // Bloom — matches TUNE.def from parlour
  bloomThreshold: 0.0,
  bloomStrength:  0.9,
  bloomRadius:    0.7,
});

// buildLights(scene) — construct and add all Task-3 lights; populate scene.lights.
// Returns nothing; callers discover lights via scene.lights.
export function buildLights(scene) {
  // Ambient — dark atmospheric base; room reads by glow, not flood
  const ambient = new THREE.AmbientLight(PARLOUR.ambientColor, PARLOUR.ambientIntensity);
  scene.add(ambient);
  scene.lights.ambient = ambient;

  // Hemisphere — subtle warm-from-above / cool-from-floor grounding
  const hemi = new THREE.HemisphereLight(PARLOUR.hemiSky, PARLOUR.hemiGround, PARLOUR.hemiIntensity);
  scene.add(hemi);
  scene.lights.hemi = hemi;

  // Key SpotLight — pendant lamp; sole shadow-caster, 1024² PCFSoft
  const spot = new THREE.SpotLight(
    PARLOUR.keyColor,
    PARLOUR.keyIntensity,
    PARLOUR.keyDistance,
    PARLOUR.keyAngle,
    PARLOUR.keyPenumbra,
    PARLOUR.keyDecay,
  );
  spot.position.set(...PARLOUR.keyPos);
  spot.target.position.set(...PARLOUR.keyTargetPos);
  spot.castShadow = true;
  spot.shadow.mapSize.set(PARLOUR.shadowMapSize, PARLOUR.shadowMapSize);
  spot.shadow.camera.near = PARLOUR.shadowNear;
  spot.shadow.camera.far  = PARLOUR.shadowFar;
  spot.shadow.bias        = PARLOUR.shadowBias;
  spot.shadow.normalBias  = PARLOUR.shadowNormalBias;
  scene.add(spot);
  scene.add(spot.target);
  scene.lights.lamp = spot;

  // Warm fill PointLight — soft halo under the shade
  const fill = new THREE.PointLight(
    PARLOUR.fillColor,
    PARLOUR.fillIntensity,
    PARLOUR.fillDistance,
    PARLOUR.fillDecay,
  );
  fill.position.set(...PARLOUR.fillPos);
  scene.add(fill);
  scene.lights.warmFill = fill;

  // NOTE: the cool fluorescent fill is created by buildFluorescentTubes() in
  // decor.js (so the tube on/off toggle dims it). It is deliberately NOT added
  // here — a second always-on copy would stay lit when the tubes are switched off.
}
