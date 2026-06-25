# Pacing: turn clock, react window, game pace, and bots

> Per-room controls that keep a hand moving — a per-turn discard clock with auto-discard, a react-to-discard claim/rob window, a realistic-vs-fast pace, and AI bots with difficulty tiers — all host-configured in the lobby and locked once a match starts.

## Overview

A Hong Kong mahjong hand can stall in three places: a player who never discards, a discard nobody acts on, and an empty seat that should be filled. This feature set addresses all three:

- **Per-turn discard clock** — bounds how long the player whose turn it is may take. On expiry the just-drawn tile is auto-discarded (tsumogiri). The clock can be turned **off**; even off, a *disconnected* player on turn is still force-discarded after a fallback so the hand never freezes, while a *present* player is never rushed.
- **React-to-discard window** — after every discard, a bounded window in which other players may pong / kong / chow / ron. The same window mechanism backs robbing-the-kong (搶槓).
- **Game pace** — `realistic` keeps manual passing in multiplayer; `fast` auto-passes any player who has no possible claim. A solo game (≤1 connected human) is always fast regardless of the setting.
- **Bots** — fill empty seats with AI players at `easy` / `normal` / `hard` difficulty. Bots self-schedule their actions and are never put on the turn clock.

All settings are host-only and only changeable while the room is `waiting` (`requireHostWaiting`, `server.js`); the lobby locks them once `startGame` runs.

## Architecture

| File / module | Responsibility |
| --- | --- |
| `server.js` | Owns all timing state and bot scheduling. Turn-clock constants + `clampTurnTimer`/`clampReactTimer`; arms/clears the discard clock (`maybeArmTurnTimer`, `clearTurnTimer`, `autoDiscardTile`); opens/resolves the claim window (`doDiscard`, `processClaims`) and rob window (`openRobWindow`, `resolveRob`); pace logic (`autoPassOn`, `autoPassNoClaimHumans`); bot scheduling (`scheduleBots`, `botTiming`, `botTakeTurn`, `botRespondClaim`, `botRespondRob`); the `setTimers` / `setPace` / `addBot` / `removeBot` socket handlers; the disconnect fallback (`disconnect` handler). |
| `bot.js` | The AI. `tileUsefulness`, `chooseDiscard`, `findConcealedKong`, `decideClaim`, `pickBotName`, `BOT_NAMES`; difficulty tunes discard and claim aggression. Pure logic — no socket/room access. |
| `mahjong.js` | Rules primitives the bot and server call: `getValidClaims`, `getChowOptions`, `checkWin` (imported at `server.js`, `bot.js`). |
| `public/index.html` | Lobby controls (`#turn-timer`, `#turn-timer-off`, `#react-timer`, `#game-pace`, `#bot-difficulty`) and the `setTimers` / `setPace` / `addBot` emits (`sendTimers`). |
| `public/shared/indicator-core.js` | Client clock selection (`liveClock`): reads `turnDeadline`/`turnTotal`/`claimDeadline`/`reactTimer`/`turnTimer` from game state to render the countdown on the turn token. Bots have no `turnDeadline`, so the token shows no digit on a bot turn. |

## Configuration

