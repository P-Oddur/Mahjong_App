// Tests for the expressible MCR structural patterns (default-off) + the HK
// Extended preset. Each pattern is enabled via a ruleset, given its canonical
// hand, and checked for presence + faan. HK Standard must ignore them all.
const assert = require('assert');
const { scoreWin } = require('../scoring');
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

const enable = (...ids) => sanitizeRuleset({ patterns: Object.fromEntries(ids.map(id => [id, { enabled: true }])) });
const ctxOf = (hand, extra = {}) => ({ hand, melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false, ...extra });
const entry = (s, id) => s.breakdown.find(b => b.id === id);

function pat(name, id, hand, expectFaan, extra) {
  check(`${name} (${id})`, () => {
    const s = scoreWin(ctxOf(hand, extra), enable(id));
    const e = entry(s, id);
    assert.ok(e, `${id} not in breakdown: ${s.breakdown.map(b => b.id)}`);
    if (expectFaan != null && !e.limit) assert.strictEqual(e.faan, expectFaan, `${id} faan ${e.faan}`);
  });
}

pat('Mixed Double Chow', 'mixed-double-chow',
  [...run('man', 1), ...run('pin', 1), ...run('bam', 4), ...run('bam', 7), ...pair('man', 9)], 1);
pat('Mixed Triple Chow', 'mixed-triple-chow',
  [...run('man', 3), ...run('pin', 3), ...run('bam', 3), ...run('man', 6), ...pair('pin', 9)], 2);
pat('Mixed Straight', 'mixed-straight',
  [...run('man', 1), ...run('pin', 4), ...run('bam', 7), ...trip('man', 9), ...pair('pin', 2)], 2);
pat('Pure Shifted Chows', 'pure-shifted-chows',
  [...run('man', 1), ...run('man', 3), ...run('man', 5), ...trip('pin', 9), ...pair('bam', 2)], 3);
pat('Triple Pung', 'triple-pung',
  [...trip('man', 5), ...trip('pin', 5), ...trip('bam', 5), ...trip('man', 1), ...pair('wind', 'east')], 3);
pat('Double Pung', 'double-pung',
  [...trip('man', 5), ...trip('pin', 5), ...run('bam', 1), ...run('bam', 4), ...pair('wind', 'east')], 1);
pat('All Types', 'all-types',
  [...run('man', 1), ...run('pin', 4), ...trip('bam', 9), ...trip('wind', 'east'), ...pair('dragon', 'red')], 2);
pat('All Simples', 'all-simples',
  [...run('man', 2), ...run('pin', 3), ...run('bam', 4), ...trip('pin', 6), ...pair('bam', 5)], 1);
pat('Outside Hand', 'outside-hand',
  [...trip('man', 1), ...run('pin', 1), ...run('bam', 7), ...trip('dragon', 'red'), ...pair('man', 9)], 2);
pat('Two Concealed Pungs', 'two-concealed-pungs',
  [...trip('man', 1), ...trip('pin', 9), ...run('bam', 1), ...run('bam', 4), ...pair('man', 5)], 1);
pat('Big Three Winds', 'big-three-winds',
  [...trip('wind', 'east'), ...trip('wind', 'south'), ...trip('wind', 'west'), ...run('man', 1), ...pair('pin', 5)], 3);
pat('All Even Pungs', 'all-even-pungs',
  [...trip('man', 2), ...trip('pin', 4), ...trip('bam', 6), ...trip('man', 8), ...pair('pin', 2)], 5);
pat('Reversible Tiles', 'reversible-tiles',
  [...run('pin', 1), ...run('pin', 3), ...trip('bam', 5), ...trip('dragon', 'white'), ...pair('bam', 2)], 2);

// All Green is a limit hand.
check('All Green (all-green) = limit', () => {
  const hand = [...trip('bam', 2), ...trip('bam', 3), ...trip('bam', 6), ...trip('dragon', 'green'), ...pair('bam', 8)];
  const s = scoreWin(ctxOf(hand), enable('all-green'));
  assert.ok(s.isLimit, 'should be limit');
  assert.ok(entry(s, 'all-green'), 'all-green in breakdown');
});

// HK Standard ignores every new pattern.
check('HK Standard ignores MCR patterns', () => {
  const hand = [...run('man', 3), ...run('pin', 3), ...run('bam', 3), ...run('man', 6), ...pair('pin', 9)];
  const s = scoreWin(ctxOf(hand), sanitizeRuleset({})); // HK Standard
  assert.strictEqual(s.faan, 2, `got ${s.faan}`); // all-chows + concealed only
  const ids = s.breakdown.map(b => b.id);
  assert.ok(!ids.includes('mixed-triple-chow') && !ids.includes('mixed-double-chow'));
});

// HK Extended enables them.
check('HK Extended enables MCR structural patterns', () => {
  const hand = [...run('man', 3), ...run('pin', 3), ...run('bam', 3), ...run('man', 6), ...pair('pin', 9)];
  const s = scoreWin(ctxOf(hand), PRESETS['hk-extended']);
  assert.ok(s.breakdown.map(b => b.id).includes('mixed-triple-chow'));
});

console.log(`\n${passed} MCR-extended tests passed`);
if (process.exitCode) console.error('MCR-EXTENDED TESTS FAILED');
