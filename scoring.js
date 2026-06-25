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

const { sortTiles, isThirteenOrphans, isSevenPairs, parseKnitted, checkWin } = require('./mahjong');

const WINDS = ['east', 'south', 'west', 'north'];
const SUITED = new Set(['man', 'pin', 'bam']);

// Tunable rule set. The server overrides these from environment variables.
const DEFAULT_SCORING = {
  minFaan: 0, // minimum faan required to win (0 = allow a "chicken hand" 雞糊)
  limitFaan: 13, // a hand at/above this faan is a limit hand (爆棚); also caps payout
  basePoints: 1, // payout multiplier
};

// Seven Pairs base faan (七對). The Pure Straight and Flower Set magnitudes now
// live in the pattern library as `hkFaan`, so they're retunable like the rest.
const SEVEN_PAIRS_FAAN = 4;

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

const chowStart = s => Math.min(...s.tiles.map(t => t.value));

// 清龍: chows starting at 1, 4 and 7 all in the same suit.
function hasPureStraight(d) {
  for (const suit of SUITED) {
    const starts = new Set(d.sets.filter(s => s.kind === 'chow' && s.tiles[0].suit === suit).map(chowStart));
    if (starts.has(1) && starts.has(4) && starts.has(7)) return true;
  }
  return false;
}

// 九蓮寶燈: concealed full flush in the 1112345678999(+1) shape.
function isNineGatesDecomp(d) {
  if (!d.sets.every(s => s.concealed)) return false;
  const tiles = allTilesOf(d);
  if (!tiles.every(t => SUITED.has(t.suit)) || new Set(tiles.map(t => t.suit)).size !== 1) return false;
  const cnt = {};
  for (let v = 1; v <= 9; v++) cnt[v] = 0;
  for (const t of tiles) cnt[t.value]++;
  if (cnt[1] < 3 || cnt[9] < 3) return false;
  for (let v = 2; v <= 8; v++) if (cnt[v] < 1) return false;
  return true;
}

// Flowers come in two suits of four (1-4 and 5-8); a complete suit is 一台花.
const FLOWER_SETS = [[1, 2, 3, 4], [5, 6, 7, 8]];
const flowerSetCount = flowers => {
  const vals = new Set((flowers || []).map(f => f.value));
  return FLOWER_SETS.filter(set => set.every(v => vals.has(v))).length;
};
const hasAllFlowers = flowers => {
  const vals = new Set((flowers || []).map(f => f.value));
  return [1, 2, 3, 4, 5, 6, 7, 8].every(v => vals.has(v));
};

// ── MCR pattern helpers ──────────────────────────────────────────────────────
// Everything below operates on the same decomposition shape the HK patterns use
// ({ sets:[{kind,tiles,concealed,isKong?}], pair:[t,t] }), so the full MCR
// library is just more data — no new engine machinery.
const chows = d => d.sets.filter(s => s.kind === 'chow');
const suitedPungs = d => pungs(d).filter(s => SUITED.has(s.tiles[0].suit));
// A pung completed by the winning DISCARD is not a concealed pung (暗刻); the
// `ronCompleted` mark (set in scoreWin on a non-self-draw win) excludes it.
const concealedPungCount = d => pungs(d).filter(s => s.concealed && !s.ronCompleted).length;
function kongCounts(d) {
  let concealed = 0, melded = 0;
  for (const s of d.sets) if (s.isKong) (s.concealed ? concealed++ : melded++);
  return { concealed, melded, total: concealed + melded };
}

// On a discard win, the concealed pung the winning tile completes was effectively
// claimed, so it must not count as a 暗刻. Mark that one set (the hand-level
// `concealed` flag is left intact, so 門前清/不求人 are unaffected). No-op on a
// self-draw or when the winning tile isn't part of a concealed pung.
function markRonCompletedSet(sets, ctx) {
  if (ctx.selfDraw || !ctx.winningTile) return sets;
  for (const s of sets) {
    if (s.concealed && s.kind === 'pung' && s.tiles.some(t => t.id === ctx.winningTile.id)) {
      s.ronCompleted = true;
      break;
    }
  }
  return sets;
}
const isTerminal = t => SUITED.has(t.suit) && (t.value === 1 || t.value === 9);
const isHonorTile = t => t.suit === 'wind' || t.suit === 'dragon';
const groupHasTerminalOrHonor = tiles => tiles.some(t => isTerminal(t) || isHonorTile(t));
const groupHasValue = (tiles, v) => tiles.some(t => SUITED.has(t.suit) && t.value === v);
// every set AND the pair satisfy pred(tiles)
const everyGroup = (d, pred) => pred(d.pair) && d.sets.every(s => pred(s.tiles));
// all tiles suited and within [lo,hi]
const allInBand = (d, lo, hi) => allTilesOf(d).every(t => SUITED.has(t.suit) && t.value >= lo && t.value <= hi);
function isReversibleTile(t) {
  if (t.suit === 'pin') return [1, 2, 3, 4, 5, 8, 9].includes(t.value);
  if (t.suit === 'bam') return [2, 4, 5, 6, 8, 9].includes(t.value);
  if (t.suit === 'dragon') return t.value === 'white';
  return false;
}
function isGreenTile(t) {
  if (t.suit === 'bam') return [2, 3, 4, 6, 8].includes(t.value);
  if (t.suit === 'dragon') return t.value === 'green';
  return false;
}
function chowStartsBySuit(d) {
  const m = {};
  for (const s of chows(d)) (m[s.tiles[0].suit] ??= []).push(chowStart(s));
  return m;
}
function pungRanksBySuit(d) {
  const m = {};
  for (const s of suitedPungs(d)) (m[s.tiles[0].suit] ??= []).push(s.tiles[0].value);
  return m;
}

// ── Pattern table ────────────────────────────────────────────────────────────
//
// evaluate(ctx, decomp) returns a MULTIPLICITY: 0 = no match, 1 = a plain
// match, N = a `perCount` pattern's instance count (dragon triplets, seat
// flowers). The aggregator multiplies it by the EFFECTIVE faan — `hkFaan` by
// default, or a ruleset's per-pattern override — so values are retunable
// without touching these bodies. `limit` patterns return 1 to flag that the
// hand pays the cap. Each entry also carries its MCR equivalent
// (`mcrPoints`, `mcrRef`) for the additive mode, and `defaultEnabled` (the HK
// Standard on/off baseline; new MCR-only patterns will be added with false).

