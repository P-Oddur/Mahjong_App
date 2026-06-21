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
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

check('register a new user → starts at 1000', () => {
  const r = accounts.loginOrRegister('Josh', '1234');
  assert.ok(r.ok && r.token, 'should register and return a token');
  assert.strictEqual(r.balance, 1000);
  assert.strictEqual(r.name, 'Josh');
});

check('login is case-insensitive and verifies the PIN', () => {
  const ok = accounts.loginOrRegister('josh', '1234'); // same account, different case
  assert.ok(ok.ok, 'correct PIN logs in');
  const bad = accounts.loginOrRegister('JOSH', '0000');
  assert.ok(!bad.ok && /pin/i.test(bad.error), 'wrong PIN is rejected');
});

check('validation: name length + 4-digit PIN', () => {
  assert.ok(!accounts.loginOrRegister('', '1234').ok, 'empty name');
  assert.ok(!accounts.loginOrRegister('Bob', '12').ok, 'short PIN');
  assert.ok(!accounts.loginOrRegister('Bob', 'abcd').ok, 'non-numeric PIN');
});

check('token round-trips, bad token rejected', () => {
  const r = accounts.loginOrRegister('Mei', '4321');
  const u = accounts.verifyToken(r.token);
  assert.ok(u && u.name === 'Mei' && u.balance === 1000);
  assert.strictEqual(accounts.verifyToken('not-a-token'), null);
});

check('balance changes persist across a reopen', () => {
  accounts.addToBalance('josh', -150);
  accounts.addToBalance('josh', +50); // net -100 → 900
  accounts.open(tmp);                 // reopen the same file
  assert.strictEqual(accounts.balanceOf('josh'), 900);
});

check('rate-limit locks a name after repeated wrong PINs', () => {
  accounts.loginOrRegister('Lin', '1111');                       // create
  for (let i = 0; i < 5; i++) accounts.loginOrRegister('Lin', '9999'); // 5 wrong
  const r = accounts.loginOrRegister('Lin', '1111');             // correct, but locked
  assert.ok(!r.ok && /many tries|wait/i.test(r.error), 'should be locked out');
});

check('saveRuleset + listRulesets round-trip', () => {
  const r = accounts.saveRuleset('josh', 'House Rules', JSON.stringify({ mode: 'mcr-additive' }));
  assert.ok(r.ok && r.id, 'saved');
  const list = accounts.listRulesets('josh');
  assert.ok(list.some(x => x.name === 'House Rules' && x.ruleset.mode === 'mcr-additive'));
});

check('saving the same name updates in place (no duplicate)', () => {
  accounts.saveRuleset('josh', 'House Rules', JSON.stringify({ mode: 'hk-grouped' }));
  const list = accounts.listRulesets('josh').filter(x => x.name === 'House Rules');
  assert.strictEqual(list.length, 1, 'no duplicate name');
  assert.strictEqual(list[0].ruleset.mode, 'hk-grouped', 'updated');
});

check('getRuleset + owner-scoped deleteRuleset', () => {
  const saved = accounts.saveRuleset('josh', 'ToDelete', JSON.stringify({ mode: 'hk-doubling' }));
  assert.ok(accounts.getRuleset(saved.id), 'getRuleset finds it');
  accounts.deleteRuleset('mei', saved.id);               // wrong owner → no-op
  assert.ok(accounts.getRuleset(saved.id), 'not deleted by a different owner');
  accounts.deleteRuleset('josh', saved.id);
  assert.strictEqual(accounts.getRuleset(saved.id), null, 'deleted by owner');
});

check('rejects an oversized ruleset json', () => {
  const r = accounts.saveRuleset('josh', 'Big', 'x'.repeat(20001));
  assert.ok(!r.ok && /large/i.test(r.error));
});

console.log(`\n${passed} account tests passed`);
try { fs.unlinkSync(tmp); } catch {}