| Setting | Default | Bounds | Where set |
| --- | --- | --- | --- |
| Turn timer (s) | `15` (`DEFAULT_TURN_TIMER`, `server.js`) | `0` = off, else `3`–`60` (`TURN_TIMER_MIN`/`TURN_TIMER_MAX`, `server.js`; `clampTurnTimer`, `server.js`) | Lobby `#turn-timer` + `#turn-timer-off` → `setTimers`; defaults to `DEFAULT_TURN_TIMER` per room (`server.js`) |
| React-to-discard (s) | `15` (`DEFAULT_REACT_TIMER`, `server.js`) | `1`–`15` (`REACT_TIMER_MIN`/`REACT_TIMER_MAX`, `server.js`; `clampReactTimer`, `server.js`) | Lobby `#react-timer` → `setTimers`; defaults to `DEFAULT_REACT_TIMER` per room |
| Pace | `'fast'` (room is created with `pace: 'fast'`, `server.js`) | `'realistic'` \| `'fast'` (`setPace`, `server.js`) | Lobby `#game-pace` → `setPace`. Solo (≤1 connected human) is always fast regardless (`autoPassOn`, `server.js`) |
| Bot difficulty (new bot) | `'normal'` (`addBot` falls back to `'normal'`, `server.js`) | `'easy'` \| `'normal'` \| `'hard'` | Lobby `#bot-difficulty` → `addBot` payload |
| `BOT_DELAY` | `700` ms | env `BOT_DELAY_MS` (`server.js`) | Environment variable (base bot "thinking" time) |
| `DISCONNECT_FALLBACK_MS` | `30000` ms | env `DISCONNECT_FALLBACK_MS` (`server.js`) | Environment variable (off-clock no-stall fallback for a disconnected player) |

> Lobby note: the HTML inputs ship with `value="15"` for both timers (`index.html`) and `Fast (auto-pass)` is the pre-selected pace option (`index.html`), matching the server room default of `pace: 'fast'`. The lobby clamps client-side to the same bounds (`sendTimers`, `index.html`) before emitting; the server re-clamps authoritatively.

## Protocol

Socket.IO. "C→S" = client to server, "S→C" = server to client(s).

| Event | Direction | Payload | When |
| --- | --- | --- | --- |
| `setTimers` | C→S | `{ turnTimer?, reactTimer? }` | Host changes the turn clock and/or react window (lobby only). Each field is independently clamped; `turnTimer: 0` turns the clock off. Handler `server.js`. |
| `setPace` | C→S | `{ pace }` (`'realistic'` \| `'fast'`) | Host changes multiplayer pace (lobby only). Other values ignored. Handler `server.js`. |
| `addBot` | C→S | `{ difficulty? }` (`'easy'`\|`'normal'`\|`'hard'`) | Host adds an AI seat (lobby only, room not full). Invalid/missing difficulty → `'normal'`. Name from `pickBotName`. Handler `server.js`. |
| `removeBot` | C→S | `{ index }` | Host removes the bot at that seat (must be a bot). Re-seats remaining players. Handler `server.js`. |
| `roomUpdate` | S→C | `publicRoom(room)` incl. `turnTimer`, `reactTimer`, `pace`, and per-player `isBot` / `difficulty` | Broadcast after every lobby change (`setTimers`/`setPace`/`addBot`/`removeBot`) so all clients reflect current config (`publicRoom`, `server.js`). |
| `gameUpdate` | S→C | `gameStateFor(room, i)` (per-seat) | Per-broadcast game state. Carries the deadline fields below (`gameStateFor`, `server.js`; sent in `broadcast`, `server.js`). |

Deadline / clock fields inside the `gameUpdate` (`gameState`) payload:

| Field | Meaning | Set at |
| --- | --- | --- |
| `turnDeadline` | `Date.now()`-epoch ms when the active player's turn clock expires, or `null` (no clock armed, e.g. a bot turn or present player while clock off) | `maybeArmTurnTimer` (`server.js`); read into payload `server.js` |
| `turnTotal` | Full armed-window length in ms (`turnTotalMs`), so the client calibrates its countdown bar | `server.js`; payload `server.js` (`turnTotal`) |
| `claimDeadline` | `Date.now()`-epoch ms when the claim or rob window closes, or `null` | `doDiscard` (`server.js`), `openRobWindow` (`server.js`); payload `server.js` |
| `turnTimer` | Current room turn-timer setting (seconds; `0` = off), echoed so the client knows the configured length | payload `server.js` |
| `reactTimer` | Current room react-timer setting (seconds) | payload `server.js` |

