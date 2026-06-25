# Match flow & between-hands votes

> How a match is structured (rounds, dealer rotation, 連莊 streaks, standings) and how players advance to the next hand or end the match early via unanimous, mutually-exclusive votes between hands.

## Overview

A *match* is a sequence of *hands*. Each hand is one deal that ends in a win
(ron/tsumo, including a robbed kong) or a wall draw. Between hands the game pauses
on a result screen; play only resumes when **every connected human** agrees. Two
mutually-exclusive votes are offered: **Next Hand** (deal another hand) and **End
Match** (stop now and show final standings). Bots never vote, so a solo human is
instantly unanimous. A match also ends automatically once the configured number of
rounds has been played out by dealer rotation.

The deal rotates seat-to-seat only when the dealer (East) loses the hand; a win or
draw by the dealer keeps the deal in place and grows a 連莊 (continued-dealership)
streak. A full lap of the table advances the prevailing round wind (E→S→W→N).

The server (`server.js`) owns all match state and is the single source of truth for
vote tallies; both clients (2D `public/game.js`, 3D `public/js3d/*`) only mirror it
optimistically and render authoritative tallies as they arrive.

## Architecture

| File / module | Responsibility |
| --- | --- |
| `server.js` (match-flow section) | `matchWillEndAfter`, `advanceDealer`, `computeStandings`, `startMatch`, `finishMatch`, `votingHumans`, `broadcastVoteTallies` — the rules of rounds, rotation, standings, and tallies. |
| `server.js` (`startGame`, `endGame`) | Deal a hand; on hand end apply point transfers, stamp match-progress fields, decide `matchOver`, emit `gameOver`. |
| `server.js` (socket handlers) | `'startGame'`, `'setMatchLength'`, `'nextHandVote'`, `'endMatchVote'`, `'returnToLobby'`, `'requestState'`. |
| `public/game.js` (2D) | `setOverButtons`, `resetVotes`, `toggleNextVote`, `toggleEndVote`, `refreshVoteButtons`, `setVoteBtn`; handlers for `gameOver`/`matchOver`/`nextVoteUpdate`/`endVoteUpdate`/`backToLobby`. |
| `public/game.html` | Game-over overlay markup: `#btn-next-hand`, `#btn-vote-end`, `#btn-lobby`, `.vote-label`/`.vote-count` (`#next-count`, `#end-count`), `#final-standings`. |
| `public/js3d/hud.js` (3D) | `makeVoteButton`, `toggleNextVote`/`toggleEndVote`, `applyNextVote`/`applyEndVote`, `onVote`, `setOverButtons`, `showGameOver`, `showStandings`, `renderStandings`. |
| `public/js3d/main.js` (3D) | Wires `hud.onVote`/`hud.onHudButton`; routes votes and lobby through `routeAction`; registers `gameOver`/`matchOver`/`nextVoteUpdate`/`endVoteUpdate`/`backToLobby` handlers. |
| `public/js3d/net.js` (3D) | Socket transport: `emitNextHandVote`, `emitEndMatchVote`, `emitReturnToLobby`; lists the inbound events in `INBOUND_EVENTS`. |

## Data shapes

### Room match fields (set in `createRoom`, reset by `startMatch`)

`rooms[code]` carries (alongside players/game/etc.):

| Field | Type | Meaning |
| --- | --- | --- |
| `matchRounds` | `1 \| 2 \| 4` | Rounds to play; default `4`. `setMatchLength` writes it. |
| `dealer` | int seat | Current dealer seat (East). |
| `roundWind` | int `0..3` | Prevailing wind index into `WINDS` (E/S/W/N). |
| `dealerPasses` | int | Count of times the deal has *passed* (non-dealer wins). Drives both round-wind advance and match end. |
| `dealerStreak` | int | 連莊 count — consecutive hands the dealer has held the deal. |
| `handNumber` | int | 1-based hand counter within the match. |
| `nextVotes` | `Set<seat>` | Seats currently voting Next Hand. |
| `endVotes` | `Set<seat>` | Seats currently voting End Match. |
| `matchOver` | bool | True once the match is complete (rounds done or End-Match vote). |
| `lastResult` | object \| null | The most recent hand result (also read by `advanceDealer`). |

