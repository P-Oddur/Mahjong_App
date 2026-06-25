// hand-render.js — shared DOM builders for tile elements and the bottom hand dock.
// Imported by BOTH clients: the 2D board (game.js, an ES module) and the 3D HUD
// overlay (hud.js). Visual styling lives in /shared/hand-dock.css; this module owns
// the DOM structure so the two clients stay in lockstep. (buildHandDock is added in
// a later task.) Pure of sockets/Three.js — it only builds DOM from data + callbacks.
import { tileImageSrc, tileLabel, tileGlyph } from '/shared/rules-client.js';

// makeTileEl(tile, opts) → a .tile card. Renders a PNG face (man/pin/bam/wind/
// dragon), a CSS back (the 'back' sentinel / null), or a glyph + label (flowers).
export function makeTileEl(tile, { small = false, selected = false, clickable = false, highlight = false, onClick = null } = {}) {
  const el = document.createElement('div');
  const kind =
    (!tile || tile === 'back') ? 'tile-back' :
    (tile.suit === 'flower')   ? 'tile-flower' : '';
  el.className = ['tile', kind, small && 'sm', selected && 'selected', clickable && 'clickable', highlight && 'last-discard'].filter(Boolean).join(' ');
  if (tile && tile !== 'back') el.title = tileLabel(tile);

  const src = tileImageSrc(tile);
  if (src) {
    const img = document.createElement('img');
    img.className = 'tile-face';
    img.src = src; img.alt = tileLabel(tile); img.draggable = false;
    el.appendChild(img);
  } else if (tile && tile !== 'back') {
    const g = document.createElement('span'); g.className = 'tile-glyph'; g.textContent = tileGlyph(tile);
    const l = document.createElement('span'); l.className = 'tile-label'; l.textContent = tileLabel(tile);
    el.append(g, l);
  }
  // else: face-down 'back' / null — the CSS .tile-back draws itself, no children.

  if (onClick) el.addEventListener('click', onClick);
  return el;
}

