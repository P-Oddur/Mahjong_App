# Configurable Hong Kong / MCR Scoring

> A data-driven faan/points engine where every scoring pattern is one table entry, wrapped by per-room rulesets (three payout modes, presets, per-pattern overrides) that are sanitized before the engine ever sees them, and exposed to a lobby editor + standalone sandbox.

## Overview

Scoring is split into two cleanly separated layers:

- **The engine** (`scoring.js`) is standalone and knows nothing about rooms, sockets, or clients. It holds a flat `PATTERNS` table (the pattern *library*) and the decomposition / summation logic. Adding a rule means appending one object to `PATTERNS` — `decompose()`, the candidate enumeration, and the aggregators are untouched.
- **The ruleset layer** (`rulesets.js`) is the per-room *configuration*: it picks a payout `mode`, overlays sparse per-pattern deltas (enable/disable, retune faan or points) on top of the library defaults, and carries the win-legality `allow` flags. `sanitizeRuleset()` is the trust boundary — every client-supplied ruleset passes through it before the engine runs.

A ruleset can change scoring three ways without any engine change: pick a different **mode** (how a faan/points total becomes a payout), toggle/retune individual **patterns**, or adjust the **global params** (min/limit faan, base points, grouped breakpoints, MCR min points). The dependency direction is strict: `rulesets.js` requires `scoring.js` for the canonical id list, but `scoring.js` must not require `rulesets.js` (avoids a require cycle; engine stays embeddable). The engine accepts either a full ruleset (carrying `.mode`) or the legacy `{minFaan,limitFaan,basePoints}` cfg via its own shim (`resolveCfg`, `scoring.js`).

## Architecture

| File / module | Responsibility |
| --- | --- |
| `scoring.js` | The engine: `PATTERNS` library, `decompose()`, per-decomposition scorers, mode payout math, out-of-band special-hand scorers, wait analysis. Exports `scoreWin`, `computePayments`, `faanToPoints`, `decompose`, `analyzeWait`, `DEFAULT_SCORING`, `PATTERNS`, `WINDS` (`scoring.js`). |
| `rulesets.js` | The config model: `MODES`, built-in `PRESETS`, `KNOWN_PATTERN_IDS`, `MAX_*` bounds, and `sanitizeRuleset()` (the trust boundary). Exports `PRESETS`, `sanitizeRuleset`, `KNOWN_PATTERN_IDS`, `MODES` (`rulesets.js`). |
| `probe.js` | Stateless scoring probe for the sandbox: sanitizes an untrusted ruleset + described hand, bounds every array, runs the real `scoreWin`/`computePayments`, returns `{ ruleset, score, payments, wait }`. Exports `probeScore` (`probe.js`). |
| `server.js` | Wires scoring into rooms: builds `CATALOG` + the `/api/catalog` route (`server.js`); env-var defaults `SCORING` (`server.js`); per-room `ruleset` via `defaultRuleset()` (`server.js`); socket handlers `setRuleset`/`listRulesets`/`saveRuleset`/`deleteRuleset`/`scoreProbe`; calls `scoreWin`/`computePayments` on every win. |
| `accounts.js` | Persists per-user saved rulesets (`listRulesets`/`saveRuleset`/`deleteRuleset`, called from the socket handlers). |
| `canonical-examples.js` | One example hand per pattern family (`EXAMPLES`), shared by `test/mcr-catalog.test.js` and the sandbox's "run all" grid. |
| `public/ruleset-editor.js` | Reusable vanilla editor `createRulesetEditor()` (mode selector, global params, searchable tier-grouped pattern list). Returns `{ getRuleset, setRuleset, setSavedPresets }`. |
| `public/index.html` | Lobby rules panel: instantiates the editor from `/api/catalog`, debounce-emits `setRuleset` (host only), saves via `saveRuleset`, renders the summary via `MODE_LABEL`. |
| `public/sandbox.html` | Standalone tester at `/sandbox.html`: build a hand + ruleset, live `scoreProbe`, plus the canonical-examples verification grid. |

## Data shapes

### Ruleset config object

The shape `sanitizeRuleset()` always returns (`rulesets.js`). Built-in presets follow the same shape (`rulesets.js`):

