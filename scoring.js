// Hong Kong–style faan (番) scoring.
//
// The engine is deliberately data-driven: every scoring pattern is a small,
// self-contained entry in the PATTERNS table below. To add a new rule (e.g.
// a yaku, a limit hand, or a situational bonus) you append one object — you do
// not touch the decomposition or summation logic. Situational patterns read
// optional flags off the scoring context (kongReplacement, robbingKong,
// lastTile, ...), so the server can light them up as those rules are added
// without any change here.
//
// A winning hand is 4 sets + 1 pair. The concealed tiles can often be read as
// sets in more than one way (e.g. three of a kind vs. part of runs); we
// enumerate every legal decomposition, score each, and keep the highest —
// the standard "best interpretation wins" rule.

const { sortTiles } = require('./mahjong');

const WINDS = ['east', 'south', 'west', 'north'];
const SUITED = new Set(['man', 'pin', 'bam']);

// Tunable rule set. The server overrides these from environment variables.
const DEFAULT_SCORING = {
  minFaan: 0, // minimum faan required to win (0 = allow a "chicken hand" 雞糊)
  limitFaan: 13, // a hand at/above this faan is a limit hand (爆棚); also caps payout
  basePoints: 1, // payout multiplier
};

// ── Hand decomposition ───────────────────────────────────────────────────────

// All ways to read `tiles` (no flowers) as `setsNeeded` sets + 1 pair.
// Each result: { pair: [t,t], sets: [{ kind:'pung'|'chow', tiles, concealed:true }] }.
// Tiles carry unique ids, so removal is unambiguous. We always consume the
// lowest remaining tile, which makes the enumeration complete and duplicate-free.
function decompose(tiles, setsNeeded) {
  const results = [];

  function rec(remaining, sets, pair) {
    if (remaining.length === 0) {
      if (sets.length === setsNeeded && pair) results.push({ pair, sets: sets.slice() });
      return;
    }
    const t = remaining[0];
    const rest = remaining.slice(1);

    // Use t as the pair.
    if (!pair) {
      const j = rest.findIndex(r => r.suit === t.suit && r.value === t.value);
      if (j !== -1) {
        const r2 = rest.slice();
        const partner = r2.splice(j, 1)[0];
        rec(r2, sets, [t, partner]);
      }
    }

    if (sets.length < setsNeeded) {
      // Use t as the base of a pung.
      const same = rest.filter(r => r.suit === t.suit && r.value === t.value);
      if (same.length >= 2) {
        const used = new Set([same[0].id, same[1].id]);
        const r2 = rest.filter(r => !used.has(r.id));
        rec(r2, [...sets, { kind: 'pung', tiles: [t, same[0], same[1]], concealed: true }], pair);
      }
      // Use t as the lowest tile of a chow.
      if (SUITED.has(t.suit)) {
        const a = rest.find(r => r.suit === t.suit && r.value === t.value + 1);
        const b = rest.find(r => r.suit === t.suit && r.value === t.value + 2);
        if (a && b) {
          const used = new Set([a.id, b.id]);
          const r2 = rest.filter(r => !used.has(r.id));
          rec(r2, [...sets, { kind: 'chow', tiles: [t, a, b], concealed: true }], pair);
        }
      }
    }
  }

  rec(sortTiles(tiles), [], null);
  return results;
}

// Exposed/declared melds carry their own concealment; normalise them to the
// same shape decomposition produces. Kongs score as triplets here.
function normalizeMeld(m) {
  if (m.type === 'chow') return { kind: 'chow', tiles: m.tiles, concealed: false, isKong: false };
  if (m.type === 'pong') return { kind: 'pung', tiles: m.tiles, concealed: false, isKong: false };
  if (m.type === 'kong') return { kind: 'pung', tiles: m.tiles, concealed: false, isKong: true };
  if (m.type === 'concealed-kong') return { kind: 'pung', tiles: m.tiles, concealed: true, isKong: true };
  return { kind: m.type === 'chow' ? 'chow' : 'pung', tiles: m.tiles, concealed: false, isKong: false };
}

// ── Pattern helpers ────────────────────────────────────────────────────────

