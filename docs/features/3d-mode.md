# Experimental First-Person 3D Client
> A vanilla-JS, Three.js (WebGPU) first-person "Neon Parlour" client that renders the same Hong Kong mahjong game as the 2D board, speaking the **identical** Socket.IO protocol so the server is completely unchanged.

## Overview

The 3D client is a fully additive, opt-in alternative front-end. The 2D page (`public/game.html`) remains the default; a per-browser toggle routes the player to the 3D page instead. The 3D client:

- puts the camera at a fixed first-person seat eye and lets the player free-look with the mouse (pointer-lock), aiming a center reticle at their own tiles to discard;
- renders a procedural neon-parlour room, a table, 3D tiles loaded from a GLB, seated avatars whose heads turn to mirror each remote player's look, and a gliding turn-token puck;
- keeps **all** game logic on the server and reuses the same `public/shared/` modules the 2D client uses (rules affordances, hand dock, discard/claim indicator), so gameplay rules and emit vocabulary are byte-for-byte the same.

Two genuinely new socket events exist (`playerLook`, `interactState`) purely for cosmetic scene sync (avatar heads, parlour toys); the server relays them and stores the last value for late joiners. Everything else is the pre-existing 2D protocol.

Note: the page loads Three.js from a CDN via an import map (see Protocol/Invariants) — **it requires internet access** and a WebGPU/WebGL2-capable browser.

## Architecture

| File / module | Responsibility |
| --- | --- |
| `public/game3d.html` | Page shell: full-screen `#game3d-canvas`, empty HUD container divs (`#hud-reticle`, `#hud-status`, `#hud-action-bar`, `#hud-dock`, `#hud-game-over`), neon "雀" loading splash, the Three.js import map, loads `/socket.io/socket.io.js` then `/js3d/main.js` as the entry module. |
| `public/index.html` | Lobby. `gamePage()` and the `#mode3d-toggle` checkbox persist the `localStorage 'mahjong3d'` preference and choose `/game3d.html` vs `/game.html`. |
| `js3d/main.js` | Orchestrator. The only module with broad imports. Boot guard, socket connect + rejoin, builds scene/camera/subsystems, registers inbound net handlers, wires the `gameUpdate → state.applyGameUpdate → subscribers` fan-out, routes committed actions (`routeAction`/`routeHudButton`), runs the rAF render loop. |
| `js3d/net.js` | The **only** module that touches the socket. Owns the single `io()` instance, `INBOUND_EVENTS` dispatch table, typed `emit*` helpers, and the outbound `playerLook` throttle. Imports no Three. |
| `js3d/state.js` | Single source of truth: the `store` mirroring server `gameState`. `applyGameUpdate`, `subscribe`/`notify`, `setMyIndex`, `setClaimResponded`, and relative-seat math (`relativeSeat`/`absSeatAtRelative`). Imports no Three. |
| `js3d/hud.js` | 2D DOM overlay: reticle, status banner, wall/round-wind line, action button bar, always-on hand dock, hover-magnify, dice readout, discard/claim indicator, game-over + standings overlay, action bubbles. Injects its own CSS (`style.css` is not loaded by the 3D page). |
| `js3d/scene.js` | Owns `THREE.Scene` + `WebGPURenderer` (ACES tone mapping, shadows, `await renderer.init()` for WebGL2 fallback), builds the parlour room/lights/furniture/decor, and the lazy emissive-MRT **bloom** post pipeline. Exposes `buildScene`, `render`, `onResize`, `updateParlour`, `getParlourAnimated`. |
| `js3d/camera.js` | Fixed first-person `PerspectiveCamera` pinned at relative seat 0; never translates, only rotates. `createCamera`, `seatCamera`, `setLook`/`getLook`, `update`, `onLookChange`. Defers angle math to `lib/camera-math.js`. |
| `js3d/seats.js` | Seat world transforms (THREE wrapper over `lib/seat-geometry.js`): `SEATS`, `seatTransform`, `eyeForSeat`, `SEAT_FACING_BASE`. No IO, no scene mutation. |
| `js3d/tiles.js` | Tile mesh factory + table layout + per-`gameUpdate` reconciliation. Loads `/assets/3d/tiles.glb`, caches a node per tile type, lays out hands/melds/discards/wall, runs eased draw/discard tweens and the opening deal-in jump. `tileAtReticle` for hit-testing. |
| `js3d/avatar.js` | Loads `/assets/3d/avatar.glb`, instances one seated avatar per occupied seat, recolors the `Avatar_Accent` material per seat, **hides the local avatar**, drives remote `Avatar_Head` from `playerLook`, idle glancing + breathing. |
| `js3d/input.js` | First-person look control (pointer-lock + per-frame mouse-delta apply), center-reticle raycast, hotkeys, and `computeAffordances` (mirrors `game.js renderActions`). Converts committed input into the action objects `main.routeAction` understands. |
| `js3d/interact.js` | Reticle-driven parlour toys (`tubes`/`shrine`/`dice`/`opensign`). `objectAtReticle`, `handleReticleClick`, `applyInteractState`; sets request flags on the parlour animation registry and relays via `net.emitInteractState`. |
| `js3d/audio.js` | Minimal WebAudio synth (no asset deps): `initAudio`, `playTileClick`, `startAmbient`/`stopAmbient`, `setMuted`. Unlocks on first user gesture. |
| `js3d/deal.js` | Opening dice roll + deal-in trigger. Derives dice deterministically from hand number/round so all clients match; tumbles 3 dice, shows the sum, triggers `tiles.startDealIn`. Cosmetic only — never changes game state. |
| `js3d/token.js` | The 3D turn token: a gliding canvas-textured puck that rests at the active seat's discard slot, chases to the next seat, and carries the turn clock dial. |
| `js3d/lib/seat-geometry.js` | Dependency-free pure core: seat positions/facing/eye, relative↔absolute seat mapping. Unit-tested in Node. |
| `js3d/lib/camera-math.js` | Dependency-free pure core: yaw wrap, pitch clamp, look composition, look-changed epsilon. Unit-tested in Node. |
| `js3d/lib/tile-math.js` | Dependency-free pure core: tile→GLB node name, hand-rack offsets, seat-local→world, discard grid, deal-break seat, easing, tile dimensions, corner-bonus placement. Unit-tested in Node. |
| `js3d/parlour/*.js` | Procedural "Neon Parlour" environment (see below). |

