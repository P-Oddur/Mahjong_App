// Tests for the MCR non-repeat rule (不重复原则): implied patterns are absorbed
// by their implier and hard-excluded pairs keep only the higher-valued side.
// Each test enables only the patterns under examination so the totals are exact.
const assert = require('assert');
const { scoreWin } = require('../scoring');
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
const mcr = (enabled) => sanitizeRuleset({ mode: 'mcr-additive', patterns: Object.fromEntries((enabled || []).map(id => [id, { enabled: true }])) });
const ctxOf = (hand, extra = {}) => ({ hand, melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false, ...extra });
const ids = s => s.breakdown.map(b => b.id);

// 1. Implication: All Even Pungs absorbs All Pungs + All Simples.
check('implication: all-even-pungs drops all-pungs + all-simples', () => {
  const hand = [...trip('man', 2), ...trip('pin', 4), ...trip('bam', 6), ...trip('man', 8), ...pair('pin', 2)];
  const s = scoreWin(ctxOf(hand), mcr(['all-even-pungs', 'all-simples']));
  assert.strictEqual(s.value, 26, `value ${s.value}`); // all-even-pungs 24 + concealed 2
  assert.ok(ids(s).includes('all-even-pungs'));
  assert.ok(!ids(s).includes('all-pungs'), 'all-pungs should be absorbed');
  assert.ok(!ids(s).includes('all-simples'), 'all-simples should be absorbed');
});

// 2. Exclusion: All Terminals excludes Double Pung + No Honours (and absorbs All Pungs).
check('exclusion: all-terminals drops no-honors + double-pung', () => {
  const hand = [...trip('man', 1), ...trip('pin', 1), ...trip('bam', 9), ...trip('man', 9), ...pair('pin', 9)];
  const s = scoreWin(ctxOf(hand), mcr(['no-honors', 'double-pung']));
  assert.strictEqual(s.value, 66, `value ${s.value}`); // all-terminals 64 + concealed 2
  assert.ok(ids(s).includes('all-terminals'));
  assert.ok(!ids(s).includes('no-honors'), 'no-honors excluded');
  assert.ok(!ids(s).includes('double-pung'), 'double-pung excluded');
  assert.ok(!ids(s).includes('all-pungs'), 'all-pungs absorbed');
});

// 3. Implication: Full Flush absorbs No Honours.
check('implication: full-flush drops no-honors', () => {
  const hand = [...trip('man', 1), ...trip('man', 9), ...run('man', 4), ...run('man', 6), ...pair('man', 2)];
  const s = scoreWin(ctxOf(hand), mcr(['no-honors']));
  assert.strictEqual(s.value, 26, `value ${s.value}`); // full-flush 24 + concealed 2
  assert.ok(ids(s).includes('full-flush'));
  assert.ok(!ids(s).includes('no-honors'), 'no-honors absorbed by full-flush');
});

// 4. Exclusion: Last-Tile Draw is scored instead of Self-Drawn.
check('exclusion: last-tile-draw drops self-draw', () => {
  const hand = [...run('man', 1), ...run('man', 4), ...run('pin', 1), ...run('pin', 4), ...pair('bam', 5)];
  const s = scoreWin(ctxOf(hand, { selfDraw: true, lastTile: true }), mcr());
  assert.ok(ids(s).includes('last-tile-draw'));
  assert.ok(!ids(s).includes('self-draw'), 'self-draw excluded by last-tile-draw');
});

console.log(`\n${passed} MCR non-repeat tests passed`);
if (process.exitCode) console.error('MCR-NONREPEAT TESTS FAILED');
