# Shared Bottom Hand Dock
> The permanent local-player inventory bar — one DOM builder (`buildHandDock`) and one stylesheet shared by both the 2D board and the 3D HUD, so the player's hand always looks and behaves identically across clients.

## Overview

The hand dock is the pinned bar at the bottom of the screen that shows the local
player's concealed hand (and, in the 2D layout, their flowers, exposed melds,
seat identity, and sort controls). It is built by a single client-agnostic
module, `public/shared/hand-render.js`, and styled by a single stylesheet,
`public/shared/hand-dock.css`. Both the 2D client (`public/game.js`) and the
experimental 3D client (`public/js3d/hud.js`) call the same `buildHandDock(opts)`
and link the same CSS, so the two clients stay in lockstep: a change to tile
rendering, hover behaviour, or dock structure lands in both at once.

The module is pure of sockets and Three.js. It builds DOM from plain data
(`player`, `drawnId`, `selectedId`, flags) plus callbacks (`onTileClick`,
`onOrganize`, `onShuffle`); each client wires its own select/discard/organize
paths into those callbacks. Tile faces are rendered as PNG images
(`/assets/tiles2d/…`) via the shared rules-client mapping, with a CSS-drawn
"back" and a glyph+label fallback for flowers.

## Architecture

| File / module | Responsibility |
| --- | --- |
| `public/shared/hand-render.js` | The single source of DOM truth. Exports `makeTileEl(tile, opts)` and `buildHandDock(opts)`; owns `attachSeamlessHover(row)` and the private `ctrlBtn(label, title, fn)`. |
| `public/shared/rules-client.js` | Pure tile→face mapping used for rendering: `tileImageSrc(tile)` (PNG path), `tileLabel(tile)` (e.g. `3m`, `東`, `F2`), `tileGlyph(tile)` (unicode tile char). |
| `public/shared/hand-dock.css` | Shared styling: the `.tile` card, unified `.tile-face` PNG, the CSS `.tile-back`, flower glyph/label fallback, the `.hand-dock`/`.hand-dock-row` bar, and the lift+spread `.is-hover` popout. Also defines the `.hand-dock--bare` overrides. |
| `public/style.css` | 2D-only `.hand-dock--spread` rules (header + 3-zone body grid). Linked AFTER `hand-dock.css` on `game.html`. |
| `public/game.js` (`renderDock`) | 2D client. Calls `buildHandDock({ …, layout: 'spread' })`; wires `onTileClick`/`onOrganize`/`onShuffle`; emits `organizeHand`/`shuffleHand`. |
| `public/js3d/hud.js` (`renderDock`) | 3D client. Calls `buildHandDock({ …, layout: 'bare' })` (tile row only); injects `<link href="/shared/hand-dock.css">` in `injectStyles()`. |

## API

### `makeTileEl(tile, opts)` — `hand-render.js`

Returns a `.tile` card element. `tile` is a server tile object
`{ suit, value, id }`, the literal `'back'` sentinel, or `null`.

Options (all default to `false`/`null`):

- `small` — adds the `sm` class (smaller card; used for flowers and meld tiles).
- `selected` — adds the `selected` class (raised + green outline).
- `clickable` — adds the `clickable` class (pointer cursor).
- `highlight` — adds the `last-discard` class (pulsing gold ring).
- `onClick` — a click handler attached to the element when supplied.

Rendering branches (`hand-render.js`):
- `null` / `'back'` → `tile-back` class, no children (CSS draws the back).
- `tile.suit === 'flower'` → `tile-flower` class; since `tileImageSrc` returns
  `null` for flowers, it falls through to a `.tile-glyph` + `.tile-label` span pair.
- Any face tile (man/pin/bam/wind/dragon) → `tileImageSrc(tile)` returns a path,
  so an `<img class="tile-face">` is appended (`draggable = false`).
- `el.title` is set to `tileLabel(tile)` for non-back tiles.

### `buildHandDock(opts)` — `hand-render.js`

Returns the `.hand-dock` element. Built with `createElement` + `textContent`
(no `innerHTML`), so player names need no escaping. Full options list (verbatim
from the destructure at `hand-render.js`):

- `player` — the local player object (`hand`, `flowers`, `melds`, `name`, `seatWind`, `points`). If falsy, an empty dock is returned early (`hand-render.js`).
- `drawnId = null` — id of the freshly-drawn tile; it is moved to the end of the row and gets the `just-drawn` class (gapped on the left).
- `selectedId = null` — id of the currently-selected tile (gets `selected`).
- `canDiscard = false` — when true, tiles are `clickable` and wired to `onTileClick`.
- `isTurn = false` — accepted in the signature; currently not used for rendering inside the builder. *(unverified intent — accepted but unread)*
- `onTileClick = null` — `(tileId) => …`; attached per tile only when `canDiscard` is also true.
- `onOrganize = null` — builds the "↕ Organize" control button when supplied.
- `onShuffle = null` — builds the "🔀 Shuffle" control button when supplied.
- `layout = 'compact'` — one of `'compact'` / `'spread'` / `'bare'` (see below).

