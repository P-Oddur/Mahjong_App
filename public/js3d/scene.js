// scene.js — static world + lighting + render plumbing for the 3D mahjong client.
//
// Responsibilities (contract §5.4):
//   • create THREE.Scene + WebGPURenderer (antialias, sRGB output, ACESFilmic
//     tone mapping, shadows; WebGL2 fallback via await renderer.init()),
//   • procedural "Neon Parlour" room shell via parlour/ modules (Task 3),
//   • lit-by-glow lighting (dark exposure 0.26, key SpotLight pool, PMREM env),
//   • expose scene / renderer / lights handles, getNode(), render(), onResize().
//
// This module owns the renderer and the static world only. Dynamic objects
// (tiles, avatars, props) are added to `scene` by their own modules. main.js
// calls buildScene(canvas) once, then render(camera) every frame and
// onResize(camera) on window resize.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { pass, mrt, output, emissive } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

import { buildRoom, buildCeiling }    from './parlour/room.js';
import { buildLights, PARLOUR }       from './parlour/lights.js';
import { buildTableAndChairs }        from './parlour/furniture.js';
import { buildDecor }                 from './parlour/decor.js';
import { updateParlour as updateParlourAnim } from './parlour/animate.js';

// ── Bloom / post-processing constants ────────────────────────────────────────
// Wired to PARLOUR baked values (Task 3). Threshold 0 = every emissive texel
// blooms (glow comes from emissive-tagged materials, not bright lighting).
// Kept as an export for any future consumer that wants to read them at startup.
export const BLOOM = Object.freeze({
  THRESHOLD: PARLOUR.bloomThreshold,
  STRENGTH:  PARLOUR.bloomStrength,
  RADIUS:    PARLOUR.bloomRadius,
});

// ── Module-level handles (exposed for siblings / debugging) ──────────────────
export let scene    = null;  // THREE.Scene
export let renderer = null;  // THREE.WebGPURenderer (WebGL2 fallback via renderer.init())
export let clock    = null;  // THREE.Clock — consumed by the parlour-preview harness's dt loop
export let root     = null;  // null — procedural room has no GLB root; kept for API compat
export let pipeline = null;  // THREE.RenderPipeline — built lazily on first render()
export let postBloom = null; // the bloom node, for later tuning

// ── Decor animation handles (Task 4) ─────────────────────────────────────────
// buildDecor(scene) returns an `animated` registry (neon-flicker entries etc.)
// and a `pickables` list (interactable toys, Task 5). updateParlour(dt) below
// advances `animated` via parlour/animate.js. `parlourElapsed` is a private
// monotonic clock accumulated from whatever dt the caller passes each frame
// (main.js derives dt from performance.now(); the parlour-preview harness uses
// the exported THREE.Clock's getDelta()).
let parlourAnimated  = null;
let parlourElapsed   = 0;
export let pickables = []; // exposed for Task 5 interaction wiring

// Named light handles, extended by buildLights() from lights.js.
// avatar.js/tiles.js never read these; scene.lights is filled here as a
// single object so callers can inspect live handles if needed.
export const lights = {
  ambient:  null,   // AmbientLight
  hemi:     null,   // HemisphereLight
  lamp:     null,   // SpotLight  (shadow-casting pendant key)
  warmFill: null,   // PointLight (warm fill under shade)
  // The cool fluorescent fill lives in decor.js (animated.tubeLight) so it can be
  // toggled with the tubes; it is intentionally not mirrored here.
};

// ── buildScene(canvas) ───────────────────────────────────────────────────────
// Create the scene + renderer, set up the procedural parlour room + lighting,
// and return the handles main.js holds onto.
export async function buildScene(canvas) {
  // --- Scene ---
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06090a); // near-black parlour backdrop
  scene.fog = new THREE.FogExp2(0x06090a, 0.05); // corners fall to fog-black

  // Expose lights object on the scene so parlour/lights.js can fill it
  scene.lights = lights;

  // --- Renderer ---
  renderer = new THREE.WebGPURenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = PARLOUR.exposure; // 0.26 — the moody dark grade
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  await renderer.init(); // WebGPU→WebGL2 handshake; must complete before first render

  // --- Clock ---
  clock = new THREE.Clock();

  // --- PMREM environment from RoomEnvironment ---
  // Provides IBL reflections at a very low intensity (0.22) so surfaces pick up
  // subtle environment colour without the room reading as "lit from everywhere".
  // Wrapped in try/catch: lights alone are fine if PMREM throws under WebGPU.
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    scene.environment = pmrem.fromScene(roomEnv, 0.04).texture;
    scene.environmentIntensity = 0.22;
    roomEnv.dispose(); // free the env scene's BoxGeometry + materials (not just the generator)
    pmrem.dispose();
  } catch (e) {
    console.warn('[scene] RoomEnvironment PMREM failed — IBL skipped, lights only:', e);
  }

  // --- Procedural room shell ---
  buildRoom(scene);
  buildCeiling(scene);

  // --- Table + chairs ---
  buildTableAndChairs(scene);

  // --- Lighting ---
  buildLights(scene);

  // --- Decor (neon signs, faan chart, pendant, skyline, …) ---
  // Built after furniture + lights so companion spill lights layer correctly.
  // Returns the animation registry (consumed by updateParlour) + pickables.
  // Wait for system fonts first so the procedural CJK glyph canvases bake with the
  // correct face rather than a cold-load fallback (resolves immediately once fonts
  // are ready, or when there are none to load).
  if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch (e) {}
  }
  const decor = buildDecor(scene);
  parlourAnimated = decor.animated;
  pickables = decor.pickables;

  return { scene, renderer, clock, root };
}

