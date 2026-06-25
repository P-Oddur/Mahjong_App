// tile-math.js — pure layout/animation arithmetic for the tile table.
//
// THREE-free (its only import is the sibling seat-geometry core, also dependency-free)
// so it runs identically in the browser and in Node unit tests. tiles.js keeps the GLB
// loading, mesh cloning, THREE.Quaternion/Euler composition and scene mutation; it calls
// into this core for every numeric/string decision so the bug-prone parts are testable.

import { SEAT_RADIUS } from './seat-geometry.js';

// The blank tile used for backs / wall / unknown tiles.
export const BLANK_NODE = 'MahjongTile';

// ── Tile → GLB node name (server protocol → asset node) ──────────────────────
// The two translations that are easy to get wrong: server suit 'bam' → GLB 'sou',
// and flowers 1–4 ("flowers") vs 5–8 ("seasons"). Honor tiles carry STRING values.
export function tileNodeName(tile) {
  if (!tile || tile === 'back') return BLANK_NODE;

  switch (tile.suit) {
    case 'man': return 'S_man' + tile.value;       // value 1..9
    case 'pin': return 'S_pin' + tile.value;       // value 1..9
    case 'bam': return 'S_sou' + tile.value;       // server 'bam' → GLB 'sou', 1..9
    case 'wind':
      return { east: 'S_dong', south: 'S_nan', west: 'S_xi', north: 'S_bei' }[tile.value]
             || warnUnmapped('wind', tile.value);
    case 'dragon':
      return { red: 'S_zhong', green: 'S_fa', white: 'S_bai' }[tile.value]
             || warnUnmapped('dragon', tile.value);
    case 'flower':
      // 1..4 = flowers (S_flower1..4), 5..8 = seasons (S_season1..4).
      return tile.value <= 4 ? ('S_flower' + tile.value)
                             : ('S_season' + (tile.value - 4));
    default:
      return BLANK_NODE; // unknown → blank
  }
}

// Warn once per unmapped honor value, then fall back to the blank node so an
// asset/protocol drift renders a visible blank instead of a silent undefined.
const _warnedNodes = new Set();
function warnUnmapped(suit, value) {
  const key = suit + ':' + value;
  if (!_warnedNodes.has(key)) {
    _warnedNodes.add(key);
    console.warn(`[tiles] unmapped ${suit} value "${value}" → blank tile`);
  }
  return BLANK_NODE;
}

// ── Hand rack ─────────────────────────────────────────────────────────────────

// hasDrawnTile(src, drawnId): is the freshly-drawn tile (server's drawnId) present?
export function hasDrawnTile(src, drawnId) {
  return drawnId != null && (src || []).some(t => t && t.id === drawnId);
}

// orderHandTiles(src, drawnId): pull the freshly-drawn tile to the FAR RIGHT so it's
// obvious which tile was just drawn; the rest keep their sent (sorted/shuffled) order.
// Returns the original array reference unchanged when there's no drawn tile present.
export function orderHandTiles(src, drawnId) {
  const arr = src || [];
  if (!hasDrawnTile(arr, drawnId)) return arr;
  return [...arr.filter(t => t.id !== drawnId), ...arr.filter(t => t.id === drawnId)];
}

// handRackXOffsets(count, hasDrawn, gap, drawnGap): per-tile x offsets along the rack
// plus the startX that keeps the whole row centred on the seat. When hasDrawn, the
// last (drawn) tile is pushed right by an extra drawnGap.
export function handRackXOffsets(count, hasDrawn, gap, drawnGap) {
  const xs = [];
  for (let i = 0, x = 0; i < count; i++) {
    if (hasDrawn && i === count - 1) x += drawnGap;
    xs.push(x);
    x += gap;
  }
  const totalW = count > 0 ? xs[count - 1] : 0;
  return { xs, startX: -totalW / 2 };
}

// ── Seat-frame → world ────────────────────────────────────────────────────────

// seatLocalToWorld(seatPos, yaw, localX, localZ): rotate a seat-local offset
// (x = the seated player's left→right, z = toward/away from table centre) into world
// XZ using THREE's +Y-rotation handedness, anchored at the seat position. Returns
// {x, z}. (The previous formula used the opposite handedness, flinging the side
// seats' hands out behind the player — keep this handedness.)
export function seatLocalToWorld(seatPos, yaw, localX, localZ) {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return {
    x: seatPos.x + (localX * cos + localZ * sin),
    z: seatPos.z + (-localX * sin + localZ * cos),
  };
}

// ── Discard grid ──────────────────────────────────────────────────────────────

