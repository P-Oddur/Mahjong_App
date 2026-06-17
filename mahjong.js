const SUITS = ['man', 'pin', 'bam'];
const WINDS = ['east', 'south', 'west', 'north'];
const DRAGONS = ['red', 'green', 'white'];

function createDeck() {
  const tiles = [];
  let id = 0;
  for (const suit of SUITS)
    for (let v = 1; v <= 9; v++)
      for (let c = 0; c < 4; c++)
        tiles.push({ suit, value: v, id: id++ });
  for (const value of WINDS)
    for (let c = 0; c < 4; c++)
      tiles.push({ suit: 'wind', value, id: id++ });
  for (const value of DRAGONS)
    for (let c = 0; c < 4; c++)
      tiles.push({ suit: 'dragon', value, id: id++ });
  for (let v = 1; v <= 8; v++)
    tiles.push({ suit: 'flower', value: v, id: id++ });
  return tiles; // 144 tiles
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function suitRank(suit) {
  return { man: 0, pin: 1, bam: 2, wind: 3, dragon: 4, flower: 5 }[suit] ?? 6;
}
function valueRank(t) {
  if (t.suit === 'wind') return { east: 0, south: 1, west: 2, north: 3 }[t.value];
  if (t.suit === 'dragon') return { red: 0, green: 1, white: 2 }[t.value];
  return t.value;
}
function sortTiles(tiles) {
  return [...tiles].sort((a, b) => {
    const sd = suitRank(a.suit) - suitRank(b.suit);
    return sd !== 0 ? sd : valueRank(a) - valueRank(b);
  });
}

function findTile(arr, suit, value) {
  return arr.find(t => t.suit === suit && t.value === value) ?? null;
}

// Recursive win check: 4 sets + 1 pair
function checkWin(hand, melds) {
  const setsNeeded = 4 - melds.length;
  const tiles = sortTiles(hand.filter(t => t.suit !== 'flower'));
  if (tiles.length !== setsNeeded * 3 + 2) return false;
  return canWin(tiles, setsNeeded, false);
}

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

// Return array of valid claim types for a player
function getValidClaims(hand, melds, discardedTile, isNextPlayer) {
  const claims = [];
  const testHand = [...hand, discardedTile];
  if (checkWin(testHand, melds)) claims.push('win');
  const matching = hand.filter(t => t.suit === discardedTile.suit && t.value === discardedTile.value);
  if (matching.length >= 3) claims.push('kong');
  if (matching.length >= 2) claims.push('pong');
  if (isNextPlayer && ['man', 'pin', 'bam'].includes(discardedTile.suit)) {
    if (getChowOptions(hand, discardedTile).length > 0) claims.push('chow');
  }
  return claims;
}

// Return all valid chow tile combos (each is 3-tile array including discardedTile)
function getChowOptions(hand, discardedTile) {
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

const Mahjong = { createDeck, shuffle, sortTiles, checkWin, getValidClaims, getChowOptions };
// Usable both as a Node module (server) and a browser global (client) so the
// client shares this one authoritative rules engine instead of a hand-copy.
if (typeof module !== 'undefined' && module.exports) module.exports = Mahjong;
else if (typeof window !== 'undefined') window.Mahjong = Mahjong;