### `parlour/` (room environment, summarized)

A self-contained procedural room ported from an Open Design original; no `env.glb`. Collectively: `room.js` (`buildRoom`/`buildCeiling` — floor, walls, ceiling), `lights.js` (`buildLights` + the frozen `PARLOUR` baked look constants that also feed scene.js's bloom/exposure), `furniture.js` (`buildTableAndChairs`), `materials.js` (`mat`/`box`/`neonMaterial` helpers), `textures.js` (procedural canvas textures — terrazzo, walls, neon glyphs, dice pips via `pipTexture`, etc.), `decor.js` (`buildDecor` — neon signs, faan chart, pendant, and the four interactable toys tagged `userData.pickType`), `animate.js` (`makeRegistry`/`register`/`updateParlour` — neon flicker, dice tumble, sign flip eases consumed from request flags).

## Data shapes

`state.store` (`state.js`) — the local mirror:
```
store = {
  gameState: null,        // last `gameUpdate` payload from the server; null until first update
  myIndex: null,          // local ABSOLUTE seat index
  claimResponded: false,  // locked after a claim/pass until the phase changes
  prevPhase: null,        // previous gameState.phase, for transition detection
}
```

`gameState` fields the 3D client reads (server-owned; consumed across hud/tiles/token/deal/input): `phase` (`'discard' | 'claim' | 'rob' | 'over'`), `players[]`, `currentTurn`, `lastDiscard`, `lastDiscardPlayer`, `discardPile[]`, `wallCount`, `roundWind`, `handNumber`, `dealerStreak`, `dealer`, `drawnId`, `robKong` (`{ seat, tile }`), `ruleset`, and `playerIndex` (re-asserts `myIndex`). Each `players[i]`: `name`, `isBot`, `hand` (present only for self), `handCount`, `melds[]` (`{ type, tiles[] }`, `type ∈ pong|chow|kong|concealed-kong`), `flowers[]`, plus optional `look = { yaw, pitch }` stored server-side for snapshots.

Relative seats everywhere: `0 = near (local)`, `1 = right`, `2 = across`, `3 = left`.

Cross-module HUD↔input bridge globals (set on `window`, not the store): `__hud_selectedTileId`, `__hud_hoverTileId`.

## Protocol

The 3D client speaks the same protocol as the 2D client; the server is unchanged. Inbound names live in `net.js` `INBOUND_EVENTS`; outbound are the `net.emit*` helpers. Only events that actually exist in code are listed.

| event | direction | payload | when |
| --- | --- | --- | --- |
| `rejoin` | client→server | `{ code, token }` | On connect / boot (`net.doRejoin`) from `sessionStorage 'mahjong'`. |
| `discard` | client→server | `{ tileId }` | Player discards (reticle click, hotkey, or dock tap). |
| `claim` | client→server | `{ type, tileIds }` | Claim a discard; `type ∈ win|pong|kong|chow`; chow carries the two from-hand ids. |
| `pass` | client→server | _(none)_ | Decline a claim/rob window. |
| `declareWin` | client→server | _(none)_ | Self-draw (tsumo) win. |
| `declareKong` | client→server | `{ tileId }` | Concealed kong (group[0].id). |
| `declareAddedKong` | client→server | `{ tileId }` | Upgrade an exposed pong (加槓). |
| `nextHandVote` | client→server | `{ value }` | Between-hands "Next Hand" toggle vote. |
| `endMatchVote` | client→server | `{ value }` | Between-hands "End Match" toggle vote. |
| `returnToLobby` | client→server | _(none)_ | Return to lobby button. |
| `organizeHand` | client→server | _(none)_ | Deterministic hand sort (`o` key). |
| `shuffleHand` | client→server | _(none)_ | Randomize hand order (`u` key). |
| `chat` | client→server | `{ text }` | Available via `net.emitChat` (chat wiring). |
| `requestState` | client→server | _(none)_ | `net.emitRequestState` (escape hatch). |
| `playerLook` | client→server | `{ yaw, pitch }` | **NEW.** ~20 Hz throttled head look (radians). |
| `interactState` | client→server | `{ object, ...toggle }` | **NEW.** Toy state; server whitelists only `on`/`open` booleans. |
| `gameUpdate` | server→client | full `gameState` | Authoritative per-frame state → `state.applyGameUpdate`. |
| `rejoined` | server→client | `{ playerIndex, state }` | Rejoin confirmed; `state==='waiting'` bounces to `/`. |
| `rejoinError` | server→client | _(none)_ | Bad/expired creds → clear session, go to `/`. |
| `identityUpdate` | server→client | `{ playerIndex }` | Seat reshuffle → re-seat camera. |
| `gameOver` | server→client | hand `result` | Hand-over overlay (faan breakdown + payments). |
| `matchOver` | server→client | `{ standings, ... }` | Final standings overlay. |
| `nextVoteUpdate` / `endVoteUpdate` | server→client | `{ voted, needed }` | Live between-hands vote tallies. |
| `backToLobby` | server→client | _(none)_ | Navigate to `/`. |
| `playerDisconnected` / `playerReconnected` | server→client | `{ name }` | Status banner. |
| `actionError` | server→client | `string` | Rejected action; unlocks the claim panel. |
| `playerAction` | server→client | `{ seat, type, tiles }` | Pong/kong/chow bubble over a seat. |
| `playerLook` | server→broadcast (others) | `{ playerIndex, yaw, pitch }` | **NEW.** Drives remote `avatar.applyLook`. |
| `interactState` | server→broadcast (others) | `{ object, playerIndex, on?, open? }` | **NEW.** Replays a peer's toy via `interact.applyInteractState`. |
| `roomUpdate` / `chatHistory` / `chatMessage` | server→client | _various_ | Listened for in `INBOUND_EVENTS` but ignored in-game here. |

Server relay points: `server.js` (`playerLook`, rate-gated, relayed via `socket.to(code).emit`), `server.js` (`interactState`, whitelisted), and `sendSceneSnapshot` (`server.js`) which replays last looks/props to a late joiner.

## Key flows

1. **Toggle & navigation.** `index.html` `init3dToggle()` reads/writes `localStorage 'mahjong3d'`; `gamePage()` returns `/game3d.html` when it is `'1'`. On `gameStarted`/`rejoined(state==='playing')` the lobby navigates there.
2. **Boot guard.** `main.start()` reads `sessionStorage 'mahjong'`; missing `code`/`token` → redirect to `/`.
3. **Connect + rejoin.** `net.connect()` creates the socket; handlers are registered **before** connecting; `net.onEvent('connect', net.doRejoin)` plus an immediate `doRejoin()` emit `rejoin { code, token }`.
4. **World build.** `scene.buildScene(canvas)` (async; `await renderer.init()`), `tiles.setScene`, `token.initToken`, `camera.createCamera()` + `seatCamera(cam, 0)`. The heavy `tiles.glb`/`avatar.glb` load **in the background** (fire-and-forget) so they never block first paint; each re-lays against the current store when it resolves.
5. **Subsystems.** `hud.initHud`, `input.initInput`, `audio.initAudio`, `interact.initInteractables`; a global pointerdown/keydown calls `deal.skip()`.
6. **Inbound data flow (the core loop).** socket `gameUpdate` → `net` dispatch → `state.applyGameUpdate(s)` (stores gameState, re-asserts `myIndex`, resets `claimResponded` on entering/leaving a claim/rob window, notifies) → every `state.subscribe` callback fires: `tiles.reconcile(store)`, `hud.render(store)`, `avatar.placeAvatars(...)`, `deal.onGameUpdate(store)`, `token.onUpdate(store)`. `subscribe()` also replays the latest snapshot immediately so a late subscriber (after async asset load) still renders.
7. **Look sync out.** `camera.onLookChange((yaw,pitch) => net.emitPlayerLook(...))`; `net` throttles to ~50 ms + 0.01 rad epsilon; server relays to other clients → their `avatar.applyLook`.
8. **Action sink in.** `input.onAction(routeAction)` and `hud.onHudButton(routeHudButton)` / `hud.onVote(...)` converge on `routeAction`, which maps each `{kind}` to one `net.emit*`. (The HUD's gameplay buttons also emit through `net.*` directly, mirroring `game.js`.)
9. **Render loop.** `frame()` clamps dt, calls `input.update`, `hud.updateMagnify`, `camera.update`, `avatar.update`, `tiles.updateTweens`, `token.update`, `deal.update`, `scene.updateParlour`, `scene.render`; hides the splash after the **first** fully-rendered frame; the whole body is wrapped in try/finally so one throw can't kill the rAF chain.
10. **Opening deal.** On a fresh-deal `gameUpdate` (wall jumps up, no discards, full hands), `deal.startRoll` derives deterministic dice, tumbles them near the dealer, and `tiles.startDealIn` jumps the freshly-laid hand in from the dice-broken wall side. Any click/key skips it.

## Invariants & gotchas

- **Identical protocol → unchanged server.** The only server additions are `playerLook`/`interactState` relays; both are cosmetic and the 2D client simply ignores them.
- **CDN import map (needs internet, no build step).** `game3d.html` maps `three`, `three/webgpu`, `three/tsl`, and `three/addons/` to `https://cdn.jsdelivr.net/npm/three@0.184.0/...`. `three` resolves to the **WebGPU build** (`three.webgpu.js`, exposing `WebGPURenderer`). There is no bundler; modules are loaded natively as ES modules.
- **WebGPU with WebGL2 fallback.** `await renderer.init()` performs the handshake before the first render; `main.showStartupError` surfaces a GPU-blocked message on the splash if init fails.
- **Pure cores are dependency-free and unit-tested in Node.** `lib/seat-geometry.js`, `lib/camera-math.js`, `lib/tile-math.js` import nothing (not even three) so the bug-prone math runs identically in the browser and under `node` tests. Tweak orientation/seat/tile constants there, not inline.
- **Camera never translates.** It is pinned at the seat eye and only rotates; a **same-seat** reseat (routine reconnect) preserves the current look — the long-standing "camera jump on reconnect" was a forced look reset (`camera.js seatCamera`).
- **Shared 2D modules are reused verbatim** from `public/shared/`: `rules-client.js` (affordances), `hand-render.js` `buildHandDock({ ..., layout: 'bare' })` for the bottom dock, and `indicator-core.js`/`indicator-dom.js` for the discard/claim controller and turn clock. Affordance logic mirrors `game.js renderActions` exactly so the panel always matches the server's re-validation.
- **Tile node-name traps** (`lib/tile-math.js tileNodeName`): server suit `'bam'` → GLB `'S_sou'`; flowers 1–4 → `S_flower`, 5–8 → `S_season`; honor tiles carry **string** values; unmapped → warn-once + blank `MahjongTile` node.
- **Geometry is shared, not cloned per instance.** Tile/avatar clones share cached geometry + non-tinted materials; only per-instance material clones (highlighted discard, `Avatar_Accent`) are disposed, never the shared geometry.
- **Local avatar is hidden** from the FP camera (otherwise own head/shoulders clip at ~180° look), but only once `myIndex` is known.
- **Dealing is animation-only.** `deal.js` derives dice from the hand number so all clients agree without a server round-trip; it changes no game state. The fresh-deal trigger persists `wallCount` in `sessionStorage` so a mid-hand reload doesn't replay the opening roll.
- **Touch is HUD-only.** First-person look is desktop pointer-lock + mousemove; touch devices fall back to the tappable 2D HUD buttons and dock.

## Code map

- `public/index.html` — `gamePage()`, `init3dToggle()`, `localStorage 'mahjong3d'`.
- `js3d/main.js` — `start`, `registerNetHandlers`, `routeAction`, `routeHudButton`, `frame`, `reseatCamera`.
- `js3d/net.js` — `INBOUND_EVENTS`, `connect`, `onEvent`, `doRejoin`, `emitDiscard`/`emitClaim`/`emitPass`/`emitDeclareWin`/`emitDeclareKong`/`emitDeclareAddedKong`/`emitNextHandVote`/`emitEndMatchVote`/`emitReturnToLobby`/`emitOrganizeHand`/`emitShuffleHand`, `emitPlayerLook`, `emitInteractState`.
- `js3d/state.js` — `store`, `applyGameUpdate`, `subscribe`, `setMyIndex`, `setClaimResponded`, `relativeSeat`, `absSeatAtRelative`, `me`, `localHand`.
- `js3d/scene.js` — `buildScene`, `render`, `onResize`, `buildPipeline`, `updateParlour`, `getParlourAnimated`, `BLOOM`.
- `js3d/camera.js` — `createCamera`, `seatCamera`, `setLook`, `getLook`, `update`, `onLookChange`.
- `js3d/tiles.js` — `loadTileGeometries`, `setScene`, `reconcile`, `makeTileMesh`, `tileAtReticle`, `tweenTo`, `updateTweens`, `startDealIn`/`snapDealIn`.
- `js3d/hud.js` — `initHud`, `render`, `setStatus`, `showGameOver`, `showStandings`, `onHudButton`, `onVote`, `updateMagnify`, `showActionBubble`, `showDiceRoll`/`hideDiceRoll`.
- `js3d/input.js` — `initInput`, `update`, `onAction`, `computeAffordances`.
- `js3d/avatar.js` — `loadAvatar`, `placeAvatars`, `applyLook`, `setLocalSeat`, `update`.
- `js3d/interact.js` — `initInteractables`, `objectAtReticle`, `handleReticleClick`, `applyInteractState`.
- `js3d/deal.js` — `onGameUpdate`, `update`, `skip`.
- `js3d/token.js` — `initToken`, `onUpdate`, `update`.
- `server.js` — `sendSceneSnapshot`, `playerLook` handler, `interactState` handler.

## Tests

The three pure cores are unit-tested in Node (run via `npm test`):

- `test/js3d-seat-geometry.test.js` → `js3d/lib/seat-geometry.js`
- `test/js3d-camera-math.test.js` → `js3d/lib/camera-math.js`
- `test/js3d-tile-math.test.js` → `js3d/lib/tile-math.js`

The THREE-dependent scene/render/HUD layers are not covered by Node unit tests (they require a browser/GPU); visual verification is done in-browser. Shared affordance/indicator logic reused by the 3D client is additionally covered by `test/rules-client-tiles.test.js` and `test/indicator-core.test.js`.
