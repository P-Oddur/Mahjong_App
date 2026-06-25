# Accounts & Persistent Fake-Money Balance
> Optional username + 4-digit-PIN accounts (SQLite via `node:sqlite`) that persist a fake-money wallet across sessions; guests can play without one.

## Overview
Players may either **log in / sign up** with a name and a 4-digit PIN, or **play as a guest** (a typed display name with no persistence). A logged-in account carries a persistent `balance` (fake money, starts at `1000`) that survives server restarts because it lives in a SQLite file (`data/mahjong.db`). After every hand, each seated player's point delta is also applied to their account balance — but the **per-match scoreboard always starts from 0 points** (`points` is per-room, in-memory); only the wallet persists.

A 4-digit PIN is weak by design ("fake-money fun among friends, not real authentication" — `accounts.js`). The security posture compensates: PINs are scrypt-hashed + salted, logins are rate-limited with escalating per-name lockouts, and session tokens live only in memory (cleared on restart).

Accounts also own **saved scoring rulesets** (a `rulesets` table); that subsystem shares this module and is summarized where relevant but is a separate feature.

## Architecture
| File / module | Responsibility |
| --- | --- |
| `accounts.js` | The whole store: opens/creates the SQLite DB, defines the `users` (+ `rulesets`) schema, scrypt PIN hashing, register/login, token sessions, rate-limit lockouts, balance read/write. Exports the public API. |
| `server.js` (`io.on('connection')`, lines ~1016-1052) | Socket handlers `login` / `authToken` / `logout` (+ `listRulesets`/`saveRuleset`/`deleteRuleset`). Attaches the resolved account to `socket.data.account`. |
| `server.js` `publicRoom` (`server.js`) | Exposes per-player `account` (boolean) and `balance` (number or null) in room snapshots. |
| `server.js` `endGame` (`server.js`) | End-of-hand path that calls `accounts.addToBalance` for each seated account. |
| `server.js` `createRoom` / `joinRoom` / `rejoin` | Stamp `player.account` (the username key) from `socket.data.account`; `rejoin` re-attaches the account on reconnect. |
| `public/index.html` (entry UI + script, lines ~20-311) | Login/guest UI (`#player-name`, `#pin-input`, `#btn-login`, `#btn-guest`, `#btn-switch`), `loginResult` handling, `AUTH_KEY` token persistence in `localStorage`, `restoreLogin` auto-resume. |
| `data/mahjong.db` | The SQLite database file (created on first `accounts.open()`). |

## Data shapes
### `users` table (`accounts.js`)
| Column | Type | Notes |
| --- | --- | --- |
| `username` | TEXT PRIMARY KEY | normalized **lower-cased** key (the login identity) |
| `display` | TEXT NOT NULL | name exactly as entered, used for display |
| `pin_hash` | TEXT NOT NULL | scrypt hash, 64 bytes, hex-encoded |
| `salt` | TEXT NOT NULL | per-user random salt, 16 bytes, hex |
| `balance` | INTEGER NOT NULL | defaults to `START_BALANCE` (1000) |
| `created` | INTEGER NOT NULL | `Date.now()` epoch ms |

### `rulesets` table (`accounts.js`)
`id` INTEGER PK AUTOINCREMENT, `owner` TEXT (= `users.username`), `name` TEXT, `json` TEXT (server-sanitized ruleset, stringified), `created` INTEGER.

### In-memory maps (cleared on restart) (`accounts.js`)
- `attempts: Map<key, { count, lockLevel, lockedUntil, seen }>` — failed-login throttle, keyed by lower-cased name.
- `sessions: Map<token, { username, createdAt }>` — active login tokens.

### Constants (`accounts.js`)
`START_BALANCE = 1000`; `MAX_ATTEMPTS = 5`; `BASE_LOCK_MS = 60_000`; `MAX_LOCK_MS = 60 * 60_000` (1h); `ATTEMPT_TTL_MS = 60 * 60_000` (1h); `SESSION_TTL_MS = 48 * 60 * 60_000` (48h).

### Client `loginResult` payload (server → client)
On success: `{ ok: true, token, username, name, balance }` (`accounts.js` via `startSession`; `server.js` for token-resume). On failure: `{ ok: false, error }`.

## Protocol
Only events that exist in the code are listed.

