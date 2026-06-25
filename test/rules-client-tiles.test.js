// Unit tests for tileImageSrc (public/shared/rules-client.js) — the server-tile →
// rendered 2D face-image path mapping used by the shared hand-render module.
const assert = require('assert');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

(async () => {
  const { tileImageSrc } = await import('../public/shared/rules-client.js');

  check('maps numeric suits man/pin/bam', () => {
    assert.strictEqual(tileImageSrc({ suit: 'man', value: 1 }), '/assets/tiles2d/man1.png');
    assert.strictEqual(tileImageSrc({ suit: 'pin', value: 9 }), '/assets/tiles2d/pin9.png');
    assert.strictEqual(tileImageSrc({ suit: 'bam', value: 5 }), '/assets/tiles2d/bam5.png');
  });

  check('maps winds and dragons with an underscore', () => {
    assert.strictEqual(tileImageSrc({ suit: 'wind', value: 'east' }), '/assets/tiles2d/wind_east.png');
    assert.strictEqual(tileImageSrc({ suit: 'wind', value: 'north' }), '/assets/tiles2d/wind_north.png');
    assert.strictEqual(tileImageSrc({ suit: 'dragon', value: 'red' }), '/assets/tiles2d/dragon_red.png');
    assert.strictEqual(tileImageSrc({ suit: 'dragon', value: 'white' }), '/assets/tiles2d/dragon_white.png');
  });

  check('returns null for back, flowers, null, and unknown suits', () => {
    assert.strictEqual(tileImageSrc('back'), null);
    assert.strictEqual(tileImageSrc(null), null);
    assert.strictEqual(tileImageSrc({ suit: 'flower', value: 1 }), null);
    assert.strictEqual(tileImageSrc({ suit: 'flower', value: 8 }), null);
    assert.strictEqual(tileImageSrc({ suit: 'bogus', value: 1 }), null);
  });

  console.log(`\nrules-client tile-image tests: ${passed} passed`);
})();