const PATTERNS = [
  // Situational (whole-hand state). `ctxOnly` patterns read only the context,
  // never the decomposition, so the special-hand scorers can reuse them.
  { id: 'self-draw', name: 'Self-Draw', cn: '自摸', ctxOnly: true,
    hkFaan: 1, mcrPoints: 1, mcrRef: 79, defaultEnabled: true,
    evaluate: c => (c.selfDraw ? 1 : 0) },
  { id: 'concealed', name: 'Concealed Hand', cn: '門前清',
    hkFaan: 1, mcrPoints: 2, mcrRef: 61, defaultEnabled: true, excludes: ['fully-concealed-hand'],
    evaluate: (c, d) => (d.sets.every(s => s.concealed) ? 1 : 0) },

  // Set-shape patterns
  { id: 'all-chows', name: 'All Sequences', cn: '平糊',
    hkFaan: 1, mcrPoints: 2, mcrRef: 62, defaultEnabled: true,
    evaluate: (c, d) => (d.sets.every(s => s.kind === 'chow') && !isValuePair(d, c) ? 1 : 0) },
  { id: 'all-pungs', name: 'All Triplets', cn: '對對糊',
    hkFaan: 3, mcrPoints: 6, mcrRef: 48, defaultEnabled: true,
    evaluate: (c, d) => (d.sets.every(s => s.kind === 'pung') ? 1 : 0) },
  { id: 'pure-straight', name: 'Pure Straight', cn: '清龍',
    hkFaan: 1, mcrPoints: 16, mcrRef: 28, defaultEnabled: true,
    implies: ['short-straight', 'two-terminal-chows'], // 清龍 contains 連六 and 老少副 (MCR no-repeat)
    evaluate: (c, d) => (hasPureStraight(d) ? 1 : 0) },

  // Honour triplets (役牌). A wind that is both seat and round scores twice.
  // `additive` honour yakuhai: HK counts each on top of any named hand it forms
  // part of, so the HK non-repeat pass never absorbs them (e.g. 小三元 keeps its
  // 三元牌). MCR's stricter absorption still folds them in.
  { id: 'dragon-pung', name: 'Dragon Triplet', cn: '三元牌', perCount: true,
    hkFaan: 1, mcrPoints: 2, mcrRef: 58, defaultEnabled: true, additive: true,
    evaluate: (c, d) => dragonPungCount(d) },
  { id: 'seat-wind', name: 'Seat Wind', cn: '門風',
    hkFaan: 1, mcrPoints: 2, mcrRef: 60, defaultEnabled: true, additive: true,
    evaluate: (c, d) => (pungs(d).some(s => s.tiles[0].suit === 'wind' && s.tiles[0].value === c.seatWind) ? 1 : 0) },
  { id: 'round-wind', name: 'Round Wind', cn: '圈風',
    hkFaan: 1, mcrPoints: 2, mcrRef: 59, defaultEnabled: true, additive: true,
    evaluate: (c, d) => (pungs(d).some(s => s.tiles[0].suit === 'wind' && s.tiles[0].value === c.roundWind) ? 1 : 0) },

  // Flushes
  { id: 'half-flush', name: 'Half Flush', cn: '混一色',
    hkFaan: 3, mcrPoints: 6, mcrRef: 49, defaultEnabled: true,
    evaluate: (c, d) => (suitsOf(d).size === 1 && hasHonor(d) ? 1 : 0) },
  { id: 'full-flush', name: 'Full Flush', cn: '清一色',
    hkFaan: 7, mcrPoints: 24, mcrRef: 22, defaultEnabled: true, implies: ['no-honors'],
    evaluate: (c, d) => (suitsOf(d).size === 1 && !hasHonor(d) ? 1 : 0) },

  // Small three dragons sits on top of its two dragon triplets (net 5 in HK).
  { id: 'small-three-dragons', name: 'Small Three Dragons', cn: '小三元',
    hkFaan: 3, mcrPoints: 64, mcrRef: 10, defaultEnabled: true, implies: ['dragon-pung', 'two-dragon-pungs'],
    evaluate: (c, d) => (dragonPungCount(d) === 2 && d.pair[0].suit === 'dragon' ? 1 : 0) },

  // Limit hands (大牌) — each pays the cap regardless of the rest.
  { id: 'big-three-dragons', name: 'Big Three Dragons', cn: '大三元', limit: true,
    hkFaan: 13, mcrPoints: 88, mcrRef: 2, defaultEnabled: true, implies: ['dragon-pung', 'two-dragon-pungs', 'small-three-dragons'],
    evaluate: (c, d) => (dragonPungCount(d) === 3 ? 1 : 0) },
  { id: 'small-four-winds', name: 'Small Four Winds', cn: '小四喜', limit: true,
    hkFaan: 13, mcrPoints: 64, mcrRef: 9, defaultEnabled: true, implies: ['seat-wind', 'round-wind', 'big-three-winds'],
    evaluate: (c, d) => (windPungCount(d) === 3 && d.pair[0].suit === 'wind' ? 1 : 0) },
  { id: 'big-four-winds', name: 'Big Four Winds', cn: '大四喜', limit: true,
    hkFaan: 13, mcrPoints: 88, mcrRef: 1, defaultEnabled: true, implies: ['seat-wind', 'round-wind', 'big-three-winds', 'small-four-winds'],
    evaluate: (c, d) => (windPungCount(d) === 4 ? 1 : 0) },
  { id: 'all-honors', name: 'All Honours', cn: '字一色', limit: true,
    hkFaan: 13, mcrPoints: 64, mcrRef: 11, defaultEnabled: true, implies: ['all-pungs', 'all-terminals-honors'],
    evaluate: (c, d) => (allTilesOf(d).every(t => t.suit === 'wind' || t.suit === 'dragon') ? 1 : 0) },
  { id: 'all-terminals', name: 'All Terminals', cn: '清幺九', limit: true,
    hkFaan: 13, mcrPoints: 64, mcrRef: 8, defaultEnabled: true, implies: ['all-pungs', 'all-terminals-honors', 'outside-hand'], excludes: ['double-pung', 'no-honors'],
    evaluate: (c, d) => (allTilesOf(d).every(t => SUITED.has(t.suit) && (t.value === 1 || t.value === 9)) ? 1 : 0) },
  { id: 'nine-gates', name: 'Nine Gates', cn: '九蓮寶燈', limit: true,
    hkFaan: 13, mcrPoints: 88, mcrRef: 4, defaultEnabled: true, implies: ['full-flush'],
    evaluate: (c, d) => (isNineGatesDecomp(d) ? 1 : 0) },

  // Situational bonuses — wired to optional context flags.
  { id: 'kong-replacement', name: 'Win on Kong Replacement', cn: '槓上開花', ctxOnly: true,
    hkFaan: 1, mcrPoints: 8, mcrRef: 46, defaultEnabled: true,
    evaluate: c => (c.kongReplacement ? 1 : 0) },
  { id: 'robbing-kong', name: 'Robbing the Kong', cn: '搶槓', ctxOnly: true,
    hkFaan: 1, mcrPoints: 8, mcrRef: 47, defaultEnabled: true, excludes: ['fully-concealed-hand'],
    evaluate: c => (c.robbingKong ? 1 : 0) },
  { id: 'last-tile-draw', name: 'Win on Last Tile', cn: '海底撈月', ctxOnly: true,
    hkFaan: 1, mcrPoints: 8, mcrRef: 44, defaultEnabled: true, excludes: ['self-draw'],
    evaluate: c => (c.selfDraw && c.lastTile ? 1 : 0) },
  { id: 'last-tile-discard', name: 'Win on Last Discard', cn: '河底撈魚', ctxOnly: true,
    hkFaan: 1, mcrPoints: 8, mcrRef: 45, defaultEnabled: true,
    evaluate: c => (!c.selfDraw && c.lastTile ? 1 : 0) },

  // Flowers — matching the player's seat (正花), a complete set of four (一台花),
  // or all eight (八仙過海, a limit hand). MCR scores flowers individually
  // (1 pt each, handled in MCR mode), so the HK-only set/all bonuses carry
  // mcrPoints 0 here.
  { id: 'seat-flower', name: 'Seat Flower', cn: '正花', perCount: true, ctxOnly: true,
    hkFaan: 1, mcrPoints: 1, mcrRef: 80, defaultEnabled: true,
    evaluate: c => (c.flowers || []).filter(f => WINDS[(f.value - 1) % 4] === c.seatWind).length },
  { id: 'flower-set', name: 'Flower Set', cn: '一台花', perCount: true, ctxOnly: true,
    hkFaan: 1, mcrPoints: 0, mcrRef: null, defaultEnabled: true,
    evaluate: c => flowerSetCount(c.flowers) },
  { id: 'all-flowers', name: 'All Flowers', cn: '八仙過海', limit: true, ctxOnly: true,
    hkFaan: 13, mcrPoints: 0, mcrRef: null, defaultEnabled: true,
    evaluate: c => (hasAllFlowers(c.flowers) ? 1 : 0) },

  // ── MCR library (Mahjong Competition Rules) — default OFF; presets/host
  //    enable them. `structural` marks decomposition-shape fans; `implies`/
  //    `excludes` drive the MCR non-repeat rule (applied in mcr-additive mode).

  // Same-sequence / shifted chow family
  { id: 'pure-double-chow', name: 'Pure Double Chow', cn: '一般高', mcrRef: 68, structural: true,
    hkFaan: 1, mcrPoints: 1, defaultEnabled: false, perCount: true,
    evaluate: (c, d) => { const g = {}; for (const s of chows(d)) { const k = s.tiles[0].suit + chowStart(s); g[k] = (g[k] || 0) + 1; } let m = 0; for (const k in g) m += Math.floor(g[k] / 2); return m; } },
  { id: 'mixed-double-chow', name: 'Mixed Double Chow', cn: '喜相逢', mcrRef: 69, structural: true,
    hkFaan: 1, mcrPoints: 1, defaultEnabled: false, perCount: true,
    evaluate: (c, d) => { const cs = chows(d); let m = 0; for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) if (chowStart(cs[i]) === chowStart(cs[j]) && cs[i].tiles[0].suit !== cs[j].tiles[0].suit) m++; return m; } },
  { id: 'short-straight', name: 'Short Straight', cn: '連六', mcrRef: 70, structural: true,
    hkFaan: 1, mcrPoints: 1, defaultEnabled: false,
    evaluate: (c, d) => { const bs = chowStartsBySuit(d); for (const su in bs) { const a = bs[su]; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (Math.abs(a[i] - a[j]) === 3) return 1; } return 0; } },
  { id: 'two-terminal-chows', name: 'Two Terminal Chows', cn: '老少副', mcrRef: 71, structural: true,
    hkFaan: 1, mcrPoints: 1, defaultEnabled: false,
    evaluate: (c, d) => { const bs = chowStartsBySuit(d); for (const su in bs) { const set = new Set(bs[su]); if (set.has(1) && set.has(7)) return 1; } return 0; } },
  { id: 'mixed-triple-chow', name: 'Mixed Triple Chow', cn: '三色三同順', mcrRef: 41, structural: true,
    hkFaan: 2, mcrPoints: 8, defaultEnabled: false, implies: ['mixed-double-chow'],
    evaluate: (c, d) => { const by = {}; for (const s of chows(d)) (by[chowStart(s)] ??= new Set()).add(s.tiles[0].suit); return Object.values(by).some(x => x.size >= 3) ? 1 : 0; } },
  { id: 'pure-triple-chow', name: 'Pure Triple Chow', cn: '一色三同順', mcrRef: 23, structural: true,
    hkFaan: 5, mcrPoints: 24, defaultEnabled: false, implies: ['pure-double-chow'], excludes: ['pure-shifted-pungs'],
    evaluate: (c, d) => { const g = {}; for (const s of chows(d)) { const k = s.tiles[0].suit + '-' + chowStart(s); g[k] = (g[k] || 0) + 1; } return Object.values(g).some(x => x >= 3) ? 1 : 0; } },
  { id: 'quadruple-chow', name: 'Quadruple Chow', cn: '一色四同順', mcrRef: 14, structural: true,
    hkFaan: 8, mcrPoints: 48, defaultEnabled: false, implies: ['pure-triple-chow', 'pure-double-chow', 'tile-hog'],
    evaluate: (c, d) => { const g = {}; for (const s of chows(d)) { const k = s.tiles[0].suit + '-' + chowStart(s); g[k] = (g[k] || 0) + 1; } return Object.values(g).some(x => x >= 4) ? 1 : 0; } },
  { id: 'mixed-straight', name: 'Mixed Straight', cn: '花龍', mcrRef: 39, structural: true,
    hkFaan: 2, mcrPoints: 8, defaultEnabled: false,
    evaluate: (c, d) => { const cs = chows(d); for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) for (let k = j + 1; k < cs.length; k++) { const tri = [cs[i], cs[j], cs[k]]; if (new Set(tri.map(s => s.tiles[0].suit)).size !== 3) continue; const st = new Set(tri.map(chowStart)); if (st.has(1) && st.has(4) && st.has(7)) return 1; } return 0; } },
  { id: 'mixed-shifted-chows', name: 'Mixed Shifted Chows', cn: '三色三步高', mcrRef: 50, structural: true,
    hkFaan: 2, mcrPoints: 6, defaultEnabled: false,
    evaluate: (c, d) => { const cs = chows(d); for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) for (let k = j + 1; k < cs.length; k++) { const tri = [cs[i], cs[j], cs[k]]; if (new Set(tri.map(s => s.tiles[0].suit)).size !== 3) continue; const st = tri.map(chowStart).sort((a, b) => a - b); const step = st[1] - st[0]; if ((step === 1 || step === 2) && st[2] - st[1] === step) return 1; } return 0; } },
  { id: 'pure-shifted-chows', name: 'Pure Shifted Chows', cn: '一色三步高', mcrRef: 30, structural: true,
    hkFaan: 3, mcrPoints: 16, defaultEnabled: false, implies: ['short-straight'],
    evaluate: (c, d) => { const bs = chowStartsBySuit(d); for (const su in bs) { const a = [...bs[su]].sort((x, y) => x - y); for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) for (let k = j + 1; k < a.length; k++) { const d1 = a[j] - a[i], d2 = a[k] - a[j]; if (d1 === d2 && (d1 === 1 || d1 === 2)) return 1; } } return 0; } },
  { id: 'four-pure-shifted-chows', name: 'Four Pure Shifted Chows', cn: '一色四步高', mcrRef: 16, structural: true,
    hkFaan: 6, mcrPoints: 32, defaultEnabled: false, implies: ['pure-shifted-chows'],
    evaluate: (c, d) => { const cs = chows(d); if (cs.length !== 4) return 0; if (new Set(cs.map(s => s.tiles[0].suit)).size !== 1) return 0; const a = cs.map(chowStart).sort((x, y) => x - y); const d1 = a[1] - a[0]; if (d1 !== 1 && d1 !== 2) return 0; return (a[2] - a[1] === d1 && a[3] - a[2] === d1) ? 1 : 0; } },

  // Pung-shape family
  { id: 'double-pung', name: 'Double Pung', cn: '雙同刻', mcrRef: 64, structural: true,
    hkFaan: 1, mcrPoints: 2, defaultEnabled: false, perCount: true,
    evaluate: (c, d) => { const ps = suitedPungs(d); let m = 0; for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) if (ps[i].tiles[0].value === ps[j].tiles[0].value && ps[i].tiles[0].suit !== ps[j].tiles[0].suit) m++; return m; } },
  { id: 'triple-pung', name: 'Triple Pung', cn: '三同刻', mcrRef: 32, structural: true,
    hkFaan: 3, mcrPoints: 16, defaultEnabled: false, implies: ['double-pung'],
    evaluate: (c, d) => { const by = {}; for (const s of suitedPungs(d)) (by[s.tiles[0].value] ??= new Set()).add(s.tiles[0].suit); return Object.values(by).some(x => x.size >= 3) ? 1 : 0; } },
  { id: 'mixed-shifted-pungs', name: 'Mixed Shifted Pungs', cn: '三色三節高', mcrRef: 42, structural: true,
    hkFaan: 2, mcrPoints: 8, defaultEnabled: false,
    evaluate: (c, d) => { const ps = suitedPungs(d); for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) for (let k = j + 1; k < ps.length; k++) { const tri = [ps[i], ps[j], ps[k]]; if (new Set(tri.map(s => s.tiles[0].suit)).size !== 3) continue; const r = tri.map(s => s.tiles[0].value).sort((a, b) => a - b); if (r[1] - r[0] === 1 && r[2] - r[1] === 1) return 1; } return 0; } },
  { id: 'pure-shifted-pungs', name: 'Pure Shifted Pungs', cn: '一色三節高', mcrRef: 24, structural: true,
    hkFaan: 5, mcrPoints: 24, defaultEnabled: false,
    evaluate: (c, d) => { const pr = pungRanksBySuit(d); for (const su in pr) { const r = [...pr[su]].sort((a, b) => a - b); for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) for (let k = j + 1; k < r.length; k++) if (r[j] - r[i] === 1 && r[k] - r[j] === 1) return 1; } return 0; } },
  { id: 'four-pure-shifted-pungs', name: 'Four Pure Shifted Pungs', cn: '一色四節高', mcrRef: 15, structural: true,
    hkFaan: 8, mcrPoints: 48, defaultEnabled: false, implies: ['pure-shifted-pungs'],
    evaluate: (c, d) => { const ps = suitedPungs(d); if (ps.length !== 4) return 0; if (new Set(ps.map(s => s.tiles[0].suit)).size !== 1) return 0; const r = ps.map(s => s.tiles[0].value).sort((a, b) => a - b); return (r[1] - r[0] === 1 && r[2] - r[1] === 1 && r[3] - r[2] === 1) ? 1 : 0; } },
  { id: 'two-dragon-pungs', name: 'Two Dragon Pungs', cn: '雙箭刻', mcrRef: 53, structural: true,
    hkFaan: 2, mcrPoints: 6, defaultEnabled: false, implies: ['dragon-pung'],
    evaluate: (c, d) => (dragonPungCount(d) === 2 ? 1 : 0) },
  { id: 'big-three-winds', name: 'Big Three Winds', cn: '三風刻', mcrRef: 38, structural: true,
    hkFaan: 3, mcrPoints: 12, defaultEnabled: false,
    evaluate: (c, d) => (windPungCount(d) === 3 ? 1 : 0) },
  { id: 'pung-terminals-honors', name: 'Pung of Terminals or Honours', cn: '幺九刻', mcrRef: 72, structural: true,
    hkFaan: 1, mcrPoints: 1, defaultEnabled: false, perCount: true,
    evaluate: (c, d) => { let m = 0; for (const s of pungs(d)) { const t = s.tiles[0]; if (isTerminal(t) || isHonorTile(t)) m++; } return m; } },

  // Concealment & kong family
  { id: 'two-concealed-pungs', name: 'Two Concealed Pungs', cn: '雙暗刻', mcrRef: 65, structural: true,
    hkFaan: 1, mcrPoints: 2, defaultEnabled: false,
    evaluate: (c, d) => (concealedPungCount(d) === 2 ? 1 : 0) },
  { id: 'three-concealed-pungs', name: 'Three Concealed Pungs', cn: '三暗刻', mcrRef: 33, structural: true,
    hkFaan: 3, mcrPoints: 16, defaultEnabled: false, implies: ['two-concealed-pungs'],
    evaluate: (c, d) => (concealedPungCount(d) === 3 ? 1 : 0) },
  { id: 'four-concealed-pungs', name: 'Four Concealed Pungs', cn: '四暗刻', mcrRef: 12, structural: true, limit: true,
    hkFaan: 13, mcrPoints: 64, defaultEnabled: false, implies: ['three-concealed-pungs', 'all-pungs'],
    evaluate: (c, d) => (concealedPungCount(d) === 4 ? 1 : 0) },
  { id: 'concealed-kong', name: 'Concealed Kong', cn: '暗槓', mcrRef: 66, structural: true,
    hkFaan: 1, mcrPoints: 2, defaultEnabled: false,
    evaluate: (c, d) => (kongCounts(d).concealed === 1 ? 1 : 0) },
  { id: 'two-concealed-kongs', name: 'Two Concealed Kongs', cn: '雙暗槓', mcrRef: 42, structural: true,
    hkFaan: 2, mcrPoints: 8, defaultEnabled: false,
    evaluate: (c, d) => (kongCounts(d).concealed === 2 ? 1 : 0) },
  { id: 'melded-kong', name: 'Melded Kong', cn: '明槓', mcrRef: 73, structural: true,
    hkFaan: 1, mcrPoints: 1, defaultEnabled: false,
    evaluate: (c, d) => (kongCounts(d).melded === 1 ? 1 : 0) },
  { id: 'two-melded-kongs', name: 'Two Melded Kongs', cn: '雙明槓', mcrRef: 56, structural: true,
    hkFaan: 1, mcrPoints: 4, defaultEnabled: false,
    evaluate: (c, d) => (kongCounts(d).melded === 2 ? 1 : 0) },
  { id: 'three-kongs', name: 'Three Kongs', cn: '三槓', mcrRef: 17, structural: true,
    hkFaan: 6, mcrPoints: 32, defaultEnabled: false,
    implies: ['melded-kong', 'two-melded-kongs', 'concealed-kong', 'two-concealed-kongs'],
    evaluate: (c, d) => (kongCounts(d).total === 3 ? 1 : 0) },
  { id: 'four-kongs', name: 'Four Kongs', cn: '四槓', mcrRef: 5, structural: true, limit: true,
    hkFaan: 13, mcrPoints: 88, defaultEnabled: false,
    implies: ['three-kongs', 'melded-kong', 'two-melded-kongs', 'concealed-kong', 'two-concealed-kongs'],
    evaluate: (c, d) => (kongCounts(d).total === 4 ? 1 : 0) },
  { id: 'tile-hog', name: 'Tile Hog', cn: '四歸一', mcrRef: 63, structural: true,
    hkFaan: 1, mcrPoints: 2, defaultEnabled: false,
    evaluate: (c, d) => { const counts = {}; for (const t of allTilesOf(d)) { if (!SUITED.has(t.suit)) continue; const k = t.suit + '-' + t.value; counts[k] = (counts[k] || 0) + 1; } const kongKeys = new Set(d.sets.filter(s => s.isKong).map(s => s.tiles[0].suit + '-' + s.tiles[0].value)); for (const k in counts) if (counts[k] === 4 && !kongKeys.has(k)) return 1; return 0; } },
  { id: 'fully-concealed-hand', name: 'Fully Concealed Hand', cn: '不求人', mcrRef: 55,
    hkFaan: 1, mcrPoints: 4, defaultEnabled: false,
    evaluate: (c, d) => (c.selfDraw && d.sets.every(s => s.concealed) ? 1 : 0) },

  // Band / suit-set family
  { id: 'all-simples', name: 'All Simples', cn: '斷幺', mcrRef: 67, structural: true,
    hkFaan: 1, mcrPoints: 2, defaultEnabled: false,
    evaluate: (c, d) => (allTilesOf(d).every(t => SUITED.has(t.suit) && t.value >= 2 && t.value <= 8) ? 1 : 0) },
  { id: 'no-honors', name: 'No Honours', cn: '無字', mcrRef: 75, structural: true,
    hkFaan: 1, mcrPoints: 1, defaultEnabled: false,
    evaluate: (c, d) => (hasHonor(d) ? 0 : 1) },
  { id: 'one-voided-suit', name: 'One Voided Suit', cn: '缺一門', mcrRef: 74, structural: true,
    hkFaan: 1, mcrPoints: 1, defaultEnabled: false,
    evaluate: (c, d) => (suitsOf(d).size === 2 ? 1 : 0) },
  { id: 'all-types', name: 'All Types', cn: '五門齊', mcrRef: 51, structural: true,
    hkFaan: 2, mcrPoints: 6, defaultEnabled: false,
    evaluate: (c, d) => { const cats = new Set(allTilesOf(d).map(t => t.suit)); return ['man', 'pin', 'bam', 'wind', 'dragon'].every(s => cats.has(s)) ? 1 : 0; } },
  { id: 'reversible-tiles', name: 'Reversible Tiles', cn: '推不倒', mcrRef: 40, structural: true,
    hkFaan: 2, mcrPoints: 8, defaultEnabled: false,
    evaluate: (c, d) => (allTilesOf(d).every(isReversibleTile) ? 1 : 0) },
  { id: 'outside-hand', name: 'Outside Hand', cn: '全帶幺', mcrRef: 54, structural: true,
    hkFaan: 2, mcrPoints: 4, defaultEnabled: false,
    evaluate: (c, d) => (everyGroup(d, groupHasTerminalOrHonor) ? 1 : 0) },
  { id: 'all-fives', name: 'All Fives', cn: '全帶五', mcrRef: 31, structural: true,
    hkFaan: 4, mcrPoints: 16, defaultEnabled: false,
    evaluate: (c, d) => (everyGroup(d, tiles => groupHasValue(tiles, 5)) ? 1 : 0) },
  { id: 'all-even-pungs', name: 'All Even Pungs', cn: '全雙刻', mcrRef: 21, structural: true,
    hkFaan: 5, mcrPoints: 24, defaultEnabled: false, implies: ['all-pungs', 'all-simples'],
    evaluate: (c, d) => { if (!d.sets.every(s => s.kind === 'pung')) return 0; return everyGroup(d, tiles => tiles.every(t => SUITED.has(t.suit) && t.value % 2 === 0)) ? 1 : 0; } },
  { id: 'upper-tiles', name: 'Upper Tiles', cn: '全大', mcrRef: 25, structural: true,
    hkFaan: 5, mcrPoints: 24, defaultEnabled: false, implies: ['no-honors'],
    evaluate: (c, d) => (allInBand(d, 7, 9) ? 1 : 0) },
  { id: 'middle-tiles', name: 'Middle Tiles', cn: '全中', mcrRef: 26, structural: true,
    hkFaan: 5, mcrPoints: 24, defaultEnabled: false, implies: ['no-honors', 'all-simples'],
    evaluate: (c, d) => (allInBand(d, 4, 6) ? 1 : 0) },
  { id: 'lower-tiles', name: 'Lower Tiles', cn: '全小', mcrRef: 27, structural: true,
    hkFaan: 5, mcrPoints: 24, defaultEnabled: false, implies: ['no-honors'],
    evaluate: (c, d) => (allInBand(d, 1, 3) ? 1 : 0) },
  { id: 'upper-four', name: 'Upper Four', cn: '大於五', mcrRef: 36, structural: true,
    hkFaan: 3, mcrPoints: 12, defaultEnabled: false, implies: ['no-honors'],
    evaluate: (c, d) => (allInBand(d, 6, 9) ? 1 : 0) },
  { id: 'lower-four', name: 'Lower Four', cn: '小於五', mcrRef: 37, structural: true,
    hkFaan: 3, mcrPoints: 12, defaultEnabled: false, implies: ['no-honors'],
    evaluate: (c, d) => (allInBand(d, 1, 4) ? 1 : 0) },
  { id: 'all-terminals-honors', name: 'All Terminals and Honours', cn: '混幺九', mcrRef: 18, structural: true,
    hkFaan: 6, mcrPoints: 32, defaultEnabled: false, implies: ['all-pungs', 'pung-terminals-honors'],
    evaluate: (c, d) => (allTilesOf(d).every(t => isTerminal(t) || isHonorTile(t)) ? 1 : 0) },
  { id: 'pure-terminal-chows', name: 'Pure Terminal Chows', cn: '一色雙龍會', mcrRef: 13, structural: true,
    hkFaan: 10, mcrPoints: 64, defaultEnabled: false,
    evaluate: (c, d) => { const cs = chows(d); if (cs.length !== 4) return 0; if (new Set(allTilesOf(d).map(t => t.suit)).size !== 1) return 0; if (!SUITED.has(d.pair[0].suit) || d.pair[0].value !== 5) return 0; const a = cs.map(chowStart).sort((x, y) => x - y); return (a[0] === 1 && a[1] === 1 && a[2] === 7 && a[3] === 7) ? 1 : 0; } },
  { id: 'three-suited-terminal-chows', name: 'Three-Suited Terminal Chows', cn: '三色雙龍會', mcrRef: 29, structural: true,
    hkFaan: 4, mcrPoints: 16, defaultEnabled: false,
    evaluate: (c, d) => { const cs = chows(d); if (cs.length !== 4) return 0; if (!SUITED.has(d.pair[0].suit) || d.pair[0].value !== 5) return 0; const bs = chowStartsBySuit(d); const with17 = Object.keys(bs).filter(su => { const set = new Set(bs[su]); return set.has(1) && set.has(7) && bs[su].length === 2; }); return (with17.length === 2 && !with17.includes(d.pair[0].suit)) ? 1 : 0; } },

  // Wait-shape / last-of-kind / melded-hand bonuses — read flags the server
  // computes at the winning moment (`needs` documents the extra tracking). The
  // wait fans require a SOLE wait; MCR suppresses them on the irregular hands,
  // which is automatic here since those are scored out-of-band.
  { id: 'edge-wait', name: 'Edge Wait', cn: '邊張', mcrRef: 76, ctxOnly: true, needs: 'wait',
    hkFaan: 1, mcrPoints: 1, defaultEnabled: false,
    evaluate: c => (c.wait && c.wait.single && c.wait.shape === 'edge' ? 1 : 0) },
  { id: 'closed-wait', name: 'Closed Wait', cn: '坎張', mcrRef: 77, ctxOnly: true, needs: 'wait',
    hkFaan: 1, mcrPoints: 1, defaultEnabled: false,
    evaluate: c => (c.wait && c.wait.single && c.wait.shape === 'closed' ? 1 : 0) },
  { id: 'pair-wait', name: 'Single Wait', cn: '單釣將', mcrRef: 78, ctxOnly: true, needs: 'wait',
    hkFaan: 1, mcrPoints: 1, defaultEnabled: false,
    evaluate: c => (c.wait && c.wait.single && c.wait.shape === 'pair' ? 1 : 0) },
  { id: 'last-of-kind', name: 'Last Tile', cn: '和絕張', mcrRef: 57, ctxOnly: true, needs: 'last-of-kind',
    hkFaan: 2, mcrPoints: 4, defaultEnabled: false,
    evaluate: c => (c.lastOfKind ? 1 : 0) },
  { id: 'melded-hand', name: 'Melded Hand', cn: '全求人', mcrRef: 52, ctxOnly: true, needs: 'melded-hand',
    hkFaan: 2, mcrPoints: 6, defaultEnabled: false,
    evaluate: c => (c.meldedHand ? 1 : 0) },

  // Limit-class additions not in the HK engine
  { id: 'all-green', name: 'All Green', cn: '綠一色', mcrRef: 3, limit: true,
    hkFaan: 13, mcrPoints: 88, defaultEnabled: false, excludes: ['half-flush'],
    evaluate: (c, d) => (allTilesOf(d).every(isGreenTile) ? 1 : 0) },
];

