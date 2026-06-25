// Stateless scoring probe — powers the ruleset sandbox. Takes an untrusted
// ruleset + a described winning hand/context and returns the score + payments
// using the EXACT server scoring engine (no duplicated browser scorer).
const { scoreWin, computePayments, analyzeWait } = require('./scoring');
const { sanitizeRuleset } = require('./rulesets');

const WINDS = ['east', 'south', 'west', 'north'];
const DRAGONS = ['red', 'green', 'white'];
const SUITS = ['man', 'pin', 'bam'];

// Sanitize a client-supplied tile, assigning a fresh unique id (client ids are
// ignored so decomposition's id-based removal is never ambiguous).
function cleanTile(t, id) {
  if (!t || typeof t !== 'object') return null;
  const { suit, value } = t;
  if (SUITS.includes(suit)) {
    if (!(Number.isInteger(value) && value >= 1 && value <= 9)) return null;
  } else if (suit === 'wind') {
    if (!WINDS.includes(value)) return null;
  } else if (suit === 'dragon') {
    if (!DRAGONS.includes(value)) return null;
  } else if (suit === 'flower') {
    if (!(Number.isInteger(value) && value >= 1 && value <= 8)) return null;
  } else return null;
  return { suit, value, id };
}

function cleanTiles(arr, start, max = Infinity) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  let id = start;
  for (const t of arr) {
    if (out.length >= max) break; // bound untrusted input — a real win context is tiny (see caps below)
    const c = cleanTile(t, id); if (c) { out.push(c); id++; }
  }
  return out;
}

// rawCtx: { hand:[tile], melds:[{type,tiles}], flowers:[tile], seatWind, roundWind,
//   selfDraw, winningTileIndex, lastTile, kongReplacement, robbingKong,
//   lastOfKind, meldedHand, discarderIndex }
function probeScore(rawRuleset, rawCtx) {
  const ruleset = sanitizeRuleset(rawRuleset);
  rawCtx = (rawCtx && typeof rawCtx === 'object') ? rawCtx : {};

  // Bound every untrusted array. A real win context is small (≤14 concealed
  // tiles, ≤4 melds of ≤4 tiles, ≤8 flowers); without these caps a single large
  // scoreProbe message could drive the recursive win-search in scoring/mahjong
  // and block the single-threaded event loop for every connected player (DoS).
  const MAX_HAND = 18, MAX_MELDS = 4, MAX_MELD_TILES = 4, MAX_FLOWERS = 8;
  const hand = cleanTiles(rawCtx.hand, 0, MAX_HAND);
  let nextId = hand.length;
  const melds = (Array.isArray(rawCtx.melds) ? rawCtx.melds.slice(0, MAX_MELDS) : []).map(m => {
    const type = ['pong', 'kong', 'chow', 'concealed-kong'].includes(m && m.type) ? m.type : 'pong';
    const tiles = cleanTiles(m && m.tiles, nextId, MAX_MELD_TILES);
    nextId += tiles.length;
    return { type, tiles };
  }).filter(m => m.tiles.length >= 3);
  const flowers = cleanTiles(rawCtx.flowers, 1000, MAX_FLOWERS);

  const seatWind = WINDS.includes(rawCtx.seatWind) ? rawCtx.seatWind : 'east';
  const roundWind = WINDS.includes(rawCtx.roundWind) ? rawCtx.roundWind : 'east';
  const selfDraw = rawCtx.selfDraw === true;

  // Winning tile: an index into the concealed hand (default the last tile).
  let winningTile = null;
  const wi = rawCtx.winningTileIndex;
  if (Number.isInteger(wi) && wi >= 0 && wi < hand.length) winningTile = hand[wi];
  else if (hand.length) winningTile = hand[hand.length - 1];

  const wait = winningTile
    ? analyzeWait(hand.filter(t => t.id !== winningTile.id), melds, winningTile, ruleset)
    : { single: false, shape: null };

  const ctx = {
    hand, melds, flowers, seatWind, roundWind, selfDraw,
    lastTile: rawCtx.lastTile === true,
    kongReplacement: rawCtx.kongReplacement === true,
    robbingKong: rawCtx.robbingKong === true,
    winningTile, wait,
    lastOfKind: rawCtx.lastOfKind === true,
    meldedHand: rawCtx.meldedHand === true,
    ruleset,
  };

  const score = scoreWin(ctx, ruleset);
  const playerCount = 4;
  let discarderIndex = null;
  if (!selfDraw) {
    discarderIndex = Number.isInteger(rawCtx.discarderIndex) && rawCtx.discarderIndex > 0 && rawCtx.discarderIndex < playerCount
      ? rawCtx.discarderIndex : 1;
  }
  // Only a legal win produces payments; an illegal (below-minimum) hand pays
  // nothing, so the sandbox never shows real-looking payouts for a non-win.
  const payments = score.legal
    ? computePayments(score, 0, playerCount, selfDraw, discarderIndex, ruleset)
    : new Array(playerCount).fill(0);
  return { ruleset, score, payments, wait };
}

module.exports = { probeScore };
