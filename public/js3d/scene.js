// scene.js — static world + lighting + render plumbing for the 3D mahjong client.
//
// Responsibilities (contract §5.4):
//   • create THREE.Scene + WebGLRenderer (antialias, sRGB output, ACESFilmic-ish
//     tone mapping, shadows),
//   • add warm interior parlor lighting matching the validated Blender look
//     (a soft table-area RectAreaLight key + lantern PointLights + warm ambient),
//   • load '/assets/3d/environment.glb' WHOLE as the static room+table (do NOT
//     rebuild procedurally),
//   • expose scene / renderer / lights handles, getNode(), render(), onResize().
//
// This module owns the renderer and the static world only. Dynamic objects
// (tiles, avatars, props) are added to `scene` by their own modules. main.js
// calls buildScene(canvas) once, then render(camera) every frame and
// onResize(camera) on window resize.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

// ── Asset path ────────────────────────────────────────────────────────────────
const ENV_URL = '/assets/3d/environment.glb';

// ── Expected environment node names (contract §7.2) ──────────────────────────
// Frozen list used by getNode() callers and for a startup sanity check. These are
// the nodes authored in environment.glb; the room is 5×5 m centered at origin,
// walls at ±2.5, ceiling ~3.05, square table ~0.9 m with top surface at Y≈0.78.
export const ENV_NODES = Object.freeze([
  'Floor', 'Ceiling',
  'Wall_N', 'Wall_S', 'Wall_E', 'Wall_W',
  'TableTop', 'TableRim', 'TableApron',
  'Leg_-1_-1', 'Leg_-1_1', 'Leg_1_-1', 'Leg_1_1',
  'Lamp_Shade', 'Lamp_Cord',
  'LanternA', 'LanternB',
]);

// ── Lighting constants (warm interior parlor look) ───────────────────────────
// Kept as a labeled block at the top so the validated Blender look is easy to
// re-tune in one place. Colors are warm whites/ambers; intensities are tuned for
// the ACESFilmic tone-mapped, physically-correct (candela/lux) light model.
const LIGHT = Object.freeze({
  // Tone mapping / exposure for the whole frame.
  TONE_MAPPING: THREE.ACESFilmicToneMapping, // warm filmic rolloff; AgX-like feel
  EXPOSURE: 1.05,

  // Warm ambient floor so shadows never go pure black in the parlor.
  AMBIENT_COLOR: 0x3a2f24,
  AMBIENT_INTENSITY: 0.55,

  // Subtle warm/cool hemisphere to ground the room (warm sky from lamp, cooler
  // bounce from the wood floor).
  HEMI_SKY: 0x4a3a28,
  HEMI_GROUND: 0x141017,
  HEMI_INTENSITY: 0.35,

  // Table-area soft key: a downward RectAreaLight over the table giving the broad,
  // even, slightly warm illumination on the felt/tiles. RectAreaLight does NOT
  // cast shadows (engine limitation), so a separate SpotLight handles shadows.
  TABLE_AREA_COLOR: 0xfff1d6,
  TABLE_AREA_INTENSITY: 6.5,
  TABLE_AREA_WIDTH: 1.4,
  TABLE_AREA_HEIGHT: 1.4,
  TABLE_AREA_Y: 1.7,          // a bit below the lamp, hovering over the table

  // Shadow-casting key from the hanging lamp position (warm), pointed at the table.
  LAMP_COLOR: 0xffd9a0,
  LAMP_INTENSITY: 22,         // candela-ish; tuned with the area light above
  LAMP_Y: 2.05,               // just under the lamp shade
  LAMP_ANGLE: Math.PI / 3.4,  // cone half-angle
  LAMP_PENUMBRA: 0.55,
  LAMP_DISTANCE: 6,
  LAMP_DECAY: 1.4,

  // Two wall lanterns: warm amber point lights for atmosphere / fill from the sides.
  LANTERN_COLOR: 0xff9a4d,
  LANTERN_INTENSITY: 3.0,
  LANTERN_DISTANCE: 5,
  LANTERN_DECAY: 1.6,
  // Fallback world positions if LanternA/LanternB nodes aren't found in the glb.
  LANTERN_A_POS: [-2.3, 1.9, -2.3],
  LANTERN_B_POS: [2.3, 1.9, 2.3],

  // Shadow map resolution for the lamp spot.
  SHADOW_MAP: 2048,
});

// ── Module-level handles (exposed for siblings / debugging) ──────────────────
export let scene = null;     // THREE.Scene
export let renderer = null;  // THREE.WebGLRenderer
export let clock = null;     // THREE.Clock
export let root = null;      // the loaded environment glTF scene (Object3D)

