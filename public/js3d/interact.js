// interact.js — interactable parlour TOYS (dice bowl, shrine incense, fluorescent
// tubes, OPEN/CLOSED sign) driven by the center reticle and relayed to peers.
//
// Architecture (Task 5)
// ─────────────────────
// The toy GEOMETRY + its animation HANDLES live in parlour/decor.js, stored on the
// shared `animated` registry (scene.js owns that registry and advances it every
// frame via parlour/animate.js using its own monotonic `parlourElapsed` clock).
// This module never owns that clock, so it does NOT compute timed deadlines itself.
// Instead a click sets a one-shot REQUEST flag on the registry handle, and
// animate.js (which can see `elapsed`) consumes the flag into a timed ease. The
// same request flags are set on a peer replay, so a toy one client triggers also
// plays on everyone else (cosmetic drift — e.g. dice faces — is acceptable).
//
// input.js contract (READ-ONLY):
//   • objectAtReticle(raycaster) — per-frame hover; input.js toggles
//     userData.reticleHover on whatever mesh we return (we return the tagged root).
//   • handleReticleClick(mesh) — on click; return true to CONSUME the click.
//
// main.js contract:
//   • initInteractables(scene) — called once after buildScene.
//   • applyInteractState(object, state) — called when a peer's interactState arrives.
//
// net.js is SAFE to import even with no socket (io() only runs inside connect();
// emit guards on `socket`), so the parlour preview can import this module too.

import { pickables as scenePickables, getParlourAnimated } from '/js3d/scene.js';
import { emitInteractState } from '/js3d/net.js';

// ── Module state ─────────────────────────────────────────────────────────────
let sceneRef = null;
let pickables = [];   // the toy ROOTS (each has userData.pickType)
let animated  = null; // the shared parlour animation registry (from scene.js)

// Reused raycaster scratch is owned by input.js; we only consume the one passed in.

// initInteractables(scene) — record the scene, collect the toy roots, and grab the
// live animation registry. Prefer scene.js's exported `pickables` (populated by
// buildDecor in buildScene); fall back to a scene traversal for any tagged root.
export function initInteractables(scene) {
  sceneRef = scene || null;
  animated = getParlourAnimated();

  // Primary source: scene.js's exported pickables list (the toy roots).
  pickables = Array.isArray(scenePickables) ? scenePickables.slice() : [];

  // Fallback / safety net: if the export was empty (load order), traverse the
  // scene for anything tagged with a pickType and de-dupe into the list.
  if (!pickables.length && sceneRef && sceneRef.traverse) {
    const seen = new Set(pickables);
    sceneRef.traverse((o) => {
      if (o && o.userData && o.userData.pickType && !seen.has(o)) {
        seen.add(o);
        pickables.push(o);
      }
    });
  }
}

// pickRoot(obj) — walk up the parent chain to the nearest ancestor tagged with a
// userData.pickType (mirrors the parlour source's pickRoot). Returns null if none.
function pickRoot(obj) {
  let o = obj;
  while (o) {
    if (o.userData && o.userData.pickType) return o;
    o = o.parent;
  }
  return null;
}

// objectAtReticle(raycaster) — raycast (recursive) against the toy roots and return
// the pickType-tagged ANCESTOR of the first hit. This is what input.js highlights.
export function objectAtReticle(raycaster) {
  if (!raycaster || !pickables.length) return null;
  const hits = raycaster.intersectObjects(pickables, true);
  if (!hits.length) return null;
  return pickRoot(hits[0].object);
}

// handleReticleClick(mesh) — the toy trigger. Resolve the tagged root, set the
// registry state for that toy (LOCAL, emit=true so it relays), and CONSUME the
// click by returning true. Returns false if nothing interactable was hit.
export function handleReticleClick(mesh) {
  const root = pickRoot(mesh);
  if (!root) return false;
  const type = root.userData.pickType;
  triggerToy(type, /* emit */ true);
  return true;
}

// applyInteractState(object, state) — replay a peer's toy change WITHOUT re-emitting
// (no net call), so a toy one client triggers also animates here. `object` is the
// pickType string; `state` carries any toggle values (e.g. { on }, { open }).
export function applyInteractState(object, state) {
  if (!object) return;
  triggerToy(object, /* emit */ false, state || {});
}

// ── Shared trigger logic (local click AND peer replay) ───────────────────────
// Sets one-shot REQUEST flags + carried toggle state on the registry; animate.js
// converts the flags to timed eases using its own clock. When emit=true (a local
// click) the resulting state is relayed via net.emitInteractState so peers replay
// the SAME state with emit=false. `incoming` is the peer's carried state on replay.
function triggerToy(type, emit, incoming = {}) {
  if (!animated) return; // not built yet (defensive)

  switch (type) {
    case 'tubes': {
      // The tube visual follows animated.tubesOn directly, so always drive it from an
      // ABSOLUTE value: a local click flips it; a peer replay adopts the sender's
      // value. A replay with no `on` field is a no-op (never blind-flip local state).
      if (emit) {
        const on = !animated.tubesOn;
        animated.tubesOn = on;
        if (on) animated.tubeFlickerRequested = true; // authentic startup flicker
        emitInteractState('tubes', { on });
      } else if (incoming.on != null) {
        const on = !!incoming.on;
        if (on && !animated.tubesOn) animated.tubeFlickerRequested = true;
        animated.tubesOn = on;
      }
      break;
    }

    case 'shrine': {
      // Light the incense — a timed warm-glow pulse. No carried state needed.
      animated.shrineRequested = true;
      if (emit) emitInteractState('shrine', {});
      break;
    }

    case 'dice': {
      // Roll the dice — animate.js ignores the request while already rolling, so
      // re-clicks during a roll are no-ops. Landing faces may drift per client.
      if (animated.dice) animated.dice.rollRequested = true;
      if (emit) emitInteractState('dice', {});
      break;
    }

    case 'opensign': {
      // Half-turn flip toggling 營業中 ↔ 休息中. animate.js drives the flip RELATIVELY
      // (one half-turn per request), so to keep the visible face matched to the
      // boolean we only request a flip when the target state differs from the one we
      // are currently showing — otherwise an even-parity difference would invert it.
      if (animated.openSign) {
        if (emit) {
          // Local click: flip to the other face and relay the resulting state.
          animated.openSign.open = !animated.openSign.open;
          animated.openSign.flipRequested = true;
          emitInteractState('opensign', { open: animated.openSign.open });
        } else if (incoming.open != null && !!incoming.open !== animated.openSign.open) {
          // Peer replay: adopt the sender's ABSOLUTE state; flip only if our shown
          // face differs. A replay with no `open` field is a no-op.
          animated.openSign.open = !!incoming.open;
          animated.openSign.flipRequested = true;
        }
      }
      break;
    }

    default:
      // Unknown pickType — ignore.
      break;
  }
}
