// Rulesets — the per-room scoring configuration that drives scoring.js.
//
// A ruleset selects a payout MODE and overlays sparse per-pattern deltas over
// the static pattern library in scoring.js. Built-in PRESETS are the starting
// points; hosts tweak them in the lobby and (when logged in) save custom ones.
// sanitizeRuleset() is the trust boundary: every ruleset that arrives from a
// client passes through it before the engine ever sees it.
//
// This module depends on scoring.js (for the canonical pattern-id list) but
// scoring.js MUST NOT depend on this module — that keeps the engine standalone
// and avoids a require cycle. The engine accepts either a ruleset (with .mode)
// or the legacy {minFaan,limitFaan,basePoints} shape via its own shim.

const { PATTERNS } = require('./scoring');

const MODES = new Set(['hk-doubling', 'hk-grouped', 'mcr-additive']);

// Every id a ruleset may legitimately reference. PATTERNS plus the two special
// concealed hands that are scored outside the pattern table.
const KNOWN_PATTERN_IDS = new Set([
  ...PATTERNS.map(p => p.id),
  'seven-pairs',
  'thirteen-orphans',
  // Knitted special hands (scored out-of-band, gated by `allow`).
  'greater-knitted',
  'lesser-knitted',
  'knitted-straight',
]);

const MAX_PATTERN_OVERRIDES = 200;
const MAX_FAAN = 99;     // bound; the engine separately caps payout at limitFaan
const MAX_POINTS = 999;
const MAX_NAME_LEN = 40;

const clone = o => JSON.parse(JSON.stringify(o));

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

// ── Built-in presets ──────────────────────────────────────────────────────────
//
// HK Standard reproduces today's scoring exactly: hk-doubling, the legacy
// limits, and NO pattern overrides (so the library defaults — which equal the
// current behaviour — apply). HK Extended and MCR Official are filled in by
// later increments as the modes and full library land.

const HK_DEFAULT_ALLOW = {
  sevenPairs: true,
  thirteenOrphans: true,
  knittedStraight: false,
  lesserKnitted: false,
  greaterKnitted: false,
};

// HK Extended turns on the expressible MCR structural fans (at their default
// hkFaan) on top of the standard HK game — the "combos that do nothing in HK"
// the host asked for — while keeping the HK doubling payout.
const HK_EXTENDED_ENABLED = [
  'pure-double-chow', 'mixed-double-chow', 'short-straight', 'two-terminal-chows',
  'mixed-triple-chow', 'pure-triple-chow', 'mixed-straight', 'mixed-shifted-chows',
  'pure-shifted-chows', 'double-pung', 'triple-pung', 'mixed-shifted-pungs',
  'pure-shifted-pungs', 'two-dragon-pungs', 'big-three-winds', 'two-concealed-pungs',
  'three-concealed-pungs', 'tile-hog', 'all-simples', 'one-voided-suit', 'all-types',
  'reversible-tiles', 'outside-hand', 'all-fives', 'all-even-pungs',
  'upper-tiles', 'middle-tiles', 'lower-tiles', 'upper-four', 'lower-four',
];

const PRESETS = {
  'hk-standard': {
    id: 'hk-standard',
    name: 'HK Standard',
    builtin: true,
    mode: 'hk-doubling',
    hk: { minFaan: 0, limitFaan: 13, basePoints: 1 },
    grouped: { breakpoints: [3, 5, 8, 11], basePoints: 1 },
    mcr: { minPoints: 8, base: 8, basePoints: 1 },
    allow: { ...HK_DEFAULT_ALLOW },
    patterns: {},
  },
  'hk-extended': {
    id: 'hk-extended',
    name: 'HK Extended',
    builtin: true,
    mode: 'hk-doubling',
    hk: { minFaan: 0, limitFaan: 13, basePoints: 1 },
    grouped: { breakpoints: [3, 5, 8, 11], basePoints: 1 },
    mcr: { minPoints: 8, base: 8, basePoints: 1 },
    allow: { ...HK_DEFAULT_ALLOW },
    patterns: Object.fromEntries(HK_EXTENDED_ENABLED.map(id => [id, { enabled: true }])),
  },
  'mcr-official': {
    id: 'mcr-official',
    name: 'MCR Official',
    builtin: true,
    mode: 'mcr-additive',
    hk: { minFaan: 0, limitFaan: 13, basePoints: 1 },
    grouped: { breakpoints: [3, 5, 8, 11], basePoints: 1 },
    mcr: { minPoints: 8, base: 8, basePoints: 1 },
    allow: { sevenPairs: true, thirteenOrphans: true, knittedStraight: true, lesserKnitted: true, greaterKnitted: true },
    // Every catalogued fan on, at its official points.
    patterns: Object.fromEntries([...KNOWN_PATTERN_IDS].map(id => [id, { enabled: true }])),
  },
};

