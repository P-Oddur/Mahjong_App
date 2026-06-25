# Feature documentation

Deep-dive docs for the major features this fork adds on top of the base game —
written to onboard a new session quickly and to show the upstream maintainer what
the fork changed. For setup, running, and a high-level tour, see the top-level
[README](../../README.md).

## How the app fits together

- **Server** (`server.js`) is the single source of truth: rooms, the turn-based
  game loop, timers, bots, scoring, accounts, and every Socket.IO event. Both
  clients speak the same protocol, so a feature usually lives once on the server
  and is mirrored by each client.
- **2D client** (`public/game.html` + `game.js`) — the default DOM board.
- **3D client** (`public/game3d.html` + `js3d/`) — an experimental first-person
  Three.js table that renders the *same* server state.
- **Shared modules** (`public/shared/`) — DOM/logic imported by both clients (the
  hand dock, the turn/claim indicators, tile rendering) so the two stay in lockstep.

## Features

| Doc | What it covers |
| --- | --- |
| [3d-mode.md](3d-mode.md) | The experimental first-person 3D client: the `js3d/` module map, inbound data flow, the CDN/WebGPU import map, and protocol parity with the 2D board. |
| [accounts-and-currency.md](accounts-and-currency.md) | Optional username + 4-digit-PIN accounts (`node:sqlite`), the auth/session protocol, the security posture, and the persistent fake-money balance. |
| [configurable-scoring.md](configurable-scoring.md) | The data-driven HK/MCR faan engine, payout modes, presets, per-pattern overrides, the `sanitizeRuleset` trust boundary, and the lobby editor + sandbox. |
| [turn-indicator-and-claim-window.md](turn-indicator-and-claim-window.md) | The travelling turn token and the every-discard reveal panel with a claim/rob countdown — split into a unit-tested pure core plus DOM widgets. |
| [hand-dock.md](hand-dock.md) | The shared bottom hand dock: one builder, three layouts (`spread`/`bare`/`compact`), PNG tile faces, hover-magnify, and organize/shuffle. |
| [match-flow-and-votes.md](match-flow-and-votes.md) | Match structure (rounds, dealer rotation, 連莊, standings) and the unanimous, mutually-exclusive Next Hand / End Match votes between hands. |
| [pacing-timers-and-bots.md](pacing-timers-and-bots.md) | The per-turn clock, the react-to-discard window, game pace (realistic vs fast auto-pass), and the bots (difficulty + AI). |

> These docs are kept at "deep dive" depth — architecture, data shapes, socket
> protocol, and invariants — and cite `file:line` so they can be checked against the
> source as it evolves. The planning artifacts under `docs/superpowers/` are
> local-only (gitignored); these feature docs are committed.
