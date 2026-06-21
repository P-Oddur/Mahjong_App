// Tests for the ruleset model + sanitizer (rulesets.js) and the back-compat
// shim that lets scoreWin/computePayments accept a ruleset while HK Standard
// reproduces the legacy {minFaan,limitFaan,basePoints} behaviour exactly.
const assert = require('assert');
const { PRESETS, sanitizeRuleset } = require('../rulesets');
const { scoreWin, DEFAULT_SCORING } = require('../scoring');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

let _id = 0;
const t = (suit, value) => ({ suit, value, id: _id++ });
const run = (suit, start) => [t(suit, start), t(suit, start + 1), t(suit, start + 2)];
const pair = (suit, value) => [t(suit, value), t(suit, value)];

// 1. HK Standard preset exists and mirrors the legacy defaults.
check('HK Standard preset matches legacy DEFAULT_SCORING', () => {
  const p = PRESETS['hk-standard'];
  assert.ok(p && p.builtin && p.mode === 'hk-doubling');
  assert.strictEqual(p.hk.minFaan, DEFAULT_SCORING.minFaan);
  assert.strictEqual(p.hk.limitFaan, DEFAULT_SCORING.limitFaan);
  assert.strictEqual(p.hk.basePoints, DEFAULT_SCORING.basePoints);
  assert.deepStrictEqual(p.patterns, {});
});

// 2. sanitizeRuleset({}) yields a complete, safe HK-Standard-shaped ruleset.
check('sanitizeRuleset({}) → complete HK Standard skeleton', () => {
  const r = sanitizeRuleset({});
  assert.strictEqual(r.mode, 'hk-doubling');
  assert.strictEqual(r.hk.limitFaan, 13);
  assert.deepStrictEqual(r.grouped.breakpoints, [3, 5, 8, 11]);
  assert.strictEqual(r.mcr.minPoints, 8);
  assert.ok(r.allow && typeof r.allow === 'object');
});

// 3. Invalid mode falls back to hk-doubling.
check('invalid mode → hk-doubling', () => {
  assert.strictEqual(sanitizeRuleset({ mode: 'nonsense' }).mode, 'hk-doubling');
  assert.strictEqual(sanitizeRuleset({ mode: 'mcr-additive' }).mode, 'mcr-additive');
});

// 4. Numeric params are clamped to safe ranges.
check('clamps limitFaan, minFaan, basePoints', () => {
  const r = sanitizeRuleset({ hk: { limitFaan: 9999, minFaan: 50, basePoints: -3 } });
  assert.ok(r.hk.limitFaan <= 26, `limitFaan ${r.hk.limitFaan}`);
  assert.ok(r.hk.minFaan <= r.hk.limitFaan, `minFaan ${r.hk.minFaan} > limit`);
  assert.ok(r.hk.basePoints >= 1, `basePoints ${r.hk.basePoints}`);
});

// 5. grouped.breakpoints must be strictly ascending positive ints, else default.
check('breakpoints validation', () => {
  assert.deepStrictEqual(sanitizeRuleset({ grouped: { breakpoints: [2, 2, 5] } }).grouped.breakpoints, [3, 5, 8, 11]);
  assert.deepStrictEqual(sanitizeRuleset({ grouped: { breakpoints: [1, 4, 9] } }).grouped.breakpoints, [1, 4, 9]);
  assert.deepStrictEqual(sanitizeRuleset({ grouped: { breakpoints: 'x' } }).grouped.breakpoints, [3, 5, 8, 11]);
});

// 6. Unknown pattern ids are dropped; known ones survive with coerced fields.
check('pattern override whitelisting + coercion', () => {
  const r = sanitizeRuleset({ patterns: {
    'all-pungs': { enabled: true, faan: 4, points: 6 },
    'not-a-real-pattern': { enabled: true, faan: 9 },
  } });
  assert.ok(r.patterns['all-pungs']);
  assert.strictEqual(r.patterns['all-pungs'].faan, 4);
  assert.ok(!('not-a-real-pattern' in r.patterns));
});

// 7. Prototype-pollution attempt is rejected.
check('rejects __proto__ / prototype pollution', () => {
  const evil = JSON.parse('{"patterns":{"__proto__":{"polluted":true}}}');
  const r = sanitizeRuleset(evil);
  assert.strictEqual(({}).polluted, undefined, 'Object prototype polluted!');
  assert.ok(!('__proto__' in r.patterns) || r.patterns.__proto__ === undefined);
});

// 8. Back-compat: scoring with the HK Standard ruleset === scoring with legacy cfg.
check('HK Standard ruleset scores identically to legacy DEFAULT_SCORING', () => {
  const hand = [...run('man', 1), ...run('man', 4), ...run('pin', 1), ...run('pin', 4), ...pair('bam', 5)];
  const ctx = { hand, melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false };
  const legacy = scoreWin(ctx, DEFAULT_SCORING);
  const viaRuleset = scoreWin(ctx, PRESETS['hk-standard']);
  assert.strictEqual(viaRuleset.faan, legacy.faan);
  assert.strictEqual(viaRuleset.points, legacy.points);
  assert.deepStrictEqual(viaRuleset.breakdown.map(b => b.id), legacy.breakdown.map(b => b.id));
});

console.log(`\n${passed} ruleset tests passed`);
if (process.exitCode) console.error('RULESET TESTS FAILED');