// discardCell(i, perRow, stepX, stepZ): grid slot for the i-th shown discard, laid
// out perRow across and centred around the origin (up to 4 rows). Returns {x, z}.
export function discardCell(i, perRow, stepX, stepZ) {
  const col = i % perRow;
  const row = Math.floor(i / perRow);
  return {
    x: (col - (perRow - 1) / 2) * stepX,
    z: (row - 1.5) * stepZ, // centre the (up to) 4 rows around origin
  };
}

// ── Opening deal-in ───────────────────────────────────────────────────────────

// dealBreakSeat(dealerRel, diceVals): standard HK — the dice sum counts seats from
// the dealer to pick which player's wall is opened. Returns that relative seat.
// Empty/absent dice default to a sum of 7 (matches the tiles.js fallback).
export function dealBreakSeat(dealerRel, diceVals) {
  const sum = (diceVals && diceVals.length)
    ? diceVals.reduce((a, b) => a + (b || 0), 0)
    : 7;
  const d = dealerRel == null ? 0 : dealerRel;
  return (((d + (sum - 1)) % 4) + 4) % 4;
}

// ── Tween easing ──────────────────────────────────────────────────────────────

// easeOutCubic(t): t∈[0,1] → eased progress; fast start, gentle settle.
export function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

// ── Tile dimensions (metres) ─────────────────────────────────────────────────
// Native GLB tile size (at scale 1) and the global up-scale applied to every tile
// mesh. tiles.js imports these so the layout math and the meshes share one source.
export const TILE_W0 = 0.022; // X — width
export const TILE_T0 = 0.016; // Z — thickness (front-to-back when flat)
export const TILE_H0 = 0.030; // Y — height
export const TILE_SCALE = 1.5;
export const TILE_W = TILE_W0 * TILE_SCALE; // scaled width  (row spacing)
export const TILE_T = TILE_T0 * TILE_SCALE; // scaled thickness
export const TILE_H = TILE_H0 * TILE_SCALE; // scaled height — a flat tile's depth along Z

// ── Table felt / corner-bonus placement ──────────────────────────────────────
// FELT_CLEAR: flat-felt clear radius (m). The inlaid wood border strips (furniture.js)
// are raised ~7 mm above the felt (felt top 0.791, border top 0.798) with their inner
// edge at ±0.44 from centre. A tile laid flat ON the felt clips the rail iff its footprint
// crosses this boundary (overlaps the rail's floor-area), since the tile's body then passes
// through the raised rail. So a flat-on-felt tile must keep its footprint within |x|,|z| ≤ this.
export const FELT_CLEAR = 0.44;

// RAIL_SETBACK: horizontal anti-z-fight gap (m). The corner-bonus row tucks one of these
// INSIDE the rail's inner edge so it reads flush against the rail without its vertical side
// face going coplanar with the rail's inner face (which would z-fight). The horizontal analog
// of TILE_LIFT (the vertical hair that keeps tiles off the felt) — ~0.6 mm, imperceptible.
export const RAIL_SETBACK = 0.0006;

// CORNER_BONUS: seat-local placement of the exposed flowers+melds row tucked into the seat's
// bottom-left, laid flat. The row starts at leftX and grows rightward; localZ is the toward-
// centre offset from the seat (worldZ = SEAT_RADIUS + localZ). leftX/localZ are DERIVED so the
// row's left and far (toward-seat) edges sit exactly one RAIL_SETBACK inside the rail's inner
// edge — flush against the rail with no overlap (so the clip can't recur). See the test.
const ROW_EDGE = FELT_CLEAR - RAIL_SETBACK; // |world coord| of the row's outermost tile edges
export const CORNER_BONUS = {
  leftX: -ROW_EDGE + TILE_W / 2,               // leftmost tile's left edge → -ROW_EDGE
  localZ: ROW_EDGE - TILE_H / 2 - SEAT_RADIUS, // row centre so its far edge → +ROW_EDGE
  gap: TILE_W,   // edge-to-edge spacing among flowers / within a meld
  meldGap: 0.02, // small break flowers→melds and between melds
};

// cornerBonusClearance({seatRadius, leftX, localZ, tileW, tileH, feltClear}): how far the
// corner-bonus row sits INSIDE the flat-felt clear boundary, in metres (positive = clear,
// negative = overhangs the raised border). zClear = gap from the row's far (toward-seat)
// edge to the near border; xClear = gap from the leftmost tile's left edge to the side border.
export function cornerBonusClearance({ seatRadius, leftX, localZ, tileW, tileH, feltClear }) {
  const rowZ = seatRadius + localZ; // world z of the row centre at the local (rel-0) seat
  return {
    zClear: feltClear - (rowZ + tileH / 2),
    xClear: (leftX - tileW / 2) + feltClear,
  };
}