// ── Ruleset-aware pattern value/enabled lookup ────────────────────────────────
// A ruleset may override a pattern's faan/points or disable it. Legacy callers
// pass the old cfg (no `.patterns`), so these fall back to the library defaults.
// The *-ById variants let the special-hand scorers (seven pairs, thirteen
// orphans) honour the same overrides as the decomposition path.
function overrideById(id, ruleset) {
  return ruleset && ruleset.patterns ? ruleset.patterns[id] : undefined;
}
function isEnabledId(id, ruleset, dflt = true) {
  const o = overrideById(id, ruleset);
  if (o && typeof o.enabled === 'boolean') return o.enabled;
  return dflt;
}
function effFaanId(id, ruleset, fallback) {
  const o = overrideById(id, ruleset);
  if (o && o.faan != null) return o.faan;
  const p = PATTERNS.find(x => x.id === id);
  return p ? p.hkFaan : fallback;
}
function effFaan(p, ruleset) {
  const o = overrideById(p.id, ruleset);
  return o && o.faan != null ? o.faan : p.hkFaan;
}
function effPoints(p, ruleset) {
  const o = overrideById(p.id, ruleset);
  return o && o.points != null ? o.points : p.mcrPoints;
}
function effPointsId(id, ruleset, fallback) {
  const o = overrideById(id, ruleset);
  if (o && o.points != null) return o.points;
  const p = PATTERNS.find(x => x.id === id);
  return p ? p.mcrPoints : fallback;
}
function isEnabled(p, ruleset) {
  return isEnabledId(p.id, ruleset, p.defaultEnabled !== false);
}

