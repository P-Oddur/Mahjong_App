"use strict";
// Tiny username + 4-digit-PIN account store backed by node:sqlite (built into
// Node 24 — no dependency, no native build). Casual-grade: a 4-digit PIN is weak
// by design, so PINs are scrypt-hashed + salted and logins are rate-limited, but
// this is for fake-money fun among friends, not real authentication.
const { DatabaseSync } = require("node:sqlite");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const START_BALANCE = 1000;
const MAX_ATTEMPTS = 5;       // wrong PINs before a lockout
const LOCK_MS = 60_000;       // lockout duration

// In-memory (cleared on restart): failed-login throttle + active session tokens.
const attempts = new Map();   // key -> { count, lockedUntil }
const sessions = new Map();   // token -> username key

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
  return db;
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 64).toString("hex");
}
function safeEqual(aHex, bHex) {
  const a = Buffer.from(aHex, "hex"), b = Buffer.from(bHex, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const norm = name => String(name || "").trim();
const validName = name => norm(name).length >= 1 && norm(name).length <= 20;
const validPin = pin => /^\d{4}$/.test(String(pin || ""));

function bumpAttempt(key) {
  const a = attempts.get(key) || { count: 0, lockedUntil: 0 };
  a.count += 1;
  if (a.count >= MAX_ATTEMPTS) { a.lockedUntil = Date.now() + LOCK_MS; a.count = 0; }
  attempts.set(key, a);
}
function startSession(row) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, row.username);
  return { ok: true, token, username: row.username, name: row.display, balance: row.balance };
}

// One entry point: registers a brand-new name, or logs into an existing one.
function loginOrRegister(name, pin) {
  const display = norm(name);
  if (!validName(display)) return { ok: false, error: "Name must be 1–20 characters." };
  if (!validPin(pin)) return { ok: false, error: "PIN must be exactly 4 digits." };
  const key = display.toLowerCase();

  const a = attempts.get(key);
  if (a && a.lockedUntil > Date.now()) return { ok: false, error: "Too many tries — wait a minute and retry." };

  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(key);
  if (row) {
    if (!safeEqual(hashPin(pin, row.salt), row.pin_hash)) {
      bumpAttempt(key);
      return { ok: false, error: "Wrong PIN for that name." };
    }
    attempts.delete(key);
    return startSession(row);
  }
  // New account.
  const salt = crypto.randomBytes(16).toString("hex");
  db.prepare("INSERT INTO users (username, display, pin_hash, salt, balance, created) VALUES (?,?,?,?,?,?)")
    .run(key, display, hashPin(pin, salt), salt, START_BALANCE, Date.now());
  return startSession(db.prepare("SELECT * FROM users WHERE username = ?").get(key));
}

// Resume a session from a token (e.g. a stored login on page load).
function verifyToken(token) {
  const key = sessions.get(token);
  if (!key) return null;
  const row = db.prepare("SELECT username, display, balance FROM users WHERE username = ?").get(key);
  return row ? { username: key, name: row.display, balance: row.balance } : null;
}

function balanceOf(key) {
  const row = db.prepare("SELECT balance FROM users WHERE username = ?").get(key);
  return row ? row.balance : null;
}

// Apply a signed delta to a user's persistent balance (called per hand).
function addToBalance(key, delta) {
  if (!key || !delta) return;
  db.prepare("UPDATE users SET balance = balance + ? WHERE username = ?").run(Math.round(delta), key);
}

function logout(token) { sessions.delete(token); }

module.exports = { open, loginOrRegister, verifyToken, balanceOf, addToBalance, logout, START_BALANCE };