// ── updateParlour(dt) ─────────────────────────────────────────────────────────
// Advance the parlour decor animation (neon flicker, fan/clock spin, dust drift,
// toy eases, etc.). Called every frame by main.js's render loop (frame() in
// main.js calls scene.updateParlour?.(dt) before scene.render()) and also by
// the preview harness in parlour-preview.html.
// Accumulates its own elapsed clock from the dt passed in each frame (so it is
// independent of how the caller measures dt).
export function updateParlour(dt) {
  if (!parlourAnimated) return;
  parlourElapsed += dt;
  updateParlourAnim(dt, parlourElapsed, parlourAnimated);
}

// ── getParlourAnimated() ──────────────────────────────────────────────────────
// Expose the live parlour animation registry to interact.js (Task 5). interact.js
// sets one-shot REQUEST flags on the toy handles here; updateParlour/animate.js
// (which owns parlourElapsed) consumes them into timed eases. Returns the same
// object reference buildScene assigned, or null before buildScene runs.
export function getParlourAnimated() {
  return parlourAnimated;
}

// ── getNode(name) ────────────────────────────────────────────────────────────
// Legacy stub kept for avatar.js compatibility (it calls scene.getNode &&
// scene.getNode('Floor') to discover the live THREE.Scene). With the procedural
// room there is no GLB node index, so this always returns null. avatar.js guards
// with `scene.getNode &&` and has other discovery paths, so null is safe.
export function getNode(_name) {
  return null;
}

// ── buildPipeline(camera) ────────────────────────────────────────────────────
// Lazily constructs the emissive-MRT bloom post-processing pipeline on the
// first render() call. Building here (not in buildScene) because
// pass(scene, camera) needs the camera, which main.js creates after buildScene.
//
// Pipeline:  scenePass (MRT: output + emissive)
//            → bloom only the emissive target (PARLOUR baked values)
//            → outputNode = colorTex + bloomedEmissive
function buildPipeline(camera) {
  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, emissive }));

  const colorTex    = scenePass.getTextureNode('output');
  const emissiveTex = scenePass.getTextureNode('emissive');

  // Values come from PARLOUR.bloom* via the BLOOM export (see lights.js); no
  // duplicated numeric literals here so the comments can't drift from the bake.
  postBloom = bloom(emissiveTex);
  postBloom.threshold.value = BLOOM.THRESHOLD; // every emissive texel blooms (0)
  postBloom.strength.value  = BLOOM.STRENGTH;
  postBloom.radius.value    = BLOOM.RADIUS;

  pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputNode = colorTex.add(postBloom);
}

// ── render(camera) ───────────────────────────────────────────────────────────
// Draw the scene. Called every frame by main.js.
// Lazily builds the post-processing pipeline on first call (needs camera).
// Three r0.184: use sync render() — renderAsync() is deprecated.
export function render(camera) {
  if (!renderer || !scene || !camera) return;
  if (!pipeline) buildPipeline(camera);
  pipeline.render();
}

// ── onResize(camera) ─────────────────────────────────────────────────────────
// Update renderer size + pixel ratio and camera aspect on window resize.
export function onResize(camera) {
  if (!renderer) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1));
  renderer.setSize(w, h, false);
  // The post pipeline's pass/bloom nodes auto-track renderer.getDrawingBufferSize()
  // each frame, so only renderer.setSize() is needed here (RenderPipeline has no
  // setSize method — the old pipeline?.setSize?.() was a silent no-op).
  if (camera && camera.isPerspectiveCamera) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
