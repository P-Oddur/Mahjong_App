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
    const entry = score.breakdown.find(b => b.id === ex.id);
    // Stronger than mere presence: the named pattern must actually CONTRIBUTE — a limit hand,
    // or a positive faan/points — so a pattern that fires but scores 0 is caught.
    assert.ok(entry, `'${ex.id}' not in breakdown: [${score.breakdown.map(b => b.id).join(', ')}]`);
    assert.ok(entry.limit || (entry.points ?? entry.faan ?? 0) > 0, `'${ex.id}' contributed 0`);
  });
}

console.log(`\n${passed}/${EXAMPLES.length} canonical examples verified`);
if (process.exitCode) console.error('CATALOG TESTS FAILED');