```js
{
  id: 'hk-standard',          // preset id, or 'custom'
  name: 'HK Standard',        // display name (<= MAX_NAME_LEN = 40)
  builtin: true,              // true only for the three built-in presets
  mode: 'hk-doubling',        // one of MODES (see Modes below)
  hk:      { minFaan: 0, limitFaan: 13, basePoints: 1 },           // hk-doubling / hk-grouped min-faan
  grouped: { breakpoints: [3, 5, 8, 11], basePoints: 1 },          // hk-grouped tiers
  mcr:     { minPoints: 8, base: 8, basePoints: 1 },               // mcr-additive floor + payments
  allow: {                    // win-LEGALITY gates for irregular hands
    sevenPairs: true, thirteenOrphans: true,
    knittedStraight: false, lesserKnitted: false, greaterKnitted: false,
  },
  patterns: {                 // sparse per-pattern overrides, keyed by pattern id
    'all-pungs': { enabled: true, faan: 4 },   // any subset of { enabled, faan, points }
    // ...
  },
}
```

`patterns` is built on a null-proto object (`Object.create(null)`, `rulesets.js`) and only whitelisted ids survive. An absent pattern key means "use the library default."

### A `PATTERNS` entry (the library)

Each entry is self-contained (`scoring.js`). Example (`all-pungs`, `scoring.js`):

```js
{ id: 'all-pungs', name: 'All Triplets', cn: '對對糊',
  hkFaan: 3, mcrPoints: 6, mcrRef: 48, defaultEnabled: true,
  evaluate: (c, d) => (d.sets.every(s => s.kind === 'pung') ? 1 : 0) }
```

Fields seen across the table:

- `id` / `name` / `cn` — stable id, English name, Chinese name.
- `hkFaan` / `mcrPoints` — the default magnitude in HK faan vs. MCR points (a ruleset can override either).
- `mcrRef` — the official MCR fan number (metadata; `null` for HK-only bonuses).
- `defaultEnabled` — the **HK Standard** on/off baseline (`true` for the HK set; `false` for MCR-only fans).
- `evaluate(ctx, decomp)` — returns a **multiplicity**: `0` = no match = a plain match, `N` = instance count for a `perCount` pattern. The aggregator multiplies it by the *effective* faan/points.
- `perCount` — multiplicity scales the score (e.g. `dragon-pung`, `seat-flower`).
- `limit` — a limit hand (大牌); pays the cap regardless of the rest.
- `ctxOnly` — reads only `ctx`, never the decomposition (reused by the special-hand scorers via `CONTEXT_PATTERNS`, `scoring.js`).
- `structural` — a decomposition-shape MCR fan (mostly default-off).
- `additive` — honour yakuhai (`dragon-pung`/`seat-wind`/`round-wind`) that HK stacks on top of named hands and the HK non-repeat pass never absorbs.
- `implies` / `excludes` — drive the non-repeat rule (transitive absorption / hard-exclusion).
- `needs` — documents extra tracking the server must supply (`wait`, `last-of-kind`, `melded-hand`).

Module-level scoring constants: `DEFAULT_SCORING = { minFaan: 0, limitFaan: 13, basePoints: 1 }` (`scoring.js`) and `SEVEN_PAIRS_FAAN = 4` (`scoring.js`).

## Protocol

Socket handlers (server side; all in `server.js`):

| Event (direction) | Payload | Handler / effect |
| --- | --- | --- |
| `setRuleset` (client→server) | `{ ruleset }` | `server.js` — host-only, waiting-state only (`requireHostWaiting`); sets `room.ruleset = sanitizeRuleset(ruleset)` and broadcasts `roomUpdate`. |
| `listRulesets` (client→server) | — | `server.js` — requires login; emits `rulesetList` `{ ok, rulesets }` from `accounts.listRulesets`. |
| `saveRuleset` (client→server) | `{ name, ruleset }` | `server.js` — requires login; persists `JSON.stringify(sanitizeRuleset(ruleset))`; emits `rulesetSaved`, then `rulesetList`. |
| `deleteRuleset` (client→server) | `{ id }` | `server.js` — requires login; deletes, then emits `rulesetList`. |
| `scoreProbe` (client→server) | `{ ruleset, ctx }` | `server.js` — stateless; emits `scoreProbeResult` = `probeScore(ruleset, ctx)` (errors return `{ error }`). |
| `rulesetList` (server→client) | `{ ok, rulesets, error? }` | Consumed by the editor's `setSavedPresets` (`index.html`). |
| `rulesetSaved` (server→client) | `{ ok, error? }` | Renders the save status line (`index.html`). |
| `scoreProbeResult` (server→client) | `{ ruleset, score, payments, wait }` or `{ error }` | Sandbox `renderResult` (`sandbox.html`). |
| `roomUpdate` (server→client) | `publicRoom(room)` incl. `ruleset` | Carries the locked/active room ruleset (`server.js`). |

