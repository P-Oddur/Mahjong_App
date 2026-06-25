// Pure, dependency-free logic shared by the 2D (game.js) and 3D (hud.js / token.js)
// clients. NO DOM, NO Three.js, NO sockets — unit-tested in Node.

// Single source of timing feel — tune here (see plan "Timing model").
export const TIMING = { tokenSlideMs: 500, discardRevealMs: 1500 };

// Urgency ramp — fraction-based so it reads identically for ANY countdown length.
export const RAMP = { full: '#f0c040', warn: '#ff9800', danger: '#f44336' };

export function timerFraction(remainingMs, totalMs) {
  if (!(totalMs > 0)) return 0;
  return Math.max(0, Math.min(1, remainingMs / totalMs));
}

export function secondsLeft(remainingMs) {
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

export function rampColor(frac) {
  return frac > 0.5 ? RAMP.full : frac > 0.2 ? RAMP.warn : RAMP.danger;
}

// SVG stroke-dasharray for a perimeter halo whose <rect> has pathLength="100".
export function haloDashArray(frac) {
  return `${(Math.max(0, Math.min(1, frac)) * 100).toFixed(2)} 100`;
}

// Which clock is live. Replaces the duplicated selection in game.js + js3d/hud.js.
// Bots have no turnDeadline (server skips arming for them) → returns null on a bot
// turn, so the token shows no digit.
export function liveClock(gs) {
  if (!gs) return null;
  if ((gs.phase === 'claim' || gs.phase === 'rob') && gs.claimDeadline) {
    return { kind: 'claim', deadline: gs.claimDeadline, totalMs: (gs.reactTimer || 5) * 1000 };
  }
  if (gs.phase === 'discard' && gs.turnDeadline) {
    const totalMs = gs.turnTotal || (gs.turnTimer > 0 ? gs.turnTimer : 30) * 1000;
    return { kind: 'turn', deadline: gs.turnDeadline, totalMs };
  }
  return null;
}

// The tile to REVEAL — the most recent discard, regardless of phase. Reveal is keyed
// off this tile's .id changing, so auto-skipped discards (which never broadcast a
// 'claim' phase) are still shown.
export function currentDiscard(gs) {
  return (gs && gs.lastDiscard) || null;
}

// Best single claim for a one-tap shortcut: win > kong > pong > UNAMBIGUOUS chow.
// getChowOptions is injected so this module stays rules-engine-free. Returns
// { type, tileIds } or null. For chow, tileIds is the two tiles FROM HAND (the
// discard is excluded — the server matches against the player's hand) and a tap is
// only offered when exactly one chow option exists, since a single tap can't pick
// between several. Returns null for a multi-option ("ambiguous") chow.
export function bestClaimAction(valid, hand, discard, getChowOptions) {
  if (valid.includes('win'))  return { type: 'win',  tileIds: [] };
  if (valid.includes('kong')) return { type: 'kong', tileIds: [] };
  if (valid.includes('pong')) return { type: 'pong', tileIds: [] };
  if (valid.includes('chow')) {
    const opts = getChowOptions(hand, discard);
    if (opts.length === 1) {
      return { type: 'chow', tileIds: opts[0].filter(t => t !== discard).map(t => t.id) };
    }
  }
  return null;
}

// The local player's claim affordance on the current discard, computed ONCE per
// gameState. Both the 3D discard glow (tiles.js) and the reaction panel (hud.js)
// ask for this on the same update; memoising on the gs reference means getValidClaims
// runs a single time instead of once per caller (a fresh gameUpdate replaces gs →
// cache misses). Rules fns injected to keep this module pure. Returns:
//   { valid: string[], action: {type,tileIds}|null, ambiguous: boolean }
// ambiguous = a chow is available but spread across several options, so there is no
// single tap action (the per-option buttons handle it; callers may show a hint).
const EMPTY_CLAIM = Object.freeze({ valid: [], action: null, ambiguous: false });
let _claimMemo = { gs: null, myIndex: null, out: EMPTY_CLAIM };

export function localClaim(gs, myIndex, getValidClaims, getChowOptions) {
  if (_claimMemo.gs === gs && _claimMemo.myIndex === myIndex) return _claimMemo.out;
  const out = computeLocalClaim(gs, myIndex, getValidClaims, getChowOptions);
  _claimMemo = { gs, myIndex, out };
  return out;
}

function computeLocalClaim(gs, myIndex, getValidClaims, getChowOptions) {
  const me = (gs && myIndex != null && gs.players) ? gs.players[myIndex] : null;
  if (!gs || gs.phase !== 'claim' || !gs.lastDiscard || !me || !me.hand
      || gs.lastDiscardPlayer === myIndex) return EMPTY_CLAIM;
  const isNext = (gs.lastDiscardPlayer + 1) % gs.players.length === myIndex;
  const valid = getValidClaims(me.hand, me.melds, gs.lastDiscard, isNext, gs.ruleset);
  if (!valid.length) return EMPTY_CLAIM;
  const action = bestClaimAction(valid, me.hand, gs.lastDiscard, getChowOptions);
  return { valid, action, ambiguous: !action && valid.includes('chow') };
}
