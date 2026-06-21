// Drives every canonical example hand through the probe (the exact server
// engine) and asserts the named pattern shows up in the breakdown. This is the
// single source of truth the sandbox's "run all" grid also uses.
const assert = require('assert');
const { probeScore } = require('../probe');
const { EXAMPLES } = require('../canonical-examples');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

for (const ex of EXAMPLES) {
  check(`${ex.id} — ${ex.label}`, () => {
    const { score } = probeScore(ex.ruleset, ex.ctx);
    const ids = score.breakdown.map(b => b.id);
    assert.ok(ids.includes(ex.id), `'${ex.id}' not in breakdown: [${ids.join(', ')}]`);
  });
}

console.log(`\n${passed}/${EXAMPLES.length} canonical examples verified`);
if (process.exitCode) console.error('CATALOG TESTS FAILED');