## Layouts

The `layout` option selects one of three structures. All three contain the
`.hand-dock-row` (the hand tiles, with seamless hover and click-to-discard).

- **`compact`** (default) — `.hand-dock` with a single centred `.hand-dock-header`
  row above the hand. The header holds identity (`.hand-dock-id`: name + seat
  wind + session points) and, appended into the same header row, the flowers,
  melds, and controls when present (`hand-render.js`). No client currently
  passes `'compact'`; it is the fallback default.

- **`spread`** — used by the **2D board** (`game.js renderDock`). Adds the
  `hand-dock--spread` class and builds a name-only `.hand-dock-header` followed by
  a `.hand-dock-body` 3-zone grid (`hand-render.js`):
  `[.hand-dock-side | .hand-dock-row | .hand-dock-controls]`. The
  `.hand-dock-side` cluster (flowers + melds, far left) is **always appended even
  when empty**, so the hand lands in the centre grid column and stays centred. The
  grid (`style.css`) is `grid-template-columns: 1fr auto 1fr` with a
  `column-gap: 40px` chosen to exceed the hover reach so the lift/spread popout
  never crowds the flanking clusters. Controls (Organize/Shuffle) sit in column 3.

- **`bare`** — used by the **3D HUD** (`hud.js renderDock`). Adds the
  `hand-dock--bare` class and **returns early after appending only the hand row**
  (`hand-render.js`): no header, no name, no flowers/melds, no controls. The
  `.hand-dock--bare` CSS strips the background bar, shadow, and padding
  (`hand-dock.css`) so the tile row floats over the 3D scene. Organize/shuffle
  are intentionally omitted here because the 3D client maps them to the `o`/`s`
  hotkeys instead.

Why the split: the 2D board has screen real estate for flanking clusters and
on-screen sort buttons, so it uses `spread`. The 3D first-person client renders
flowers/melds in the scene and drives organize/shuffle from hotkeys, so its dock
is reduced to just the tile bar (`bare`) to stay out of the camera's way.

## Key flows

1. **Building the local dock (per `gameUpdate`).**
   - 2D: `game.js renderDock(pIdx, s)` (`game.js`) reads `s.players[pIdx]` and
     calls `dock.replaceChildren(buildHandDock({ player, drawnId: s.drawnId, selectedId: selectedTileId, canDiscard: phase==='discard' && currentTurn===myIndex, isTurn, onTileClick: handleTileClick, onOrganize, onShuffle, layout: 'spread' }))`.
   - 3D: `hud.js renderDock(store)` (`hud.js`) reads `store.gameState.players[myIndex]`
     and calls `buildHandDock({ …, selectedId: window.__hud_selectedTileId, layout: 'bare' })`.
     Its `onTileClick` is a two-stage select-then-discard: first click sets
     `window.__hud_selectedTileId`, a second click on the same tile emits the
     discard and clears the selection, then re-renders (`hud.js`).
   - Both rebuild the dock wholesale via `replaceChildren` on each update — the
     cadence at which the hand changes.

2. **Organize / shuffle (2D only).**
   - The dock builds two `.hand-ctrl-btn` buttons via `ctrlBtn` only when
     `onOrganize`/`onShuffle` are supplied (`hand-render.js`).
   - 2D wires them to `socket.emit('organizeHand')` and `socket.emit('shuffleHand')`
     (`game.js`). The server reorders the hand and pushes a fresh
     `gameUpdate`, which rebuilds the dock.
   - 3D passes neither callback, so no buttons render; the equivalent actions are
     the `o`/`s` hotkeys handled elsewhere in the 3D input layer.

3. **Click-to-discard.**
   - 2D `handleTileClick(id)` (`game.js`): if the id is already selected it
     calls `discardSelected()` (emits `discard`); otherwise it sets
     `selectedTileId` and re-renders. The dock only wires the click when
     `canDiscard` is true (`hand-render.js`).

