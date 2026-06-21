// Tests for the MCR additive mode: flat point summation, the 8-point floor,
// Chicken Hand, flower handling, and the official MCR payment formula.
const assert = require('assert');
const { scoreWin, computePayments } = require('../scoring');
const { sanitizeRuleset, PRESETS } = require('../rulesets');

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
const MCR = sanitizeRuleset({ mode: 'mcr-additive' });
const ctxOf = (hand, extra = {}) => ({ hand, melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false, ...extra });
const entry = (s, id) => s.breakdown.find(b => b.id === id);

// 1. Additive sum: all-pungs(6) + dragon(2) + concealed(2) = 10.
check('MCR additive sum = 10', () => {
  const hand = [...trip('dragon', 'red'), ...trip('man', 1), ...trip('pin', 9), ...trip('bam', 5), ...pair('wind', 'east')];
  const s = scoreWin(ctxOf(hand), MCR);
  assert.strictEqual(s.mode, 'mcr-additive');
  assert.strictEqual(s.value, 10, `value ${s.value}`);
  assert.strictEqual(s.points, 10, `points ${s.points}`);
  assert.ok(s.legal);
  assert.strictEqual(entry(s, 'all-pungs').points, 6);
});

// 2. The 8-point floor: a 4-point hand is not a legal MCR win.
check('MCR floor: 4 points is not a legal win', () => {
  const hand = [...run('man', 1), ...run('man', 4), ...run('pin', 1), ...run('pin', 4), ...pair('bam', 5)];
  const s = scoreWin(ctxOf(hand), MCR);
  assert.strictEqual(s.value, 4, `value ${s.value}`);
  assert.strictEqual(s.legal, false, 'should be below the floor');
});

// 3. Chicken Hand: a legal winning shape worth 0 fan reaches the floor at 8.
check('MCR Chicken Hand = 8', () => {
  const hand = [...run('man', 1), ...run('man', 4), ...run('bam', 7), ...pair('bam', 2)];
  const melds = [{ type: 'pong', tiles: trip('pin', 5) }];
  const s = scoreWin({ hand, melds, seatWind: 'east', roundWind: 'east', selfDraw: false }, MCR);
  assert.strictEqual(s.value, 8, `value ${s.value}`);
  assert.ok(s.legal);
  assert.ok(entry(s, 'chicken-hand'), 'chicken-hand in breakdown');
});

// 4. Flowers are excluded from the floor but added to the total.
check('MCR flowers excluded from floor, added to total', () => {
  // 4-point hand + 3 flowers stays illegal (flowers do not reach the floor)...
  const lowHand = [...run('man', 1), ...run('man', 4), ...run('pin', 1), ...run('pin', 4), ...pair('bam', 5)];
  const low = scoreWin(ctxOf(lowHand, { flowers: [t('flower', 1), t('flower', 2), t('flower', 3)] }), MCR);
  assert.strictEqual(low.legal, false, 'flowers must not push a sub-floor hand to legal');
  // ...but a legal 10-point hand + 2 flowers totals 12.
  const okHand = [...trip('dragon', 'red'), ...trip('man', 1), ...trip('pin', 9), ...trip('bam', 5), ...pair('wind', 'east')];
  const ok = scoreWin(ctxOf(okHand, { flowers: [t('flower', 1), t('flower', 2)] }), MCR);
  assert.strictEqual(ok.value, 12, `value ${ok.value}`);
  assert.ok(ok.legal);
});

// 5. MCR payment — win by discard (official worked example: V=12 → +36).
check('MCR payments: discard (V=12) → 24 + V', () => {
  const score = { mode: 'mcr-additive', value: 12 };
  const pay = computePayments(score, 0, 4, false, 2, MCR);
  assert.deepStrictEqual(pay, [36, -8, -20, -8]);
  assert.strictEqual(pay.reduce((a, b) => a + b, 0), 0, 'zero-sum');
});

// 6. MCR payment — win by self-draw (official worked example: V=12 → +60).
check('MCR payments: self-draw (V=12) → 3·(V+8)', () => {
  const score = { mode: 'mcr-additive', value: 12 };
  const pay = computePayments(score, 0, 4, true, null, MCR);
  assert.deepStrictEqual(pay, [60, -20, -20, -20]);
  assert.strictEqual(pay.reduce((a, b) => a + b, 0), 0, 'zero-sum');
});

// 7. MCR Official preset runs and treats a big hand as a legal high-value win.
check('MCR Official scores a big hand legally', () => {
  const hand = [...trip('dragon', 'red'), ...trip('dragon', 'green'), ...trip('dragon', 'white'), ...trip('man', 1), ...pair('pin', 2)];
  const s = scoreWin(ctxOf(hand), PRESETS['mcr-official']);
  assert.strictEqual(s.mode, 'mcr-additive');
  assert.ok(s.legal);
  assert.ok(s.value >= 88, `big three dragons should be >= 88, got ${s.value}`);
});

// 8. pung-terminals-honors counts dragon pungs (review fix #1).
check('幺九刻 counts a dragon pung', () => {
  const hand = [...trip('man', 1), ...trip('dragon', 'red'), ...run('pin', 4), ...run('pin', 7), ...pair('bam', 5)];
  const s = scoreWin(ctxOf(hand), sanitizeRuleset({ mode: 'mcr-additive', patterns: { 'pung-terminals-honors': { enabled: true } } }));
  const e = s.breakdown.find(b => b.id === 'pung-terminals-honors');
  assert.ok(e && e.count === 2, `expected count 2 (man1 + dragon), got ${JSON.stringify(e)}`);
});

// 9. mixed-shifted-chows allows a constant shift of 2 (review fix #4).
check('三色三步高 fires on a shift of 2', () => {
  const hand = [...run('man', 1), ...run('pin', 3), ...run('bam', 5), ...trip('dragon', 'red'), ...pair('man', 9)];
  const s = scoreWin(ctxOf(hand), sanitizeRuleset({ mode: 'mcr-additive', patterns: { 'mixed-shifted-chows': { enabled: true } } }));
  assert.ok(s.breakdown.map(b => b.id).includes('mixed-shifted-chows'));
});

// 10. MCR seven pairs stacks Full Flush (review fix #2).
check('七對 stacks 清一色 in MCR', () => {
  const hand = [...pair('man', 1), ...pair('man', 2), ...pair('man', 4), ...pair('man', 5), ...pair('man', 7), ...pair('man', 8), ...pair('man', 9)];
  const s = scoreWin(ctxOf(hand), PRESETS['mcr-official']);
  assert.strictEqual(s.value, 48, `seven pairs + full flush = 48, got ${s.value}`);
});

console.log(`\n${passed} MCR tests passed`);
if (process.exitCode) console.error('MCR TESTS FAILED');
