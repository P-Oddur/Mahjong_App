// Tests for the HK-mode non-repeat rule ("suppress redundant fans only").
// In HK modes (hk-doubling / hk-grouped) a fan that is (transitively) implied by
// another present fan is absorbed — EXCEPT the genuine honour yakuhai
// (三元牌 / 門風 / 圈風), which HK counts additively on top of named hands.
// MCR additive mode keeps its own (stricter) absorption and must be unchanged.
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
const ctxOf = (hand, extra = {}) => ({ hand, melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false, ...extra });
const ids = s => s.breakdown.map(b => b.id);
const hkExt = sanitizeRuleset(PRESETS['hk-extended']);

// A) Mixed Triple Chow absorbs Mixed Double Chow (pure restatement).
check('HK: 三色三同順 absorbs 喜相逢 (A → 5 faan)', () => {
  const hand = [...run('man', 1), ...run('pin', 1), ...run('bam', 1), ...run('man', 4), ...pair('pin', 7)];
  const s = scoreWin(ctxOf(hand), hkExt);
  assert.ok(ids(s).includes('mixed-triple-chow'), 'mixed-triple-chow kept');
  assert.ok(!ids(s).includes('mixed-double-chow'), 'mixed-double-chow absorbed');
  assert.strictEqual(s.faan, 5, `faan ${s.faan}`); // concealed1 + all-chows1 + short-straight1 + mixed-triple-chow2
});

// B) Small Three Dragons absorbs Two Dragon Pungs but KEEPS the additive 三元牌.
check('HK: 小三元 absorbs 雙箭刻 but keeps 三元牌 (B → 8 faan)', () => {
  const hand = [...trip('dragon', 'red'), ...trip('dragon', 'green'), ...pair('dragon', 'white'),
                ...run('man', 1), ...run('pin', 4)];
  const s = scoreWin(ctxOf(hand), hkExt);
  assert.ok(ids(s).includes('small-three-dragons'), 'small-three-dragons kept');
  assert.ok(ids(s).includes('dragon-pung'), '三元牌 is additive — must stay');
  assert.ok(!ids(s).includes('two-dragon-pungs'), '雙箭刻 absorbed by 小三元');
  assert.strictEqual(s.faan, 8, `faan ${s.faan}`); // concealed1 + dragon×2 + s3d3 + 2concealed1 + voided1
});

// C) Triple Pung absorbs Double Pung.
check('HK: 三同刻 absorbs 雙同刻 (C → 3 faan)', () => {
  const melds = [
    { type: 'pong', tiles: trip('man', 5) },
    { type: 'pong', tiles: trip('pin', 5) },
    { type: 'pong', tiles: trip('bam', 5) },
  ];
  const s = scoreWin({ hand: [...run('man', 1), ...pair('pin', 9)], melds, seatWind: 'east', roundWind: 'east', selfDraw: false }, hkExt);
  assert.ok(ids(s).includes('triple-pung'), 'triple-pung kept');
  assert.ok(!ids(s).includes('double-pung'), 'double-pung absorbed');
  assert.strictEqual(s.faan, 3, `faan ${s.faan}`);
});

// Regression: MCR additive still absorbs the 三元牌 (stricter than HK) — unchanged.
check('MCR: 小三元 still absorbs 三元牌 (unchanged)', () => {
  const hand = [...trip('dragon', 'red'), ...trip('dragon', 'green'), ...pair('dragon', 'white'),
                ...run('man', 1), ...run('pin', 4)];
  const s = scoreWin(ctxOf(hand), PRESETS['mcr-official']);
  assert.ok(ids(s).includes('small-three-dragons'), 'small-three-dragons present');
  assert.ok(!ids(s).includes('dragon-pung'), 'MCR absorbs 三元牌 into 小三元');
  assert.ok(!ids(s).includes('two-dragon-pungs'), 'MCR absorbs 雙箭刻');
});

// Regression: HK Standard is unaffected (doesn't enable the structural fans; the
// 小三元⇒三元牌 edge keeps the additive triplet, so nothing changes).
check('HK Standard: 小三元 unchanged (三元牌 kept, 雙箭刻 never enabled)', () => {
  const hand = [...trip('dragon', 'red'), ...trip('dragon', 'green'), ...pair('dragon', 'white'),
                ...run('man', 1), ...run('pin', 4)];
  const s = scoreWin(ctxOf(hand), sanitizeRuleset({})); // HK Standard
  assert.ok(ids(s).includes('dragon-pung'), '三元牌 present');
  assert.ok(ids(s).includes('small-three-dragons'), '小三元 present');
  assert.ok(!ids(s).includes('two-dragon-pungs'), '雙箭刻 not enabled in Standard');
});

console.log(`\n${passed} HK non-repeat tests passed`);
if (process.exitCode) console.error('HK-NONREPEAT TESTS FAILED');
