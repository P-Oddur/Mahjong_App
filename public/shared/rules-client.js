// rules-client.js — pure client-side mahjong rules + label helpers (ES module).
//
// This module is the 3D client's stand-in for the browser global `window.Mahjong`
// (served from /mahjong.js for the 2D client). The 3D page does NOT load
// /mahjong.js; instead input.js / hud.js / tiles.js import the named exports here.
//
// The validation/affordance logic below is reproduced VERBATIM from mahjong.js so
// it matches the server's re-validation exactly. The label helpers (tileLabel /
// tileGlyph) are reproduced VERBATIM from public/game.js. Nothing here touches the
// DOM, the socket, or Three.js — it is pure and side-effect free.
//
// Tile shape (contract §2.1):
//   tile = { suit, value, id }
//     suit  ∈ 'man' | 'pin' | 'bam' | 'wind' | 'dragon' | 'flower'
//     value : 1..9 for man/pin/bam, 1..8 for flower, STRING for honors
//             wind ∈ 'east'|'south'|'west'|'north', dragon ∈ 'red'|'green'|'white'
//     id    : unique int 0..143
//   The literal string 'back' is the face-down sentinel.
// Meld shape (contract §2.2):
//   meld = { type, tiles: [tile, ...] }  type ∈ pong|kong|chow|concealed-kong

// ── Private constants (identical to mahjong.js; not exported) ─────────────────
const SUITS = ['man', 'pin', 'bam'];
const WINDS = ['east', 'south', 'west', 'north'];
const DRAGONS = ['red', 'green', 'white'];

// ── Private ordering helpers (identical to mahjong.js) ───────────────────────
function suitRank(suit) {
  return { man: 0, pin: 1, bam: 2, wind: 3, dragon: 4, flower: 5 }[suit] ?? 6;
}
function valueRank(t) {
  if (t.suit === 'wind') return { east: 0, south: 1, west: 2, north: 3 }[t.value];
  if (t.suit === 'dragon') return { red: 0, green: 1, white: 2 }[t.value];
  return t.value;
}

// ── Stable sort copy by suit rank then value rank (identical to mahjong.js) ───
export function sortTiles(tiles) {
  return [...tiles].sort((a, b) => {
    const sd = suitRank(a.suit) - suitRank(b.suit);
    return sd !== 0 ? sd : valueRank(a) - valueRank(b);
  });
}

// ── Private tile lookup helper (identical to mahjong.js) ──────────────────────
function findTile(arr, suit, value) {
  return arr.find(t => t.suit === suit && t.value === value) ?? null;
}

// 十三幺 / 七對 don't fit "4 sets + a pair", so they get dedicated detectors.
// (Private predicates, identical to mahjong.js.)
const isTerminalOrHonor = t =>
  ((t.suit === 'man' || t.suit === 'pin' || t.suit === 'bam') && (t.value === 1 || t.value === 9)) ||
  t.suit === 'wind' || t.suit === 'dragon';
const tileKey = t => `${t.suit}-${t.value}`;

// Thirteen Orphans (十三幺): all 13 terminal/honour types present + one duplicate.
// 14 tiles all terminal/honour with 13 distinct keys ⇒ every type present, one doubled.
export function isThirteenOrphans(tiles) {
  return tiles.length === 14 && tiles.every(isTerminalOrHonor) && new Set(tiles.map(tileKey)).size === 13;
}

// Seven Pairs (七對): exactly seven DISTINCT pairs (a four-of-a-kind is not two pairs).
export function isSevenPairs(tiles) {
  if (tiles.length !== 14) return false;
  const counts = {};
  for (const t of tiles) counts[tileKey(t)] = (counts[tileKey(t)] || 0) + 1;
  const vals = Object.values(counts);
  return vals.length === 7 && vals.every(c => c === 2);
}

// ── Knitted hands (組合龍 / 全不靠 / 七星不靠) — identical to mahjong.js ────────
// A "knitted" line splits 1-9 into three families (1-4-7 / 2-5-8 / 3-6-9), each
// family assigned to a distinct suit. The family of a value is (value-1) % 3.
const KNIT_PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const isHonorTile = t => t.suit === 'wind' || t.suit === 'dragon';

function knittedAssignmentExists(suited) {
  for (const perm of KNIT_PERMS) {
    const assign = { man: perm[0], pin: perm[1], bam: perm[2] };
    if (suited.every(t => (t.value - 1) % 3 === assign[t.suit])) return true;
  }
  return false;
}

