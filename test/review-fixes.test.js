// Regression tests for the pre-upstream code-review remediation. Each test pins a
// specific fix (lettered by the plan's groups) so it can't silently regress.
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
const pair = (suit, value) => [t(suit, value), t(suit, value)];
const ctxOf = (hand, extra) => ({ hand, melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false, ...extra });
const ids = s => s.breakdown.map(b => b.id);

// ── B4: 清龍 (Pure Straight) absorbs 連六 + 老少副 in MCR no-repeat ──────────────
check('B4: 清龍 absorbs 連六 + 老少副 in MCR (no double-count)', () => {
  const hand = [...run('man', 1), ...run('man', 4), ...run('man', 7), ...run('pin', 2), ...pair('pin', 7)];
  const b = ids(scoreWin(ctxOf(hand), PRESETS['mcr-official']));
  assert.ok(b.includes('pure-straight'), '清龍 present');
  assert.ok(!b.includes('short-straight'), '連六 absorbed by 清龍');
  assert.ok(!b.includes('two-terminal-chows'), '老少副 absorbed by 清龍');
});

// ── B5: Thirteen Orphans honours an HK per-pattern faan override ────────────────
const thirteenOrphans = () => [t('man', 1), t('man', 9), t('pin', 1), t('pin', 9), t('bam', 1), t('bam', 9),
  t('wind', 'east'), t('wind', 'south'), t('wind', 'west'), t('wind', 'north'),
  t('dragon', 'red'), t('dragon', 'green'), t('dragon', 'white'), t('man', 1)];
check('B5: 十三幺 HK faan override is honoured', () => {
  const def = scoreWin(ctxOf(thirteenOrphans()), sanitizeRuleset({ mode: 'hk-doubling' }));
  assert.ok(def.isLimit && def.faan === 13, `default stays a limit hand (${def.faan})`);
  const ov = scoreWin(ctxOf(thirteenOrphans()), sanitizeRuleset({ patterns: { 'thirteen-orphans': { faan: 5 } } }));
  assert.strictEqual(ov.breakdown.find(b => b.id === 'thirteen-orphans').faan, 5, 'override applied to the faan');
  assert.ok(!ov.isLimit, 'below the cap → no longer a limit hand');
});

// ── B6: sanitizer keeps the special-hand allow flag and scoring `enabled` in sync ─
check('B6: allow.sevenPairs forces seven-pairs.enabled (no legal-but-zero win)', () => {
  // A raw/saved blob that allows the win but disables scoring — the desync source.
  const rs = sanitizeRuleset({ mode: 'hk-doubling', allow: { sevenPairs: true },
    patterns: { 'seven-pairs': { enabled: false } } });
  assert.strictEqual(rs.patterns['seven-pairs'].enabled, true, 'enabled forced to track allow');
  const hand = [...pair('man', 2), ...pair('man', 5), ...pair('pin', 3), ...pair('pin', 7),
    ...pair('bam', 1), ...pair('bam', 9), ...pair('dragon', 'red')];
  const s = scoreWin(ctxOf(hand), rs);
  assert.ok(s.breakdown.find(b => b.id === 'seven-pairs'), 'seven pairs actually scores');
  assert.ok(s.faan >= 4, `not floored to 0 (got ${s.faan})`);
});

// ── F5: MCR payout scales by mcr.basePoints (the bp != 1 branch was untested) ────
check('F5: MCR payout scales by mcr.basePoints', () => {
  const score = { mode: 'mcr-additive', value: 10 };
  const pay1 = computePayments(score, 0, 4, true, null, { mcr: { base: 8, basePoints: 1 } });
  const pay3 = computePayments(score, 0, 4, true, null, { mcr: { base: 8, basePoints: 3 } });
  // Self-draw: each of the 3 opponents pays (value + base) * bp = 18 * bp.
  assert.strictEqual(pay1[1], -18, `bp=1 opponent ${pay1[1]}`);
  assert.strictEqual(pay3[1], -54, `bp=3 opponent ${pay3[1]}`);
  assert.strictEqual(pay3[0], 162, `bp=3 winner collects 3*54 (${pay3[0]})`);
});

console.log(`\n${passed} review-fix regression tests passed`);
if (process.exitCode) console.error('REVIEW-FIX TESTS FAILED');
