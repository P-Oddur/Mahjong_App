// Tests for the per-room payout MODES. hk-doubling reproduces the legacy
// points; hk-grouped compresses faan into tiers (editable breakpoints) before
// doubling, with limit hands jumping to the top tier.
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
const ctxOf = hand => ({ hand, melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false });

// 5-faan hand: all-pungs(3) + dragon(1) + concealed(1). Pair is a non-scoring wind.
const fiveFaanHand = () => [...trip('dragon', 'red'), ...trip('man', 1), ...trip('pin', 9), ...trip('bam', 5), ...pair('wind', 'south')];
// 2-faan hand: all-chows(1) + concealed(1).
const twoFaanHand = () => [...run('man', 1), ...run('man', 4), ...run('pin', 1), ...run('pin', 4), ...pair('bam', 5)];

// 1. hk-doubling reproduces the legacy points formula.
check('hk-doubling: 5 faan → 2^5 = 32 points', () => {
  const s = scoreWin(ctxOf(fiveFaanHand()), sanitizeRuleset({ mode: 'hk-doubling' }));
  assert.strictEqual(s.mode, 'hk-doubling');
  assert.strictEqual(s.faan, 5, `faan ${s.faan}`);
  assert.strictEqual(s.points, 32, `points ${s.points}`);
});

// 2. hk-grouped: 5 faan → tier 2 (4–5 band) → 2^2 = 4 points.
check('hk-grouped: 5 faan → tier 2 → 4 points', () => {
  const s = scoreWin(ctxOf(fiveFaanHand()), sanitizeRuleset({ mode: 'hk-grouped' }));
  assert.strictEqual(s.mode, 'hk-grouped');
  assert.strictEqual(s.faan, 5, `faan ${s.faan}`);
  assert.strictEqual(s.tier, 2, `tier ${s.tier}`);
  assert.strictEqual(s.points, 4, `points ${s.points}`);
});

// 3. hk-grouped: 2 faan → tier 1 (≤3 band) → 2^1 = 2 points.
check('hk-grouped: 2 faan → tier 1 → 2 points', () => {
  const s = scoreWin(ctxOf(twoFaanHand()), sanitizeRuleset({ mode: 'hk-grouped' }));
  assert.strictEqual(s.tier, 1, `tier ${s.tier}`);
  assert.strictEqual(s.points, 2, `points ${s.points}`);
});

// 4. hk-grouped: a limit hand jumps to the top tier (5) → 2^5 = 32 points.
check('hk-grouped: limit hand → top tier', () => {
  const hand = [...trip('dragon', 'red'), ...trip('dragon', 'green'), ...trip('dragon', 'white'), ...trip('man', 1), ...pair('pin', 2)];
  const s = scoreWin(ctxOf(hand), sanitizeRuleset({ mode: 'hk-grouped' }));
  assert.ok(s.isLimit);
  assert.strictEqual(s.tier, 5, `tier ${s.tier}`);
  assert.strictEqual(s.points, 32, `points ${s.points}`);
});

// 5. hk-grouped: editable breakpoints change the tiering.
check('hk-grouped: custom breakpoints [2,4] → top tier 3', () => {
  const s = scoreWin(ctxOf(fiveFaanHand()), sanitizeRuleset({ mode: 'hk-grouped', grouped: { breakpoints: [2, 4] } }));
  // faan 5 > 4 → overflow to top tier = 3 → 2^3 = 8
  assert.strictEqual(s.tier, 3, `tier ${s.tier}`);
  assert.strictEqual(s.points, 8, `points ${s.points}`);
});

// 6. hk-grouped: basePoints scales the payout.
check('hk-grouped: basePoints multiplies payout', () => {
  const s = scoreWin(ctxOf(fiveFaanHand()), sanitizeRuleset({ mode: 'hk-grouped', grouped: { basePoints: 2 } }));
  // tier 2 → 2 * 2^2 = 8
  assert.strictEqual(s.points, 8, `points ${s.points}`);
});

console.log(`\n${passed} mode tests passed`);
if (process.exitCode) console.error('MODE TESTS FAILED');