`publicRoom()` exposes `roundWind` (as a wind string), `dealer`, and `matchRounds`;
`gameStateFor()` additionally exposes `handNumber` and `dealerStreak` so the HUD can
render the round-wind line (`東 East Round · Hand N · 連莊 ×K`).

### `gameOver` result (built in `endGame`)

The result object emitted with `gameOver` includes the scoring fields
(`type`, `winner`, `winnerName`, `score`, `payments`, `discarder`/`discarderName`,
`robbed`) plus these match-progress fields stamped by `endGame`:

```
totals       // [int] running session points per seat (after this hand's transfers)
roundWind    // WINDS[room.roundWind] — prevailing wind string
handNumber   // which hand this was
dealerStreak // 連莊 count at hand end
matchRounds  // configured rounds
matchOver    // bool: matchWillEndAfter(room, result)
standings    // present ONLY when matchOver — computeStandings(room)
```

`type` is one of `'ron'`, `'tsumo'`, or `'draw'`.

### Standings rows (`computeStandings`)

Ranked high→low; tied players share a rank:

```
{ name, isBot, points, seat, rank }
```

`finishMatch` emits `matchOver` with `{ standings, rounds }` (no per-hand result).

## Protocol

| Event | Direction | Payload | When |
| --- | --- | --- | --- |
| `startGame` | client→server | *(none)* | Host (seat 0) in `waiting` with 4 players starts the match → `startMatch`. |
| `setMatchLength` | client→server | `{ rounds }` (`1\|2\|4`) | Host in lobby sets match length. |
| `gameStarted` | server→client (room) | *(none)* | Emitted by `startGame` when a hand is dealt. |
| `gameUpdate` | server→client (per seat) | full game state (incl. `handNumber`, `dealerStreak`, `roundWind`, `dealer`, `matchRounds`) | Every broadcast during play. |
| `gameOver` | server→client (room) | result object (see Data shapes; `matchOver` + `standings`) | A hand ended (win/draw). |
| `nextHandVote` | client→server | `{ value: bool }` | A connected human toggles their Next-Hand vote between hands. |
| `endMatchVote` | client→server | `{ value: bool }` | A connected human toggles their End-Match vote between hands. |
| `nextVoteUpdate` | server→client (room) | `{ voted, needed }` | After any vote change (broadcast with `endVoteUpdate` in lockstep). |
| `endVoteUpdate` | server→client (room) | `{ voted, needed }` | After any vote change. |
| `matchOver` | server→client (room) | `{ standings, rounds }` | Match ended early by a unanimous End-Match vote (`finishMatch`). |
| `returnToLobby` | client→server | *(none)* | A seated human resets a finished room to the lobby. |
| `backToLobby` | server→client (room) | *(none)* | Room reset to `waiting`; clients navigate to `/`. |
| `roomUpdate` | server→client (room) | `publicRoom(room)` | Lobby/room state changed (e.g. after `returnToLobby`, `setMatchLength`). |
| `requestState` | client→server | *(none)* | Client re-sync: replies with `roomUpdate` (+ `gameUpdate` if a game is live). |

Note: between-hands voting requires `room.state === 'finished' && !room.matchOver`;
`returnToLobby` requires `room.state === 'finished'`. Both reject bot/empty seats.

## Key flows

### 1. A hand ends

1. A win or wall draw calls `endGame(room, result)`.
2. `endGame` clears timers, sets `room.state = 'finished'`, applies
   `result.payments` to each `player.points` (and persists to logged-in accounts),
   and sets `result.totals`.
3. It stamps `result.handNumber`, `result.dealerStreak`, `result.matchRounds`, and
   `result.matchOver = matchWillEndAfter(room, result)`.
