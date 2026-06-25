"use strict";
// Tiny username + 4-digit-PIN account store backed by node:sqlite (built into
// Node 24 — no dependency, no native build). Casual-grade: a 4-digit PIN is weak
// by design, so PINs are scrypt-hashed + salted and logins are rate-limited, but
// this is for fake-money fun among friends, not real authentication.
const { DatabaseSync } = require("node:sqlite");
const crypto = require("crypto");
const { promisify } = require("util");
const path = require("path");
const fs = require("fs");

const scrypt = promisify(crypto.scrypt); // async — keeps the slow KDF off the event loop

const START_BALANCE = 1000;
const MAX_ATTEMPTS = 5;             // wrong PINs before a lockout trips
const BASE_LOCK_MS = 60_000;        // first lockout; doubles each further trip (escalating backoff)
const MAX_LOCK_MS = 60 * 60_000;    // cap any single lockout at 1 hour
const ATTEMPT_TTL_MS = 60 * 60_000; // forget a name's failure history after an hour of no attempts
const SESSION_TTL_MS = 48 * 60 * 60_000; // a login token is valid for 48h

// In-memory (cleared on restart): failed-login throttle + active session tokens.
const attempts = new Map();   // key -> { count, lockLevel, lockedUntil, seen }
const sessions = new Map();   // token -> { username, createdAt }

let db = null;

