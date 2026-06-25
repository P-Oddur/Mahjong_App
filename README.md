# Mahjong_App

Multiplayer Hong Kong–style Mahjong for the browser. Create a room, share a
4-letter code with friends, and fill any empty seats with bots. Play on a classic
2D board or an experimental first-person 3D table. Node.js + Socket.IO backend,
dependency-light vanilla-JS frontend.

## Features

- **Real-time multiplayer** — 4-player rooms with 4-letter codes; share a code or
  an invite link. Refreshing mid-game is safe: your seat is restored automatically
  (token-based rejoin).
- **Bots** — fill empty seats with Easy / Normal / Hard bots; add or remove them in
  the lobby.
- **Two clients** — the default 2D board, or an experimental first-person **3D mode**
  (Three.js / WebGPU) toggled per browser in the lobby. Both share the same rules,
  scoring, and protocol.
- **Optional accounts** — sign in with a username + 4-digit PIN to keep a persistent
  (fake-money) balance across sessions, or play as a guest. PINs are scrypt-hashed
  and logins are rate-limited.
- **Configurable scoring** — choose a payout mode and tweak individual patterns from
  the lobby, save custom rulesets to your account, and experiment in a standalone
  sandbox (see [Scoring](#scoring)).
- **Match options** — match length (East only / East + South / Full 東南西北), a
  per-room turn timer, a react-to-discard window, and a game pace (Realistic or Fast
  auto-pass).
- **Quality-of-life** — chat with emoji + action notifications, a pinned hand dock
  with organize/shuffle, a travelling turn indicator, an every-discard reveal panel
  with a claim countdown, and unanimous **Next Hand** / **End Match** votes between
  hands.

## Requirements

- [Node.js](https://nodejs.org/) **24+** — the accounts store uses the built-in
  `node:sqlite` module (no native build, no extra dependency).

## Setup

Install dependencies once (Express + Socket.IO):

```sh
npm install
```

## Run

For local play and your LAN:

```sh
npm start
```

Then open <http://localhost:3000>. The console also prints your LAN URLs (e.g.
`http://<your-lan-ip>:3000`) — friends on the same Wi-Fi can open one of those and
enter the room code.

> **Optional: Tailscale-only mode.** `npm run start:tailscale` (or `TAILSCALE_ONLY=1`)
> binds **only** to a [Tailscale](https://tailscale.com/) interface and waits for it to
> come up — reachable by your tailnet, not your physical LAN, so no open ports are
> needed. Plain `npm start` listens on all interfaces, which is what most hosting and
> LAN setups want.

To play over the internet, port-forward `3000` on your router or use a tunnel such as
[ngrok](https://ngrok.com/):

```sh
ngrok http 3000
```

## How to play

1. Enter a name. Optionally sign in with a 4-digit PIN to save your balance, or
   **Play as guest**.
2. **Create Room** (you become the host) or join with a 4-letter **room code**.
3. As host, choose match length / timers / pace / scoring, click **🤖 Add Bot** to
   fill seats, and **Start Game** once there are 4 players. Empty seats are shown
   until they're filled.
4. On your turn, click a tile to select it, then click again (or **Discard**) to
   discard. Claim **Pong / Kong / Chow / Win** on others' discards within the react
   window. When a hand ends, every human must agree to deal the **Next Hand** or to
   **End Match**.

## Accounts & balance

Accounts are optional and casual-grade — a 4-digit PIN is weak by design, so this is
for fake-money fun among friends, not real authentication. New accounts start with a
balance of 1000; each hand's payments adjust it and persist. Data lives in a local
SQLite file at `data/mahjong.db` (created on first run). Login sessions/tokens are
kept in memory and clear when the server restarts.

## Scoring

Wins are scored with a Hong Kong **faan (番)** system. After each hand the game-over
screen shows the winning patterns, the faan total, the points the hand is worth, and
a running session scoreboard.

- **Prevailing (round) wind** starts at East and advances E→S→W→N each time the
  dealership completes a full lap of the table. The dealer keeps the deal on a win or
  a draw (連莊); otherwise it passes to the next seat.
- **Payments** — on a self-draw every other player pays the winner; on a discard win
  the player who discarded pays in full.

### Configurable rulesets

Scoring is data-driven: `scoring.js` holds a static pattern library and `rulesets.js`
overlays the per-room configuration on top of it. Hosts can customise it from the
lobby:

- **Payout modes** — `HK Doubling` (classic faan, points = base × 2^faan),
  `HK Grouped`, and `MCR Additive` (Mahjong Competition Rules, points add up).
- **Presets** — start from a built-in preset (e.g. *HK Standard*, which reproduces
  the classic scoring exactly) and adjust from there.
- **Per-pattern overrides** — toggle individual patterns on/off and retune their
  faan/points.
- **Save & share** — logged-in hosts can save custom rulesets to their account.
- **Sandbox** — `/sandbox.html` is a standalone tester for trying rulesets against
  example hands without starting a game.

Recognised patterns include self-draw, concealed hand, all sequences (平糊), all
triplets (對對糊), dragon/seat/round-wind triplets, half & full flush, the big limit
hands (大三元 / 大四喜 / 字一色 …), seven pairs, thirteen orphans, knitted hands, and
the full MCR pattern set.

## Room & server options

Most options are configured per-room in the lobby (match length, turn timer, react
window, pace, bot difficulty, scoring ruleset, 2D/3D). The environment variables
below set server-wide **defaults**:

| Variable                 | Default | Effect                                                          |
| ------------------------ | ------- | -------------------------------------------------------------- |
| `PORT`                   | `3000`  | HTTP/WebSocket port                                            |
| `BOT_DELAY_MS`           | `700`   | Bot "thinking" time per move (ms)                              |
| `DISCONNECT_FALLBACK_MS` | `30000` | With the turn clock off, auto-discard a *disconnected* player after this |
| `MIN_FAAN`               | `0`     | Default minimum faan to win (set `3` for traditional HK)       |
| `LIMIT_FAAN`             | `13`    | Default faan at which a hand becomes a limit hand (caps payout) |
| `BASE_POINTS`            | `1`     | Default payout multiplier                                      |
| `TAILSCALE_ONLY`         | —       | Set `1` to bind only to Tailscale (same as `--tailscale`)     |

`MIN_FAAN` / `LIMIT_FAAN` / `BASE_POINTS` are only defaults — a room's ruleset can
override them.

PowerShell example:

```powershell
$env:PORT='4000'; $env:BOT_DELAY_MS='300'; npm start
```

## Development

Auto-restart the server on file changes:

```sh
npm run dev
```

## Test

```sh
npm test
```

Runs the unit suites (scoring engine, rulesets / pattern library / modes, MCR
variants, accounts, and the pure 3D-math cores) followed by the end-to-end suites —
each spawns its own server and plays real games against bots:

- `e2e.js` — one human vs three bots, including page-navigation rejoin/reconnect.
- `two-humans.e2e.js` — two human clients sharing a room, with hard invariants
  checked on every update.
- `vote.test.js` — the between-hands Next Hand / End Match vote flow.
- `timers.test.js` · `pace.test.js` — the turn clock and the realistic/fast pace.

## Project layout

| Path                              | Purpose                                                            |
| --------------------------------- | ----------------------------------------------------------------- |
| `server.js`                       | Express + Socket.IO server: rooms, game flow, timers, bots, relays |
| `mahjong.js`                      | Core rules: 144-tile deck, win detection, claim/chow validation   |
| `scoring.js`                      | HK faan engine: hand decomposition + data-driven pattern library  |
| `rulesets.js`                     | Per-room scoring config: modes, presets, overrides, sanitisation  |
| `bot.js`                          | Bot AI: discard scoring and claim decisions                       |
| `accounts.js`                     | Username + PIN accounts and balances (`node:sqlite`)              |
| `public/index.html`               | Lobby: accounts, create/join, room options, ruleset editor, bots  |
| `public/game.html`, `game.js`     | 2D board client                                                   |
| `public/game3d.html`, `js3d/`     | Experimental first-person 3D client (Three.js)                    |
| `public/shared/`                  | Modules shared by both clients (hand dock, indicators, tiles)     |
| `public/sandbox.html`             | Standalone scoring-ruleset sandbox                                |
| `public/style.css`                | Green-felt theme and tile styles                                  |
| `test/`                           | Unit + end-to-end suites (run by `npm test`)                      |

## Notes

- Rooms live in server memory; restarting the server clears all active rooms.
- The 3D mode loads Three.js from a CDN (jsdelivr) at runtime, so it needs an
  internet connection; the 2D board has no third-party runtime dependencies.

## Contributing

This repository is a fork of
[`winkyfaceemoji/Mahjong_App`](https://github.com/winkyfaceemoji/Mahjong_App), the
original by Adam Chou — `origin` is the fork and `upstream` is the source. Feature
work lands on the `p-oddur-dev` branch and is offered back to the original project as
pull requests.

Before opening a PR:

- Run `npm test`. The suite spawns its own servers and plays full games against bots,
  so it catches scoring and protocol regressions, not just unit-level bugs.
- Follow the existing patterns: scoring is data-driven (add a pattern entry in
  `scoring.js` or a ruleset override — don't change the engine), the 2D and 3D clients
  share DOM/logic through `public/shared/`, and pure 3D math is extracted to
  dependency-free cores in `public/js3d/lib/` with Node unit tests.

For deep dives on the major features — architecture, data shapes, and the socket
protocol — see [`docs/features/`](docs/features/).

## License

[MIT](LICENSE) © 2026 Adam Chou.
