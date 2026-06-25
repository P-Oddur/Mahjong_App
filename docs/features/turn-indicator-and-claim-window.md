# Turn Indicator & Claim Window

> A travelling turn-token with a colour-ramping countdown, plus a reveal-every-discard panel that upgrades into a tap-to-claim/rob countdown — driven entirely from `gameState`, with one unit-tested pure core shared by both the 2D and 3D clients.

## Overview

This feature is the on-board "whose turn is it / what was just discarded / can I claim it?" UI. It is composed of three visible pieces:

1. **The turn token** — a small puck with a conic pie-dial that glides to whichever seat is on turn and shows the remaining seconds, the dial sweeping and its colour ramping from gold to red as time runs out.
2. **The discard reveal panel** — a dock-styled bottom-right panel that pops up on *every* discard to show the discarded tile (a min-dwell ensures it is seen even on auto-skipped discards).
3. **The claim/rob countdown** — when there is a live claim or rob window *for the local player*, the reveal panel upgrades: a perimeter halo + seconds digit appear around the tile, a matching halo is drawn around the newest tile in the discard pile (2D), and the whole panel becomes tap-to-claim (or flares to point at the chow buttons when a chow is ambiguous).

There is **no dedicated socket protocol** for any of this. Every widget renders from fields already present on the broadcast `gameState`: `phase`, `currentTurn`, `turnDeadline`, `turnTotal`, `turnTimer`, `claimDeadline`, `reactTimer`, `lastDiscard`, `lastDiscardPlayer`, `robKong`, `players[*].hand`/`.melds`, and `ruleset`. The clients also read their local `myIndex` and `claimResponded` flags.

The defining design choice is a **deliberate three-layer split**:

- `indicator-core.js` — pure, dependency-free logic (no DOM, no Three.js, no sockets), unit-tested in Node (`test/indicator-core.test.js`).
- `indicator-dom.js` — DOM widgets (the token, halo, and discard controller) built on the core; shared verbatim by the 2D board (`game.js`) and the 3D HUD overlay (`js3d/hud.js`).
- `js3d/token.js` — a *separate* in-scene Three.js puck that reuses the same core but reimplements the visual as a canvas-textured cylinder.

## Architecture

| File / module | Responsibility |
| --- | --- |
| `public/shared/indicator-core.js` | Pure logic: `TIMING`, `RAMP`, `timerFraction`, `secondsLeft`, `rampColor`, `haloDashArray`, `liveClock`, `currentDiscard`, `bestClaimAction`, `localClaim` (with a per-`gameState` memo). No DOM/Three/socket imports. |
| `public/shared/indicator-dom.js` | DOM widgets: `makePerimeterHalo`, `buildDiscardPanel`, `makeDiscardController`, `buildToken`. Imports the core + `tileImageSrc`/`tileLabel`. |
| `public/shared/indicator.css` | Styling for `.ind-token*`, `.ind-halo*`, `.ind-discard-panel`, and the `claimable` / `ind-ambiguous` / `ind-flash` states. |
| `public/game.js` (2D board) | Mounts and drives the shared widgets: `mountIndicators`, `positionToken`, `driveIndicators`/`updateTimer`, plus the board-pile halo (`boardHalo`, `placeBoardHalo`, `lastDiscardEl`). |
| `public/js3d/hud.js` (3D overlay) | Reuses `makeDiscardController` verbatim for the discard/claim panel (`buildDiscard`, `updateDiscardGraphic`); does **not** use `buildToken`/`makePerimeterHalo`. |
| `public/js3d/token.js` (3D scene) | A separate in-scene Three.js puck (`initToken`, `onUpdate`, `update`) that reuses the core clock helpers but draws its dial to a `CanvasTexture`. |
| `public/js3d/main.js` | Orchestrates the 3D pieces: `token.initToken(scene.scene)`, `hud.render(store)` + `token.onUpdate(store)` per gameUpdate, `token.update(dt, …)` per frame. |
| `test/indicator-core.test.js` | Node unit tests for the pure core. |