// Open (or create) the database. Safe to call again to reopen a different file.
function open(dbPath) {
  const file = dbPath || path.join(__dirname, "data", "mahjong.db");
  if (db) { try { db.close(); } catch (_) {} }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,    -- normalized (lower-cased) key
    display  TEXT NOT NULL,       -- name as entered, for display
    pin_hash TEXT NOT NULL,
    salt     TEXT NOT NULL,
    balance  INTEGER NOT NULL DEFAULT ${START_BALANCE},
    created  INTEGER NOT NULL
  )`);
  // Saved custom scoring rulesets (added idempotently — existing DBs upgrade in
  // place). The JSON is a server-sanitized ruleset object.
  db.exec(`CREATE TABLE IF NOT EXISTS rulesets (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    owner   TEXT NOT NULL,        -- users.username key
    name    TEXT NOT NULL,
    json    TEXT NOT NULL,
    created INTEGER NOT NULL
  )`);
  return db;
}

async function hashPin(pin, salt) {
  return (await scrypt(String(pin), salt, 64)).toString("hex");
}
function safeEqual(aHex, bHex) {
  const a = Buffer.from(aHex, "hex"), b = Buffer.from(bHex, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const norm = name => String(name || "").trim();
const validName = name => norm(name).length >= 1 && norm(name).length <= 20;
const validPin = pin => /^\d{4}$/.test(String(pin || ""));

// Lockout duration for an escalation level: 1m, 2m, 4m, 8m … capped at MAX_LOCK_MS.
const lockDurationMs = level => Math.min(BASE_LOCK_MS * 2 ** (level - 1), MAX_LOCK_MS);

// Escalating, per-name lockout. Each time MAX_ATTEMPTS wrong PINs accumulate the
// lockout LEVEL bumps (so the next lock is longer) instead of resetting to a flat
// 60s window — sustained guessing backs off exponentially. A name's history is
// forgotten after ATTEMPT_TTL_MS of inactivity, and a successful login clears it
// (see loginOrRegister).
function bumpAttempt(key) {
  const now = Date.now();
  let a = attempts.get(key);
  if (!a || now - a.seen > ATTEMPT_TTL_MS) a = { count: 0, lockLevel: 0, lockedUntil: 0, seen: now };
  a.count += 1;
  a.seen = now;
  if (a.count >= MAX_ATTEMPTS) {
    a.lockLevel += 1;
    a.lockedUntil = now + lockDurationMs(a.lockLevel);
    a.count = 0; // reset the per-window counter; lockLevel persists so the next lock is longer
  }
  attempts.set(key, a);
}
function startSession(row) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { username: row.username, createdAt: Date.now() });
  return { ok: true, token, username: row.username, name: row.display, balance: row.balance };
}

// One entry point: registers a brand-new name, or logs into an existing one.
// Async because the scrypt KDF runs off-thread (so a burst of logins can't block
// the event loop / freeze live games).
async function loginOrRegister(name, pin) {
  const display = norm(name);
  if (!validName(display)) return { ok: false, error: "Name must be 1–20 characters." };
  if (!validPin(pin)) return { ok: false, error: "PIN must be exactly 4 digits." };
  const key = display.toLowerCase();

  const a = attempts.get(key);
  if (a && a.lockedUntil > Date.now()) return { ok: false, error: "Too many tries — wait a minute and retry." };

  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(key);
  if (row) {
    if (!safeEqual(await hashPin(pin, row.salt), row.pin_hash)) {
      bumpAttempt(key);
      return { ok: false, error: "Wrong PIN for that name." };
    }
    attempts.delete(key);
    return startSession(row);
  }
  // New account.
  const salt = crypto.randomBytes(16).toString("hex");
  db.prepare("INSERT INTO users (username, display, pin_hash, salt, balance, created) VALUES (?,?,?,?,?,?)")
    .run(key, display, await hashPin(pin, salt), salt, START_BALANCE, Date.now());
  return startSession(db.prepare("SELECT * FROM users WHERE username = ?").get(key));
}

// Resume a session from a token (e.g. a stored login on page load). Expired tokens
// are rejected (and dropped) so a leaked old token can't be used indefinitely.
function verifyToken(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) { sessions.delete(token); return null; }
  const row = db.prepare("SELECT username, display, balance FROM users WHERE username = ?").get(s.username);
  return row ? { username: s.username, name: row.display, balance: row.balance } : null;
}

function balanceOf(key) {
  const row = db.prepare("SELECT balance FROM users WHERE username = ?").get(key);
  return row ? row.balance : null;
}

// Apply a signed delta to a user's persistent balance (called per hand). Floored at
// 0 — a fake-money wallet must never go negative.
function addToBalance(key, delta) {
  if (!key || !delta) return;
  db.prepare("UPDATE users SET balance = MAX(0, balance + ?) WHERE username = ?").run(Math.round(delta), key);
}

function logout(token) { sessions.delete(token); }

// Drop expired session tokens so the in-memory map can't grow unbounded as clients
// close tabs without logging out. Runs on a background interval and is exposed for tests.
function sweepSessions(now = Date.now()) {
  for (const [token, s] of sessions) if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(token);
}
const sessionSweep = setInterval(() => sweepSessions(), 60 * 60_000);
if (sessionSweep.unref) sessionSweep.unref(); // never keep the process (or a test) alive

// ── Saved rulesets ────────────────────────────────────────────────────────────
const MAX_RULESETS_PER_USER = 30;
const MAX_RULESET_NAME = 40;
const MAX_RULESET_JSON = 20_000;
const safeParse = s => { try { return JSON.parse(s); } catch (_) { return null; } };

function listRulesets(owner) {
  if (!owner) return [];
  const rows = db.prepare("SELECT id, name, json, created FROM rulesets WHERE owner = ? ORDER BY created DESC").all(owner);
  return rows.map(r => ({ id: r.id, name: r.name, created: r.created, ruleset: safeParse(r.json) }))
    .filter(r => r.ruleset);
}

// Save (insert) or overwrite (by name) one of a user's rulesets. `json` is the
// already-stringified, server-sanitized ruleset.
function saveRuleset(owner, name, json) {
  if (!owner) return { ok: false, error: "Log in to save rulesets." };
  name = String(name || "").trim().slice(0, MAX_RULESET_NAME);
  if (!name) return { ok: false, error: "Give the ruleset a name." };
  if (typeof json !== "string" || json.length > MAX_RULESET_JSON) return { ok: false, error: "Ruleset is too large." };
  const existing = db.prepare("SELECT id FROM rulesets WHERE owner = ? AND name = ?").get(owner, name);
  if (existing) {
    db.prepare("UPDATE rulesets SET json = ?, created = ? WHERE id = ?").run(json, Date.now(), existing.id);
    return { ok: true, id: existing.id };
  }
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM rulesets WHERE owner = ?").get(owner);
  if (c >= MAX_RULESETS_PER_USER) return { ok: false, error: `Limit of ${MAX_RULESETS_PER_USER} saved rulesets reached.` };
  const info = db.prepare("INSERT INTO rulesets (owner, name, json, created) VALUES (?,?,?,?)").run(owner, name, json, Date.now());
  return { ok: true, id: Number(info.lastInsertRowid) };
}

function getRuleset(id) {
  const row = db.prepare("SELECT id, owner, name, json FROM rulesets WHERE id = ?").get(id);
  if (!row) return null;
  const ruleset = safeParse(row.json);
  return ruleset ? { id: row.id, owner: row.owner, name: row.name, ruleset } : null;
}

function deleteRuleset(owner, id) {
  if (!owner) return { ok: false };
  db.prepare("DELETE FROM rulesets WHERE id = ? AND owner = ?").run(id, owner);
  return { ok: true };
}

module.exports = {
  open, loginOrRegister, verifyToken, balanceOf, addToBalance, logout, sweepSessions, START_BALANCE,
  listRulesets, saveRuleset, getRuleset, deleteRuleset,
  _lockDurationMs: lockDurationMs, // exposed for tests (escalation formula)
};