// ── Scoring ──────────────────────────────────────────────────────────────────

function faanToPoints(faan, cfg) {
  return cfg.basePoints * Math.pow(2, Math.min(faan, cfg.limitFaan));
}

function resolveMode(ruleset) {
  return ruleset && ruleset.mode ? ruleset.mode : 'hk-doubling';
}

// Map a faan total into a grouped-mode tier and its doubled points. The tier
// breakpoints are ascending faan ceilings; anything above the last one (and any
// limit hand) lands in the top tier, which is the cap.
function groupedPayout(faan, isLimit, ruleset, cfg) {
  const g = (ruleset && ruleset.grouped) || {};
  const breakpoints = Array.isArray(g.breakpoints) && g.breakpoints.length ? g.breakpoints : [3, 5, 8, 11];
  const base = g.basePoints != null ? g.basePoints : cfg.basePoints;
  const topTier = breakpoints.length + 1;
  let tier = topTier;
  if (!isLimit) {
    for (let i = 0; i < breakpoints.length; i++) {
      if (faan <= breakpoints[i]) { tier = i + 1; break; }
    }
  }
  return { tier, points: base * Math.pow(2, tier) };
}

// Turn a capped faan total into the mode's payout descriptor { points, tier }.
function payoutFor(mode, faan, isLimit, ruleset, cfg) {
  if (mode === 'hk-grouped') return groupedPayout(faan, isLimit, ruleset, cfg);
  return { points: faanToPoints(faan, cfg), tier: undefined };
}