The client's `liveClock` (`indicator-core.js`) picks the claim/rob clock when `phase` is `claim`/`rob` and `claimDeadline` is set, otherwise the turn clock when `phase` is `discard` and `turnDeadline` is set.

## Key flows

1. **Per-turn clock + auto-discard.** On each `broadcast` (`server.js`), if `phase === 'discard'` and the room is `playing`, the clock is armed at most once per turn keyed on `currentTurn:drawnGapId` (`armedKey`, `server.js`) so mid-turn rebroadcasts (organize/shuffle hand) don't reset it. `maybeArmTurnTimer` skips bots (`server.js`); for a human it sets `ms = room.turnTimer * 1000` when the clock is on, records `turnSeat`/`turnTotalMs`/`turnDeadline`, and schedules `setTimeout`. On expiry the timer re-checks the room/game/seat are still current and still in `discard`, then calls `autoDiscardTile` → `doDiscard` (`server.js`). `autoDiscardTile` (`server.js`) discards the just-drawn tile (`drawnGapId`) when it is in hand and not a flower, else the rightmost visible non-flower tile (covers a pong/chow pickup that owes a discard). `doDiscard` calls `clearTurnTimer` first thing (`server.js`) so the clock stops the instant the player acts or is auto-acted.

2. **Clock OFF + disconnect fallback.** With `room.turnTimer === 0`, `maybeArmTurnTimer` arms **nothing** for a *present* player (`ms` stays `null`, `server.js`) — a present player is never rushed. For a *disconnected* player on turn it sets `ms = DISCONNECT_FALLBACK_MS` (`server.js`). The arming is triggered from the `disconnect` handler: if the absent player owes a discard and no clock is running, it calls `maybeArmTurnTimer` + `broadcast` (`server.js`). On expiry the same auto-discard path runs, so the hand can't freeze on an empty seat. Conversely `rejoin` cancels an off-clock fallback armed for the returning seat (`server.js`), since a present player must not be rushed.

3. **React-to-discard window (claim / rob).** `doDiscard` moves the tile to the discard pile, sets `phase = 'claim'`, resets `claims`/`passes`, and opens the window: `claimDeadline = Date.now() + reactWindowMs(room)` with a matching `setTimeout` → `processClaims` (`server.js`). `reactWindowMs` = `(room.reactTimer || DEFAULT_REACT_TIMER) * 1000` (`server.js`). Players respond via `claim` / `pass` (→ `registerClaim` / `registerPass`); once everyone except the discarder has responded (`allResponded`, `server.js`) the window resolves early via `checkAllResponded`. `processClaims` (`server.js`) applies priority **win > kong > pong > chow**; multiple ron claimants are ordered nearest-the-discarder. The **rob window** (`openRobWindow`, `server.js`) mirrors this for an added kong (`declareAddedKong`): `phase = 'rob'`, `claimDeadline` set the same way, resolved by `resolveRob` (`server.js`) which awards a robber if anyone won, else completes the kong and draws a replacement.

4. **Fast pace auto-pass.** `autoPassOn(room)` is true when `connectedHumans(room) <= 1` OR `room.pace === 'fast'` (`server.js`). When on, `doDiscard` calls `autoPassNoClaimHumans` *before* broadcasting (`server.js`) so a window that resolves immediately never flashes a stale claim countdown. `autoPassNoClaimHumans` (`server.js`) registers a pass for every non-discarder human who has no valid claim (`getValidClaims(...).length === 0`); players who *can* claim still decide manually. In `realistic` multiplayer with ≥2 connected humans, no auto-pass happens, so a non-responding player blocks the window until `claimDeadline`.

5. **Always-fast solo rule.** Because `autoPassOn` short-circuits on `connectedHumans <= 1`, a solo game (or the lone human left after others drop) always auto-passes no-claim windows regardless of the `pace` setting. Bot pacing tightens too: `botTiming` (`server.js`) returns a locked `{ base: 300, jit: 120 }` when ≤1 human is connected, versus `{ base: BOT_DELAY, jit: BOT_DELAY }` for multiplayer — so a passive solo player's game still flies.