HTTP route:

- `GET /api/catalog` (`server.js`) → `CATALOG` = `{ patterns, presets, modes }` (`server.js`):
  - `patterns`: `PATTERN_CATALOG` — every `PATTERNS` entry projected to `{ id, name, cn, mcrRef, mcrPoints, hkFaan, defaultEnabled, limit, ctxOnly }`, plus the five out-of-band ids (`seven-pairs`, `thirteen-orphans`, `greater-knitted`, `lesser-knitted`, `knitted-straight`) carrying an `allowFlag` and a `special`/`knitted` marker (`server.js`).
  - `presets`: the `PRESETS` object (`hk-standard`, `hk-extended`, `mcr-official`).
  - `modes`: the three payout modes with `{ id, name, desc }`.

(Related static route: `GET /canonical-examples.js`, `server.js`, lets the sandbox load the shared examples.)

## Modes

`MODES = { 'hk-doubling', 'hk-grouped', 'mcr-additive' }` (`rulesets.js`). `resolveMode()` defaults to `hk-doubling` (`scoring.js`). How each turns a total into a payout:

1. **`hk-doubling`** — sum enabled patterns' faan (capped at `limitFaan`), then `points = basePoints × 2^faan` (`faanToPoints`, `scoring.js`). A limit hand is forced to exactly `limitFaan` (`scoring.js`).
2. **`hk-grouped`** — same faan fold, but the capped faan is compressed into a tier by ascending `breakpoints` (default `[3,5,8,11]`); `points = base × 2^tier`. Any limit hand jumps to the top tier (`groupedPayout`, `scoring.js`).
3. **`mcr-additive`** — separate path (`scoreWinMcr`, `scoring.js`): sum enabled patterns' **points** after the MCR non-repeat rule; a legal-but-zero hand floors at `mcr.minPoints` as Chicken Hand (無番和); flowers add 1 pt each (excluded from the floor check). Payments use the MCR formula (see Key flows).

`payoutFor()` dispatches doubling vs. grouped (`scoring.js`); MCR is dispatched earlier in `scoreWin` (`scoring.js`).

## Presets

Three built-ins (`rulesets.js`):

- **`hk-standard`** ("HK Standard") — `hk-doubling`, legacy limits, **no pattern overrides** (`patterns: {}`), so the library `defaultEnabled`/`hkFaan` baseline applies. This reproduces the pre-feature scoring byte-for-byte.
- **`hk-extended`** ("HK Extended") — `hk-doubling` but turns on ~30 expressible MCR structural fans (`HK_EXTENDED_ENABLED`, `rulesets.js`) at their default `hkFaan`, keeping HK doubling payouts.
- **`mcr-official`** ("MCR Official") — `mcr-additive`, all `allow` flags on, and every catalogued id enabled (`Object.fromEntries([...KNOWN_PATTERN_IDS].map(id => [id, {enabled:true}]))`, `rulesets.js`).

## Key flows

1. **Server scores a win.** A win handler builds a ctx (`selfDrawContext`/`ronContext`/`robContext`) and calls `scoreWin(ctx, room.ruleset)` (e.g. `server.js`). `scoreWin` (`scoring.js`) resolves cfg+mode, filters flowers, normalizes melds (`normalizeMeld`), and either dispatches to `scoreWinMcr` or enumerates `decompose()` candidates + the out-of-band special hands.

2. **Best interpretation wins.** Concealed tiles can be read as sets multiple ways; `decompose(tiles, 4 - melds.length)` (`scoring.js`) yields every legal 4-sets+pair reading. Each is scored (`scoreDecomposition`, `scoring.js` for HK; `scoreDecompositionMcr`, `scoring.js` for MCR) and the highest-faan / highest-points candidate is kept (`scoring.js`). Faan is monotonic in payout for both HK modes, so the top-faan reading is also top-paying.

3. **Pattern → score (per decomposition).** For each enabled pattern, `evaluate()` returns a multiplicity; the contribution is `(perCount ? m : 1) × effFaan/effPoints` (`scoring.js`). A pattern retuned to 0 contributes nothing and shows no breakdown row. `limit` patterns flag the cap. Then the non-repeat pass runs (HK: `impliesOnly` + keep additive yakuhai; MCR: implication absorption + exclusion tie-break) via `applyNonRepeat` (`scoring.js`).