// Score one decomposition against every enabled pattern (HK faan fold).
function scoreDecomposition(ctx, d, cfg, ruleset) {
  const matched = [];
  let isLimit = false;

  for (const p of PATTERNS) {
    if (!isEnabled(p, ruleset)) continue;
    const m = p.evaluate(ctx, d);
    if (!m) continue;
    if (p.limit) {
      isLimit = true; // the total is set to the cap below (limit hands never stack)
      matched.push({ id: p.id, name: p.name, cn: p.cn, p, limit: true });
    } else {
      const contributed = (p.perCount ? m : 1) * effFaan(p, ruleset);
      if (contributed === 0) continue; // a pattern retuned to 0 contributes nothing and shows no row
      matched.push({ id: p.id, name: p.name, cn: p.cn, p, m, faan: contributed });
    }
  }

  // HK non-repeat ("suppress redundant fans only"): a fan that is (transitively)
  // implied by, or hard-excluded by, another present fan is absorbed — EXCEPT the
  // additive honour yakuhai (三元牌/門風/圈風), which stack on top in HK. Limit
  // hands pay the cap regardless, so the fold is skipped there.
  if (!isLimit) applyNonRepeat(matched, { keepAdditive: true, impliesOnly: true });

  const breakdown = [];
  let faan = 0;
  for (const e of matched) {
    if (e.dropped) continue;
    if (e.limit) { breakdown.push({ id: e.id, name: e.name, cn: e.cn, limit: true }); continue; }
    faan += e.faan;
    breakdown.push({ id: e.id, name: e.name, cn: e.cn, faan: e.faan, count: e.p.perCount && e.m > 1 ? e.m : undefined });
  }
  // A limit hand is worth exactly the cap regardless of how many limit patterns it matches.
  if (isLimit) faan = cfg.limitFaan;
  return { faan, isLimit, breakdown };
}