| Event | Direction | Payload | When |
| --- | --- | --- | --- |
| `login` | client → server | `{ name, pin }` | User clicks **Log in / Sign up** (`index.html`). Server calls `loginOrRegister` (`server.js`). |
| `authToken` | client → server | `{ token }` | Page load with a stored token, to resume a session (`index.html`; `server.js`). |
| `logout` | client → server | `{ token }` | User clicks **Log out / switch** while logged in (`index.html`; `server.js`). |
| `loginResult` | server → client | success `{ ok:true, token, username, name, balance }` / failure `{ ok:false, error }` | Reply to `login` and `authToken` (`server.js`, `server.js`, `server.js`). |
| `roomUpdate` | server → client | `publicRoom(room)` incl. `players[].account` (bool) + `players[].balance` (number\|null) | On any room change (e.g. `server.js`, `server.js`). |
| `listRulesets` | client → server | _(none)_ | Ruleset editor init (`index.html`); server replies `rulesetList`. |
| `saveRuleset` | client → server | `{ name, ruleset }` | Save current ruleset to account (`index.html`; `server.js`). |
| `deleteRuleset` | client → server | `{ id }` | Delete an owned saved ruleset (`server.js`). |
| `rulesetList` | server → client | `{ ok, rulesets } ` (or `{ ok:false, error, rulesets:[] }`) | Reply to ruleset list/save/delete. |
| `rulesetSaved` | server → client | `{ ok, id }` / `{ ok:false, error }` | Reply to `saveRuleset` (`server.js`). |

Note: the room-reconnect `token` (from `createRoom`/`joinRoom`/`rejoin`, generated by `genToken()` at `server.js`) is a **separate** per-seat token, unrelated to the account session token returned in `loginResult`.

## Key flows
### Sign up / log in
1. Client validates locally: non-empty name and `/^\d{4}$/` PIN (`index.html`), then emits `login { name, pin }`.
2. `loginOrRegister(name, pin)` (`accounts.js`) normalizes the name, re-validates (`validName` 1-20 chars, `validPin` 4 digits), and computes `key = display.toLowerCase()`.
3. Lockout check: if `attempts[key].lockedUntil > now`, return `"Too many tries — wait a minute and retry."` (`accounts.js`).
4. If a `users` row exists: hash the PIN with the stored salt and `safeEqual` (constant-time) against `pin_hash`. Mismatch → `bumpAttempt(key)` and return wrong-PIN error; match → `attempts.delete(key)` and `startSession` (`accounts.js`).
5. If no row: generate a 16-byte salt, `INSERT` a new user with `balance = START_BALANCE`, then `startSession` (`accounts.js`). **Registration and login share one entry point** — a brand-new name is auto-created.
6. `startSession` mints `crypto.randomBytes(24)` hex token, stores `sessions[token] = { username, createdAt }`, returns `{ ok, token, username, name: display, balance }` (`accounts.js`).
7. Server stores `socket.data.account = { username, name }` and emits `loginResult` (`server.js`). Client saves `{ token, name }` to `localStorage[AUTH_KEY]` and shows the "logged in" banner with balance (`index.html`).

### Token resume across reconnects
1. On page load, `restoreLogin()` reads `localStorage[AUTH_KEY]`; if a token exists it prefills the name and emits `authToken { token }` (`index.html`).
2. `verifyToken(token)` (`accounts.js`): rejects unknown tokens; if `now - createdAt > SESSION_TTL_MS` it deletes the token and returns null (expired); otherwise re-reads the live `display`/`balance` from `users` and returns `{ username, name, balance }`.
3. Server re-attaches `socket.data.account` and emits a success `loginResult` echoing the same token + fresh balance (`server.js`); expired/invalid → `{ ok:false, error: 'Session expired — log in again.' }`.

### Guest mode
- Clicking **Play as guest** sets `account = null; myName = name` client-side and proceeds — no socket call, no PIN, no persistence (`index.html`). Subsequent `createRoom`/`joinRoom` send `playerName`, and because `socket.data.account` is null the seat gets `account: null` (`server.js`).

### Per-hand balance persistence
1. A hand ends → `endGame(room, result)`; for each player index, `room.players[i].points += amt` (per-match scoreboard) (`server.js`).
2. If that seat has an account and `amt` is truthy: `accounts.addToBalance(room.players[i].account, amt)` (`server.js`).
3. `addToBalance(key, delta)` runs `UPDATE users SET balance = MAX(0, balance + ?)` (`accounts.js`) — rounds the delta and **floors at 0** so a wallet never goes negative. Returns early if `key` or `delta` is falsy.
4. The next `publicRoom` snapshot re-reads each account's live balance via `accounts.balanceOf` (`server.js`).

### Logout / switch
- Client emits `logout { token }`, removes `AUTH_KEY` from `localStorage`, clears `account`/`myName`, returns to the entry screen (`index.html`). Server deletes the session token and nulls `socket.data.account` (`server.js`).

