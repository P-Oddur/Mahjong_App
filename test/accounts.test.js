// Unit tests for the account store (accounts.js). Uses a throwaway temp DB file.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const accounts = require('../accounts');

const tmp = path.join(os.tmpdir(), `mahjong-accounts-${process.pid}.db`);
try { fs.unlinkSync(tmp); } catch {}
accounts.open(tmp);

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

(async () => {

await check('register a new user → starts at 1000', async () => {
  const r = await accounts.loginOrRegister('Josh', '1234');
  assert.ok(r.ok && r.token, 'should register and return a token');
  assert.strictEqual(r.balance, 1000);
  assert.strictEqual(r.name, 'Josh');
});

await check('login is case-insensitive and verifies the PIN', async () => {
  const ok = await accounts.loginOrRegister('josh', '1234'); // same account, different case
  assert.ok(ok.ok, 'correct PIN logs in');
  const bad = await accounts.loginOrRegister('JOSH', '0000');
  assert.ok(!bad.ok && /pin/i.test(bad.error), 'wrong PIN is rejected');
});

await check('validation: name length + 4-digit PIN', async () => {
  assert.ok(!(await accounts.loginOrRegister('', '1234')).ok, 'empty name');
  assert.ok(!(await accounts.loginOrRegister('Bob', '12')).ok, 'short PIN');
  assert.ok(!(await accounts.loginOrRegister('Bob', 'abcd')).ok, 'non-numeric PIN');
});

await check('token round-trips, bad token rejected', async () => {
  const r = await accounts.loginOrRegister('Mei', '4321');
  const u = accounts.verifyToken(r.token);
  assert.ok(u && u.name === 'Mei' && u.balance === 1000);
  assert.strictEqual(accounts.verifyToken('not-a-token'), null);
});

await check('expired session tokens are swept and rejected', async () => {
  const r = await accounts.loginOrRegister('Sess', '2468');
  assert.ok(accounts.verifyToken(r.token), 'fresh token is valid');
  accounts.sweepSessions(Date.now() + 1e12);              // force every token past its TTL
  assert.strictEqual(accounts.verifyToken(r.token), null, 'swept token no longer authenticates');
});

await check('balance changes persist across a reopen', async () => {
  accounts.addToBalance('josh', -150);
  accounts.addToBalance('josh', +50); // net -100 → 900
  accounts.open(tmp);                 // reopen the same file
  assert.strictEqual(accounts.balanceOf('josh'), 900);
});

await check('balance is floored at 0 (never negative)', async () => {
  await accounts.loginOrRegister('Floor', '1357');        // starts at 1000
  accounts.addToBalance('floor', -5000);                  // would be -4000 without a floor
  assert.strictEqual(accounts.balanceOf('floor'), 0, 'clamped to 0');
});

await check('rate-limit locks a name after repeated wrong PINs', async () => {
  await accounts.loginOrRegister('Lin', '1111');                       // create
  for (let i = 0; i < 5; i++) await accounts.loginOrRegister('Lin', '9999'); // 5 wrong
  const r = await accounts.loginOrRegister('Lin', '1111');             // correct, but locked
  assert.ok(!r.ok && /many tries|wait/i.test(r.error), 'should be locked out');
});

await check('lockout duration escalates and caps at 1h', () => {
  const f = accounts._lockDurationMs;
  assert.strictEqual(f(1), 60_000, 'first lock = 1 minute');
  assert.strictEqual(f(2), 120_000, 'second lock doubles');
  assert.strictEqual(f(3), 240_000, 'third lock doubles again');
  assert.ok(f(3) > f(2) && f(2) > f(1), 'each lockout is strictly longer (no flat reset)');
  assert.strictEqual(f(100), 60 * 60_000, 'capped at 1 hour');
});

await check('saveRuleset + listRulesets round-trip', async () => {
  const r = accounts.saveRuleset('josh', 'House Rules', JSON.stringify({ mode: 'mcr-additive' }));
  assert.ok(r.ok && r.id, 'saved');
  const list = accounts.listRulesets('josh');
  assert.ok(list.some(x => x.name === 'House Rules' && x.ruleset.mode === 'mcr-additive'));
});

await check('saving the same name updates in place (no duplicate)', async () => {
  accounts.saveRuleset('josh', 'House Rules', JSON.stringify({ mode: 'hk-grouped' }));
  const list = accounts.listRulesets('josh').filter(x => x.name === 'House Rules');
  assert.strictEqual(list.length, 1, 'no duplicate name');
  assert.strictEqual(list[0].ruleset.mode, 'hk-grouped', 'updated');
});

await check('getRuleset + owner-scoped deleteRuleset', async () => {
  const saved = accounts.saveRuleset('josh', 'ToDelete', JSON.stringify({ mode: 'hk-doubling' }));
  assert.ok(accounts.getRuleset(saved.id), 'getRuleset finds it');
  accounts.deleteRuleset('mei', saved.id);               // wrong owner → no-op
  assert.ok(accounts.getRuleset(saved.id), 'not deleted by a different owner');
  accounts.deleteRuleset('josh', saved.id);
  assert.strictEqual(accounts.getRuleset(saved.id), null, 'deleted by owner');
});

await check('rejects an oversized ruleset json', async () => {
  const r = accounts.saveRuleset('josh', 'Big', 'x'.repeat(20001));
  assert.ok(!r.ok && /large/i.test(r.error));
});

console.log(`\n${passed} account tests passed`);
try { fs.unlinkSync(tmp); } catch {}

})();
