// Parity test: the server rules (mahjong.js, CJS) and the 3D-client copy
// (public/shared/rules-client.js, ESM) MUST agree exactly — they are maintained
// as verbatim twins. This runs a corpus of hands through both and asserts the
// shared functions return identical results. If they ever drift, this fails.
const assert = require('assert');
const path = require('path');
const url = require('url');
const M = require('../mahjong');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

(async () => {
  const clientUrl = url.pathToFileURL(path.join(__dirname, '..', 'public', 'shared', 'rules-client.js')).href;
  const C = await import(clientUrl);

  let _id = 0;
  const t = (suit, value) => ({ suit, value, id: _id++ });
  const run = (suit, s) => [t(suit, s), t(suit, s + 1), t(suit, s + 2)];
  const trip = (suit, v) => [t(suit, v), t(suit, v), t(suit, v)];
  const pair = (suit, v) => [t(suit, v), t(suit, v)];

  // 14-tile hands (hand, melds) spanning every win shape + a near-miss.
  const fixtures = [
    { hand: [...run('man', 1), ...run('man', 4), ...run('pin', 1), ...run('pin', 4), ...pair('bam', 5)], melds: [] },
    { hand: [...run('man', 1), ...run('man', 4), ...run('pin', 1), ...run('pin', 5), ...pair('bam', 5)], melds: [] }, // near-miss
    { hand: [...pair('man', 2), ...pair('man', 5), ...pair('pin', 3), ...pair('pin', 7), ...pair('bam', 1), ...pair('bam', 9), ...pair('dragon', 'red')], melds: [] }, // seven pairs
    { hand: [t('man', 1), t('man', 1), t('man', 9), t('pin', 1), t('pin', 9), t('bam', 1), t('bam', 9), t('wind', 'east'), t('wind', 'south'), t('wind', 'west'), t('wind', 'north'), t('dragon', 'red'), t('dragon', 'green'), t('dragon', 'white')], melds: [] }, // 十三幺
    { hand: [t('man', 1), t('man', 4), t('man', 7), t('pin', 2), t('pin', 5), t('pin', 8), t('bam', 3), t('wind', 'east'), t('wind', 'south'), t('wind', 'west'), t('wind', 'north'), t('dragon', 'red'), t('dragon', 'green'), t('dragon', 'white')], melds: [] }, // 七星不靠
    { hand: [...run('man', 1), ...run('man', 4), ...pair('bam', 5)], melds: [{ type: 'pong', tiles: trip('pin', 2) }, { type: 'chow', tiles: run('bam', 7) }] }, // with melds
  ];
  const rulesets = [
    undefined,
    { allow: { sevenPairs: true, thirteenOrphans: true, greaterKnitted: true, lesserKnitted: true, knittedStraight: true } },
    { allow: { sevenPairs: false, thirteenOrphans: false, greaterKnitted: false, lesserKnitted: false, knittedStraight: false } },
  ];

  check('checkWin parity across hands × rulesets', () => {
    for (const f of fixtures) for (const rs of rulesets) {
      assert.strictEqual(M.checkWin(f.hand, f.melds, rs), C.checkWin(f.hand, f.melds, rs),
        `checkWin mismatch (ruleset ${JSON.stringify(rs)})`);
    }
  });

  check('getValidClaims parity', () => {
    const hand = [...run('man', 1), t('man', 5), ...trip('pin', 3), ...pair('bam', 9), t('dragon', 'red'), t('dragon', 'red')];
    const discards = [t('man', 4), t('dragon', 'red'), t('pin', 3), t('bam', 9)];
    for (const d of discards) for (const next of [true, false]) for (const rs of rulesets) {
      assert.deepStrictEqual(M.getValidClaims(hand, [], d, next, rs), C.getValidClaims(hand, [], d, next, rs),
        `getValidClaims mismatch on ${d.suit}-${d.value}`);
    }
  });

  check('getChowOptions parity', () => {
    const hand = [t('man', 2), t('man', 3), t('man', 4), t('man', 5)];
    for (const d of [t('man', 3), t('man', 6), t('pin', 1)]) {
      const a = M.getChowOptions(hand, d).map(o => o.map(x => x.id).join(','));
      const b = C.getChowOptions(hand, d).map(o => o.map(x => x.id).join(','));
      assert.deepStrictEqual(a, b);
    }
  });

  check('sortTiles parity', () => {
    const tiles = [t('dragon', 'green'), t('man', 5), t('wind', 'north'), t('pin', 1), t('bam', 9), t('man', 1), t('wind', 'east')];
    const a = M.sortTiles(tiles).map(x => x.id);
    const b = C.sortTiles(tiles).map(x => x.id);
    assert.deepStrictEqual(a, b);
  });

  console.log(`\n${passed} parity tests passed`);
  if (process.exitCode) console.error('PARITY TESTS FAILED');
})();
