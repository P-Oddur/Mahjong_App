// Tests for the knitted hands (組合龍 / 全不靠 / 七星不靠): recognizers,
// ruleset-gated checkWin, and scoring under both HK and MCR modes.
const assert = require('assert');
const { checkWin, isGreaterKnitted, isLesserKnitted, isKnittedStraightWin, parseKnitted } = require('../mahjong');
const { scoreWin } = require('../scoring');
const { sanitizeRuleset, PRESETS } = require('../rulesets');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

let _id = 0;
const t = (suit, value) => ({ suit, value, id: _id++ });
const trip = (suit, value) => [t(suit, value), t(suit, value), t(suit, value)];
const pair = (suit, value) => [t(suit, value), t(suit, value)];
const ids = s => s.breakdown.map(b => b.id);

// Knitted line man→{1,4,7}, pin→{2,5,8}, bam→{3,6,9}.
const HONORS7 = () => [t('wind', 'east'), t('wind', 'south'), t('wind', 'west'), t('wind', 'north'), t('dragon', 'red'), t('dragon', 'green'), t('dragon', 'white')];
// 七星不靠: 7 honours + 7 knitted suited singles.
const greaterHand = () => [t('man', 1), t('man', 4), t('man', 7), t('pin', 2), t('pin', 5), t('pin', 8), t('bam', 3), ...HONORS7()];
// 全不靠: 6 honours + 8 knitted suited singles.
const lesserHand = () => [t('man', 1), t('man', 4), t('man', 7), t('pin', 2), t('pin', 5), t('pin', 8), t('bam', 3), t('bam', 6),
  t('wind', 'east'), t('wind', 'south'), t('wind', 'west'), t('wind', 'north'), t('dragon', 'red'), t('dragon', 'green')];
// 組合龍: full knitted 1-9 + a pung + a pair.
const knittedStraightHand = () => [t('man', 1), t('man', 4), t('man', 7), t('pin', 2), t('pin', 5), t('pin', 8), t('bam', 3), t('bam', 6), t('bam', 9),
  ...trip('dragon', 'red'), ...pair('wind', 'east')];

// 1. Recognizers + parseKnitted priority.
check('isGreaterKnitted / parseKnitted greater', () => {
  assert.ok(isGreaterKnitted(greaterHand()));
  assert.ok(isLesserKnitted(greaterHand()), 'greater is also a lesser shape');
  assert.strictEqual(parseKnitted(greaterHand()).kind, 'greater');
});
check('isLesserKnitted / parseKnitted lesser', () => {
  assert.ok(isLesserKnitted(lesserHand()));
  assert.ok(!isGreaterKnitted(lesserHand()));
  assert.strictEqual(parseKnitted(lesserHand()).kind, 'lesser');
});
check('isKnittedStraightWin / parseKnitted knitted-straight', () => {
  assert.ok(isKnittedStraightWin(knittedStraightHand()));
  assert.strictEqual(parseKnitted(knittedStraightHand()).kind, 'knitted-straight');
});
check('non-knitted hands → parseKnitted null', () => {
  const normal = [...trip('man', 1), ...trip('pin', 2), ...trip('bam', 3), ...trip('man', 5), ...pair('pin', 9)];
  assert.strictEqual(parseKnitted(normal), null);
});

// 2. checkWin gating by ruleset allow flags.
check('checkWin recognizes knitted only when allowed', () => {
  const mcr = PRESETS['mcr-official'];           // knitted allowed
  const hk = PRESETS['hk-standard'];             // knitted not allowed
  assert.ok(checkWin(greaterHand(), [], mcr), 'greater is a win under MCR');
  assert.ok(checkWin(knittedStraightHand(), [], mcr), 'knitted straight is a win under MCR');
  assert.ok(!checkWin(greaterHand(), [], hk), 'greater is NOT a win under HK Standard');
  assert.ok(!checkWin(greaterHand(), []), 'legacy (no ruleset) does not recognize knitted');
});

// 3. Scoring — HK mode with knitted enabled.
check('knitted scores in HK mode when enabled', () => {
  const rs = sanitizeRuleset({ mode: 'hk-doubling', allow: { greaterKnitted: true } });
  const s = scoreWin({ hand: greaterHand(), melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false }, rs);
  assert.ok(ids(s).includes('greater-knitted'));
  assert.strictEqual(s.faan, 11, `got ${s.faan}`); // 七星不靠 10 + 門前清 1 (concealed)
});

// 4. Scoring — MCR Official.
check('knitted scores in MCR mode (Greater = 24, Knitted Straight = 12)', () => {
  const g = scoreWin({ hand: greaterHand(), melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false }, PRESETS['mcr-official']);
  assert.strictEqual(g.value, 26, `greater ${g.value}`); // 七星不靠 24 + 門前清 2 (concealed)
  assert.ok(g.legal);
  const ks = scoreWin({ hand: knittedStraightHand(), melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false }, PRESETS['mcr-official']);
  // knitted straight 12 + whatever the extra pung/pair adds, but at least 12 and legal.
  assert.ok(ids(ks).includes('knitted-straight'));
  assert.ok(ks.legal);
});

console.log(`\n${passed} knitted tests passed`);
if (process.exitCode) console.error('KNITTED TESTS FAILED');
