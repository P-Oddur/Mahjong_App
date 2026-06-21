// interact.js — interactable props (teacup grab/place, lamp toggle).
//
// v1 STUB: the interactable system is scaffolded but intentionally inert so the
// rest of the scene runs. Every export is a safe no-op that satisfies the
// interfaces main.js and input.js import. Real props drop in later by:
//   - building/grabbing meshes in initInteractables(scene),
//   - returning the targeted prop mesh from objectAtReticle(raycaster),
//   - consuming a click in handleReticleClick(mesh) and emitting via net.emitInteractState,
//   - reflecting a peer's prop state in applyInteractState(object, state).
//
// Keeping these as functions (not missing) is load-bearing: a static ES import of
// a non-existent module aborts the whole page, so this file must exist.

let sceneRef = null;

// Called once by main.js after the scene is built. Store the scene so future
// versions can add prop meshes; nothing to create in v1.
export function initInteractables(scene) {
  sceneRef = scene || null;
}

// input.js asks each frame whether an interactable prop is under the center
// reticle. v1 has no props, so nothing is ever targeted.
export function objectAtReticle(/* raycaster */) {
  return null;
}

// input.js calls this when the reticle is clicked on an interactable. Return
// true to CONSUME the click (so it isn't treated as a discard / pointer-lock).
// v1 consumes nothing.
export function handleReticleClick(/* mesh */) {
  return false;
}

// main.js calls this when a peer's `interactState` arrives. The payload may carry
// extra fields (e.g. playerIndex) which we simply ignore in v1.
export function applyInteractState(/* object, state */) {
  // no-op until props exist
}
