// state.js — single source of truth mirroring the server's gameState.
//
// This is the data hub. It imports NOTHING from Three. main.js feeds every
// `gameUpdate` here via applyGameUpdate(); tiles.js / hud.js / avatar.js subscribe
// and reconcile/render from the resulting store snapshot.
//
// The store fields and reconcile entry points match the contract §5.3 exactly.
// The relative-seat math mirrors game.js (lines 170–185, 576) verbatim.

// ── The store: the local mirror of authoritative server state ────────────────
export const store = {
  gameState: null,       // last gameUpdate object (contract §2); null until first update
  myIndex: null,         // local absolute seat index
  amHost: false,         // host flag (gates Next Hand)
  claimResponded: false, // locked after a claim/rob response until phase changes
  prevPhase: null,       // previous gameState.phase, for transition detection
};

// Subscribers fired after every applyGameUpdate(store).
const subscribers = new Set();

// True for the two windows where the local player may respond to a discard/kong.
const respondable = ph => ph === 'claim' || ph === 'rob';

// ── Mutators ─────────────────────────────────────────────────────────────────

// setMyIndex(i): set the local absolute seat (from rejoined / identityUpdate /
// gameUpdate.playerIndex). Does NOT notify on its own; the next applyGameUpdate will.
export function setMyIndex(i) {
  if (i != null) store.myIndex = i;
}

// setAmHost(v): set the host flag (from rejoined / identityUpdate).
export function setAmHost(v) {
  store.amHost = !!v;
}

// applyGameUpdate(state): the per-frame authority.
//  - stores the new gameState;
//  - re-asserts myIndex when state.playerIndex is present;
//  - resets claimResponded when we cross INTO or OUT OF a claim/rob window
//    (matches game.js: respondable(new) !== respondable(prev));
//  - updates prevPhase; then notifies all subscribers.
export function applyGameUpdate(state) {
  const prevPhase = store.prevPhase;
  store.gameState = state;
  if (state && state.playerIndex != null) store.myIndex = state.playerIndex;
  const newPhase = state ? state.phase : null;
  if (respondable(newPhase) !== respondable(prevPhase)) store.claimResponded = false;
  store.prevPhase = newPhase;
  notify();
}

// setClaimResponded(v): lock (true) / unlock (false) the local claim panel.
// Locked after sending a claim/pass; unlocked on phase change or on actionError.
export function setClaimResponded(v) {
  store.claimResponded = !!v;
}

// ── Subscription ─────────────────────────────────────────────────────────────

// subscribe(fn): register a reconcile/render callback fired after every
// applyGameUpdate. Returns an unsubscribe function.
export function subscribe(fn) {
  subscribers.add(fn);
  // Replay the latest snapshot immediately. main.js registers gameUpdate ->
  // applyGameUpdate BEFORE its async asset loads, but subscribes AFTER them, so the
  // first gameUpdate can land while no subscriber exists yet. When the local player
  // is dealer (acts first) no further update is coming, so without this replay the
  // scene would stay empty until the player's first action. Replaying here renders
  // immediately for any subscriber that registers late.
  if (store.gameState) {
    try { fn(store); }
    catch (err) { console.error('[state] subscriber threw on replay', err); }
  }
  return () => subscribers.delete(fn);
}

// Fire all subscribers with the current store. Errors are isolated so one bad
// subscriber can't break the others.
function notify() {
  for (const fn of subscribers) {
    try { fn(store); }
    catch (err) { console.error('[state] subscriber threw', err); }
  }
}

// ── Seat mapping (relative <-> absolute), identical to game.js ───────────────
// Relative seats: 0 = near (local), 1 = right, 2 = across, 3 = left.

// relativeSeat(abs): absolute server seat -> relative seat around the local player.
export function relativeSeat(absSeat) {
  const n = seatCount();
  return (((absSeat - store.myIndex) % n) + n) % n;
}

// absSeatAtRelative(rel): inverse of relativeSeat().
export function absSeatAtRelative(rel) {
  const n = seatCount();
  return (store.myIndex + rel) % n;
}

// Number of players in the current game (defaults to 4 before first update).
function seatCount() {
  return (store.gameState && store.gameState.players)
    ? store.gameState.players.length
    : 4;
}

// ── Convenience accessors ────────────────────────────────────────────────────

// me(): the local player's gameState entry (or null).
export function me() {
  if (!store.gameState || store.myIndex == null) return null;
  return store.gameState.players[store.myIndex] || null;
}

// localHand(): the local player's sorted hand (server provides hand only for self).
export function localHand() {
  const p = me();
  return (p && p.hand) ? p.hand : [];
}