4. **Special / irregular hands (out of band).** When `melds.length === 0`, `scoreWin` also tries `scoreThirteenOrphans`, `scoreSevenPairs`, and knitted hands (`scoreKnittedHk`). These bypass `decompose` but honour the same per-pattern overrides (`effFaanId`/`effPointsId`, `scoring.js`) and fold the situational + concealment fans via `addContextFaan`/`addContextMcr` (`scoring.js`). Knitted hands are gated by `knittedAllowed` (the `allow.*` flag, `scoring.js`); seven pairs / thirteen orphans by their `patterns[id].enabled`.

5. **Payments.** `computePayments(score, winnerIndex, playerCount, selfDraw, discarderIndex, ruleset)` (`scoring.js`) returns a signed per-seat array. HK: self-draw → every opponent pays `score.points`; discard → the discarder pays in full. MCR: self-draw → every opponent pays `(V + base) × basePoints`; discard → every opponent pays `base × basePoints` and the discarder additionally pays `V`. An illegal (sub-minimum) score pays nothing (`scoring.js`). NOTE: payouts are deliberately seat-symmetric — there is no dealer (莊家) multiplier (`scoring.js`).

6. **Env defaults vs. per-room override.** `SCORING` reads `MIN_FAAN`/`LIMIT_FAAN`/`BASE_POINTS` from env (`server.js`). Every new room starts on `defaultRuleset()` = `sanitizeRuleset({ id:'hk-standard', hk:{...SCORING} })` (`server.js`), so deployments keep their env tuning. The host can then swap/retune the ruleset in the lobby; `setRuleset` replaces `room.ruleset` with a freshly sanitized copy (`server.js`). Once a match starts the ruleset is locked (handlers gate on `requireHostWaiting`).

7. **Lobby editor flow.** `index.html` fetches `/api/catalog`, calls `createRulesetEditor(...)`, and on every edit debounces a host-only `setRuleset` emit (250 ms, `index.html`). The summary line uses `MODE_LABEL` (`index.html`). Non-hosts (and the unseeded host) sync their editor from `room.ruleset` on `roomUpdate` (`index.html`). Saving prompts for a name and emits `saveRuleset`; `setSavedPresets` injects saved rulesets (prefixed `★`) into the preset dropdown (`ruleset-editor.js`).

8. **Sandbox flow.** `sandbox.html` reuses the same editor and `canonical-examples.js`. Edits/tile clicks debounce a `scoreProbe` (`sandbox.html`); the result panel renders the breakdown + payments. "Run all" opens one socket per example and asserts the named pattern id appears in the breakdown — mirroring `test/mcr-catalog.test.js`.

## Invariants & gotchas

- **Adding a rule = one `PATTERNS` entry.** No change to `decompose`, the scorers, or the modes. The new id is automatically in `KNOWN_PATTERN_IDS` (derived from `PATTERNS`, `rulesets.js`), the `/api/catalog` list, the editor, and the sanitizer whitelist.
- **`sanitizeRuleset()` is the only path to the engine for client data.** Both `setRuleset` and `saveRuleset` sanitize, and `probeScore` sanitizes internally. It clamps every numeric (`clampInt`), validates `mode` against `MODES`, rebuilds `allow` from a fixed key set, and copies only whitelisted pattern ids into a null-proto object — explicitly skipping `__proto__`/`constructor`/`prototype` (`rulesets.js`). Bounds: `MAX_PATTERN_OVERRIDES=200`, `MAX_FAAN=99`, `MAX_POINTS=999`, `MAX_NAME_LEN=40` (`rulesets.js`).
- **`MAX_FAAN` (99) ≠ the payout cap.** Overrides may set a large faan, but the engine still caps the *payout* at `limitFaan` (`scoring.js`).
- **Legality and scoring are kept in lockstep for seven pairs / thirteen orphans.** `checkWin` gates them on the `allow.*` flag but `scoreWin` gates them on `patterns[id].enabled`; the editor only toggles the allow flag. The sanitizer forces `patterns[pid].enabled` to track the allow flag (`rulesets.js`) so an `allow:true`+`enabled:false` ruleset can't be a legal win that scores 0. (Knitted scores via the allow flag directly, so it needs no sync.)
- **Ron-completed pungs aren't concealed.** A pung completed by the winning discard is marked `ronCompleted` (`markRonCompletedSet`, `scoring.js`) and excluded from 暗刻 counts, while the hand-level concealment (門前清/不求人) stays intact.
- **HK keeps honour yakuhai additive; MCR absorbs.** The `additive` flag protects 三元牌/門風/圈風 from the HK non-repeat pass (`keepAdditive`, `scoring.js`). MCR's stricter pass still folds them in.
- **Special hands are fully concealed by definition** (scored at `melds.length === 0`), so `concealmentFan` awards 門前清/不求人 for them (`scoring.js`).
- **The probe bounds untrusted arrays** (`MAX_HAND=18`, `MAX_MELDS=4`, `MAX_MELD_TILES=4`, `MAX_FLOWERS=8`, `probe.js`) and assigns fresh tile ids, because the recursive win search is otherwise a DoS vector on the single event loop.
- **Engine import direction:** `scoring.js` never requires `rulesets.js`. Breaking this introduces a require cycle.