// 七星不靠 — all 7 honours (one each) + 7 suited singles on one knitted line.
export function isGreaterKnitted(tiles) {
  if (tiles.length !== 14 || new Set(tiles.map(tileKey)).size !== 14) return false;
  const honors = tiles.filter(isHonorTile);
  const suited = tiles.filter(t => SUITS.includes(t.suit));
  if (honors.length !== 7 || suited.length !== 7) return false;
  return knittedAssignmentExists(suited);
}

// 全不靠 — honours (≤7) + suited singles on one knitted line, all 14 distinct.
export function isLesserKnitted(tiles) {
  if (tiles.length !== 14 || new Set(tiles.map(tileKey)).size !== 14) return false;
  const honors = tiles.filter(isHonorTile);
  const suited = tiles.filter(t => SUITS.includes(t.suit));
  if (honors.length + suited.length !== 14 || honors.length > 7) return false;
  return knittedAssignmentExists(suited);
}

// 組合龍 — the full knitted 1-9 (one family per suit) + one normal set + a pair.
export function isKnittedStraightWin(tiles) {
  if (tiles.length !== 14) return false;
  for (const perm of KNIT_PERMS) {
    const assign = { man: perm[0], pin: perm[1], bam: perm[2] };
    const rem = [...tiles];
    let ok = true;
    for (const suit of SUITS) {
      for (let v = 1; v <= 9 && ok; v++) {
        if ((v - 1) % 3 !== assign[suit]) continue;
        const idx = rem.findIndex(t => t.suit === suit && t.value === v);
        if (idx === -1) ok = false; else rem.splice(idx, 1);
      }
    }
    if (ok && canWin(sortTiles(rem), 1, false)) return true;
  }
  return false;
}

// Identify a knitted win for the scorer (greater 24 outranks the two 12s).
export function parseKnitted(tiles) {
  if (isGreaterKnitted(tiles)) return { kind: 'greater' };
  if (isKnittedStraightWin(tiles)) return { kind: 'knitted-straight' };
  if (isLesserKnitted(tiles)) return { kind: 'lesser' };
  return null;
}

// Which non-standard winning shapes a ruleset permits. With no ruleset the
// defaults reproduce the original engine: seven pairs and thirteen orphans are
// legal, knitted hands are not.
export function legalWinShapes(ruleset) {
  const a = (ruleset && ruleset.allow) || {};
  return {
    sevenPairs: a.sevenPairs !== false,
    thirteenOrphans: a.thirteenOrphans !== false,
    greaterKnitted: a.greaterKnitted === true,
    lesserKnitted: a.lesserKnitted === true,
    knittedStraight: a.knittedStraight === true,
  };
}

// A win is 4 sets + 1 pair, or one of the special concealed hands above — each
// gated by what the active ruleset permits. (Identical to mahjong.js checkWin.)
export function checkWin(hand, melds, ruleset) {
  const tiles = sortTiles(hand.filter(t => t.suit !== 'flower'));
  if (melds.length === 0) {
    const allow = legalWinShapes(ruleset);
    if (allow.thirteenOrphans && isThirteenOrphans(tiles)) return true;
    if (allow.sevenPairs && isSevenPairs(tiles)) return true;
    if (allow.greaterKnitted && isGreaterKnitted(tiles)) return true;
    if (allow.lesserKnitted && isLesserKnitted(tiles)) return true;
    if (allow.knittedStraight && isKnittedStraightWin(tiles)) return true;
  }
  const setsNeeded = 4 - melds.length;
  if (tiles.length !== setsNeeded * 3 + 2) return false;
  return canWin(tiles, setsNeeded, false);
}

// Recursive set/pair decomposition (private, identical to mahjong.js).
function canWin(tiles, sets, hasPair) {
  if (tiles.length === 0) return sets === 0 && hasPair;
  const t = tiles[0];
  const rest = tiles.slice(1);

  // Try pair with t
  if (!hasPair) {
    const i = rest.findIndex(r => r.suit === t.suit && r.value === t.value);
    if (i !== -1) {
      const r2 = [...rest]; r2.splice(i, 1);
      if (canWin(r2, sets, true)) return true;
    }
  }

  if (sets === 0) return false;

  // Try pong with t
  const same = rest.filter(r => r.suit === t.suit && r.value === t.value);
  if (same.length >= 2) {
    const r2 = rest.filter(r => r !== same[0] && r !== same[1]);
    if (canWin(r2, sets - 1, hasPair)) return true;
  }

  // Try chow with t
  if (['man', 'pin', 'bam'].includes(t.suit)) {
    const v = t.value;
    const t2 = findTile(rest, t.suit, v + 1);
    if (t2) {
      const r2 = rest.filter(r => r !== t2);
      const t3 = findTile(r2, t.suit, v + 2);
      if (t3) {
        const r3 = r2.filter(r => r !== t3);
        if (canWin(r3, sets - 1, hasPair)) return true;
      }
    }
  }

  return false;
}