const allTilesOf = d => [...d.sets.flatMap(s => s.tiles), ...d.pair];
const pungs = d => d.sets.filter(s => s.kind === 'pung');
const dragonPungCount = d => pungs(d).filter(s => s.tiles[0].suit === 'dragon').length;
const windPungCount = d => pungs(d).filter(s => s.tiles[0].suit === 'wind').length;
const hasHonor = d => allTilesOf(d).some(t => t.suit === 'wind' || t.suit === 'dragon');

function suitsOf(d) {
  const s = new Set();
  for (const t of allTilesOf(d)) if (SUITED.has(t.suit)) s.add(t.suit);
  return s;
}

function isValuePair(d, c) {
  const t = d.pair[0];
  if (t.suit === 'dragon') return true;
  if (t.suit === 'wind' && (t.value === c.seatWind || t.value === c.roundWind)) return true;
  return false;
}

// ── Pattern table ────────────────────────────────────────────────────────────
//
// evaluate(ctx, decomp) returns the faan to add. For `limit` patterns it
// returns 1 to signal a match (the engine substitutes cfg.limitFaan). Multi-
// instance patterns (dragon triplets, seat flowers) return their count so the
// breakdown can show e.g. "×2".

const PATTERNS = [
  // Situational (whole-hand state)
  { id: 'self-draw', name: 'Self-Draw', cn: '自摸',
    evaluate: c => (c.selfDraw ? 1 : 0) },
  { id: 'concealed', name: 'Concealed Hand', cn: '門前清',
    evaluate: (c, d) => (d.sets.every(s => s.concealed) ? 1 : 0) },

  // Set-shape patterns
  { id: 'all-chows', name: 'All Sequences', cn: '平糊',
    evaluate: (c, d) => (d.sets.every(s => s.kind === 'chow') && !isValuePair(d, c) ? 1 : 0) },
  { id: 'all-pungs', name: 'All Triplets', cn: '對對糊',
    evaluate: (c, d) => (d.sets.every(s => s.kind === 'pung') ? 3 : 0) },

  // Honour triplets (役牌). A wind that is both seat and round scores twice.
  { id: 'dragon-pung', name: 'Dragon Triplet', cn: '三元牌', perCount: true,
    evaluate: (c, d) => dragonPungCount(d) },
  { id: 'seat-wind', name: 'Seat Wind', cn: '門風',
    evaluate: (c, d) => (pungs(d).some(s => s.tiles[0].suit === 'wind' && s.tiles[0].value === c.seatWind) ? 1 : 0) },
  { id: 'round-wind', name: 'Round Wind', cn: '圈風',
    evaluate: (c, d) => (pungs(d).some(s => s.tiles[0].suit === 'wind' && s.tiles[0].value === c.roundWind) ? 1 : 0) },

  // Flushes
  { id: 'half-flush', name: 'Half Flush', cn: '混一色',
    evaluate: (c, d) => (suitsOf(d).size === 1 && hasHonor(d) ? 3 : 0) },
  { id: 'full-flush', name: 'Full Flush', cn: '清一色',
    evaluate: (c, d) => (suitsOf(d).size === 1 && !hasHonor(d) ? 7 : 0) },

  // Small three dragons sits on top of its two dragon triplets (net 5).
  { id: 'small-three-dragons', name: 'Small Three Dragons', cn: '小三元',
    evaluate: (c, d) => (dragonPungCount(d) === 2 && d.pair[0].suit === 'dragon' ? 3 : 0) },

  // Limit hands (大牌) — each pays the cap regardless of the rest.
  { id: 'big-three-dragons', name: 'Big Three Dragons', cn: '大三元', limit: true,
    evaluate: (c, d) => (dragonPungCount(d) === 3 ? 1 : 0) },
  { id: 'small-four-winds', name: 'Small Four Winds', cn: '小四喜', limit: true,
    evaluate: (c, d) => (windPungCount(d) === 3 && d.pair[0].suit === 'wind' ? 1 : 0) },
  { id: 'big-four-winds', name: 'Big Four Winds', cn: '大四喜', limit: true,
    evaluate: (c, d) => (windPungCount(d) === 4 ? 1 : 0) },
  { id: 'all-honors', name: 'All Honours', cn: '字一色', limit: true,
    evaluate: (c, d) => (allTilesOf(d).every(t => t.suit === 'wind' || t.suit === 'dragon') ? 1 : 0) },
  { id: 'all-terminals', name: 'All Terminals', cn: '清幺九', limit: true,
    evaluate: (c, d) => (allTilesOf(d).every(t => SUITED.has(t.suit) && (t.value === 1 || t.value === 9)) ? 1 : 0) },

  // Situational bonuses — wired to optional context flags so advanced rules can
  // enable them later without touching the engine.
  { id: 'kong-replacement', name: 'Win on Kong Replacement', cn: '槓上開花',
    evaluate: c => (c.kongReplacement ? 1 : 0) },
  { id: 'robbing-kong', name: 'Robbing the Kong', cn: '搶槓',
    evaluate: c => (c.robbingKong ? 1 : 0) },
  { id: 'last-tile-draw', name: 'Win on Last Tile', cn: '海底撈月',
    evaluate: c => (c.selfDraw && c.lastTile ? 1 : 0) },
  { id: 'last-tile-discard', name: 'Win on Last Discard', cn: '河底撈魚',
    evaluate: c => (!c.selfDraw && c.lastTile ? 1 : 0) },

  // Flowers matching the player's seat (正花).
  { id: 'seat-flower', name: 'Seat Flower', cn: '正花', perCount: true,
    evaluate: c => (c.flowers || []).filter(f => WINDS[(f.value - 1) % 4] === c.seatWind).length },
];