## Code map

- Engine: `scoring.js`
  - Decomposition: `decompose`, `normalizeMeld`, `markRonCompletedSet`.
  - Library: `PATTERNS`, `SEVEN_PAIRS_FAAN`, `DEFAULT_SCORING`.
  - Override lookups: `overrideById`/`isEnabledId`/`effFaanId`/`effFaan`/`effPoints`/`effPointsId`/`isEnabled` (–).
  - HK scoring: `faanToPoints`, `groupedPayout`, `payoutFor`, `scoreDecomposition`.
  - Non-repeat: `applyNonRepeat`, `IMPLIES_GRAPH`/`reachableImplied`.
  - MCR scoring: `scoreDecompositionMcr`, `scoreWinMcr`.
  - Special hands: `scoreThirteenOrphans`, `scoreSevenPairs`, knitted (–).
  - Context folds: `addContextFaan`, `addContextMcr`, `concealmentFan`.
  - Waits: `analyzeWait`, `shapeOfWinningTile`.
  - Entry points: `scoreWin`, `computePayments`, `resolveCfg`, `resolveMode`.
- Config: `rulesets.js` — `MODES`, `KNOWN_PATTERN_IDS`, `PRESETS`, `sanitizeRuleset`.
- Probe: `probe.js` — `probeScore`, `cleanTile`/`cleanTiles`.
- Server: `server.js` — `CATALOG`/`PATTERN_CATALOG`, `/api/catalog`, `SCORING` env, `defaultRuleset`, `winFloorMessage`, handlers (–).
- Client: `public/ruleset-editor.js` — `createRulesetEditor`; `public/index.html` — editor wiring (–); `public/sandbox.html` — sandbox (whole file).
- Examples: `canonical-examples.js` — `EXAMPLES`.

## Tests

| Test file | Covers |
| --- | --- |
| `test/scoring.test.js` | The core faan engine: specific hands, faan totals, patterns, payments. |
| `test/rulesets.test.js` | The ruleset model + `sanitizeRuleset`, and the back-compat shim (HK Standard == legacy behaviour). |
| `test/library.test.js` | Pattern-library metadata + the multiplicity refactor; under HK Standard the contributed faan equals the old hard-coded magnitudes. |
| `test/modes.test.js` | The payout modes (`hk-doubling` legacy points; `hk-grouped` tiers + limit-to-top-tier). |
| `test/mcr.test.js` | MCR additive mode: point summation, 8-point floor, Chicken Hand, flowers, MCR payment formula. |
| `test/mcr-extended.test.js` | The expressible MCR structural patterns (default-off) + the HK Extended preset; HK Standard ignores them. |
| `test/mcr-nonrepeat.test.js` | The MCR non-repeat rule (implication absorption + exclusion tie-break). |
| `test/mcr-catalog.test.js` | Every canonical example through `probeScore`; the source of truth the sandbox grid shares. |
| `test/hk-nonrepeat.test.js` | The HK non-repeat rule (suppress redundant fans, keep additive yakuhai); MCR unchanged. |
| `test/ron-concealed.test.js` | A discard-completed pung is not a concealed pung, but the hand is still 門前清. |
| `test/special-context.test.js` | Special hands (七對/十三幺/knitted) fold the situational context fans in both modes. |
| `test/knitted.test.js` | Knitted-hand recognizers, ruleset-gated `checkWin`, and scoring under both modes. |
| `test/waits.test.js` | `analyzeWait` + the wait-shape / last-of-kind / melded-hand context fans. |
| `test/rules-parity.test.js` | `mahjong.js` (server) vs. `public/shared/rules-client.js` (3D client) agree exactly (verbatim twins) — adjacent to scoring (win legality), not the scoring engine itself. |