// Context-only patterns (read just ctx, not a decomposition) are reused by the
// special-hand scorers below.
const CONTEXT_PATTERNS = PATTERNS.filter(p => p.ctxOnly);

// The concealment fans (門前清 / 不求人) for an always-concealed special hand
// (七對 / 十三幺 / knitted are scored with melds.length === 0, so the hand is fully
// concealed). The decomposition path awards these via PATTERNS, but the special-hand
// scorers bypass it. The two patterns exclude each other, so only the higher-valued
// applies: 不求人 on a self-draw, else 門前清. Honours the same enable/override gates.
function concealmentFan(ctx, ruleset, valFn) {
  const concealedHand = { sets: [{ concealed: true }] }; // special hands are fully concealed
  const out = [];
  for (const id of ['concealed', 'fully-concealed-hand']) {
    const p = PATTERNS.find(x => x.id === id);
    if (p && isEnabled(p, ruleset) && p.evaluate(ctx, concealedHand)) out.push({ p, v: valFn(p, ruleset) });
  }
  if (!out.length) return null;
  out.sort((a, b) => b.v - a.v); // the exclusion keeps the higher-valued side
  const w = out[0];
  return { id: w.p.id, name: w.p.name, cn: w.p.cn, value: w.v };
}

// Fold the situational context fans (自摸, 海底/河底, 槓上開花, 搶槓, flowers …)
// onto a special-hand base so the out-of-band scorers (七對 / 十三幺 / knitted)
// award them just like the decomposition path. HK variant adds faan (a limit
// context fan caps the hand); MCR variant adds points and excludes the flower
// patterns, which scoreWinMcr already scores separately (花牌, 1 pt each).
function addContextFaan(base, ctx, cfg, ruleset) {
  let faan = base.faan;
  const breakdown = base.breakdown.slice();
  for (const p of CONTEXT_PATTERNS) {
    if (!isEnabled(p, ruleset)) continue;
    const m = p.evaluate(ctx, null);
    if (!m) continue;
    if (p.limit) return { faan: cfg.limitFaan, isLimit: true, breakdown: [...breakdown, { id: p.id, name: p.name, cn: p.cn, limit: true }] };
    const contributed = (p.perCount ? m : 1) * effFaan(p, ruleset);
    if (!contributed) continue;
    faan += contributed;
    breakdown.push({ id: p.id, name: p.name, cn: p.cn, faan: contributed, count: p.perCount && m > 1 ? m : undefined });
  }
  const cf = concealmentFan(ctx, ruleset, effFaan);
  if (cf && cf.value) { faan += cf.value; breakdown.push({ id: cf.id, name: cf.name, cn: cf.cn, faan: cf.value }); }
  return { faan, isLimit: false, breakdown };
}
function addContextMcr(base, ctx, ruleset) {
  let value = base.value;
  const breakdown = base.breakdown.slice();
  for (const p of CONTEXT_PATTERNS) {
    if (MCR_FLOWER_PATTERN_IDS.has(p.id)) continue;
    if (!isEnabled(p, ruleset)) continue;
    const m = p.evaluate(ctx, null);
    if (!m) continue;
    const pts = (p.perCount ? m : 1) * effPoints(p, ruleset);
    if (!pts) continue;
    value += pts;
    breakdown.push({ id: p.id, name: p.name, cn: p.cn, points: pts, count: p.perCount && m > 1 ? m : undefined });
  }
  const cf = concealmentFan(ctx, ruleset, effPoints);
  if (cf && cf.value) { value += cf.value; breakdown.push({ id: cf.id, name: cf.name, cn: cf.cn, points: cf.value }); }
  return { value, breakdown };
}

// 十三幺 — a limit hand by default, but honour a per-pattern HK faan override (like
// the seven-pairs / knitted scorers do). When overridden below the cap it stops being
// a limit hand and folds the situational + concealment fans like the other specials.
function scoreThirteenOrphans(cfg, ruleset, ctx) {
  const faan = effFaanId('thirteen-orphans', ruleset, cfg.limitFaan);
  const isLimit = faan >= cfg.limitFaan;
  const capped = Math.min(faan, cfg.limitFaan);
  const entry = isLimit
    ? { id: 'thirteen-orphans', name: 'Thirteen Orphans', cn: '十三幺', limit: true }
    : { id: 'thirteen-orphans', name: 'Thirteen Orphans', cn: '十三幺', faan: capped };
  const base = { faan: capped, isLimit, breakdown: [entry] };
  return isLimit ? base : addContextFaan(base, ctx, cfg, ruleset);
}

// 七對 — fixed 4 faan, stacking with a flush and the context bonuses. Seven
// honour pairs is 字一色 (all honours), a limit hand.
function scoreSevenPairs(ctx, tiles, cfg, ruleset) {
  const sevenPairsFaan = effFaanId('seven-pairs', ruleset, SEVEN_PAIRS_FAAN);
  // Seven honour pairs is 字一色 (all honours), a limit hand — unless the host
  // has disabled All Honours, in which case it scores as plain seven pairs.
  if (tiles.every(t => t.suit === 'wind' || t.suit === 'dragon') && isEnabledId('all-honors', ruleset)) {
    return { faan: cfg.limitFaan, isLimit: true, breakdown: [
      { id: 'seven-pairs', name: 'Seven Pairs', cn: '七對', faan: sevenPairsFaan },
      { id: 'all-honors', name: 'All Honours', cn: '字一色', limit: true },
    ] };
  }
  let faan = sevenPairsFaan;
  const breakdown = [{ id: 'seven-pairs', name: 'Seven Pairs', cn: '七對', faan: sevenPairsFaan }];
  const suits = new Set(tiles.filter(t => SUITED.has(t.suit)).map(t => t.suit));
  const honor = tiles.some(t => t.suit === 'wind' || t.suit === 'dragon');
  // Route the flush bonus through the same overrides the decomposition path uses.
  if (suits.size === 1 && !honor && isEnabledId('full-flush', ruleset)) {
    const f = effFaanId('full-flush', ruleset, 7);
    if (f) { faan += f; breakdown.push({ id: 'full-flush', name: 'Full Flush', cn: '清一色', faan: f }); }
  } else if (suits.size === 1 && honor && isEnabledId('half-flush', ruleset)) {
    const f = effFaanId('half-flush', ruleset, 3);
    if (f) { faan += f; breakdown.push({ id: 'half-flush', name: 'Half Flush', cn: '混一色', faan: f }); }
  }
  // Fold the situational + concealment fans (七對 is always fully concealed).
  return addContextFaan({ faan, isLimit: false, breakdown }, ctx, cfg, ruleset);
}

// A scoreWin/computePayments caller may pass either a full ruleset (carrying a
// `.mode`) or the legacy {minFaan,limitFaan,basePoints} cfg. Normalise to the
// legacy cfg the existing HK-doubling code paths expect. The grouped/MCR modes
// are layered on in later increments; until then every mode resolves to its hk
// params so behaviour is unchanged.
function resolveCfg(ruleset) {
  if (!ruleset || typeof ruleset !== 'object') return DEFAULT_SCORING;
  if (ruleset.mode) {
    const hk = ruleset.hk || {};
    return {
      minFaan: hk.minFaan ?? DEFAULT_SCORING.minFaan,
      limitFaan: hk.limitFaan ?? DEFAULT_SCORING.limitFaan,
      basePoints: hk.basePoints ?? DEFAULT_SCORING.basePoints,
    };
  }
  // Legacy {minFaan,limitFaan,basePoints} shape — fill any missing field so a
  // partial cfg can never produce NaN payouts.
  return {
    minFaan: ruleset.minFaan ?? DEFAULT_SCORING.minFaan,
    limitFaan: ruleset.limitFaan ?? DEFAULT_SCORING.limitFaan,
    basePoints: ruleset.basePoints ?? DEFAULT_SCORING.basePoints,
  };
}

