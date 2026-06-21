// A pung COMPLETED BY A DISCARD (ron) is not a concealed pung (暗刻): only pungs
// formed in hand (or completed by self-draw) count toward 雙暗刻/三暗刻/四暗刻.
// The hand is still 門前清 (concealed) if no melds were exposed.
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
const concealedPungs = sanitizeRuleset({ patterns: { 'two-concealed-pungs': { enabled: true }, 'three-concealed-pungs': { enabled: true } } });
const ids = s => s.breakdown.map(b => b.id);

// Build a hand with three pungs (man1, pin2, bam3) + a chow + pair; the winning
// tile completes the bam3 pung.
function handAndWin() {
  _id = 0;
  const bam3 = trip('bam', 3);
  const hand = [...trip('man', 1), ...trip('pin', 2), ...bam3, ...run('man', 5), ...pair('pin', 9)];
  return { hand, winningTile: bam3[2] };
}

check('ron: pung completed by the discard is NOT a 暗刻 (三暗刻 → 雙暗刻)', () => {
  const { hand, winningTile } = handAndWin();
  const s = scoreWin({ hand, melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false, winningTile }, concealedPungs);
  assert.ok(!ids(s).includes('three-concealed-pungs'), 'ron pung must not count → no 三暗刻');
  assert.ok(ids(s).includes('two-concealed-pungs'), 'the other two in-hand pungs are 雙暗刻');
  assert.ok(ids(s).includes('concealed'), 'hand is still 門前清 (no melds exposed)');
});

check('self-draw: the same hand IS 三暗刻 (self-drawn pung counts)', () => {
  const { hand, winningTile } = handAndWin();
  const s = scoreWin({ hand, melds: [], seatWind: 'east', roundWind: 'east', selfDraw: true, winningTile }, concealedPungs);
  assert.ok(ids(s).includes('three-concealed-pungs'), 'self-draw keeps all three concealed pungs');
});

check('ron completing the pair/chow leaves all in-hand pungs concealed', () => {
  _id = 0;
  // winning tile completes the PAIR (single wait), so both pungs stay concealed.
  const winningTile = t('pin', 9);
  const hand = [...trip('man', 1), ...trip('pin', 2), ...run('bam', 4), ...run('man', 5), t('pin', 9), winningTile];
  const s = scoreWin({ hand, melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false, winningTile }, concealedPungs);
  assert.ok(ids(s).includes('two-concealed-pungs'), 'man1 + pin2 pungs both concealed (ron hit the pair)');
});

console.log(`\n${passed} ron-concealed tests passed`);
if (process.exitCode) console.error('RON-CONCEALED TESTS FAILED');