// Named light handles, exposed per the task ("expose the scene/renderer/lights").
export const lights = {
  ambient: null,   // AmbientLight
  hemi: null,      // HemisphereLight
  tableArea: null, // RectAreaLight (soft key over table)
  lamp: null,      // SpotLight (shadow-casting key from the hanging lamp)
  lanternA: null,  // PointLight
  lanternB: null,  // PointLight
};

// Fast name → node lookup populated after the env glb loads.
const nodeIndex = new Map();

// ── buildScene(canvas) ───────────────────────────────────────────────────────
// Create the scene + renderer, set up lighting, load the environment glb whole,
// and return the handles main.js holds onto. Async because it awaits the glb.
export async function buildScene(canvas) {
  // --- Scene ---
  scene = new THREE.Scene();
  // Dim warm backdrop so anything outside the room (e.g. when looking through a
  // gap) reads as a dark parlor rather than the default black/blue.
  scene.background = new THREE.Color(0x0d0a08);

  // --- Renderer ---
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  // sRGB output so colors are not washed out / gamma-wrong.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Warm filmic tone mapping (ACESFilmic ≈ the AgX-like look requested).
  renderer.toneMapping = LIGHT.TONE_MAPPING;
  renderer.toneMappingExposure = LIGHT.EXPOSURE;
  // Soft shadows for the lamp key.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // --- Clock (handed back to main.js for dt if it wants it) ---
  clock = new THREE.Clock();

  // --- Lighting (must init the RectAreaLight uniforms before use) ---
  RectAreaLightUniformsLib.init();
  buildLighting();

  // --- Static world: load environment.glb WHOLE ---
  await loadEnvironment();

  return { scene, renderer, clock, root };
}

// ── Lighting ─────────────────────────────────────────────────────────────────
// Warm interior parlor lights matching the validated Blender look. Positions are
// re-anchored to the actual Lamp_Shade / LanternA / LanternB nodes after the glb
// loads (see anchorLightsToNodes); the values here are sensible fallbacks.
function buildLighting() {
  // Warm ambient — keeps shadowed areas from going pure black.
  lights.ambient = new THREE.AmbientLight(LIGHT.AMBIENT_COLOR, LIGHT.AMBIENT_INTENSITY);
  scene.add(lights.ambient);

  // Hemisphere — subtle warm-from-above / cool-from-floor grounding.
  lights.hemi = new THREE.HemisphereLight(LIGHT.HEMI_SKY, LIGHT.HEMI_GROUND, LIGHT.HEMI_INTENSITY);
  lights.hemi.position.set(0, 3.0, 0);
  scene.add(lights.hemi);

  // Soft table-area key: a downward-facing RectAreaLight hovering over the table.
  // Broad, even light on the felt and tile faces. (No shadows — see lamp spot.)
  lights.tableArea = new THREE.RectAreaLight(
    LIGHT.TABLE_AREA_COLOR,
    LIGHT.TABLE_AREA_INTENSITY,
    LIGHT.TABLE_AREA_WIDTH,
    LIGHT.TABLE_AREA_HEIGHT,
  );
  lights.tableArea.position.set(0, LIGHT.TABLE_AREA_Y, 0);
  lights.tableArea.lookAt(0, 0, 0); // face straight down at the table center
  scene.add(lights.tableArea);

  // Shadow-casting warm key from the hanging lamp, aimed at the table center.
  lights.lamp = new THREE.SpotLight(
    LIGHT.LAMP_COLOR,
    LIGHT.LAMP_INTENSITY,
    LIGHT.LAMP_DISTANCE,
    LIGHT.LAMP_ANGLE,
    LIGHT.LAMP_PENUMBRA,
    LIGHT.LAMP_DECAY,
  );
  lights.lamp.position.set(0, LIGHT.LAMP_Y, 0);
  lights.lamp.target.position.set(0, 0.78, 0); // aim at the table top surface
  lights.lamp.castShadow = true;
  lights.lamp.shadow.mapSize.set(LIGHT.SHADOW_MAP, LIGHT.SHADOW_MAP);
  lights.lamp.shadow.camera.near = 0.3;
  lights.lamp.shadow.camera.far = LIGHT.LAMP_DISTANCE;
  lights.lamp.shadow.bias = -0.0005;     // reduce acne on the flat tiles/table
  lights.lamp.shadow.normalBias = 0.02;
  scene.add(lights.lamp);
  scene.add(lights.lamp.target); // target must be in the scene to take effect

  // Two warm wall lanterns for atmosphere / side fill.
  lights.lanternA = new THREE.PointLight(
    LIGHT.LANTERN_COLOR, LIGHT.LANTERN_INTENSITY, LIGHT.LANTERN_DISTANCE, LIGHT.LANTERN_DECAY,
  );
  lights.lanternA.position.set(...LIGHT.LANTERN_A_POS);
  scene.add(lights.lanternA);

  lights.lanternB = new THREE.PointLight(
    LIGHT.LANTERN_COLOR, LIGHT.LANTERN_INTENSITY, LIGHT.LANTERN_DISTANCE, LIGHT.LANTERN_DECAY,
  );
  lights.lanternB.position.set(...LIGHT.LANTERN_B_POS);
  scene.add(lights.lanternB);
}