## Data shapes

### `TIMING` (the tunables) — `indicator-core.js`
```js
export const TIMING = { tokenSlideMs: 500, discardRevealMs: 1500 };
```
- `tokenSlideMs` — how long the token takes to glide to the next seat. The 2D token sets it as a CSS `transition-duration` (`buildToken` / `setSlideMs`); the 3D puck divides by 1000 to drive its per-frame lerp.
- `discardRevealMs` — the **min-dwell**: how long a plain (non-claimable) reveal stays up before auto-hiding, so even auto-skipped discards are seen.

### `RAMP` (the urgency colours) — `indicator-core.js`
```js
export const RAMP = { full: '#f0c040', warn: '#ff9800', danger: '#f44336' };
```
Fraction-based so it reads identically for any countdown length. `rampColor(frac)` returns `full` when `frac > 0.5`, `warn` when `frac > 0.2`, otherwise `danger`.

### The "live clock" object — returned by `liveClock(gs)`
`{ kind, deadline, totalMs }` where `kind` is `'claim'` or `'turn'`:
- **claim** (when `phase` is `'claim'` or `'rob'` and `claimDeadline` is set): `deadline = gs.claimDeadline`, `totalMs = (gs.reactTimer || 5) * 1000`.
- **turn** (when `phase === 'discard'` and `turnDeadline` is set): `deadline = gs.turnDeadline`, `totalMs = gs.turnTotal || (gs.turnTimer > 0 ? gs.turnTimer : 30) * 1000`.
- Returns `null` otherwise — notably on a **bot turn**, where the server arms no `turnDeadline`, so the token shows a ring but no digit.

### The `claim` descriptor — the argument to `makeDiscardController().update({ … claim })`
Assembled by the clients (`game.js driveIndicators`, `hud.js updateDiscardGraphic`) and shaped:
```
{ clock, action?, onClaim?, ambiguous? }
```
- `clock` — the `liveClock(gs)` result; the countdown shows whenever `claim.clock` is truthy (everyone in the window sees the timer).
- `action` — `{ type, tileIds }` for a single-tap claim, or absent.
- `onClaim` — the callback fired on tap (emits the claim + locks the panel). The tap is only wired when both `action` and `onClaim` are present.
- `ambiguous` — `true` when a chow is available but spread across several options (no single tap); the panel flares instead of claiming.

### The `localClaim` result — `indicator-core.js (computeLocalClaim)`
```
{ valid: string[], action: {type,tileIds}|null, ambiguous: boolean }
```
`valid` is the raw claim list from the injected `getValidClaims`; `action` is the best single tap from `bestClaimAction` (precedence **win > kong > pong > unambiguous chow**); `ambiguous = !action && valid.includes('chow')`. The frozen `EMPTY_CLAIM` is returned when there is nothing to claim. The result is **memoised on the `gs` reference** (`localClaim`) so `getValidClaims` runs once per update even though multiple callers ask.

## Key flows