4. If the match is over it sets `room.matchOver = true` and attaches
   `result.standings = computeStandings(room)`.
5. It emits `gameOver`. Clients show the result screen: between-hands controls when
   `!matchOver` (`setOverButtons('betweenHands')`), or final standings + Lobby when
   `matchOver` (`setOverButtons('matchOver')`). `gameOver` handlers call
   `resetVotes()` so a fresh screen starts at 0 votes.

`matchWillEndAfter` projects one more pass: the dealer repeats on a draw or a dealer
win, so those add 0 passes; otherwise +1. The match is over once
`passes >= matchRounds * n` (n = seat count).

### 2. Advancing via a unanimous Next Hand vote

1. A human clicks Next Hand. The client toggles `myNextVote`, clears `myEndVote`
   (mutually exclusive, optimistic), and emits `nextHandVote { value }`
   (2D `toggleNextVote`; 3D `hud.toggleNextVote` → `onVote` → `net.emitNextHandVote`).
2. Server `'nextHandVote'`: guard `state==='finished' && !matchOver`, reject bots;
   on `value` add the seat to `nextVotes` **and `endVotes.delete(seat)`** (mutual
   exclusion); on `false` remove it. Then `broadcastVoteTallies`.
3. `broadcastVoteTallies` emits both `nextVoteUpdate` and `endVoteUpdate` with
   `voted` counted only over `votingHumans(room)` (non-bot AND connected) and
   `needed = humans.length`.
4. If `voted >= humans.length` (and humans > 0): `advanceDealer(room)`,
   `room.handNumber++`, clear both vote Sets, `room.lastResult = null`,
   `startGame(room)` → new `gameStarted` + `gameUpdate` with the incremented hand.

`advanceDealer` reads `room.lastResult`: if the dealer repeated (draw, or dealer was
the winner) `dealerStreak++`; otherwise `dealer = (dealer+1) % n`, reset the streak,
`dealerPasses++`, and on a completed lap (`dealerPasses % n === 0`) advance
`roundWind`. It re-runs `assignSeatWinds`.

### 3. Ending via a unanimous End Match vote

1. A human clicks End Match; client toggles `myEndVote`, clears `myNextVote`, emits
   `endMatchVote { value }`.
2. Server `'endMatchVote'`: same guards; on `value` add to `endVotes` and
   **`nextVotes.delete(seat)`**; `broadcastVoteTallies`.
3. If End-Match `voted >= humans.length`: `finishMatch(room)` — clears timers, sets
   `matchOver = true`, `state = 'finished'`, `game = null`, clears both Sets, and
   emits `matchOver { standings, rounds }`. Clients show final standings + Lobby
   (2D `matchOver` handler; 3D `hud.showStandings`).

### 4. Return to lobby

1. From the standings screen a seated human clicks the Lobby button and emits
   `returnToLobby` (2D `#btn-lobby`; 3D `hud` Lobby button → `fireHudButton('lobby')`
   → `routeHudButton` → `routeAction({kind:'returnToLobby'})` → `net.emitReturnToLobby`).
2. Server `'returnToLobby'`: requires `state==='finished'` and a non-bot seat;
   clears timers, sets `state = 'waiting'`, `game = null`, `matchOver = false`,
   `lastResult = null`, clears both vote Sets, then emits `roomUpdate` and
   `backToLobby`. Clients navigate to `/`. (Session points are NOT zeroed here;
   they reset on the next `startMatch`.)

## Invariants & gotchas

- **Both votes are unanimous over connected humans.** `votingHumans` excludes bots
  *and* disconnected seats. `needed = humans.length`. A lone human ⇒ a single vote is
  instantly unanimous (see `two-humans.e2e.js`/`e2e.js` notes "lone human ⇒ unanimous").
