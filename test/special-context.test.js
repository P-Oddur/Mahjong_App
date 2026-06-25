// The special-hand scorers (七對 / 十三幺 / knitted) must apply the situational
// context fans (自摸, 海底, 槓上開花, 搶槓 …) just like the normal decomposition
// path — both in MCR additive mode and HK mode. Previously these out-of-band
// scorers dropped them, understating self-drawn / last-tile special hands.
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
const trip = (suit, value) => [t(suit, value), t(suit, value), t(suit, value)];
const pair = (suit, value) => [t(suit, value), t(suit, value)];
const ids = s => s.breakdown.map(b => b.id);
const ctx = (hand, extra) => ({ hand, melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false, ...extra });

// Mixed-suit seven pairs (no flush bonus).
const sevenPairsHand = () => [...pair('man', 1), ...pair('pin', 2), ...pair('bam', 3), ...pair('man', 4), ...pair('pin', 5), ...pair('bam', 6), ...pair('man', 7)];
const thirteenOrphansHand = () => [t('man', 1), t('man', 9), t('pin', 1), t('pin', 9), t('bam', 1), t('bam', 9),
  t('wind', 'east'), t('wind', 'south'), t('wind', 'west'), t('wind', 'north'), t('dragon', 'red'), t('dragon', 'green'), t('dragon', 'white'), t('man', 1)];
// 組合龍: full knitted 1-9 + pung + pair.
const knittedStraightHand = () => [t('man', 1), t('man', 4), t('man', 7), t('pin', 2), t('pin', 5), t('pin', 8), t('bam', 3), t('bam', 6), t('bam', 9),
  ...trip('dragon', 'red'), ...pair('wind', 'east')];
const greaterHand = () => [t('man', 1), t('man', 4), t('man', 7), t('pin', 2), t('pin', 5), t('pin', 8), t('bam', 3),
  t('wind', 'east'), t('wind', 'south'), t('wind', 'west'), t('wind', 'north'), t('dragon', 'red'), t('dragon', 'green'), t('dragon', 'white')];

check('MCR 七對: 門前清 on a discard win, 自摸 + 不求人 on a self-draw', () => {
  const base = scoreWin(ctx(sevenPairsHand()), PRESETS['mcr-official']);
  const sd = scoreWin(ctx(sevenPairsHand(), { selfDraw: true }), PRESETS['mcr-official']);
  assert.ok(!ids(base).includes('self-draw') && ids(base).includes('concealed'), '門前清 on a concealed discard win');
  assert.ok(ids(sd).includes('self-draw') && ids(sd).includes('fully-concealed-hand'), '自摸 + 不求人 on a self-draw');
  assert.ok(!ids(sd).includes('concealed'), '不求人 supersedes 門前清 (mutually exclusive)');
  // 七對24 + 門前清2 = 26 (discard);  七對24 + 自摸1 + 不求人4 = 29 (self-draw)
  assert.strictEqual(base.value, 26, `discard ${base.value}`);
  assert.strictEqual(sd.value, 29, `self-draw ${sd.value}`);
});

check('MCR 十三幺 self-draw adds 自摸', () => {
  const sd = scoreWin(ctx(thirteenOrphansHand(), { selfDraw: true }), PRESETS['mcr-official']);
  assert.ok(ids(sd).includes('thirteen-orphans'));
  assert.ok(ids(sd).includes('self-draw'), 'self-draw fan present on a self-drawn 十三幺');
});

check('MCR 組合龍: 門前清 on a discard win, 自摸 + 不求人 on a self-draw', () => {
  const base = scoreWin(ctx(knittedStraightHand()), PRESETS['mcr-official']);
  const sd = scoreWin(ctx(knittedStraightHand(), { selfDraw: true }), PRESETS['mcr-official']);
  assert.ok(ids(base).includes('concealed'), '門前清 on a concealed discard win');
  assert.ok(ids(sd).includes('self-draw') && ids(sd).includes('fully-concealed-hand'), '自摸 + 不求人 on a self-draw');
  // 組合龍12 + 門前清2 = 14 (discard);  組合龍12 + 自摸1 + 不求人4 = 17 (self-draw)
  assert.strictEqual(base.value, 14, `discard ${base.value}`);
  assert.strictEqual(sd.value, 17, `self-draw ${sd.value}`);
});

check('HK knitted (七星不靠) self-draw adds 自摸 faan', () => {
  const rs = sanitizeRuleset({ mode: 'hk-doubling', allow: { greaterKnitted: true } });
  const base = scoreWin(ctx(greaterHand()), rs);
  const sd = scoreWin(ctx(greaterHand(), { selfDraw: true }), rs);
  assert.ok(ids(sd).includes('self-draw'), 'self-draw fan present');
  assert.strictEqual(sd.faan, base.faan + 1, `self-draw adds 1 faan (base ${base.faan}, sd ${sd.faan})`);
});

console.log(`\n${passed} special-hand context tests passed`);
if (process.exitCode) console.error('SPECIAL-CONTEXT TESTS FAILED');
