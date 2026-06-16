# Mahjong_App

Multiplayer Hong Kong–style Mahjong for the browser — play with friends, fill empty seats with bots. Plain HTML/JS frontend, Node.js + Socket.io backend.

## Requirements

- [Node.js](https://nodejs.org/) 18+ (includes npm)

## Setup

Install dependencies once:

```sh
npm install
```

## Run

```sh
npm start
```

Then open <http://localhost:3000> in your browser.

1. Enter your name and click **Create Room**.
2. Share the 4-letter room code with friends, or click **🤖 Add Bot** to fill seats (host only).
3. Click **Start Game** (2–4 players, any mix of humans and bots).

### Playing with friends on your network

Friends on the same Wi-Fi/LAN can join at `http://<your-LAN-IP>:3000` — find your IP with:

```sh
ipconfig
```

(use the IPv4 address, e.g. `http://192.168.1.42:3000`), then they enter the room code.

To play over the internet, either forward port 3000 on your router or use a tunnel such as [ngrok](https://ngrok.com/):

```sh
ngrok http 3000
```

### Scoring

Wins are scored with a Hong Kong **faan (番)** system. After each hand the
game-over screen shows the winning patterns, the faan total, the points the
hand is worth, and a running session scoreboard.

- **Prevailing (round) wind** starts at East and advances E→S→W→N each time the
  dealership completes a full lap of the table. The dealer keeps the deal on a
  win or a draw; otherwise it passes to the next seat.
- **Payments:** on a self-draw every other player pays the winner; on a discard
  win the player who discarded pays in full.
- **Patterns** recognised include self-draw, concealed hand, all sequences
  (平糊), all triplets (對對糊), dragon/seat/round-wind triplets, half & full
  flush, small three dragons, the big limit hands (大三元 / 大四喜 / 字一色 …),
  and seat flowers. Scoring lives in `scoring.js` as a data-driven pattern
  table — adding a new rule means appending one entry, no engine changes.

### Options (environment variables)

| Variable       | Default | Effect                                            |
| -------------- | ------- | ------------------------------------------------- |
| `PORT`         | `3000`  | HTTP/WebSocket port                               |
| `BOT_DELAY_MS` | `700`   | Bot "thinking" time per move (ms)                 |
| `MIN_FAAN`     | `0`     | Minimum faan to win (set `3` for traditional HK)  |
| `LIMIT_FAAN`   | `13`    | Faan at which a hand is a limit hand (caps payout)|
| `BASE_POINTS`  | `1`     | Payout multiplier (points = `BASE × 2^faan`)      |

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

Runs the scoring unit tests, then the end-to-end suite (spawns its own server on
port 3100, plays a full game against 3 bots, exercises rejoin/reconnect):

```sh
npm test
```

## Project layout

| Path                | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `server.js`         | Express + Socket.io server: rooms, game flow, bots   |
| `mahjong.js`        | Core rules: deck, win detection, claim validation    |
| `scoring.js`        | HK faan scoring: hand decomposition + pattern table  |
| `bot.js`            | Bot AI: discard scoring and claim decisions          |
| `public/index.html` | Lobby: create/join room, add/remove bots             |
| `public/game.html`  | Game board page                                      |
| `public/game.js`    | Client game logic and rendering                      |
| `public/style.css`  | Green-felt theme and tile styles                     |
| `test/scoring.test.js` | Unit tests for the faan scoring engine            |
| `test/e2e.js`       | Self-contained end-to-end test                       |

## Notes

- Refreshing mid-game is safe — your seat is restored automatically (token-based rejoin).
- Rooms live in server memory; restarting the server clears all rooms.
