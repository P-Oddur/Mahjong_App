# Neon Parlour → js3d Visual Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the visual environment of the wired `public/js3d/` mahjong client with the "Neon Parlour" look from `_from-open-design/`, faithfully — a near-black, glow-lit HK cha-chaan-teng built procedurally, with emissive-MRT bloom, the full decor catalogue, and the interactive toys — without touching networking, state, seats, camera, input, or HUD.

**Architecture:** Swap `js3d`'s `WebGLRenderer` for a `WebGPURenderer` (three r0.184 webgpu build, automatic WebGL2-backend fallback) and add the emissive-MRT TSL bloom via `RenderPipeline`. Replace `scene.js`'s `environment.glb` load with the parlour's fully procedural room/ceiling/lights/decor (ported into focused new modules), and replace the `interact.js` stub with the parlour's working toys. The server-driven tiles/avatars stay exactly as they are (the GLBs are byte-identical to the parlour's and `tiles.js` already maps `{suit,value,id}` correctly, including `bam`→`sou`).

**Tech Stack:** three.js **r0.184.0** (WebGPU build + TSL), ES modules served raw by Express, Socket.IO (untouched), procedural `CanvasTexture` materials (zero image assets).

## Global Constraints

- **three pinned at r0.184.0**, loaded from the CDN via the existing import map. Use the **WebGPU build** (`build/three.webgpu.js`) and TSL (`build/three.tsl.js`). Renderer = `WebGPURenderer` (it falls back to a WebGL2 backend automatically when WebGPU is unavailable).
- **Never modify** `public/js3d/net.js`, `state.js`, `seats.js`, `camera.js`, `input.js`, `hud.js`. These are the networking / state / seat-geometry / interaction / overlay boundaries. `main.js` should require **no change** (verify this holds; if a one-line change is unavoidable, call it out and keep it minimal).
- **Tile contract is fixed:** `{ suit, value, id }`, `suit ∈ man|pin|bam|wind|dragon|flower`. The `bam`→`sou` GLB node mapping already lives in `tiles.js` — do **not** change it.
- **Do NOT port** the cosmetic scripted deal (`startDeal`/`updateDeal`), the 144-tile pinwheel wall, the dormant `tiles.js`, the dead/uncalled builders, or the temp dev buttons / OD-sandbox dynamic-`import()` bootstrap from the parlour.
- **No new image assets.** All textures are painted to `<canvas>` → `THREE.CanvasTexture` (matching the parlour). `tiles.glb` / `avatar.glb` are already shipped and identical — do not re-copy. Stop loading `environment.glb` (leave the file in place, unused).
- **`game3d.html` must boot and stay playable after every task/commit.** Each task ends green.
- **Branch:** work on `p-oddur-dev` (current). Commit frequently. Do **not** push upstream.
- **Lighting source of truth:** the parlour's `TUNE.def` baked values (exposure 0.26, key spot 80.5, warm fill 18.35, ambient 0.32, hemi 0.28, bloom, etc.). Port these as named constants.

---

## Coordinate reconciliation (read before Task 3)

The parlour and `js3d` coordinate systems are **already highly compatible** — both are Y-up metres, table centred at origin, 4 seats on a ~1.0 m ring, table top at `Y=0.78`. Differences to honour when porting room/decor geometry:

| Quantity | Parlour | js3d (`seats.js`) | Resolution |
|---|---|---|---|
| Table top Y | `TABLE_TOP=0.78` | `TABLE_TOP_Y=0.78` | identical ✓ |
| Seat ring | chairs at `±1.0` | `SEAT_RADIUS=1.0` | identical ✓ |
| Eye height | camera seat `1.05` | `EYE_Y=1.2` | **keep js3d `EYE_Y=1.2`**; verify decor still framed |
| Camera | FOV 90, mouse-offset | FOV 70, pointer-lock | **keep js3d camera.js** unchanged |
| Room shell | `W=D=6.4, H=3.2`, walls inner ±3.15 | from `environment.glb` (≈5×5) | **adopt parlour 6.4×6.4×3.2**; it encloses the 1.0 m seat ring fine |

Net: port the parlour room/decor geometry **as-authored** (it was built around this exact table/seat layout), then verify framing from the js3d eye (`Y=1.2`, FOV 70) and nudge only if something reads wrong.

---

## File structure

**Modified:**
- `public/game3d.html` — import map → webgpu build + `three/webgpu` + `three/tsl`.
- `public/js3d/scene.js` — `WebGPURenderer` + `await init()`, `RenderPipeline` emissive-MRT bloom, procedural room/lights/fog/exposure, decor host. Loses the `environment.glb` load and `anchorLightsToNodes`. Keeps its exported surface: `scene`, `renderer`, `clock`, `root`, `lights`, `getNode()`, `buildScene()`, `render()`, `onResize()`.
- `public/js3d/interact.js` — replace the v1 stub with the working toys, keeping the exported signatures `initInteractables(scene)`, `objectAtReticle(raycaster)`, `handleReticleClick(mesh)`, `applyInteractState(object, state)`.

**Created (focused new modules, imported by `scene.js`):**
- `public/js3d/parlour/textures.js` — canvas-texture painters (terrazzo, wall+dado, ceiling tin, neon glyph, tin-ad, menu, TV, skyline, street, etc.), each returning a configured `CanvasTexture`.
- `public/js3d/parlour/materials.js` — the `mat()` / `box()` helpers and the neon-sign material factory.
- `public/js3d/parlour/room.js` — `buildRoom()`, `buildCeiling()` (shell, floor, walls, cornice).
- `public/js3d/parlour/lights.js` — `buildLights()` + the baked `TUNE.def` constants object (`PARLOUR` lighting/glow values) and `applyTune()` to push them into live objects.
- `public/js3d/parlour/decor.js` — `buildDecor()` → the full §10 catalogue (pendant, neon signs, faan chart, menu, TV, alley window, door, tin ads, fluorescent tubes, shrine, dice bowl, exhaust fan, bar, dining nook, birdcage, clock, scroll, dust). Returns handles the render loop animates and the `pickables[]` toys.
- `public/js3d/parlour/animate.js` — `updateParlour(dt, elapsed)`: neon flicker, dust drift, fan/clock spin, candle flicker, tube buzz (the per-frame parlour animation, minus the deal).
- `public/parlour-preview.html` — **dev-only** standalone harness (not linked from the lobby) that builds scene+camera+a few sample tiles with **no socket/session guard**, so the look can be iterated and screenshotted without a live game. This is the primary verification surface.

> Source to port from: `_from-open-design/js/parlour.js` (room/lights/decor/post/animate), `_from-open-design/js/audio.js` (NOT in scope this pass), `_from-open-design/index.html` (harness reference for the preview page). Port the **techniques and values**, re-expressed for r0.184 + the js3d module layout — do not copy `_from-open-design/js/vendor/*` (we use the CDN).

---

## Open assumptions to confirm (raised per CLAUDE.md before execution)

1. **TUNE slider panel:** bake `TUNE.def` values as constants and **drop the on-screen slider panel** by default (it's a lab tool). Optionally re-add it behind a `?tune` query param later. — *Assumed: bake values, no panel this pass.*
2. **`environment.glb`:** stop loading it; leave the file on disk unused (don't delete). — *Assumed.*
3. **Camera/interaction model:** keep js3d's FOV-70 pointer-lock free-look; do **not** adopt the parlour's FOV-90 mouse-offset camera. — *Assumed.*
4. **Audio & tile/avatar materials:** out of scope this pass (per your scope selection). The existing js3d `audio.js` and GLB-baked tile/avatar materials stay. — *Confirmed by scope answer.*

---

## Task 0: Dev preview harness (verification infrastructure)

**Files:**
- Create: `public/parlour-preview.html`

**Interfaces:**
- Consumes: `scene.buildScene(canvas)`, `camera.createCamera()`, `camera.seatCamera(cam,0)`, `tiles.loadTileGeometries()` (existing exports).
- Produces: a no-socket page that renders the scene, used by every later task's verification.

- [ ] **Step 1:** Create `public/parlour-preview.html` mirroring `game3d.html`'s import map and full-screen canvas, but with an inline module that calls `scene.buildScene`, creates/seats the camera, optionally loads a couple of sample tiles, enables `camera`+`input` for free-look, and runs a `requestAnimationFrame` loop calling `scene.render(cam)` + `scene.updateParlour?.(dt)` — with **no** `net`/`state`/session-guard imports.
- [ ] **Step 2 (verify):** Launch the app (see Verification section) and open `http://localhost:<port>/parlour-preview.html` via chrome-devtools MCP. Expected: page loads, no console errors, the current (pre-port) room renders. Screenshot.
- [ ] **Step 3 (commit):** `git add public/parlour-preview.html && git commit -m "test(js3d): add socket-free parlour preview harness for visual iteration"`

---

## Task 1: Renderer swap → WebGPURenderer (look unchanged)

Swap the renderer only; keep the existing lighting and `environment.glb` so the room still renders. This isolates the renderer change.

**Files:**
- Modify: `public/game3d.html` (import map), `public/parlour-preview.html` (same import map), `public/js3d/scene.js:17` (imports), `scene.js:109-144` (`buildScene`), `scene.js:290-308` (`render`/`onResize`).

**Interfaces:**
- Produces: `scene.renderer` is now a `WebGPURenderer` initialized via `await renderer.init()` inside `buildScene` (already async, already awaited by `main.js:64`). `render()`/`onResize()` signatures unchanged.

- [ ] **Step 1:** In `game3d.html` and `parlour-preview.html`, change the import map to the webgpu build:
```html
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.webgpu.js",
    "three/webgpu": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.webgpu.js",
    "three/tsl": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.tsl.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/"
  }
}
</script>
```
- [ ] **Step 2:** In `scene.js`, construct the renderer as WebGPU and init it. Replace the `new THREE.WebGLRenderer({...})` block (lines 117-131) with:
```js
renderer = new THREE.WebGPURenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1)); // cap at 1× — biggest GPU win on HiDPI
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = LIGHT.EXPOSURE; // still 1.05 in this task; retuned in Task 3
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
await renderer.init(); // WebGPU→WebGL2 handshake; must complete before first render
```
(`THREE.WebGPURenderer` resolves from the webgpu build via the `three` mapping; no import path change needed since `scene.js` imports `* as THREE from 'three'`.)
- [ ] **Step 3:** Make rendering async-safe. Change `render()` to:
```js
export function render(camera) {
  if (renderer && scene && camera) renderer.renderAsync(scene, camera);
}
```
(Fire-and-forget renderAsync inside the existing rAF loop matches the parlour's pattern; if frame pacing stutters, switch `main.js`'s loop to `renderer.setAnimationLoop` — note only, don't do it pre-emptively.)
- [ ] **Step 4 (verify):** Reload `parlour-preview.html` and `game3d.html` (in a live game) via chrome-devtools MCP. Expected: room renders identically to before, console shows no WebGPU init failure. Check `navigator.gpu` present; then confirm WebGL2 fallback by relaunching with WebGPU disabled (chrome flag) — room still renders. Screenshot both.
- [ ] **Step 5 (commit):** `git commit -am "feat(js3d): swap WebGLRenderer for WebGPURenderer (WebGL2 fallback)"`

---

## Task 2: Emissive-MRT bloom pipeline

Add the `RenderPipeline` with emissive-MRT bloom so emissive materials glow. Tag the existing lamp/lanterns emissive to prove it.

**Files:**
- Modify: `public/js3d/scene.js` (imports, `buildScene`, `render`, `onResize`).

**Interfaces:**
- Produces: `scene.pipeline` (the `RenderPipeline`) and `scene.bloom` (the bloom node, for later tuning). `render()` uses the pipeline when present.

- [ ] **Step 1:** Add TSL imports at the top of `scene.js`:
```js
import { pass, mrt, output, emissive } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
```
- [ ] **Step 2:** After `await renderer.init()` and after the scene/lights exist (end of `buildScene`, before `return`), build the pipeline:
```js
const scenePass = pass(scene, camera /* see note */);
scenePass.setMRT(mrt({ output, emissive }));
const colorTex = scenePass.getTextureNode('output');
const emissiveTex = scenePass.getTextureNode('emissive');
const bloomPass = bloom(emissiveTex);
bloomPass.threshold.value = PARLOUR.bloomThreshold; // 0 — every emissive texel blooms
bloomPass.strength.value  = PARLOUR.bloomStrength;
bloomPass.radius.value    = PARLOUR.bloomRadius;
pipeline = new THREE.RenderPipeline(renderer);
pipeline.outputNode = colorTex.add(bloomPass);
```
> **Camera note:** `pass(scene, camera)` needs the camera, but `buildScene` runs before `main.js` creates it. Resolve by having `buildScene` accept the camera, OR build the pipeline lazily on first `render(camera)` (preferred — zero `main.js` change): on the first `render` call, if `!pipeline`, construct it with the passed `camera`, then `pipeline.renderAsync()`.
- [ ] **Step 3:** Update `render()` to use the pipeline (lazy-build on first call):
```js
export function render(camera) {
  if (!renderer || !scene || !camera) return;
  if (!pipeline) buildPipeline(camera); // constructs scenePass/bloom/pipeline once
  pipeline.renderAsync();
}
```
- [ ] **Step 4:** Handle resize: in `onResize`, after `renderer.setSize(...)`, also `pipeline?.setSize?.(w, h)` (or rebuild the pass if the RenderPipeline doesn't auto-track — verify against r0.184 behavior; the pass output targets follow renderer size in current three, so a `setSize` passthrough is usually enough).
- [ ] **Step 5 (verify):** Temporarily give `lights.lamp`-adjacent geometry or a test mesh an `emissive` color in the preview. Expected: it glows/blooms; non-emissive bright surfaces do not. Screenshot. Remove the test mesh.
- [ ] **Step 6 (commit):** `git commit -am "feat(js3d): emissive-MRT TSL bloom via RenderPipeline"`

---

## Task 3: Procedural room shell + lights + the dark "lit-by-glow" grade

Replace `environment.glb` with the parlour's procedural room and the baked dark lighting. This is where the look flips to the parlour.

**Files:**
- Create: `public/js3d/parlour/textures.js`, `materials.js`, `room.js`, `lights.js`.
- Modify: `public/js3d/scene.js` (drop `loadEnvironment`/`anchorLightsToNodes`/`ENV_*`; call procedural builders; set fog + exposure; replace `buildLighting`).

**Interfaces:**
- Produces:
  - `materials.js`: `mat(color, rough, metal, extra?)`, `box(w,h,d,material,x,y,z,cast?,recv?)`, `neonMaterial(glyphCanvasTexture)`.
  - `textures.js`: `terrazzoTexture()`, `wallTexture()`, `ceilingTexture()`, `neonGlyph(text, color, opts)`, plus the decor painters used in Task 4 (`tinAdTexture`, `menuTexture`, `tvTexture`, `skylineTexture`, `streetTexture`, …).
  - `room.js`: `buildRoom(scene)`, `buildCeiling(scene)`.
  - `lights.js`: `PARLOUR` (baked `TUNE.def` constants incl. exposure 0.26, key 80.5, fill 18.35, ambient 0.32, hemi 0.28, bloomThreshold 0, bloomStrength/Radius, neon/spill values), `buildLights(scene)` → fills `scene.lights`, `applyTune(handles)`.

- [ ] **Step 1:** Port `materials.js` (the `mat`/`box`/neon helpers) verbatim from `parlour.js`, adjusted for r0.184 (`MeshStandardMaterial`/`MeshPhysicalMaterial` APIs are unchanged). Neon-sign material = black base, `emissiveMap`+`alphaMap` = glyph canvas, `transparent`, `depthWrite:false`, `DoubleSide`.
- [ ] **Step 2:** Port the room textures into `textures.js` (`terrazzoTexture` 700 chips repeat 5×5, `wallTexture` cream+jade-dado baked repeat 8×1, `ceilingTexture` pressed-tin 2×2 repeat 6×6). All `CanvasTexture`, `SRGBColorSpace`, `anisotropy=8`.
- [ ] **Step 3:** Port `buildRoom`/`buildCeiling` into `room.js` using parlour dimensions (`W=D=6.4, H=3.2`, inner faces ±3.15, floor `y=0`, ceiling `y≈3.18`, cornice). Front wall `cast=false,recv=false`.
- [ ] **Step 4:** Port `buildLights` + `PARLOUR` constants into `lights.js`: ambient `0x2b3a3a@0.32`, hemisphere `@0.28`, **key SpotLight 80.5** @ `(0,2.78,0)` aimed at table (1024² PCFSoft, the only shadow-caster), warm fill PointLight `18.35` @ `(0,2.37,0)`, neon spill lights, tube cool fill `0.28`. Re-anchor to the parlour pendant position (no GLB nodes now).
- [ ] **Step 5:** In `scene.js` `buildScene`: set `scene.background = new THREE.Color(0x06090a)` and `scene.fog = new THREE.FogExp2(0x06090a, 0.05)`; set `renderer.toneMappingExposure = PARLOUR.exposure` (0.26); add `setupEnv()` PMREM from `RoomEnvironment` at `environmentIntensity 0.22` (import `RoomEnvironment` from `three/addons/environments/RoomEnvironment.js`, wrap in try/catch). Remove `loadEnvironment`, `anchorLightsToNodes`, `ENV_URL`, `ENV_NODES`. Call `buildRoom(scene)`, `buildCeiling(scene)`, `buildLights(scene)`. Wire the Task-2 bloom values to read from `PARLOUR`.
- [ ] **Step 6 (verify):** Reload `parlour-preview.html`. Expected: near-black room, dramatic pendant pool on the table, terrazzo floor + jade-dado walls, corners falling to fog-black. Verify framing from `EYE_Y=1.2`/FOV-70 (the player seat) looks right; nudge wall/ceiling Y only if clipped. Confirm sample tiles on the table are lit by the key pool. Screenshot.
- [ ] **Step 7 (commit):** `git commit -am "feat(js3d): procedural parlour room + lit-by-glow lighting (replaces environment.glb)"`

---

## Task 4: Full decor catalogue

Port the §10 decor. Group into sub-steps so each is independently verifiable; commit per logical group.

**Files:**
- Create: `public/js3d/parlour/decor.js`, `public/js3d/parlour/animate.js`. Extend `textures.js` with decor painters.
- Modify: `public/js3d/scene.js` (call `buildDecor(scene)`; expose `updateParlour(dt)` and call decor's animated handles).

**Interfaces:**
- Produces: `decor.js`: `buildDecor(scene)` → `{ animated, pickables }` (handles for `animate.js`; toys for Task 5). `animate.js`: `updateParlour(dt, elapsed)`. `scene.js` re-exports `updateParlour` so the preview/loop can call it.

- [ ] **Step 1 — centrepieces:** Port `buildPendantLamp`, the three neon signs (麻雀 magenta, 香港 jade, 番數表 faan chart + green frame) with companion spill lights and master-dimmer coupling, and `buildSkylineWall`. Wire neon flicker into `animate.js`. **Faan chart values must mirror the backend scoring patterns** (平糊1, 對對糊3, 清一色7, limit tiers) — cross-check against `scoring.js`/`rulesets.js`.
- [ ] **Step 2 — wall fixtures:** Port `buildMenuBoard`, `buildWallTV` (emissive broadcast canvas + cool glow), `buildClock` (sweeping hands, magenta second hand), `buildScroll`, `buildAlleyWindow` (fake-depth diorama + parallax boards + magenta spill), `buildWallFan` (recessed duct, spinning blades).
- [ ] **Step 3 — front wall & corners:** Port `buildDoor` (emissive sidewalk, frame, push-bar, couplets, 福), `buildTinAds` (10 jittered enamel plates), `buildBar` + `buildDimSum`, `buildShrine` (×2 scale), `buildBirdcage`.
- [ ] **Step 4 — ambiance & nook:** Port `buildFluorescentTubes` (twin emissive tubes + cool fill, `Number.isFinite` self-heal in the animate step), `buildDiningTable` + `buildLeftovers`, `buildDust` (340 additive points, ~55% in-cone, upward drift wrapping at `y>2.4`).
- [ ] **Step 5:** In `scene.js`, call `buildDecor(scene)` after lights; store its `animated` handles; implement/extend `updateParlour(dt)` to run `animate.js` (neon flicker, dust, fan/clock spin, candle flicker, tube buzz). Ensure the preview loop calls `scene.updateParlour(dt)`.
- [ ] **Step 6 (verify, after each of steps 1–4):** Reload `parlour-preview.html`; confirm the newly-added pieces appear, glow correctly (emissive→bloom), and animate. Pan the camera around all four walls. Screenshot each group.
- [ ] **Step 7 (commit per group):** e.g. `git commit -am "feat(js3d): parlour decor — neon signs, faan chart, pendant"` … one commit per sub-step.

---

## Task 5: Interactive toys

Replace the `interact.js` stub with the parlour's working toys, driven by the existing `input.js` reticle (`objectAtReticle`/`handleReticleClick`) and the `interactState` relay already wired in `main.js`/`net.js`.

**Files:**
- Modify: `public/js3d/interact.js` (keep exported signatures), `public/js3d/parlour/decor.js` (tag toy roots with `userData.pickType`), `public/js3d/parlour/animate.js` (toy animations).

**Interfaces:**
- Consumes: `decor.js` `pickables[]` (dice bowl, shrine, fluorescent tubes, OPEN sign), each tagged `userData.pickType ∈ {'dice','shrine','tubes','opensign'}`.
- Produces (unchanged signatures): `initInteractables(scene)` records scene + pickables; `objectAtReticle(raycaster)` returns the tagged root under the reticle (walk parents up); `handleReticleClick(mesh)` runs the toy trigger and returns `true` if consumed; `applyInteractState(object, state)` applies a peer's toy state.

- [ ] **Step 1:** `initInteractables(scene)` collects the decor toys into a local `pickables` list (from `decor.buildDecor`'s return or a `scene` traversal for `userData.pickType`).
- [ ] **Step 2:** Implement `objectAtReticle(raycaster)` = raycast against `pickables`, return the `pickType`-tagged ancestor (mirror the parlour `pickRoot`). Implement hover affordance via `userData.reticleHover` (input.js already toggles the cursor/flag).
- [ ] **Step 3:** Implement `handleReticleClick(mesh)` = the parlour `triggerToy` switch: `tubes` (toggle + startup flicker), `shrine` (4 s incense pulse), `dice` (0.9 s roll → snap, opposite faces sum 7), `opensign` (½-turn flip). Drive the per-frame eases from `animate.js`. Return `true` when a toy is hit.
- [ ] **Step 4:** Make toys multiplayer-aware: on local trigger, `main.js` already forwards `routeAction({kind:'interact', object, state})` → `net.emitInteractState`. Have `handleReticleClick` return a `{object, state}` so `input.js`'s existing action path emits it; implement `applyInteractState(object, state)` to replay a peer's toy change. (Confirm `input.js` already routes interact clicks to `onAction`; if it only calls `handleReticleClick`, surface the smallest wiring needed — do **not** restructure input.js.)
- [ ] **Step 5 (verify):** In `parlour-preview.html`, click each toy via chrome-devtools MCP (pointer-lock + click at reticle): dice roll+snap, shrine pulse, tubes toggle, sign flip. Then in a live 2-client `game3d.html` session, confirm a toy triggered by one client replays on the other via `interactState`. Screenshot.
- [ ] **Step 6 (commit):** `git commit -am "feat(js3d): wire parlour interactive toys (dice/shrine/tubes/open-sign)"`

---

## Task 6: Final integration pass on the live client

**Files:**
- Modify: `public/game3d.html` only if needed (it already just hosts the canvas + loads `main.js`).

- [ ] **Step 1 (verify, full game):** Start the server, open two browsers, create+join a room with **3D mode** enabled, start a hand. Confirm: room renders in the parlour look; server-driven tiles deal into hands/discards correctly (suits incl. a `bam`/sou tile, winds, dragons, a flower); avatars seated + head-look syncs; bloom/glow present; toys work; no console errors; acceptable frame rate (pixel ratio capped at 1×).
- [ ] **Step 2 (verify, fallback):** Repeat with WebGPU disabled → WebGL2 backend renders the same scene (bloom may differ slightly; must not error).
- [ ] **Step 3:** Run the existing test suite to confirm nothing server-side regressed: `npm test`. Expected: all pass (these cover rules/scoring, untouched).
- [ ] **Step 4 (commit):** `git commit -am "test(js3d): verify full parlour port end-to-end (live game + WebGL2 fallback)"`

---

## Verification (how to run & observe)

- **Start the app:** `npm start` (Express serves `public/` statically; note the port from server output). Use the `run`/`verify` skills if available.
- **Visual iteration (no game needed):** open `http://localhost:<port>/parlour-preview.html` with the chrome-devtools MCP (`new_page`/`navigate_page`), then `take_screenshot`, `list_console_messages` (must be clean), and `click`/`press_key` for toy/camera interaction. WebGPU works in headless Chrome; verify `evaluate_script` → `!!navigator.gpu`.
- **Live game (full path):** the real `game3d.html` requires a session (lobby → enable "🀄 3D mode" → create/join → start). Use two pages for look-sync and `interactState` checks.
- **Server-side regression:** `npm test`.
- **Per-task gate:** each task above ends with a screenshot + clean console before its commit.

## Self-review checklist (run before declaring the plan done)

- Every parlour system in `INTEGRATION.md` §1–§16 is either ported (Tasks 3–5) or explicitly excluded (deal/wall/dormant tiles/dead builders/dev buttons — Global Constraints).
- No `net.js`/`state.js`/`seats.js`/`camera.js`/`input.js`/`hud.js` edits (boundaries).
- Tile contract `{suit,value,id}` + `bam`→`sou` untouched.
- `game3d.html` boots after every task.
- r0.184 API names verified (`WebGPURenderer`, `RenderPipeline`, `pass`/`mrt`/`output`/`emissive`, `bloom` from `three/addons/tsl/display/BloomNode.js`).
