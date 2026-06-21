// Tests for the pattern-library metadata + the multiplicity refactor: each
// pattern's evaluate() now returns a multiplicity (0/1/N) and its faan value
// lives in `hkFaan`, so a ruleset can retune or disable it. Under HK Standard
// (no overrides) the contributed faan must equal the old hard-coded magnitudes.
const assert = require('assert');
const { scoreWin, PATTERNS } = require('../scoring');
const { sanitizeRuleset } = require('../rulesets');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

let _id = 0;
const t = (suit, value) => ({ suit, value, id: _id++ });
const run = (suit, start) => [t(suit, start), t(suit, start + 1), t(suit, start + 2)];
const trip = (suit, value) => [t(suit, value), t(suit, value), t(suit, value)];
const pair = (suit, value) => [t(suit, value), t(suit, value)];
const ctxOf = hand => ({ hand, melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false });
const byId = id => PATTERNS.find(p => p.id === id);

// 1. Every pattern carries the new metadata.
check('all patterns have hkFaan + defaultEnabled + mcr metadata', () => {
  for (const p of PATTERNS) {
    assert.strictEqual(typeof p.hkFaan, 'number', `${p.id} hkFaan`);
    assert.ok('mcrPoints' in p, `${p.id} mcrPoints`);
    assert.ok('defaultEnabled' in p, `${p.id} defaultEnabled`);
  }
});

// 2. hkFaan defaults equal the old magnitudes for the non-trivial patterns.
check('hkFaan defaults match legacy magnitudes', () => {
  assert.strictEqual(byId('all-pungs').hkFaan, 3);
  assert.strictEqual(byId('full-flush').hkFaan, 7);
  assert.strictEqual(byId('half-flush').hkFaan, 3);
  assert.strictEqual(byId('small-three-dragons').hkFaan, 3);
  assert.strictEqual(byId('all-chows').hkFaan, 1);
  assert.strictEqual(byId('dragon-pung').hkFaan, 1);
});

// 3. Enabled-id snapshot — pins HK Standard's pattern set (new MCR patterns,
//    once added, must be defaultEnabled:false and not appear here).
check('HK Standard enabled-id snapshot', () => {
  const SNAPSHOT = [
    'self-draw', 'concealed', 'all-chows', 'all-pungs', 'pure-straight',
    'dragon-pung', 'seat-wind', 'round-wind', 'half-flush', 'full-flush',
    'small-three-dragons', 'big-three-dragons', 'small-four-winds', 'big-four-winds',
    'all-honors', 'all-terminals', 'nine-gates', 'kong-replacement', 'robbing-kong',
    'last-tile-draw', 'last-tile-discard', 'seat-flower', 'flower-set', 'all-flowers',
  ];
  const enabled = PATTERNS.filter(p => p.defaultEnabled !== false).map(p => p.id);
  assert.deepStrictEqual(enabled, SNAPSHOT);
});

// 4. A per-pattern faan override changes the contributed value (proves multiplicity).
check('faan override retunes a pattern', () => {
  const hand = [...trip('dragon', 'red'), ...trip('man', 1), ...trip('pin', 9), ...trip('bam', 5), ...pair('wind', 'south')];
  // baseline: all-pungs(3) + dragon(1) + concealed(1) = 5
  const baseline = scoreWin(ctxOf(hand), sanitizeRuleset({}));
  assert.strictEqual(baseline.faan, 5, `baseline ${baseline.faan}`);
  const tuned = scoreWin(ctxOf(hand), sanitizeRuleset({ patterns: { 'all-pungs': { enabled: true, faan: 6 } } }));
  // all-pungs(6) + dragon(1) + concealed(1) = 8
  assert.strictEqual(tuned.faan, 8, `tuned ${tuned.faan}`);
});

// 5. Disabling a pattern removes its contribution.
check('disabling a pattern drops it', () => {
  const hand = [...run('man', 1), ...run('man', 4), ...run('pin', 1), ...run('pin', 4), ...pair('bam', 5)];
  const off = scoreWin(ctxOf(hand), sanitizeRuleset({ patterns: { 'concealed': { enabled: false } } }));
  // all-chows(1) only; concealed disabled
  assert.strictEqual(off.faan, 1, `got ${off.faan}`);
  assert.ok(!off.breakdown.map(b => b.id).includes('concealed'));
});

// 6. perCount patterns still multiply (two dragon triplets → ×2).
check('perCount multiplicity preserved', () => {
  const hand = [...trip('dragon', 'red'), ...trip('dragon', 'green'), ...trip('man', 1), ...trip('pin', 9), ...pair('bam', 5)];
  const s = scoreWin(ctxOf(hand), sanitizeRuleset({}));
  const dp = s.breakdown.find(b => b.id === 'dragon-pung');
  assert.ok(dp, 'dragon-pung present');
  assert.strictEqual(dp.count, 2, `count ${dp.count}`);
  assert.strictEqual(dp.faan, 2, `faan ${dp.faan}`);
});

// 7. Special-hand scorers honour overrides too (seven pairs retuned).
check('seven-pairs base faan is overridable', () => {
  const hand = [...pair('man', 2), ...pair('man', 5), ...pair('pin', 3), ...pair('pin', 7),
    ...pair('bam', 1), ...pair('bam', 9), ...pair('dragon', 'red')];
  const s = scoreWin(ctxOf(hand), sanitizeRuleset({ patterns: { 'seven-pairs': { enabled: true, faan: 6 } } }));
  assert.strictEqual(s.faan, 6, `got ${s.faan}`);
});

// 8. Disabling seven-pairs makes the hand score nothing (no candidate).
check('disabling seven-pairs drops the special hand', () => {
  const hand = [...pair('man', 2), ...pair('man', 5), ...pair('pin', 3), ...pair('pin', 7),
    ...pair('bam', 1), ...pair('bam', 9), ...pair('dragon', 'red')];
  const s = scoreWin(ctxOf(hand), sanitizeRuleset({ patterns: { 'seven-pairs': { enabled: false } } }));
  assert.strictEqual(s.faan, 0, `got ${s.faan}`);
  assert.deepStrictEqual(s.breakdown, []);
});

// 9. Disabling all-honors downgrades seven honour pairs from limit to plain.
check('disabling all-honors un-limits seven honour pairs', () => {
  const hand = [...pair('wind', 'east'), ...pair('wind', 'south'), ...pair('wind', 'west'),
    ...pair('wind', 'north'), ...pair('dragon', 'red'), ...pair('dragon', 'green'), ...pair('dragon', 'white')];
  const s = scoreWin(ctxOf(hand), sanitizeRuleset({ patterns: { 'all-honors': { enabled: false } } }));
  assert.ok(!s.isLimit, 'should no longer be a limit hand');
  assert.strictEqual(s.faan, 4, `got ${s.faan}`); // plain seven pairs
});

console.log(`\n${passed} library tests passed`);
if (process.exitCode) console.error('LIBRARY TESTS FAILED');