### 1. A normal turn (no claim)
1. A `gameUpdate` arrives; the client re-renders. **2D:** `render()` → `updateTimer(s)` → `driveIndicators(s)`. **3D:** `main.js` calls `hud.render(store)` then `token.onUpdate(store)`.
2. The token is positioned over the active seat. **2D** `positionToken(s)` computes the relative seat `(((currentTurn - myIndex) % n) + n) % n` and places the token at the midpoint of the nearest edge of `#center` (bottom for me, top for across, left/right for the side seats), animating via the CSS transition. **3D** `token.onUpdate` sets `toPos = seatPos(currentTurn)` (the seat's `discardSlot`) and starts a lerp (snaps on first placement, chases thereafter).
3. The countdown ticks. `liveClock(s)` returns `{ kind:'turn', … }`. **2D** runs an 80ms `setInterval` (`tokenTick`) that recomputes `left = deadline - Date.now()`, `frac = timerFraction(left, totalMs)`, and calls `token.update({ frac, color: rampColor(frac), seconds: secondsLeft(left) })`; the conic `--frac`/`--col` CSS vars redraw the dial. **3D** `token.update(dt, …)` runs per frame, advancing the lerp and redrawing the canvas dial only when the integer second changes.
4. On a **bot turn** `liveClock` is `null`: the token shows a full ring with an empty digit (`token.update({ frac: 1, color: rampColor(1), seconds: '' })`).

### 2. An every-discard reveal (no claim window for me)
1. A tile is discarded. The clients pick the tile via `currentDiscard(s)` (= `s.lastDiscard`, regardless of phase — so even an auto-skipped discard that never broadcasts a `'claim'` phase is still shown), build a caption like `"<name> discarded"`, and call `discardCtl.update({ tile, tileId: tile.id, caption, claim: null })`.
2. `makeDiscardController.update` sees a new `tileId` (≠ `cur.id`), so it sets `cur = { id, tile, caption }` and stamps `shownAt = now()`. With no `claim.clock`, the panel renders **non-claimable**: tile shown, halo + digit hidden (`claimable:false`), caption beneath.
3. A self-tick `setInterval(render, 80)` runs while the panel is visible. In the non-claim branch, once `now() - shownAt >= TIMING.discardRevealMs` (1500ms) the panel hides itself and the timer stops. This **min-dwell** is what guarantees the tile is seen.
4. If a later `update` arrives with **no current discard** (`tile`/`tileId` null — the window resolved or the turn advanced), the controller drops any live `claim` immediately but lets an in-progress reveal finish its dwell (it does not vanish mid-reveal).

### 3. A claim / rob countdown + tap-to-claim
1. The server advances to `phase === 'claim'` (after a discard) or `phase === 'rob'` (someone is adding a kong), arming `claimDeadline` (and `reactTimer`). For a rob, `robKong = { seat, tile }`.
2. Each client computes its own affordance. **Claim:** `localClaim(s, myIndex, Mahjong.getValidClaims, Mahjong.getChowOptions)`. If `lc.action` exists → `claim = { clock, action: lc.action, onClaim: …sendClaim }`; else if `lc.ambiguous` → `claim = { clock, ambiguous: true }`. **Rob:** if the local seat can win on `robKong.tile` → a `{ clock, action:{type:'win'…}, onClaim }`; otherwise just `{ clock }` so everyone still sees the countdown but only the eligible seat can act. (Affordances are computed locally but the server re-validates every claim.)
3. `discardCtl.update({ tile, tileId, caption, claim })` runs. Because `claim.clock` is set, the controller stores `claim`, toggles the `claimable` class when there is a tap action (and wires `panel.el.onclick = onClaim`), toggles `ind-ambiguous` when ambiguous-without-action (wiring `onclick = flash`), and starts/keeps the 80ms tick.
4. `render()` takes the claim branch: `left = claim.clock.deadline - now()`, `frac = timerFraction(left, totalMs)`, `color = rampColor(frac)`. It calls `panel.update({ … claimable:true, seconds: secondsLeft(left) })` (halo + digit shown, colour ramping) and `onBoardHalo(true, frac, color)`.
   - **2D** `onBoardHalo` calls `placeBoardHalo()` to attach `boardHalo.svg` over the newest pile tile (`lastDiscardEl`, captured in `renderDiscards`) and `boardHalo.update(frac, color)` — a second halo on the actual discard pile. The token is set idle (`token.setIdle(true)`) during claim/rob; **3D** dims its puck (`drawDial(0,'#888','',true)`, lower emissive).
   - **Ambiguous chow:** a tap calls `flash()`, which restarts the `ind-flash` CSS keyframe (remove class → force reflow → re-add) for a brief text-free flare pointing at the per-option chow buttons in the action bar; the `animationend` listener strips the class afterward.
5. **Tap to claim:** clicking the claimable panel (or the dedicated action buttons) fires `onClaim` → emits the claim and calls the client's `markClaimResponded`/`respond`, locking the panel against double-emits (`claimResponded`/`sendClaim`'s guard).
6. When `left <= 0` the controller drops `claim` (window ended) and the panel falls back to the plain reveal/min-dwell branch; the board halo is removed via `onBoardHalo(false, …)`.