// buildHandDock(opts) → the .hand-dock element (header + hand row) for the local
// player. Client-agnostic: the caller supplies data + callbacks so 2D and 3D wire
// their own select/discard/organize paths. Built with createElement + textContent
// (no innerHTML), so player names need no escaping.
export function buildHandDock({
  player, drawnId = null, selectedId = null, canDiscard = false, isTurn = false,
  onTileClick = null, onOrganize = null, onShuffle = null, layout = 'compact',
} = {}) {
  const dock = document.createElement('div');
  dock.className = 'hand-dock';
  // Layout. 'compact' (default) is one centred header row above the hand. 'spread' (the 2D
  // board) flanks the centred hand with a flowers/melds cluster (far left) + controls
  // (right); its CSS lives in style.css. 'bare' (the 3D HUD) is ONLY the hand-tile row —
  // no header (name/flowers/melds/controls) and no background bar (see .hand-dock--bare in
  // hand-dock.css) — so organize/shuffle move to the 3D o/s hotkeys.
  const spread = layout === 'spread';
  const bare = layout === 'bare';
  if (spread) dock.classList.add('hand-dock--spread');
  if (bare) dock.classList.add('hand-dock--bare');
  if (!player) return dock;

  // Hand row (freshly-drawn tile gapped on the right) — present in EVERY layout; the
  // lift+spread hover (attachSeamlessHover) and click-to-discard ride on it.
  const row = document.createElement('div');
  row.className = 'hand-dock-row';
  const hand = player.hand || [];
  const ordered = drawnId != null
    ? [...hand.filter(t => t.id !== drawnId), ...hand.filter(t => t.id === drawnId)]
    : hand;
  ordered.forEach(tile => {
    const el = makeTileEl(tile, {
      selected: tile.id === selectedId,
      clickable: canDiscard,
      onClick: (canDiscard && onTileClick) ? () => onTileClick(tile.id) : null,
    });
    el.dataset.tileId = String(tile.id);
    if (tile.id === drawnId) el.classList.add('just-drawn');
    row.appendChild(el);
  });
  attachSeamlessHover(row);

  // 3D 'bare': just the hand-tile bar — no header at all.
  if (bare) { dock.appendChild(row); return dock; }

  const windMap = { east: '東', south: '南', west: '西', north: '北' };

  // Header: player identity (wind + name + session points).
  const header = document.createElement('div');
  header.className = 'hand-dock-header';
  const id = document.createElement('div');
  id.className = 'hand-dock-id';
  const wind = document.createElement('span'); wind.className = 'seat-wind'; wind.textContent = windMap[player.seatWind] || '';
  const name = document.createElement('span'); name.textContent = player.name || '';
  const pts = document.createElement('span'); pts.className = 'player-points'; pts.title = 'Session score'; pts.textContent = player.points ?? 0;
  id.append(name, wind, pts);
  header.appendChild(id);

  // Flowers, melds, controls — built here, then placed by layout (header row vs body grid).
  let flowersEl = null;
  if (player.flowers && player.flowers.length) {
    flowersEl = document.createElement('div'); flowersEl.className = 'hand-dock-flowers';
    player.flowers.forEach(f => flowersEl.appendChild(makeTileEl(f, { small: true })));
  }
  let meldsEl = null;
  if (player.melds && player.melds.length) {
    meldsEl = document.createElement('div'); meldsEl.className = 'hand-dock-melds';
    player.melds.forEach(meld => {
      const m = document.createElement('div'); m.className = 'meld';
      meld.tiles.forEach(t => m.appendChild(makeTileEl(t, { small: true })));
      meldsEl.appendChild(m);
    });
  }
  let controlsEl = null;
  if (onOrganize || onShuffle) {
    controlsEl = document.createElement('div'); controlsEl.className = 'hand-dock-controls';
    if (onOrganize) controlsEl.appendChild(ctrlBtn('↕ Organize', 'Sort your hand', onOrganize));
    if (onShuffle)  controlsEl.appendChild(ctrlBtn('🔀 Shuffle', 'Shuffle your hand', onShuffle));
  }

  if (spread) {
    // 3-zone body: [flowers+melds | centred hand | controls]. The side cluster is always
    // present (even empty) so the hand lands in the centre column and stays centred.
    const body = document.createElement('div'); body.className = 'hand-dock-body';
    const side = document.createElement('div'); side.className = 'hand-dock-side';
    if (flowersEl) side.appendChild(flowersEl);
    if (meldsEl) side.appendChild(meldsEl);
    body.append(side, row);
    if (controlsEl) body.appendChild(controlsEl);
    dock.append(header, body);
  } else {
    // Compact: identity + flowers + melds + controls share the header row above the hand.
    if (flowersEl) header.appendChild(flowersEl);
    if (meldsEl) header.appendChild(meldsEl);
    if (controlsEl) header.appendChild(controlsEl);
    dock.append(header, row);
  }
  return dock;
}

// Seamless hover: drive the hovered tile from the pointer's X over the (gapless) row,
// using transform-independent layout positions (offsetLeft/offsetWidth) so the lift +
// neighbour-spread transforms never open a dead zone the cursor can fall into — the
// mouse travels the whole hand (incl. across the drawn-tile gap) without flicker. The
// row is position:relative, so a tile's offsetLeft is measured from the row's edge.
function attachSeamlessHover(row) {
  let last = null;
  const pick = (clientX) => {
    const tiles = [];
    for (const t of row.children) if (t.classList && t.classList.contains('tile')) tiles.push(t);
    if (!tiles.length) return null;
    const x = clientX - row.getBoundingClientRect().left; // pointer X in the row's space
    const lastTile = tiles[tiles.length - 1];
    // Outside the tiles' span (in the empty margin beside the hand) → no tile hovered.
    if (x < tiles[0].offsetLeft || x >= lastTile.offsetLeft + lastTile.offsetWidth) return null;
    let best = null, bestDist = Infinity;
    for (const t of tiles) {
      const l = t.offsetLeft, r = l + t.offsetWidth;
      if (x >= l && x < r) return t;       // inside a tile
      const d = x < l ? l - x : x - r;     // else nearest (bridges the drawn-tile gap)
      if (d < bestDist) { bestDist = d; best = t; }
    }
    return best;
  };
  row.addEventListener('pointermove', (e) => {
    const t = pick(e.clientX);
    if (t === last) return;
    if (last) last.classList.remove('is-hover');
    if (t) t.classList.add('is-hover');
    last = t;
  });
  row.addEventListener('pointerleave', () => {
    if (last) last.classList.remove('is-hover');
    last = null;
  });
}

function ctrlBtn(label, title, fn) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'hand-ctrl-btn';
  b.textContent = label; b.title = title;
  b.addEventListener('click', fn);
  return b;
}