- **The two votes are mutually exclusive per player.** Casting Next clears that
  player's End vote and vice-versa, on both the server (`.delete`) and the client
  (optimistic). The server's tallies are authoritative; the client only mirrors.
- **`broadcastVoteTallies` always emits BOTH tallies together** so the two buttons
  update in lockstep (a switch shows one ratio drop while the other rises).
- **Dealer repeat (連莊) does not advance the round.** Only a non-dealer win passes
  the deal and increments `dealerPasses`; the round wind advances once per full lap.
  `matchWillEndAfter` and `advanceDealer` apply the *same* repeat rule (draw OR
  dealer win = repeat) so the projected end and the actual rotation stay consistent.
- **Match length math:** `matchRounds × n` passes. With 4 seats: `1` = East-only
  (4 passes) = East+South (8) = full E/S/W/N (16). Only `1|2|4` are accepted.
- **`matchOver` is decided at hand end** (`endGame` → `matchWillEndAfter`), so the
  final hand emits `gameOver` with `matchOver:true` + `standings` and no Next-Hand
  button — there is no separate `matchOver` event in the rounds-complete path. The
  standalone `matchOver` event only fires from `finishMatch` (early End-Match vote).
- **Empty-set guard:** the `voted >= humans.length` check is also gated on
  `humans.length > 0`, so a room with zero connected humans never auto-advances.
- **State guards reject stray votes:** voting requires `finished && !matchOver`; a
  vote after the match is already over (or mid-hand) is a no-op.
- **`returnToLobby` does not reset scores;** `startMatch` zeroes `player.points` and
  all match counters at the start of the next match.

## Code map

- Match rules: `server.js` `matchWillEndAfter`, `advanceDealer`,
  `computeStandings`, `startMatch`, `finishMatch`,
  `votingHumans`, `broadcastVoteTallies`.
- Hand lifecycle: `server.js` `startGame`, `endGame`.
- Vote/lobby handlers: `server.js` `'nextHandVote'`, `'endMatchVote'`,
  `'returnToLobby'`, `'startGame'`,
  `'setMatchLength'`, `'requestState'`.
- Seat winds: `server.js` `assignSeatWinds`.
- 2D client: `public/game.js` `setOverButtons`, `resetVotes`,
  `toggleNextVote`/`toggleEndVote`, `refreshVoteButtons`,
  `setVoteBtn`; `gameOver`/`matchOver` handlers.
- 2D markup: `public/game.html`.
- 3D client: `public/js3d/hud.js` `makeVoteButton`, `toggleNextVote`/
  `toggleEndVote`, `applyNextVote`/`applyEndVote`,
  `onVote`, `setOverButtons`, `showGameOver`,
  `showStandings`; `public/js3d/main.js` routing (`routeAction`/`routeHudButton`);
  `public/js3d/net.js` `emitNextHandVote`/`emitEndMatchVote`/
  `emitReturnToLobby`, `INBOUND_EVENTS`.

## Tests

- `test/vote.test.js` — focused vote suite (2 humans + 2 bots, 1-round match, fast
  bots on PORT 3103). Asserts: a single Next-Hand vote yields `nextVoteUpdate 1/2`
  and does **not** start a hand; switching to End Match drops Next to `0/2` and
  raises End to `1/2` (mutual exclusion + lockstep tallies); both humans voting Next
  deals hand 2 (`handNumber === 2`); both voting End Match emits `matchOver` with 4
  ranked standings rows.
- `test/two-humans.e2e.js` — two-human end-to-end (step 7 "next hand": one vote does
  not advance, both votes deal hand 2; step 8: unanimous End Match → standings;
  cleanup: `returnToLobby` → `backToLobby`). Match locked to 1 round via
  `setMatchLength`.
- `test/e2e.js` — solo human path: step 8 "streamlined next hand (lone human ⇒ a
  single vote is unanimous)" advances to hand 2; step 9 unanimous `endMatchVote`
  ends a 2-round match early into final standings; then `returnToLobby` →
  `backToLobby`.