## Invariants & gotchas

- **No socket protocol — render from `gameState`.** Everything reads existing fields (`phase`, `turnDeadline`, `turnTotal`/`turnTimer`, `claimDeadline`, `reactTimer`, `lastDiscard`, `lastDiscardPlayer`, `robKong`). There is no event specific to this feature.
- **Reveal is keyed off the discard tile's `.id` changing**, not the phase — so auto-skipped discards (which never enter a `'claim'` phase) still show. (`currentDiscard` returns `lastDiscard` in any phase.)
- **`liveClock` is `null` on a bot turn** because the server skips arming `turnDeadline` for bots → the token shows a ring with no digit. The unit test asserts `turnDeadline:0` yields `null`.
- **Server is authoritative.** Client-side `localClaim`/`bestClaimAction` only decide which buttons/taps to offer; the server re-validates every `claim` emit (`actionError` is shown on rejection).
- **Chow tap rule:** a one-tap chow is offered only when exactly one chow option exists; the discard tile is excluded from `tileIds` (the server matches against the player's hand). Multiple options → `ambiguous`, no tap, use the per-option buttons.
- **`localClaim` memoises on the `gs` reference** (`_claimMemo`); a fresh `gameUpdate` is a new object → cache miss → recompute. Don't mutate `gameState` in place and expect a recompute.
- **Min-dwell vs. resolved window:** a null-tile `update` clears `claim` immediately but lets an in-progress reveal finish its dwell — this fixed a bug where a bare early-return left a stale tile + countdown + 80ms timer running.
- **`ind-flash` must be re-triggered by a forced reflow** (`void panel.el.offsetWidth`) or the animation won't restart on a second ambiguous tap.
- **2D board halo positioning** relies on `lastDiscardEl` captured during `renderDiscards` (avoids a `querySelectorAll` every 80ms tick); `placeBoardHalo` removes the SVG if that element is gone/disconnected, and sets the pile `position: relative` if it is `static`.
- **The 80ms tick is self-managed:** the discard controller starts its own `setInterval(render, 80)` while visible; the 2D token uses a separate `tokenTick` interval that `driveIndicators` clears and restarts each update. The 3D puck instead redraws on the per-frame render loop, only when the integer second changes (`lastSec`).

## 2D vs. 3D: reuse vs. reimplement

- **Discard / claim / rob panel:** *fully shared.* Both clients build it via `makeDiscardController` from `indicator-dom.js` and feed it the same `{ tile, tileId, caption, claim }` shape (2D `driveIndicators`; 3D `updateDiscardGraphic`). Behaviour — reveal, min-dwell, claim/rob upgrade, ambiguous flare, tap-to-claim — is identical.
- **Turn token:** *reimplemented per renderer, shared logic.*
  - **2D** uses `buildToken()` (a DOM puck with a conic-gradient ring) + `makePerimeterHalo()` for the on-pile halo, mounted into `#bubble-layer`.
  - **3D** does **not** use `buildToken`/`makePerimeterHalo`. `js3d/token.js` draws an in-scene `THREE.CylinderGeometry` puck whose top cap is a `CanvasTexture` dial (also used as an `emissiveMap` for bloom), resting at the seat's `discardSlot`. It still imports the same core helpers (`TIMING`, `liveClock`, `timerFraction`, `secondsLeft`, `rampColor`) so timing feel and colours match exactly.
  - The 3D claim countdown lives in the shared discard panel (`hud.js`); there is no in-scene claim halo equivalent to the 2D board halo (the puck merely dims during a reaction window).

## Code map

| Symbol | Location | Purpose |
| --- | --- | --- |
| `TIMING`, `RAMP` | `indicator-core.js` | Timing tunables + urgency colours. |
| `timerFraction` / `secondsLeft` / `rampColor` / `haloDashArray` | `indicator-core.js`– | Clamp remaining→fraction, ceil seconds, fraction→colour, fraction→SVG dasharray. |
| `liveClock(gs)` | `indicator-core.js` | Which clock is live (`turn`/`claim`/`null`). |
| `currentDiscard(gs)` | `indicator-core.js` | The tile to reveal (`lastDiscard`, any phase). |
| `bestClaimAction(valid, hand, discard, getChowOptions)` | `indicator-core.js` | Best single tap (win>kong>pong>unambiguous chow). |
| `localClaim(gs, myIndex, getValidClaims, getChowOptions)` | `indicator-core.js` | Memoised local claim affordance `{valid,action,ambiguous}`. |
| `makePerimeterHalo(tileW, tileH, opts)` | `indicator-dom.js` | SVG perimeter halo; `.update(frac, color)` sets dasharray + glow. |
| `buildDiscardPanel()` | `indicator-dom.js` | Low-level panel view; `.update({tile,frac,color,seconds,caption,claimable})` / `.hide()`. |
| `makeDiscardController({ onBoardHalo })` | `indicator-dom.js` | Stateful reveal + min-dwell + claim/rob upgrade + 80ms tick + ambiguous flare. |
| `buildToken()` | `indicator-dom.js` | 2D token puck; `.update({frac,color,seconds})`, `.setIdle()`, `.setSlideMs()`. |
| `mountIndicators` / `positionToken` / `driveIndicators` / `placeBoardHalo` | `game.js` | 2D mount + token placement + per-update drive + board-halo placement. |
| `boardHalo` / `discardCtl` / `lastDiscardEl` | `game.js` | 2D module-level widget instances + captured newest pile tile. |
| `buildDiscard` / `updateDiscardGraphic` | `hud.js` | 3D HUD mount + per-update drive of the shared controller. |
| `initToken` / `onUpdate` / `update` / `drawDial` | `token.js` | 3D in-scene puck init, per-update seat chase, per-frame dial redraw. |

CSS classes (`indicator.css`): `.ind-token` (puck, JS-set transition duration), `.ind-token-ring` (conic `--frac`/`--col` dial), `.ind-token-num` (centre digit), `.ind-token.idle` (greyed during a reaction window); `.ind-halo` / `.ind-halo-rect` (perimeter SVG); `.ind-discard-panel` (bottom-right dock panel), `.ind-dp-tilewrap` / `.ind-dp-num` / `.ind-dp-cap` (hero tile / countdown / caption), `.ind-discard-panel.claimable` (tappable), `.ind-discard-panel.ind-ambiguous` + `.ind-flash` / `@keyframes ind-flash` (ambiguous-chow flare).

## Tests

`test/indicator-core.test.js` (Node, run via `npm test`) covers the pure core only — the DOM/Three layers are verified visually (Chrome DevTools for 2D/3D). Cases:

- `TIMING` exposes numeric `tokenSlideMs` + `discardRevealMs`.
- `timerFraction` clamps to `[0,1]` and guards `total <= 0` → `0`.
- `secondsLeft` ceils and never goes negative.
- `rampColor` thresholds: gold `>0.5`, orange `>0.2`, red otherwise.
- `haloDashArray` maps fraction → `"<lit> 100"` (clamped).
- `liveClock`: claim clock in `claim`/`rob`, turn clock in `discard` (honouring `turnTotal` then `turnTimer`), `null` when off (e.g. a bot turn with `turnDeadline:0`).
- `currentDiscard` returns `lastDiscard` in any phase (reveal works on auto-skip).
- `bestClaimAction`: precedence win>kong>pong; single chow → 2 hand tiles with the discard excluded; multiple chows → `null` (ambiguous).
- `localClaim`: empty off a claim window or on your own discard; pong actionable; ambiguous chow flags with no action; **memoises on the `gameState` reference** (one `getValidClaims` per update).