## Invariants & gotchas
- **Identity is the lower-cased name.** `username` is `display.toLowerCase()`, so `Josh`/`josh`/`JOSH` are the same account (test `accounts.test.js`). `display` preserves the original casing for UI only.
- **Match score ≠ wallet.** `points` is per-room and resets each match (always starts at 0); only `balance` persists. Both are updated in the same `endGame` loop but stored in different places.
- **Balance is floored at 0**, never negative (`accounts.js`; test `accounts.test.js`).
- **Sessions are in-memory only.** A server restart invalidates every token; clients then fall back to `authToken` → `verifyToken` returning null → "Session expired" and must log in again. (Balances survive because they're in SQLite.)
- **Escalating lockout, not a flat window.** After `MAX_ATTEMPTS` (5) wrong PINs, `bumpAttempt` increments `lockLevel` and sets `lockedUntil = now + lockDurationMs(level)` where duration is `BASE_LOCK_MS * 2^(level-1)` capped at `MAX_LOCK_MS` (1m → 2m → 4m … ≤ 1h). The per-window `count` resets but `lockLevel` persists, so sustained guessing backs off exponentially (`accounts.js`; tests `accounts.test.js`).
- **A successful login clears the attempt history** (`attempts.delete(key)`), and a name's history is forgotten after `ATTEMPT_TTL_MS` (1h) of inactivity (`accounts.js`).
- **`open()` is re-entrant.** Calling it again closes the prior handle and reopens (used by tests to point at a temp DB and to reopen the same file) (`accounts.js`). The `rulesets` table is created idempotently so existing DBs upgrade in place.
- **Reconnect re-attaches the account** so a returning logged-in user keeps saved-ruleset access; otherwise the ruleset handlers treat them as a guest (`server.js`).
- **Two unrelated tokens.** The account session token (24 bytes, in `sessions`) and the per-seat room-reconnect token (`genToken`) are distinct; don't conflate them.
- **PIN hashing is async on purpose.** `scrypt` is promisified so a burst of logins can't block the event loop / freeze live games (`accounts.js`).
- **Session sweeper.** A 1-hour `setInterval` runs `sweepSessions()` to drop expired tokens; it is `.unref()`'d so it never keeps the process (or a test) alive (`accounts.js`).

## Code map
- `accounts.js` `open(dbPath)` — open/create DB (default `data/mahjong.db`), create `users` + `rulesets` tables.
- `accounts.js` `hashPin(pin, salt)` / `accounts.js` `safeEqual(aHex, bHex)` — scrypt KDF + constant-time compare.
- `accounts.js` `bumpAttempt(key)` / `accounts.js` `lockDurationMs(level)` — escalating lockout machinery.
- `accounts.js` `startSession(row)` — mint token, store session, return login payload.
- `accounts.js` `loginOrRegister(name, pin)` — single register-or-login entry point.
- `accounts.js` `verifyToken(token)` — resume a session from a token (with TTL check).
- `accounts.js` `balanceOf(key)` / `accounts.js` `addToBalance(key, delta)` — wallet read / floored update.
- `accounts.js` `logout(token)` / `accounts.js` `sweepSessions(now)` — session teardown.
- `accounts.js` `module.exports` — public API: `open, loginOrRegister, verifyToken, balanceOf, addToBalance, logout, sweepSessions, START_BALANCE, listRulesets, saveRuleset, getRuleset, deleteRuleset, _lockDurationMs`.
- `server.js` `login` / `server.js` `authToken` / `server.js` `logout` handlers.
- `server.js` `endGame(room, result)` — per-hand `addToBalance` persistence.
- `server.js` `publicRoom(room)` — exposes `account` (bool) + `balance`.
- `public/index.html` `#btn-login` handler / `index.html` `loginResult` handler / `index.html` `restoreLogin`.

## Tests
`test/accounts.test.js` (run via `npm test`) uses a throwaway temp DB (`os.tmpdir()`), `accounts.open(tmp)`, and a tiny `check()` harness. Covered cases:
- Register a new user → token returned, balance starts at `1000`.
- Login is **case-insensitive** and the PIN is verified; wrong PIN rejected.
- Validation: empty name, short PIN, non-numeric PIN all rejected.
- Token round-trips via `verifyToken`; a bogus token returns null.
- Expired session tokens are swept and rejected (`sweepSessions` with a far-future `now`).
- Balance changes persist across a DB reopen.
- Balance floored at 0, never negative.
- Rate-limit locks a name after 5 wrong PINs even when the correct PIN is then given.
- Lockout duration escalates (1m/2m/4m) and caps at 1h via `_lockDurationMs`.
- Ruleset save/list round-trip, same-name update-in-place (no duplicate), `getRuleset` + owner-scoped `deleteRuleset`, oversized-JSON rejection.

No automated test covers the server socket wiring or the browser login UI; those are verified manually.
