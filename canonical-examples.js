// Canonical example hands — ONE per pattern family — used both by the automated
// catalogue test (test/mcr-catalog.test.js) and by the sandbox's "load example"
// / "run all" verification grid. Each entry names a ruleset (partial; sanitized
// before use) and a probe context, and asserts the pattern appears in the
// breakdown. Tiles are plain {suit,value}; the probe assigns ids.
const t = (suit, value) => ({ suit, value });
const run = (s, n) => [t(s, n), t(s, n + 1), t(s, n + 2)];
const trip = (s, v) => [t(s, v), t(s, v), t(s, v)];
const pair = (s, v) => [t(s, v), t(s, v)];
// A ruleset that enables exactly one pattern on top of the MCR defaults.
const only = (id, extra) => ({ mode: 'mcr-additive', patterns: { [id]: { enabled: true } }, ...(extra || {}) });

const EXAMPLES = [
  // ── Core HK / high-value ──
  { id: 'all-pungs', label: 'All Pungs 對對糊', ruleset: only('all-pungs'),
    ctx: { hand: [...trip('man', 1), ...trip('pin', 9), ...trip('bam', 5), ...trip('man', 3), ...pair('wind', 'east')] } },
  { id: 'full-flush', label: 'Full Flush 清一色', ruleset: only('full-flush'),
    ctx: { hand: [...trip('man', 1), ...trip('man', 9), ...run('man', 4), ...run('man', 6), ...pair('man', 2)] } },
  { id: 'half-flush', label: 'Half Flush 混一色', ruleset: only('half-flush'),
    ctx: { hand: [...run('bam', 1), ...run('bam', 4), ...trip('bam', 9), ...trip('dragon', 'red'), ...pair('wind', 'east')] } },
  { id: 'pure-straight', label: 'Pure Straight 清龍', ruleset: only('pure-straight'),
    ctx: { hand: [...run('man', 1), ...run('man', 4), ...run('man', 7), ...run('pin', 2), ...pair('bam', 5)] } },
  { id: 'big-three-dragons', label: 'Big Three Dragons 大三元', ruleset: only('big-three-dragons'),
    ctx: { hand: [...trip('dragon', 'red'), ...trip('dragon', 'green'), ...trip('dragon', 'white'), ...trip('man', 1), ...pair('pin', 2)] } },
  { id: 'seven-pairs', label: 'Seven Pairs 七對', ruleset: only('seven-pairs'),
    ctx: { hand: [...pair('man', 2), ...pair('man', 5), ...pair('pin', 3), ...pair('pin', 7), ...pair('bam', 1), ...pair('bam', 9), ...pair('dragon', 'red')] } },
  { id: 'thirteen-orphans', label: 'Thirteen Orphans 十三幺', ruleset: only('thirteen-orphans'),
    ctx: { hand: [t('man', 1), t('man', 1), t('man', 9), t('pin', 1), t('pin', 9), t('bam', 1), t('bam', 9), t('wind', 'east'), t('wind', 'south'), t('wind', 'west'), t('wind', 'north'), t('dragon', 'red'), t('dragon', 'green'), t('dragon', 'white')] } },

  // ── Same-sequence / shifted family ──
  { id: 'mixed-double-chow', label: 'Mixed Double Chow 喜相逢', ruleset: only('mixed-double-chow'),
    ctx: { hand: [...run('man', 1), ...run('pin', 1), ...run('bam', 4), ...run('bam', 7), ...pair('man', 9)] } },
  { id: 'mixed-triple-chow', label: 'Mixed Triple Chow 三色三同順', ruleset: only('mixed-triple-chow'),
    ctx: { hand: [...run('man', 3), ...run('pin', 3), ...run('bam', 3), ...run('man', 6), ...pair('pin', 9)] } },
  { id: 'mixed-straight', label: 'Mixed Straight 花龍', ruleset: only('mixed-straight'),
    ctx: { hand: [...run('man', 1), ...run('pin', 4), ...run('bam', 7), ...trip('man', 9), ...pair('pin', 2)] } },
  { id: 'pure-shifted-chows', label: 'Pure Shifted Chows 一色三步高', ruleset: only('pure-shifted-chows'),
    ctx: { hand: [...run('man', 1), ...run('man', 3), ...run('man', 5), ...trip('pin', 9), ...pair('bam', 2)] } },
  { id: 'mixed-shifted-chows', label: 'Mixed Shifted Chows 三色三步高 (shift 2)', ruleset: only('mixed-shifted-chows'),
    ctx: { hand: [...run('man', 1), ...run('pin', 3), ...run('bam', 5), ...trip('dragon', 'red'), ...pair('man', 9)] } },
  { id: 'triple-pung', label: 'Triple Pung 三同刻', ruleset: only('triple-pung'),
    ctx: { hand: [...trip('man', 5), ...trip('pin', 5), ...trip('bam', 5), ...trip('man', 1), ...pair('wind', 'east')] } },
  { id: 'double-pung', label: 'Double Pung 雙同刻', ruleset: only('double-pung'),
    ctx: { hand: [...trip('man', 5), ...trip('pin', 5), ...run('bam', 1), ...run('bam', 4), ...pair('wind', 'east')] } },

  // ── Band / suit-set family ──
  { id: 'all-types', label: 'All Types 五門齊', ruleset: only('all-types'),
    ctx: { hand: [...run('man', 1), ...run('pin', 4), ...trip('bam', 9), ...trip('wind', 'east'), ...pair('dragon', 'red')] } },
  { id: 'all-simples', label: 'All Simples 斷幺', ruleset: only('all-simples'),
    ctx: { hand: [...run('man', 2), ...run('pin', 3), ...run('bam', 4), ...trip('pin', 6), ...pair('bam', 5)] } },
  { id: 'outside-hand', label: 'Outside Hand 全帶幺', ruleset: only('outside-hand'),
    ctx: { hand: [...trip('man', 1), ...run('pin', 1), ...run('bam', 7), ...trip('dragon', 'red'), ...pair('man', 9)] } },
  { id: 'all-even-pungs', label: 'All Even Pungs 全雙刻', ruleset: only('all-even-pungs'),
    ctx: { hand: [...trip('man', 2), ...trip('pin', 4), ...trip('bam', 6), ...trip('man', 8), ...pair('pin', 2)] } },
  { id: 'reversible-tiles', label: 'Reversible Tiles 推不倒', ruleset: only('reversible-tiles'),
    ctx: { hand: [...run('pin', 1), ...run('pin', 3), ...trip('bam', 5), ...trip('dragon', 'white'), ...pair('bam', 2)] } },
  { id: 'upper-tiles', label: 'Upper Tiles 全大', ruleset: only('upper-tiles'),
    ctx: { hand: [...trip('man', 7), ...trip('pin', 8), ...trip('bam', 9), ...run('man', 7), ...pair('pin', 9)] } },
  { id: 'two-concealed-pungs', label: 'Two Concealed Pungs 雙暗刻', ruleset: only('two-concealed-pungs'),
    ctx: { hand: [...trip('man', 1), ...trip('pin', 9), ...run('bam', 1), ...run('bam', 4), ...pair('man', 5)] } },
  { id: 'big-three-winds', label: 'Big Three Winds 三風刻', ruleset: only('big-three-winds'),
    ctx: { hand: [...trip('wind', 'east'), ...trip('wind', 'south'), ...trip('wind', 'west'), ...run('man', 1), ...pair('pin', 5)] } },

  // ── Limit-class additions ──
  { id: 'all-green', label: 'All Green 綠一色', ruleset: only('all-green'),
    ctx: { hand: [...trip('bam', 2), ...trip('bam', 3), ...trip('bam', 6), ...trip('dragon', 'green'), ...pair('bam', 8)] } },

  // ── Knitted (gated by `allow`) ──
  { id: 'greater-knitted', label: 'Greater Honours & Knitted 七星不靠', ruleset: { mode: 'mcr-additive', allow: { greaterKnitted: true } },
    ctx: { hand: [t('man', 1), t('man', 4), t('man', 7), t('pin', 2), t('pin', 5), t('pin', 8), t('bam', 3), t('wind', 'east'), t('wind', 'south'), t('wind', 'west'), t('wind', 'north'), t('dragon', 'red'), t('dragon', 'green'), t('dragon', 'white')] } },
  { id: 'knitted-straight', label: 'Knitted Straight 組合龍', ruleset: { mode: 'mcr-additive', allow: { knittedStraight: true } },
    ctx: { hand: [t('man', 1), t('man', 4), t('man', 7), t('pin', 2), t('pin', 5), t('pin', 8), t('bam', 3), t('bam', 6), t('bam', 9), ...trip('dragon', 'red'), ...pair('wind', 'east')] } },

  // ── Context-driven fans ──
  { id: 'edge-wait', label: 'Edge Wait 邊張 (1-2 + _3_)', ruleset: only('edge-wait'),
    ctx: { hand: [t('man', 1), t('man', 2), t('man', 3), ...run('pin', 4), ...run('pin', 7), ...trip('bam', 5), ...pair('dragon', 'red')], winningTileIndex: 2 } },
  { id: 'last-of-kind', label: 'Last Tile 和絕張', ruleset: only('last-of-kind'),
    ctx: { hand: [...run('man', 1), ...run('man', 4), ...run('pin', 1), ...run('pin', 4), ...pair('bam', 5)], lastOfKind: true } },
  { id: 'melded-hand', label: 'Melded Hand 全求人', ruleset: only('melded-hand'),
    ctx: { hand: [...run('man', 1), ...run('man', 4), ...run('pin', 1), ...run('pin', 4), ...pair('bam', 5)], meldedHand: true } },
  { id: 'self-draw', label: 'Self-Draw 自摸', ruleset: only('self-draw'),
    ctx: { hand: [...run('man', 1), ...run('man', 4), ...run('pin', 1), ...run('pin', 4), ...pair('bam', 5)], selfDraw: true } },
];

if (typeof module !== 'undefined' && module.exports) module.exports = { EXAMPLES };
else if (typeof window !== 'undefined') window.CanonicalExamples = { EXAMPLES };