6. **A bot's turn.** Bots are driven by `scheduleBots` (`server.js`), invoked at the end of every `broadcast`. On a `discard` phase whose `currentTurn` is a bot, it schedules `botTakeTurn` after `base + random*jit`. `botTakeTurn` (`server.js`): if the hand already wins it self-draws (`finishSelfDraw`); else if there's a concealed kong and tiles remain it melds it and draws a replacement; else it calls `chooseDiscard(p.hand, p.difficulty, g.discardPile)` and discards. In `claim`/`rob` phases, each eligible bot is scheduled (`botRespondClaim` / `botRespondRob`) after `base*0.6 + random*jit*0.8`. Every scheduled callback re-checks `stillCurrent()` (room/game/`seq`/state unchanged) before acting, so a stale timer can't fire into a new turn. Bots are **never** armed on the turn clock (`maybeArmTurnTimer` returns early for `p.isBot`, `server.js`).

## Invariants & gotchas

- **Bots are never on the turn clock.** `maybeArmTurnTimer` bails for `p.isBot`; bots self-schedule well within any human limit. Their `gameUpdate` therefore has `turnDeadline === null`, and the client shows no countdown digit on a bot turn (`indicator-core.js`).
- **Clock-on rushes everyone; clock-off rushes only the disconnected.** With `turnTimer > 0`, every human turn is bounded identically whether connected or not. With `turnTimer === 0`, only a disconnected player gets the `DISCONNECT_FALLBACK_MS` net; a present player has no deadline (`server.js`).
- **Clock armed at most once per turn.** `armedKey = currentTurn:drawnGapId` (`server.js`) prevents organize/shuffle-hand rebroadcasts from resetting the countdown. Any non-discard phase clears the clock (`server.js`).
- **`turnTotal` calibrates the client bar.** The server sends the full window length (`turnTotalMs`) so the countdown bar starts full even if the `gameUpdate` arrives mid-window.
- **Auto-pass runs before broadcast.** In fast/solo, `autoPassNoClaimHumans` is applied prior to broadcasting (`server.js`) so an instantly-resolving window doesn't flash a stale claim countdown to clients.
- **Solo overrides the pace setting.** A `realistic` room with only one connected human still auto-passes (and runs bots at the locked 300ms) because `autoPassOn`/`botTiming` key on `connectedHumans <= 1`.
- **`reactWindowMs` fallback constant differs from the client's.** Server uses `DEFAULT_REACT_TIMER` (15) when `reactTimer` is unset; the client's `liveClock` falls back to `5` for the claim bar and `30` for the turn bar only when the corresponding field is absent (`indicator-core.js`) — these client fallbacks are display-only and don't drive server timing.
- **All timing config is lobby-only.** `setTimers`/`setPace`/`addBot`/`removeBot` go through `requireHostWaiting`; once `room.state` leaves `waiting` they no-op. Per-room bot pacing (`botTiming`) and the solo auto-pass rule are not host-configurable.
- **Stale-timer guard.** Every scheduled callback (turn timeout, claim/rob resolution, bot action) re-verifies `rooms[room.code] === room && room.game === g` (and bots additionally `g.seq === seq`) before mutating, so a timer that fires after the turn/hand moved on is a no-op.
- **Auto-discard tile choice is defensive.** Flowers are auto-extracted on draw (`drawFlowers`), so the hand normally has none; the rightmost-non-flower / last-tile fallback in `autoDiscardTile` exists only so a turn can't stall on a degenerate hand.

## Code map

