// Unit tests for the faan scoring engine (scoring.js). Deterministic — builds
// specific hands and checks the faan total, patterns, and payments.
const assert = require('assert');
const { scoreWin, computePayments, DEFAULT_SCORING } = require('../scoring');

let _id = 0;
const t = (suit, value) => ({ suit, value, id: _id++ });
// chow/run of consecutive suited tiles
const run = (suit, start) => [t(suit, start), t(suit, start + 1), t(suit, start + 2)];
// triplet
const trip = (suit, value) => [t(suit, value), t(suit, value), t(suit, value)];
const pair = (suit, value) => [t(suit, value), t(suit, value)];

const cfg = DEFAULT_SCORING;
const ids = b => b.breakdown.map(x => x.id);

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

// 1. Concealed all-sequences (平糊) won by discard → all-chows + concealed = 2.
check('all sequences + concealed = 2 faan', () => {
  const hand = [...run('man', 1), ...run('man', 4), ...run('man', 7), ...run('pin', 1), ...pair('bam', 5)];
  const s = scoreWin({ hand, melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false }, cfg);
  assert.strictEqual(s.faan, 2, `got ${s.faan}`);
  assert.ok(ids(s).includes('all-chows') && ids(s).includes('concealed'));
});

// 2. All triplets with a dragon triplet → 對對糊(3) + dragon(1) + concealed(1) = 5.
check('all triplets + dragon = 5 faan', () => {
  const hand = [...trip('dragon', 'red'), ...trip('man', 1), ...trip('pin', 9), ...trip('bam', 5), ...pair('wind', 'east')];
  const s = scoreWin({ hand, melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false }, cfg);
  assert.strictEqual(s.faan, 5, `got ${s.faan}`);
  assert.ok(ids(s).includes('all-pungs') && ids(s).includes('dragon-pung'));
});

// 3. Big three dragons is a limit hand, capped at LIMIT_FAAN.
check('big three dragons = limit (13)', () => {
  const hand = [...trip('dragon', 'red'), ...trip('dragon', 'green'), ...trip('dragon', 'white'), ...trip('man', 1), ...pair('pin', 2)];
  const s = scoreWin({ hand, melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false }, cfg);
  assert.strictEqual(s.faan, 13, `got ${s.faan}`);
  assert.ok(s.isLimit);
});

// 4. Full flush (清一色): one suit, no honours → flush(7) + concealed(1) = 8.
check('full flush = 8 faan', () => {
  const hand = [...run('man', 1), ...run('man', 4), ...run('man', 7), ...trip('man', 1), ...pair('man', 9)];
  const s = scoreWin({ hand, melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false }, cfg);
  assert.strictEqual(s.faan, 8, `got ${s.faan}`);
  assert.ok(ids(s).includes('full-flush'));
});

// 5. Seat + round wind triplets each score (連風 when equal).
check('seat & round wind triplets', () => {
  const hand = [...trip('wind', 'east'), ...trip('wind', 'south'), ...run('man', 1), ...run('pin', 4), ...pair('bam', 5)];
  const s = scoreWin({ hand, melds: [], seatWind: 'east', roundWind: 'south', selfDraw: false }, cfg);
  // seat(1) + round(1) + concealed(1) = 3
  assert.strictEqual(s.faan, 3, `got ${s.faan}`);
  assert.ok(ids(s).includes('seat-wind') && ids(s).includes('round-wind'));
});

// 6. Chicken hand (雞糊): an exposed pung, mixed shapes, no honours → 0 faan, 1 point.
check('chicken hand = 0 faan, 1 point', () => {
  const hand = [...run('man', 1), ...run('man', 4), ...run('bam', 7), ...pair('bam', 2)];
  const melds = [{ type: 'pong', tiles: trip('pin', 5) }];
  const s = scoreWin({ hand, melds, seatWind: 'east', roundWind: 'east', selfDraw: false }, cfg);
  assert.strictEqual(s.faan, 0, `got ${s.faan}`);
  assert.strictEqual(s.points, 1, `got ${s.points}`);
});

// 7. The best decomposition wins: 222333444 reads as three runs (all-chows) not three pungs.
check('picks highest-scoring decomposition', () => {
  const hand = [...trip('man', 2), ...trip('man', 3), ...trip('man', 4), ...run('pin', 7), ...pair('man', 5)];
  const s = scoreWin({ hand, melds: [], seatWind: 'east', roundWind: 'east', selfDraw: false }, cfg);
  // all four sets readable as chows → all-chows(1) + concealed(1) = 2
  assert.strictEqual(s.faan, 2, `got ${s.faan}`);
  assert.ok(ids(s).includes('all-chows'));
});

// 8. Payments: self-draw collects from all; discard win is paid by the discarder.
check('payments: self-draw vs discard', () => {
  const score = { points: 8 };
  const tsumo = computePayments(score, 0, 4, true, null, cfg);
  assert.deepStrictEqual(tsumo, [24, -8, -8, -8]);
  const ron = computePayments(score, 1, 4, false, 3, cfg);
  assert.deepStrictEqual(ron, [0, 8, 0, -8]);
});

console.log(`\n${passed} scoring tests passed`);
if (process.exitCode) { console.error('SCORING TESTS FAILED'); }