4. **Hover-magnify (lift + neighbours-spread).**
   - `attachSeamlessHover(row)` (`hand-render.js`) is attached to every
     layout's `.hand-dock-row`. On `pointermove` it picks the hovered tile from the
     pointer's X using **layout positions** (`offsetLeft`/`offsetWidth`), not the
     visual (transformed) box, and toggles the `.is-hover` class.
   - Using transform-independent geometry matters because the CSS hover
     (`hand-dock.css`) lifts and scales the hovered tile
     (`translateY(-22px) scale(1.35)`) and slides every right neighbour
     (`.is-hover ~ .tile`) right by `16px` and every left neighbour
     (`:has(~ .tile.is-hover)`) left by `16px`. If hover were CSS `:hover`, those
     transforms would open a dead zone under the cursor and flicker. Driving
     `.is-hover` from the gapless row's layout coordinates lets the pointer travel
     the whole hand — including across the drawn-tile gap, which `pick()` bridges
     via nearest-tile fallback (`hand-render.js`) — without flicker.
   - The picker returns `null` when the pointer is in the empty margin beside the
     tiles' span (`hand-render.js`), and `pointerleave` clears the last
     hovered tile (`hand-render.js`).
   - Note: the 3D client also has a *separate*, reticle-driven magnify
     (`hud.js updateMagnify`, `window.__hud_hoverTileId`) that floats a large tile
     face when the camera aims at a hand tile — distinct from this DOM hover.

## Invariants & gotchas

- **Single source of DOM truth.** Do not fork dock/tile DOM per client. Edit
  `hand-render.js` (structure) and `hand-dock.css` (shared styling); both clients
  inherit the change. `game.js` links `hand-dock.css` via `game.html` (after
  `style.css`); `hud.js` injects the `<link>` in `injectStyles()` because
  `style.css` is deliberately not loaded by `game3d.html`.
- **`spread` lives in two files.** The base dock/tile/hover styling is in
  `hand-dock.css`, but the `.hand-dock--spread` grid is in `style.css` — so the
  2D-only layout depends on `style.css` being present. The 3D client must never
  rely on `.hand-dock--spread`.
- **The side cluster is always present in `spread`** (even empty) to keep the hand
  centred in the middle grid column. Removing the empty-cluster append would let
  the hand drift off-centre.
- **`bare` returns early** before any header/flowers/melds/controls are built
  (`hand-render.js`) — passing `onOrganize`/`onShuffle` with `layout: 'bare'`
  would have no effect.
- **No `innerHTML` in the builder.** All text goes through `textContent`, so
  player names need no escaping inside `buildHandDock`. (The 3D HUD's *other*
  panels do use `escapeHtml` for `innerHTML`, but the dock builder does not.)
- **Drawn tile placement.** `drawnId` reorders the row so the drawn tile is last
  and visually gapped (`.just-drawn` → `margin-left: 22px`, `hand-dock.css`).
- **PNG faces only for suited/honor tiles.** `tileImageSrc` returns `null` for
  `'back'`, flowers, and unknown suits (`rules-client.js`); those fall back
  to the CSS back or the glyph+label, so missing/extra suits degrade gracefully.
- **`isTurn`** is accepted by `buildHandDock` but not read inside the builder; both
  clients still pass it.

## Code map

- Tile element: `public/shared/hand-render.js` (`makeTileEl`).
- Dock builder: `public/shared/hand-render.js` (`buildHandDock`); layout
  branching at, early `bare` return, `spread` body,
  `compact` header.
- Seamless hover: `public/shared/hand-render.js` (`attachSeamlessHover`),
  picker.
- Control button: `public/shared/hand-render.js` (`ctrlBtn`).
- Face mapping: `public/shared/rules-client.js` (`tileImageSrc`)
  (`tileGlyph`) (`tileLabel`).
- Shared CSS: `public/shared/hand-dock.css` — `.tile`, `.tile-face`,
  `.tile-back`, `.hand-dock`, `.hand-dock--bare`,
  `.hand-dock-row`, `.is-hover` rules.
- 2D `spread` grid: `public/style.css`.
- 2D wiring: `public/game.js` (`renderDock`) (`handleTileClick`),
  organize/shuffle emits.
- 3D wiring: `public/js3d/hud.js` (`renderDock`), CSS link injection in
  `injectStyles`.

## Tests

- `test/rules-client-tiles.test.js` covers `tileImageSrc` — the server-tile → PNG
  face-path mapping that `makeTileEl` relies on. It asserts: numeric suits
  (`man`/`pin`/`bam`) map to `/assets/tiles2d/<suit><value>.png`; winds/dragons
  map to `/assets/tiles2d/<suit>_<value>.png` (underscore); and `'back'`, `null`,
  flowers, and unknown suits all return `null`. Run via `npm test`.
- There are **no direct DOM tests** for `buildHandDock`, `makeTileEl`, or
  `attachSeamlessHover` — the module touches the browser DOM (`document.createElement`,
  pointer events) and is exercised manually in the running clients. The hover
  geometry and layout grids are verified visually (per the project's Chrome
  DevTools workflow), not in the Node unit suite.