// ── Knitted special hands (組合龍 / 全不靠 / 七星不靠) ─────────────────────────
// These aren't 4-sets+pair, so they're scored out-of-band like seven pairs /
// thirteen orphans. They are only scored when the ruleset's `allow` flags permit
// the corresponding shape (the same gate checkWin uses for win legality).
const KNITTED_INFO = {
  greater: { id: 'greater-knitted', name: 'Greater Honours & Knitted', cn: '七星不靠', hkFaan: 10, mcrPoints: 24 },
  'knitted-straight': { id: 'knitted-straight', name: 'Knitted Straight', cn: '組合龍', hkFaan: 6, mcrPoints: 12 },
  lesser: { id: 'lesser-knitted', name: 'Lesser Honours & Knitted', cn: '全不靠', hkFaan: 6, mcrPoints: 12 },
};
function knittedAllowed(kind, ruleset) {
  const a = ruleset && ruleset.allow;
  if (!a) return false;
  if (kind === 'greater') return a.greaterKnitted === true;
  if (kind === 'lesser') return a.lesserKnitted === true;
  if (kind === 'knitted-straight') return a.knittedStraight === true;
  return false;
}
function scoreKnittedHk(kind, cfg, ruleset, ctx) {
  const info = KNITTED_INFO[kind];
  const faan = ruleset?.patterns?.[info.id]?.faan ?? info.hkFaan;
  const capped = Math.min(faan, cfg.limitFaan);
  const base = { faan: capped, isLimit: faan >= cfg.limitFaan, breakdown: [{ id: info.id, name: info.name, cn: info.cn, faan: capped }] };
  return base.isLimit ? base : addContextFaan(base, ctx, cfg, ruleset);
}
function scoreKnittedMcr(kind, ctx, ruleset) {
  const info = KNITTED_INFO[kind];
  const pts = ruleset?.patterns?.[info.id]?.points ?? info.mcrPoints;
  return addContextMcr({ value: pts, breakdown: [{ id: info.id, name: info.name, cn: info.cn, points: pts }] }, ctx, ruleset);
}

// ── Wait-shape analysis ──────────────────────────────────────────────────────
// Used by the server to populate ctx.wait for the edge/closed/single wait fans.
const ALL_TILE_TYPES = (() => {
  const out = [];
  for (const s of ['man', 'pin', 'bam']) for (let v = 1; v <= 9; v++) out.push({ suit: s, value: v });
  for (const v of ['east', 'south', 'west', 'north']) out.push({ suit: 'wind', value: v });
  for (const v of ['red', 'green', 'white']) out.push({ suit: 'dragon', value: v });
  return out;
})();

function waitingTiles(hand13, melds, ruleset) {
  const out = [];
  for (const tt of ALL_TILE_TYPES) {
    if (checkWin([...hand13, { suit: tt.suit, value: tt.value, id: -1 }], melds, ruleset)) out.push(tt);
  }
  return out;
}

function shapeOfWinningTile(dc, winningTile) {
  if (dc.pair.some(t => t.id === winningTile.id)) return 'pair';
  for (const s of dc.sets) {
    if (!s.tiles.some(t => t.id === winningTile.id)) continue;
    if (s.kind !== 'chow') return null; // completing a pung has no MCR wait-shape bonus
    const vals = s.tiles.map(t => t.value).sort((a, b) => a - b);
    const wv = winningTile.value;
    if (wv === vals[1]) return 'closed';                 // middle of a chow
    if (wv === vals[2] && vals[0] === 1) return 'edge';  // 1-2-_3_
    if (wv === vals[0] && vals[2] === 9) return 'edge';  // _7_-8-9
    return null;                                          // open (two-sided) end
  }
  return null;
}

// Was the win a SOLE wait, and what shape did the winning tile complete?
// hand13 = the concealed tiles BEFORE the winning tile; winningTile is the
// completing tile (carrying its real id, already part of scoreWin's hand).
function analyzeWait(hand13, melds, winningTile, ruleset) {
  melds = melds || [];
  if (waitingTiles(hand13, melds, ruleset).length !== 1) return { single: false, shape: null };
  const full = sortTiles([...hand13, winningTile].filter(t => t.suit !== 'flower'));
  for (const dc of decompose(full, 4 - melds.length)) {
    const shape = shapeOfWinningTile(dc, winningTile);
    if (shape) return { single: true, shape };
  }
  return { single: true, shape: null };
}

// ── MCR additive mode ─────────────────────────────────────────────────────────
// Flowers are scored individually (1 pt each) in MCR, not via the HK seat/set
// bonuses, so the HK flower patterns are excluded from the additive fold.
const MCR_FLOWER_PATTERN_IDS = new Set(['seat-flower', 'flower-set', 'all-flowers']);

// Static implication graph (id → directly-implied ids), built once from the
// library, so an implication chain (A⇒B⇒C) absorbs C even when B itself isn't
// part of the winning hand.
const IMPLIES_GRAPH = new Map();
for (const p of PATTERNS) if (p.implies) IMPLIES_GRAPH.set(p.id, p.implies);
function reachableImplied(startId) {
  const out = new Set();
  const stack = [...(IMPLIES_GRAPH.get(startId) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    for (const n of IMPLIES_GRAPH.get(id) || []) stack.push(n);
  }
  return out;
}

// MCR non-repeat (不重复原则): a pattern that is (transitively) implied by a
// present one is absorbed and not scored again; a hard-excluded pair keeps only
// the higher-valued side. Mutates each entry's `dropped` flag.
// opts.valueFn — the comparison value for the exclusion tie-break (MCR: points;
// HK: faan). (Named valueFn, not valueOf, to avoid colliding with the inherited
// Object.prototype.valueOf when opts is a plain {}.) opts.keepAdditive — protect
// honour yakuhai (p.additive) from being absorbed (HK rule). opts.impliesOnly —
// apply only the implication absorption, skipping the exclusion pass: HK keeps
// situational pairs additive (e.g. 海底撈月 + 自摸), whereas MCR replaces.
function applyNonRepeat(entries, opts = {}) {
  const valueFn = opts.valueFn || (e => e.pts);
  const kept = e => opts.keepAdditive && e.p && e.p.additive;
  const implied = new Set();
  for (const e of entries) for (const id of reachableImplied(e.id)) implied.add(id);
  for (const e of entries) if (implied.has(e.id) && !kept(e)) e.dropped = true;
  if (opts.impliesOnly) return;
  // Exclusion — for each conflicting pair still alive, drop the lower-valued
  // (deterministic id tie-break); never drop a protected additive yakuhai.
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    if (a.dropped) continue;
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j];
      if (b.dropped) continue;
      const conflict = (a.p.excludes && a.p.excludes.includes(b.id)) || (b.p.excludes && b.p.excludes.includes(a.id));
      if (!conflict) continue;
      const av = valueFn(a), bv = valueFn(b);
      let loser = av < bv ? a : (av > bv ? b : (a.id < b.id ? b : a));
      if (kept(loser)) loser = loser === a ? b : a; // protect additive yakuhai; drop the other side
      loser.dropped = true;
    }
  }
}

// Score one decomposition as the max legal MCR total (sum after non-repeat).
function scoreDecompositionMcr(ctx, d, ruleset) {
  const entries = [];
  for (const p of PATTERNS) {
    if (MCR_FLOWER_PATTERN_IDS.has(p.id)) continue;
    if (!isEnabled(p, ruleset)) continue;
    const m = p.evaluate(ctx, d);
    if (!m) continue;
    const pts = (p.perCount ? m : 1) * effPoints(p, ruleset);
    if (pts === 0) continue;
    entries.push({ id: p.id, name: p.name, cn: p.cn, p, m, pts });
  }
  applyNonRepeat(entries);
  let value = 0;
  const breakdown = [];
  for (const e of entries) {
    if (e.dropped) continue;
    value += e.pts;
    breakdown.push({ id: e.id, name: e.name, cn: e.cn, points: e.pts, count: e.p.perCount && e.m > 1 ? e.m : undefined });
  }
  return { value, breakdown };
}

