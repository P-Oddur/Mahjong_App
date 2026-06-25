// Tests for wait-shape detection (analyzeWait) and the context-driven fans
// (edge/closed/single wait, last-of-kind, melded-hand).
const assert = require('assert');
const { analyzeWait, scoreWin } = require('../scoring');
const { sanitizeRuleset } = require('../rulesets');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

let _id = 0;
const t = (suit, value) => ({ suit, value, id: _id++ });
const run = (suit, s) => [t(suit, s), t(suit, s + 1), t(suit, s + 2)];
const trip = (suit, v) => [t(suit, v), t(suit, v), t(suit, v)];
const pair = (suit, v) => [t(suit, v), t(suit, v)];
const ids = s => s.breakdown.map(b => b.id);

// 1. Edge wait — 1-2 waiting on 3.
check('analyzeWait: edge (1-2 + _3_)', () => {
  const hand13 = [t('man', 1), t('man', 2), ...run('pin', 4), ...run('pin', 7), ...trip('bam', 5), ...pair('dragon', 'red')];
  const win = t('man', 3);
  assert.deepStrictEqual(analyzeWait(hand13, [], win), { single: true, shape: 'edge' });
});

// 2. Closed wait — 4-6 waiting on 5.
check('analyzeWait: closed (4-_5_-6)', () => {
  const hand13 = [t('man', 4), t('man', 6), ...run('pin', 1), ...run('pin', 4), ...trip('bam', 5), ...pair('dragon', 'red')];
  const win = t('man', 5);
  assert.deepStrictEqual(analyzeWait(hand13, [], win), { single: true, shape: 'closed' });
});

// 3. Single (pair) wait — lone tile waiting to pair.
check('analyzeWait: pair (tanki)', () => {
  const hand13 = [...run('man', 1), ...run('man', 4), ...run('pin', 1), ...run('pin', 4), t('dragon', 'red')];
  const win = t('dragon', 'red');
  assert.deepStrictEqual(analyzeWait(hand13, [], win), { single: true, shape: 'pair' });
});

// 4. Multi-wait — 2-3 waiting on 1 or 4 → not single.
check('analyzeWait: two-sided wait is not single', () => {
  const hand13 = [t('man', 2), t('man', 3), ...run('pin', 1), ...run('pin', 4), ...trip('bam', 5), ...pair('dragon', 'red')];
  const win = t('man', 4);
  assert.deepStrictEqual(analyzeWait(hand13, [], win), { single: false, shape: null });
});

// 5. The fans fire off the computed context flags.
const baseHand = () => [...run('man', 1), ...run('man', 4), ...run('pin', 1), ...run('pin', 4), ...pair('bam', 5)];
const ctxOf = (extra) => ({ hand: baseHand(), melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false, ...extra });

check('edge-wait fan fires on ctx.wait', () => {
  const s = scoreWin(ctxOf({ wait: { single: true, shape: 'edge' } }), sanitizeRuleset({ mode: 'mcr-additive', patterns: { 'edge-wait': { enabled: true } } }));
  assert.ok(ids(s).includes('edge-wait'));
});
check('last-of-kind fan fires on ctx.lastOfKind', () => {
  const s = scoreWin(ctxOf({ lastOfKind: true }), sanitizeRuleset({ mode: 'mcr-additive', patterns: { 'last-of-kind': { enabled: true } } }));
  const e = s.breakdown.find(b => b.id === 'last-of-kind');
  assert.ok(e && e.points === 4, `last-of-kind ${JSON.stringify(e)}`);
});
check('melded-hand fan fires on ctx.meldedHand', () => {
  const s = scoreWin(ctxOf({ meldedHand: true }), sanitizeRuleset({ mode: 'mcr-additive', patterns: { 'melded-hand': { enabled: true } } }));
  const e = s.breakdown.find(b => b.id === 'melded-hand');
  assert.ok(e && e.points === 6, `melded-hand ${JSON.stringify(e)}`);
});

console.log(`\n${passed} wait tests passed`);
if (process.exitCode) console.error('WAIT TESTS FAILED');