// Return array of valid claim types for a player.
// Subset of ['win','kong','pong','chow'] claimable on discardedTile.
// (Identical to mahjong.js getValidClaims.)
export function getValidClaims(hand, melds, discardedTile, isNextPlayer, ruleset) {
  const claims = [];
  const testHand = [...hand, discardedTile];
  if (checkWin(testHand, melds, ruleset)) claims.push('win');
  const matching = hand.filter(t => t.suit === discardedTile.suit && t.value === discardedTile.value);
  if (matching.length >= 3) claims.push('kong');
  if (matching.length >= 2) claims.push('pong');
  if (isNextPlayer && ['man', 'pin', 'bam'].includes(discardedTile.suit)) {
    if (getChowOptions(hand, discardedTile).length > 0) claims.push('chow');
  }
  return claims;
}

// Return all valid chow tile combos (each is a 3-tile array [low,mid,high]
// INCLUDING discardedTile). (Identical to mahjong.js getChowOptions.)
export function getChowOptions(hand, discardedTile) {
  if (!['man', 'pin', 'bam'].includes(discardedTile.suit)) return [];
  const v = discardedTile.value;
  const s = discardedTile.suit;
  const opts = [];
  // low: need v-2, v-1
  if (v >= 3) {
    const a = findTile(hand, s, v - 2), b = findTile(hand, s, v - 1);
    if (a && b) opts.push([a, b, discardedTile]);
  }
  // mid: need v-1, v+1
  if (v >= 2 && v <= 8) {
    const a = findTile(hand, s, v - 1), b = findTile(hand, s, v + 1);
    if (a && b) opts.push([a, discardedTile, b]);
  }
  // high: need v+1, v+2
  if (v <= 7) {
    const a = findTile(hand, s, v + 1), b = findTile(hand, s, v + 2);
    if (a && b) opts.push([discardedTile, a, b]);
  }
  return opts;
}

// ── Label / glyph helpers (reproduced VERBATIM from public/game.js) ──────────
// Pure and DOM-free; the 3D client uses these for tile labels (tiles.js/hud.js)
// and for chat action-bubble glyphs (matching the 2D client's chat wiring).

// Unicode mahjong-tile glyph for a tile ('back'/null → face-down 🀫).
export function tileGlyph(tile) {
  if (!tile || tile === 'back') return '🀫'; // 🀫
  if (tile.suit === 'man')    return String.fromCodePoint(0x1F007 + tile.value - 1);
  if (tile.suit === 'bam')    return String.fromCodePoint(0x1F010 + tile.value - 1);
  if (tile.suit === 'pin')    return String.fromCodePoint(0x1F019 + tile.value - 1);
  if (tile.suit === 'wind')   return { east:'🀀', south:'🀁', west:'🀂', north:'🀃' }[tile.value];
  if (tile.suit === 'dragon') return { red:'🀄', green:'🀅', white:'🀆' }[tile.value];
  if (tile.suit === 'flower') return ['🀢','🀣','🀤','🀥','🀦','🀧','🀨','🀩'][tile.value - 1];
  return '?';
}

// Short text label for a tile (e.g. '3m', '東', '中', 'F2'); '' for back/null.
export function tileLabel(tile) {
  if (!tile || tile === 'back') return '';
  if (tile.suit === 'man')    return tile.value + 'm';
  if (tile.suit === 'pin')    return tile.value + 'p';
  if (tile.suit === 'bam')    return tile.value + 'b';
  if (tile.suit === 'wind')   return { east:'東', south:'南', west:'西', north:'北' }[tile.value];
  if (tile.suit === 'dragon') return { red:'中', green:'發', white:'白' }[tile.value];
  if (tile.suit === 'flower') return 'F' + tile.value;
  return '';
}

// Map a server tile to its rendered 2D face image under /assets/tiles2d.
// Suited tiles (man/pin/bam) → `${suit}${value}`; honors (wind/dragon) → `${suit}_${value}`.
// Returns null for tiles with no rendered face: the 'back' sentinel, flowers, and null/unknown —
// callers fall back to the unicode glyph + label (flowers) or a CSS tile-back (face-down).
export function tileImageSrc(tile) {
  if (!tile || tile === 'back' || !tile.suit) return null;
  const { suit, value } = tile;
  if (suit === 'man' || suit === 'pin' || suit === 'bam') return `/assets/tiles2d/${suit}${value}.png`;
  if (suit === 'wind' || suit === 'dragon') return `/assets/tiles2d/${suit}_${value}.png`;
  return null;
}