- Turn-clock constants + clamps: `server.js` (`DEFAULT_TURN_TIMER`, `DEFAULT_REACT_TIMER`, `TURN_TIMER_MIN/MAX`, `REACT_TIMER_MIN/MAX`, `DISCONNECT_FALLBACK_MS`, `reactWindowMs`, `clampTurnTimer`, `clampReactTimer`).
- Clock arming / clearing / auto-discard: `clearTurnTimer` `server.js`; `autoDiscardTile` `server.js`; `maybeArmTurnTimer` `server.js`; arm-once logic in `broadcast` `server.js`.
- Deadlines in game state: `server.js` (`gameStateFor`) sets `turnDeadline`/`turnTotal`/`claimDeadline`/`turnTimer`/`reactTimer`.
- React window open/resolve: `doDiscard` `server.js`; `processClaims` `server.js`; `openRobWindow` `server.js`; `resolveRob` `server.js`; `registerClaim`/`registerPass`/`allResponded` `server.js`.
- Pace: `connectedHumans` `server.js`; `autoPassOn` `server.js`; `autoPassNoClaimHumans` `server.js`; `setPace` handler `server.js`.
- Bots (server): `BOT_DELAY` `server.js`; `botTiming` `server.js`; `scheduleBots` `server.js`; `botTakeTurn` `server.js`; `botRespondClaim` `server.js`; `botRespondRob` `server.js`; `addBot` `server.js`; `removeBot` `server.js`.
- Bots (AI): `BOT_NAMES`/`pickBotName` `bot.js`; `tileUsefulness` `bot.js`; `chooseDiscard` `bot.js`; `findConcealedKong` `bot.js`; `countPairs` `bot.js`; `decideClaim` `bot.js`; exports `bot.js`.
- Disconnect fallback / rejoin cancel: `disconnect` handler `server.js`; rejoin cancel `server.js`.
- Lobby controls: `index.html` (inputs); `sendTimers` `index.html`; bindings `index.html`.

### Bot difficulty behavior (`bot.js`)

- **Discard** (`chooseDiscard`, `bot.js`): scores each tile by `tileUsefulness` (pair/triplet partners +50 each; adjacent suited tiles +25/+10; central tiles +3/+1) and picks the lowest. `easy` tosses a random tile ~50% of the time, else the worst; `normal` always discards the least useful (original behavior); `hard` among the least-useful band (within `min + 10`) prefers a tile already seen in the discard pile (safer to part with).
- **Claim** (`decideClaim`, `bot.js`): wins and kongs are always taken at every level. `easy` skips ~75% of pong/chow chances (`Math.random() < 0.75` → pass). `normal` claims a pong/chow only if a pair remains as the head (`countPairs(remaining) >= 1`). `hard` (`aggressive`) claims whenever legal.
- Concealed kong is decided server-side via `findConcealedKong` (any 4-of-a-kind), independent of difficulty.

## Tests

- `test/timers.test.js` — spawns a server with `BOT_DELAY_MS=20` and a lowered `DISCONNECT_FALLBACK_MS=800` so the off-mode safety net is observable quickly.
  - **T1**: with a 3s turn clock and 1s react, an idle dealer's just-drawn tile is auto-discarded after ~3s (asserts a `turnDeadline` was broadcast and the auto-discard didn't fire before ~2s).
  - **T2**: clock **off** — a *present* idle player still holds 14 tiles after 1.3s (not rushed, and no `turnDeadline`); after that player disconnects on turn, the ~800ms fallback force-discards (no stall).
- `test/pace.test.js` — spawns a server with `BOT_DELAY_MS=20` (solo bots are the locked 300ms in code).
  - **T1**: solo game where the human never passes still completes 6 discards quickly (no-claim windows auto-passed; without it each would wait the react timeout).
  - **T2**: `setPace` round-trips `fast` ↔ `realistic`.
  - **T3**: multiplayer `realistic` — a passive (non-responding) player blocks the window; the 2nd discard waits ~the react timer (no auto-pass).
  - **T4**: multiplayer `fast` — a player who passes only its real claims has its no-claim windows auto-passed, so 6 discards resolve far below the react timeout.