function scoreThirteenOrphansMcr(ctx, ruleset) {
  const pts = effPointsId('thirteen-orphans', ruleset, 88);
  return addContextMcr({ value: pts, breakdown: [{ id: 'thirteen-orphans', name: 'Thirteen Orphans', cn: '十三幺', points: pts }] }, ctx, ruleset);
}

function scoreSevenPairsMcr(ctx, tiles, ruleset) {
  const sp = effPointsId('seven-pairs', ruleset, 24);
  // Seven honour pairs is 字一色 (All Honours).
  if (tiles.every(t => t.suit === 'wind' || t.suit === 'dragon') && isEnabledId('all-honors', ruleset)) {
    const ah = effPointsId('all-honors', ruleset, 64);
    return addContextMcr({ value: sp + ah, breakdown: [
      { id: 'seven-pairs', name: 'Seven Pairs', cn: '七對', points: sp },
      { id: 'all-honors', name: 'All Honours', cn: '字一色', points: ah },
    ] }, ctx, ruleset);
  }
  let value = sp;
  const breakdown = [{ id: 'seven-pairs', name: 'Seven Pairs', cn: '七對', points: sp }];
  const suits = new Set(tiles.filter(t => SUITED.has(t.suit)).map(t => t.suit));
  const honor = tiles.some(t => t.suit === 'wind' || t.suit === 'dragon');
  if (suits.size === 1 && !honor && isEnabledId('full-flush', ruleset)) {
    const f = effPointsId('full-flush', ruleset, 24); value += f;
    breakdown.push({ id: 'full-flush', name: 'Full Flush', cn: '清一色', points: f });
  } else if (suits.size === 1 && honor && isEnabledId('half-flush', ruleset)) {
    const f = effPointsId('half-flush', ruleset, 6); value += f;
    breakdown.push({ id: 'half-flush', name: 'Half Flush', cn: '混一色', points: f });
  }
  return addContextMcr({ value, breakdown }, ctx, ruleset);
}

function scoreWinMcr(ctx, ruleset, handTiles, melds) {
  const mcr = (ruleset && ruleset.mcr) || { minPoints: 8, base: 8, basePoints: 1 };
  const minPoints = mcr.minPoints ?? 8;
  const basePoints = mcr.basePoints ?? 1;
  const flowerPts = (ctx.flowers || []).length; // each flower scores 1 (花牌)

  const candidates = [];
  for (const dc of decompose(handTiles, 4 - melds.length)) {
    candidates.push(scoreDecompositionMcr(ctx, { sets: [...melds, ...markRonCompletedSet(dc.sets, ctx)], pair: dc.pair }, ruleset));
  }
  if (melds.length === 0) {
    if (isEnabledId('thirteen-orphans', ruleset) && isThirteenOrphans(handTiles)) candidates.push(scoreThirteenOrphansMcr(ctx, ruleset));
    if (isEnabledId('seven-pairs', ruleset) && isSevenPairs(handTiles)) candidates.push(scoreSevenPairsMcr(ctx, handTiles, ruleset));
    const k = parseKnitted(handTiles);
    if (k && knittedAllowed(k.kind, ruleset)) candidates.push(scoreKnittedMcr(k.kind, ctx, ruleset));
  }

  const hasWinningShape = candidates.length > 0;
  let best = null;
  for (const c of candidates) if (!best || c.value > best.value) best = c;
  if (!best) best = { value: 0, breakdown: [] };

  let value = best.value;
  let breakdown = best.breakdown.slice();
  // Chicken Hand (無番和): a legal winning shape that otherwise scores 0 reaches
  // the floor with an 8-point fan.
  if (hasWinningShape && value === 0) {
    value = minPoints; // the no-fan floor tracks the configured MCR minimum (8 by default)
    breakdown = [{ id: 'chicken-hand', name: 'Chicken Hand', cn: '無番和', points: value }];
  }
  // Flowers are excluded from the 8-point minimum, then added on.
  const legal = hasWinningShape && value >= minPoints;
  if (flowerPts > 0) breakdown.push({ id: 'flowers', name: 'Flowers', cn: '花牌', points: flowerPts, count: flowerPts > 1 ? flowerPts : undefined });
  const total = value + flowerPts;

  return {
    mode: 'mcr-additive', legal,
    faan: 0, rawFaan: 0, isLimit: false, tier: undefined,
    value: total, points: total * basePoints, breakdown,
  };
}

// ctx: { hand, melds, seatWind, roundWind, selfDraw, flowers,
//        kongReplacement?, robbingKong?, lastTile? }
// `hand` is the concealed tiles INCLUDING the winning tile.
// Returns { faan, rawFaan, isLimit, points, breakdown }. faan is capped at the
// limit; rawFaan is the uncapped best interpretation's sum.
function scoreWin(ctx, ruleset = DEFAULT_SCORING) {
  const cfg = resolveCfg(ruleset);
  const mode = resolveMode(ruleset);
  const handTiles = (ctx.hand || []).filter(t => t.suit !== 'flower');
  const melds = (ctx.melds || []).map(normalizeMeld);

  if (mode === 'mcr-additive') return scoreWinMcr(ctx, ruleset, handTiles, melds);

  const candidates = [];
  for (const dc of decompose(handTiles, 4 - melds.length)) {
    candidates.push(scoreDecomposition(ctx, { sets: [...melds, ...markRonCompletedSet(dc.sets, ctx)], pair: dc.pair }, cfg, ruleset));
  }
  // Special concealed hands that aren't 4 sets + a pair (honour the host's
  // enable toggles — a disabled special hand contributes no candidate).
  if (melds.length === 0) {
    if (isEnabledId('thirteen-orphans', ruleset) && isThirteenOrphans(handTiles)) candidates.push(scoreThirteenOrphans(cfg, ruleset, ctx));
    if (isEnabledId('seven-pairs', ruleset) && isSevenPairs(handTiles)) candidates.push(scoreSevenPairs(ctx, handTiles, cfg, ruleset));
    const k = parseKnitted(handTiles);
    if (k && knittedAllowed(k.kind, ruleset)) candidates.push(scoreKnittedHk(k.kind, cfg, ruleset, ctx));
  }

  let best = null;
  for (const c of candidates) if (!best || c.faan > best.faan) best = c;
  if (!best) best = { faan: 0, isLimit: false, breakdown: [] };

  // Faan total is monotonic in payout for both HK modes, so the highest-faan
  // decomposition is also the highest-paying one.
  const faan = Math.min(best.faan, cfg.limitFaan);
  const { points, tier } = payoutFor(mode, faan, best.isLimit, ruleset, cfg);
  return {
    mode, legal: faan >= cfg.minFaan,
    faan, rawFaan: best.faan, isLimit: best.isLimit,
    tier, points, value: points, breakdown: best.breakdown,
  };
}

// Signed point transfer per player index after a win.
// HK modes — self-draw: every other player pays the winner the points; discard:
//   the discarder pays in full.
// MCR mode — self-draw: every opponent pays V + base; discard: every opponent
//   pays base, and the discarder additionally pays V (the hand value).
// NOTE: payouts are intentionally seat-symmetric — there is deliberately NO dealer
// (莊家) multiplier. The dealer is modelled only for rotation / seat winds, not pay;
// this is a house-rule choice (standard HK would double the dealer's win and loss).
function computePayments(score, winnerIndex, playerCount, selfDraw, discarderIndex, ruleset = DEFAULT_SCORING) {
  const pay = new Array(playerCount).fill(0);
  if (score && score.legal === false) return pay; // defence-in-depth: never pay out a sub-minimum / illegal hand

  if (score.mode === 'mcr-additive') {
    const mcr = (ruleset && ruleset.mcr) || { base: 8, basePoints: 1 };
    const base = mcr.base ?? 8;
    const bp = mcr.basePoints ?? 1;
    const V = score.value || 0;
    if (selfDraw) {
      for (let i = 0; i < playerCount; i++) {
        if (i === winnerIndex) continue;
        const amt = (V + base) * bp;
        pay[i] -= amt; pay[winnerIndex] += amt;
      }
    } else if (discarderIndex != null && discarderIndex !== winnerIndex) {
      for (let i = 0; i < playerCount; i++) {
        if (i === winnerIndex) continue;
        const amt = (base + (i === discarderIndex ? V : 0)) * bp;
        pay[i] -= amt; pay[winnerIndex] += amt;
      }
    }
    return pay;
  }

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
  analyzeWait,
  DEFAULT_SCORING,
  PATTERNS,
  WINDS,
};