// ── Scoring ──────────────────────────────────────────────────────────────────

function faanToPoints(faan, cfg) {
  return cfg.basePoints * Math.pow(2, Math.min(faan, cfg.limitFaan));
}

// Score one decomposition against every pattern.
function scoreDecomposition(ctx, d, cfg) {
  const breakdown = [];
  let faan = 0;
  let isLimit = false;

  for (const p of PATTERNS) {
    const v = p.evaluate(ctx, d);
    if (!v) continue;
    if (p.limit) {
      isLimit = true;
      faan += cfg.limitFaan;
      breakdown.push({ id: p.id, name: p.name, cn: p.cn, faan: cfg.limitFaan, limit: true });
    } else {
      faan += v;
      breakdown.push({ id: p.id, name: p.name, cn: p.cn, faan: v, count: p.perCount && v > 1 ? v : undefined });
    }
  }
  return { faan, isLimit, breakdown };
}

// ctx: { hand, melds, seatWind, roundWind, selfDraw, flowers,
//        kongReplacement?, robbingKong?, lastTile? }
// `hand` is the concealed tiles INCLUDING the winning tile.
// Returns { faan, rawFaan, isLimit, points, breakdown }. faan is capped at the
// limit; rawFaan is the uncapped sum (useful for display/tie-breaks).
function scoreWin(ctx, cfg = DEFAULT_SCORING) {
  const handTiles = (ctx.hand || []).filter(t => t.suit !== 'flower');
  const melds = (ctx.melds || []).map(normalizeMeld);
  const decomps = decompose(handTiles, 4 - melds.length);

  let best = null;
  for (const dc of decomps) {
    const d = { sets: [...melds, ...dc.sets], pair: dc.pair };
    const scored = scoreDecomposition(ctx, d, cfg);
    if (!best || scored.faan > best.faan) best = scored;
  }
  if (!best) best = { faan: 0, isLimit: false, breakdown: [] };

  const faan = Math.min(best.faan, cfg.limitFaan);
  return { faan, rawFaan: best.faan, isLimit: best.isLimit, points: faanToPoints(faan, cfg), breakdown: best.breakdown };
}

// Signed point transfer per player index after a win.
// Self-draw: every other player pays the winner. Discard: the discarder pays in full.
function computePayments(score, winnerIndex, playerCount, selfDraw, discarderIndex, cfg = DEFAULT_SCORING) {
  const pay = new Array(playerCount).fill(0);
  const pts = score.points;
  if (selfDraw) {
    for (let i = 0; i < playerCount; i++) {
      if (i === winnerIndex) continue;
      pay[i] -= pts;
      pay[winnerIndex] += pts;
    }
  } else if (discarderIndex != null && discarderIndex !== winnerIndex) {
    pay[discarderIndex] -= pts;
    pay[winnerIndex] += pts;
  }
  return pay;
}

module.exports = {
  scoreWin,
  computePayments,
  faanToPoints,
  decompose,
  DEFAULT_SCORING,
  PATTERNS,
  WINDS,
};
