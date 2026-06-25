const assert = require('assert');
let passed = 0;
function check(name, fn){ try { fn(); passed++; console.log('  ✓', name); }
  catch(e){ console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; } }

(async () => {
  const core = await import('../public/shared/indicator-core.js');

  check('TIMING exposes tunable slide + reveal durations', () => {
    assert.strictEqual(typeof core.TIMING.tokenSlideMs, 'number');
    assert.strictEqual(typeof core.TIMING.discardRevealMs, 'number');
  });

  check('timerFraction clamps and guards total<=0', () => {
    assert.strictEqual(core.timerFraction(500, 1000), 0.5);
    assert.strictEqual(core.timerFraction(2000, 1000), 1);
    assert.strictEqual(core.timerFraction(-5, 1000), 0);
    assert.strictEqual(core.timerFraction(500, 0), 0);
  });

  check('secondsLeft ceils, never negative', () => {
    assert.strictEqual(core.secondsLeft(4200), 5);
    assert.strictEqual(core.secondsLeft(0), 0);
    assert.strictEqual(core.secondsLeft(-10), 0);
  });

  check('rampColor: gold >0.5, orange >0.2, red otherwise', () => {
    assert.strictEqual(core.rampColor(0.9), '#f0c040');
    assert.strictEqual(core.rampColor(0.5), '#ff9800');
    assert.strictEqual(core.rampColor(0.2), '#f44336');
    assert.strictEqual(core.rampColor(0), '#f44336');
  });

  check('haloDashArray maps frac to "<lit> 100"', () => {
    assert.strictEqual(core.haloDashArray(0.55), '55.00 100');
    assert.strictEqual(core.haloDashArray(1), '100.00 100');
    assert.strictEqual(core.haloDashArray(-1), '0.00 100');
  });

  check('liveClock: claim window in claim/rob, turn clock in discard', () => {
    assert.deepStrictEqual(core.liveClock({ phase:'claim', claimDeadline:1000, reactTimer:5 }),
      { kind:'claim', deadline:1000, totalMs:5000 });
    assert.strictEqual(core.liveClock({ phase:'rob', claimDeadline:7, reactTimer:8 }).totalMs, 8000);
    assert.deepStrictEqual(core.liveClock({ phase:'discard', turnDeadline:9, turnTotal:30000 }),
      { kind:'turn', deadline:9, totalMs:30000 });
    assert.deepStrictEqual(core.liveClock({ phase:'discard', turnDeadline:9, turnTimer:12 }),
      { kind:'turn', deadline:9, totalMs:12000 });
  });

  check('liveClock null when off (e.g. a bot turn with no turnDeadline)', () => {
    assert.strictEqual(core.liveClock(null), null);
    assert.strictEqual(core.liveClock({ phase:'discard', turnDeadline:0 }), null);
    assert.strictEqual(core.liveClock({ phase:'claim', claimDeadline:0 }), null);
  });

  check('currentDiscard returns lastDiscard in ANY phase (reveal works on auto-skip)', () => {
    const tile = { suit:'pin', value:9, id:'x' };
    assert.strictEqual(core.currentDiscard({ phase:'discard', lastDiscard: tile }), tile);
    assert.strictEqual(core.currentDiscard({ phase:'claim', lastDiscard: tile }), tile);
    assert.strictEqual(core.currentDiscard({ phase:'discard' }), null);
    assert.strictEqual(core.currentDiscard(null), null);
  });

  check('bestClaimAction precedence: win > kong > pong', () => {
    const noChow = () => [];
    assert.deepStrictEqual(core.bestClaimAction(['win','pong'], [], null, noChow), { type:'win', tileIds:[] });
    assert.deepStrictEqual(core.bestClaimAction(['kong','pong'], [], null, noChow), { type:'kong', tileIds:[] });
    assert.deepStrictEqual(core.bestClaimAction(['pong','chow'], [], null, noChow), { type:'pong', tileIds:[] });
  });

  check('bestClaimAction chow: single option → 2 hand tiles, discard excluded', () => {
    const d = { id:'d' }, a = { id:'a' }, b = { id:'b' };
    const getChow = () => [[a, b, d]];   // option includes the discard tile (as mahjong.js does)
    assert.deepStrictEqual(core.bestClaimAction(['chow'], [a, b], d, getChow),
      { type:'chow', tileIds:['a','b'] });
  });

  check('bestClaimAction chow: multiple options → null (ambiguous, no single tap)', () => {
    const d = { id:'d' }, a = { id:'a' }, b = { id:'b' }, c = { id:'c' };
    const getChow = () => [[a, b, d], [d, b, c]];
    assert.strictEqual(core.bestClaimAction(['chow'], [a, b, c], d, getChow), null);
  });

  check('localClaim: empty off a claim window or on our own discard', () => {
    const d = { id:'d' };
    const base = { phase:'claim', lastDiscard:d, lastDiscardPlayer:1, ruleset:'x',
      players:[{ hand:[d], melds:[] }, {}, {}, {}] };
    const gv = () => ['pong'];
    assert.deepStrictEqual(core.localClaim({ ...base, phase:'discard' }, 0, gv, () => []),
      { valid:[], action:null, ambiguous:false });
    assert.deepStrictEqual(core.localClaim({ ...base, lastDiscardPlayer:0 }, 0, gv, () => []),
      { valid:[], action:null, ambiguous:false });
  });

  check('localClaim: pong is actionable; ambiguous chow flags but has no action', () => {
    const d = { id:'d' }, a = { id:'a' }, b = { id:'b' }, c = { id:'c' };
    const gs = { phase:'claim', lastDiscard:d, lastDiscardPlayer:1, ruleset:'x',
      players:[{ hand:[a, b, c], melds:[] }, {}, {}, {}] };
    assert.deepStrictEqual(core.localClaim(gs, 0, () => ['pong'], () => []),
      { valid:['pong'], action:{ type:'pong', tileIds:[] }, ambiguous:false });
    const r = core.localClaim({ ...gs }, 0, () => ['chow'], () => [[a, b, d], [d, b, c]]);
    assert.strictEqual(r.action, null);
    assert.strictEqual(r.ambiguous, true);
    assert.deepStrictEqual(r.valid, ['chow']);
  });

  check('localClaim memoises on the gameState reference (one getValidClaims per update)', () => {
    const d = { id:'d' };
    const gs = { phase:'claim', lastDiscard:d, lastDiscardPlayer:1, ruleset:'x',
      players:[{ hand:[d], melds:[] }, {}, {}, {}] };
    let calls = 0;
    const gv = () => { calls++; return ['pong']; };
    const r1 = core.localClaim(gs, 0, gv, () => []);
    const r2 = core.localClaim(gs, 0, gv, () => []);   // same gs → cache hit
    assert.strictEqual(calls, 1);
    assert.strictEqual(r1, r2);
  });

  console.log(`\nindicator-core tests: ${passed} passed`);
})();