// ── Sanitizer (trust boundary for untrusted host input) ───────────────────────

function sanitizeRuleset(input) {
  if (!input || typeof input !== 'object') input = {};
  const base = clone(PRESETS['hk-standard']);

  const mode = MODES.has(input.mode) ? input.mode : 'hk-doubling';

  // hk params — limitFaan first so minFaan can clamp against it.
  const inHk = (input.hk && typeof input.hk === 'object') ? input.hk : {};
  const limitFaan = clampInt(inHk.limitFaan, 1, 26, base.hk.limitFaan);
  const minFaan = clampInt(inHk.minFaan, 0, limitFaan, base.hk.minFaan);
  const hkBasePoints = clampInt(inHk.basePoints, 1, 10000, base.hk.basePoints);

  // grouped params
  const inGrouped = (input.grouped && typeof input.grouped === 'object') ? input.grouped : {};
  let breakpoints = base.grouped.breakpoints.slice();
  if (Array.isArray(inGrouped.breakpoints)) {
    const bp = inGrouped.breakpoints.map(x => Math.round(Number(x)));
    const ok = bp.length >= 1 && bp.length <= 8 &&
      bp.every((v, i) => Number.isFinite(v) && v > 0 && v <= MAX_FAAN && (i === 0 || v > bp[i - 1]));
    if (ok) breakpoints = bp;
  }
  const groupedBasePoints = clampInt(inGrouped.basePoints, 1, 10000, base.grouped.basePoints);

  // mcr params
  const inMcr = (input.mcr && typeof input.mcr === 'object') ? input.mcr : {};
  const minPoints = clampInt(inMcr.minPoints, 0, 88, base.mcr.minPoints);
  const mcrBase = clampInt(inMcr.base, 0, 100, base.mcr.base);
  const mcrBasePoints = clampInt(inMcr.basePoints, 1, 1000, base.mcr.basePoints);

  // allow flags
  const inAllow = (input.allow && typeof input.allow === 'object') ? input.allow : {};
  const allow = {};
  for (const k of Object.keys(base.allow)) {
    allow[k] = (k in inAllow) ? inAllow[k] === true : base.allow[k];
  }

  // pattern overrides — whitelisted ids only, into a null-proto object.
  const patterns = Object.create(null);
  const src = (input.patterns && typeof input.patterns === 'object') ? input.patterns : {};
  let count = 0;
  for (const id of Object.keys(src)) {
    if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
    if (!KNOWN_PATTERN_IDS.has(id)) continue;
    if (count >= MAX_PATTERN_OVERRIDES) break;
    const e = src[id];
    if (!e || typeof e !== 'object') continue;
    const entry = {};
    if ('enabled' in e) entry.enabled = e.enabled === true;
    if ('faan' in e) entry.faan = clampInt(e.faan, 0, MAX_FAAN, 0);
    if ('points' in e) entry.points = clampInt(e.points, 0, MAX_POINTS, 0);
    patterns[id] = entry;
    count++;
  }

  // Keep special-hand SCORING in lockstep with win-LEGALITY. checkWin() gates 七對 /
  // 十三幺 on the allow.* flag, but scoreWin() gates them on patterns[id].enabled — and
  // the editor only toggles the allow flag. Force enabled to track it, else a ruleset
  // with allow:true + enabled:false is a legal win that silently scores 0. (Knitted
  // already scores via the allow flag, so it needs no sync.)
  for (const [flag, pid] of [['sevenPairs', 'seven-pairs'], ['thirteenOrphans', 'thirteen-orphans']]) {
    (patterns[pid] || (patterns[pid] = {})).enabled = allow[flag] === true;
  }

  const id = typeof input.id === 'string' ? input.id.slice(0, 60) : 'custom';
  const builtin = !!(PRESETS[id] && PRESETS[id].builtin) && id === input.id;
  const name = typeof input.name === 'string' && input.name.trim()
    ? input.name.trim().slice(0, MAX_NAME_LEN)
    : (PRESETS[id] ? PRESETS[id].name : 'Custom');

  return {
    id, name, builtin, mode,
    hk: { minFaan, limitFaan, basePoints: hkBasePoints },
    grouped: { breakpoints, basePoints: groupedBasePoints },
    mcr: { minPoints, base: mcrBase, basePoints: mcrBasePoints },
    allow,
    patterns,
  };
}

module.exports = { PRESETS, sanitizeRuleset, KNOWN_PATTERN_IDS, MODES };