// ── Environment load ─────────────────────────────────────────────────────────
// Load environment.glb whole, add it to the scene, index its named nodes, enable
// shadow receive/cast on its meshes, and re-anchor the lamp/lantern lights to the
// matching asset nodes so the lighting lines up with the modeled fixtures.
async function loadEnvironment() {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(ENV_URL);
  root = gltf.scene;

  // Index every named node for getNode() and light anchoring.
  root.traverse((obj) => {
    if (obj.name) nodeIndex.set(obj.name, obj);
    if (obj.isMesh) {
      // The room/table both receive shadows; the table + furniture also cast.
      obj.receiveShadow = true;
      obj.castShadow = true;
      // Ensure any color textures are interpreted in sRGB (GLTFLoader normally
      // sets this, but be defensive for hand-authored assets).
      const mat = obj.material;
      if (mat && mat.map && mat.map.colorSpace !== THREE.SRGBColorSpace) {
        mat.map.colorSpace = THREE.SRGBColorSpace;
        mat.map.needsUpdate = true;
      }
    }
  });

  scene.add(root);

  // Re-anchor lights to the actual fixtures if those nodes exist.
  anchorLightsToNodes();

  // Non-fatal sanity check: warn if expected nodes are missing so asset/spec
  // drift is visible in the console during browser testing.
  for (const name of ENV_NODES) {
    if (!nodeIndex.has(name)) {
      console.warn(`[scene] environment.glb missing expected node "${name}"`);
    }
  }
}

// Move the lamp spot under the modeled Lamp_Shade and the lanterns to LanternA/B,
// so the emitted light matches where the fixtures actually are in the asset.
function anchorLightsToNodes() {
  // IMPORTANT: environment.glb meshes have baked geometry — every node's object
  // origin is left at (0,0,0), so getWorldPosition() returns the origin, NOT where
  // the fixture actually hangs. That collapsed all lights onto the floor (black
  // floor/table). Use the world-space bounding-box CENTER of each fixture instead.
  const _box = new THREE.Box3();
  const _c = new THREE.Vector3();
  const fixtureCenter = (name) => {
    const node = nodeIndex.get(name);
    if (!node) return null;
    _box.setFromObject(node);
    if (_box.isEmpty()) return null;
    return _box.getCenter(_c).clone();
  };

  const lampC = fixtureCenter('Lamp_Shade');
  // Guard: only re-anchor if the shade really is up near the ceiling; otherwise keep
  // the hand-tuned fallback positions from buildLighting().
  if (lampC && lights.lamp && lampC.y > 1.0) {
    // Sit the spot just below the shade so the cone clears the geometry.
    lights.lamp.position.set(lampC.x, lampC.y - 0.1, lampC.z);
    lights.lamp.target.position.set(lampC.x, 0.78, lampC.z);
    // Keep the soft area key centered under the shade too (clamped to its tuned Y).
    if (lights.tableArea) {
      lights.tableArea.position.set(lampC.x, Math.min(lampC.y - 0.3, LIGHT.TABLE_AREA_Y), lampC.z);
      lights.tableArea.lookAt(lampC.x, 0, lampC.z);
    }
  }

  const aC = fixtureCenter('LanternA');
  if (aC && lights.lanternA && aC.y > 0.5) lights.lanternA.position.copy(aC);
  const bC = fixtureCenter('LanternB');
  if (bC && lights.lanternB && bC.y > 0.5) lights.lanternB.position.copy(bC);
}

// ── getNode(name) ────────────────────────────────────────────────────────────
// Look up a named node in the loaded environment glTF (Floor, TableTop,
// Lamp_Shade, …). Returns null before load or if the name is absent.
export function getNode(name) {
  return nodeIndex.get(name) || null;
}

// ── render(camera) ───────────────────────────────────────────────────────────
// Draw the scene from the given camera. Called every frame by main.js.
export function render(camera) {
  if (renderer && scene && camera) renderer.render(scene, camera);
}

// ── onResize(camera) ─────────────────────────────────────────────────────────
// Update the renderer size + pixel ratio and the camera aspect on window resize.
export function onResize(camera) {
  if (!renderer) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  if (camera && camera.isPerspectiveCamera) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
