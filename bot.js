const { checkWin, getValidClaims, getChowOptions } = require('./mahjong');

const BOT_NAMES = ['Bot Mei', 'Bot Kai', 'Bot Lin', 'Bot Bao', 'Bot Yu', 'Bot Jin'];

function pickBotName(existingNames) {
  const free = BOT_NAMES.filter(n => !existingNames.includes(n));
  return free[0] || `Bot ${Math.floor(Math.random() * 900) + 100}`;
}

// How much a tile contributes to the rest of the hand. Higher = keep.
function tileUsefulness(tile, hand) {
  const others = hand.filter(t => t !== tile);
  let score = 0;

  const matches = others.filter(t => t.suit === tile.suit && t.value === tile.value).length;
  score += matches * 50; // pair partner 50, triplet partners 100

  if (['man', 'pin', 'bam'].includes(tile.suit)) {
    for (const t of others) {
      if (t.suit !== tile.suit) continue;
      const d = Math.abs(t.value - tile.value);
      if (d === 1) score += 25;
      else if (d === 2) score += 10;
    }
    // Central tiles connect to more sequences
    if (tile.value >= 3 && tile.value <= 7) score += 3;
    else if (tile.value === 2 || tile.value === 8) score += 1;
  }

  return score;
}

// Pick a tile to discard. Difficulty tunes the behaviour:
//   easy   – half the time tosses a random tile (loose, weak play)
//   normal – discards the least useful tile (default; original behaviour)
//   hard   – among the least useful tiles, prefers one already seen in the
//            discard pile (safer to part with)
function chooseDiscard(hand, difficulty = 'normal', discardPile = []) {
  if (!hand.length) return null;
  const scored = hand.map(t => ({ t, s: tileUsefulness(t, hand) })).sort((a, b) => a.s - b.s);
  const worst = scored[0].t;

  if (difficulty === 'easy') {
    if (Math.random() < 0.5) return hand[Math.floor(Math.random() * hand.length)];
    return worst;
  }

  if (difficulty === 'hard') {
    // Among the least-useful tiles, prefer one already seen in the discard pile.
    const min = scored[0].s;
    const pileCount = {};
    for (const d of discardPile) { const k = `${d.suit}:${d.value}`; pileCount[k] = (pileCount[k] || 0) + 1; }
    let best = worst, bestSeen = -1;
    for (const { t, s } of scored) {
      if (s > min + 10) break; // scored is ascending; past the low-usefulness band, stop
      const seen = pileCount[`${t.suit}:${t.value}`] || 0;
      if (seen > bestSeen) { bestSeen = seen; best = t; }
    }
    return best;
  }

  return worst; // normal
}

// Find a concealed 4-of-a-kind worth declaring, if any
function findConcealedKong(hand) {
  const groups = {};
  for (const t of hand) {
    const k = `${t.suit}:${t.value}`;
    (groups[k] = groups[k] || []).push(t);
  }
  for (const grp of Object.values(groups)) {
    if (grp.length === 4) return grp[0];
  }
  return null;
}

function countPairs(tiles) {
  const groups = {};
  for (const t of tiles) {
    const k = `${t.suit}:${t.value}`;
    groups[k] = (groups[k] || 0) + 1;
  }
  return Object.values(groups).filter(c => c >= 2).length;
}

// Decide how to respond to a discard. Returns {type, tileIds} or null to pass.
// Difficulty tunes pong/chow aggression (wins and kongs are always taken):
//   easy   – passes on most pong/chow chances
//   normal – claims only if it keeps a pair as the head (default; original)
//   hard   – claims whenever legal (more aggressive)
function decideClaim(hand, melds, discard, isNext, difficulty = 'normal') {
  const valid = getValidClaims(hand, melds, discard, isNext);
  if (valid.includes('win')) return { type: 'win' };
  if (valid.includes('kong')) return { type: 'kong' };

  // Easy bots are passive — they skip most pong/chow opportunities.
  if (difficulty === 'easy' && Math.random() < 0.75) return null;
  const aggressive = difficulty === 'hard';

  if (valid.includes('pong')) {
    const used = hand.filter(t => t.suit === discard.suit && t.value === discard.value).slice(0, 2);
    const remaining = hand.filter(t => !used.includes(t));
    // Only pong if we still have a pair left to serve as the head (unless aggressive)
    if (aggressive || countPairs(remaining) >= 1) return { type: 'pong' };
  }

  if (valid.includes('chow')) {
    const opts = getChowOptions(hand, discard);
    if (opts.length > 0) {
      const fromHand = opts[0].filter(t => t !== discard);
      const remaining = hand.filter(t => !fromHand.includes(t));
      if (aggressive || countPairs(remaining) >= 1) {
        return { type: 'chow', tileIds: fromHand.map(t => t.id) };
      }
    }
  }

  return null;
}

module.exports = { pickBotName, chooseDiscard, findConcealedKong, decideClaim, checkWin };
