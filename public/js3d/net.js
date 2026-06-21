// net.js — Socket.IO transport for the 3D client.
//
// This is the ONLY module that touches the socket. It owns the single io()
// instance, exposes typed emit helpers, routes inbound events to handlers that
// main.js registers, and holds the playerLook throttle (50 ms + epsilon).
//
// It NEVER imports Three.js or any scene module — pure transport. The socket.io
// client global `io` is loaded by game3d.html via <script src="/socket.io/socket.io.js">.

// ── Internal state ───────────────────────────────────────────────────────────
let socket = null;                 // the single io() instance
const handlers = Object.create(null); // name -> [fn, ...] registered via onEvent

// playerLook outbound throttle: ~20 Hz (50 ms) and only past a delta epsilon.
const LOOK_THROTTLE_MS = 50;
const LOOK_EPS = 0.01;             // radians — skip emits below this delta
let lastLookEmit = 0;
let lastYaw = null;
let lastPitch = null;

// The full set of inbound server events the 3D client listens for. Every name
// here is wired through to the handlers[] registered by main.js so that adding a
// listener is just `onEvent(name, fn)`. 'connect' is included so doRejoin fires.
const INBOUND_EVENTS = [
  'connect',
  'rejoined',
  'rejoinError',
  'gameUpdate',
  'gameOver',
  'matchOver',
  'endVoteUpdate',
  'backToLobby',
  'playerDisconnected',
  'actionError',
  'roomUpdate',
  'chatHistory',
  'chatMessage',
  'playerAction',
  'identityUpdate',
  'playerLook',     // NEW — remote head orientation
  'interactState',  // NEW — prop state (optional/stub)
];

// Dispatch a payload to every handler registered for `name`.
function dispatch(name, payload) {
  const list = handlers[name];
  if (!list) return;
  for (const fn of list) {
    try { fn(payload); }
    catch (err) { console.error(`[net] handler for "${name}" threw`, err); }
  }
}

// ── Public interface ─────────────────────────────────────────────────────────

// connect(): create (once) and return the socket. Idempotent.
export function connect() {
  if (socket) return socket;
  // io() is the global from /socket.io/socket.io.js, same as game.html uses.
  socket = io();
  // Bind every inbound event to our dispatcher exactly once.
  for (const name of INBOUND_EVENTS) {
    socket.on(name, payload => dispatch(name, payload));
  }
  return socket;
}

// onEvent(name, handler): register an inbound handler. Many handlers per event ok.
export function onEvent(name, handler) {
  (handlers[name] || (handlers[name] = [])).push(handler);
}

// doRejoin(): re-read sessionStorage 'mahjong' fresh and emit rejoin {code, token}.
// Bound by main.js to the 'connect' event AND called once at boot if already connected.
export function doRejoin() {
  const s = JSON.parse(sessionStorage.getItem('mahjong') || '{}');
  if (s.code && s.token && socket) {
    socket.emit('rejoin', { code: s.code, token: s.token });
  }
}

// ── Gameplay emits (exact events/payloads per the contract §1.1) ─────────────
export function emitDiscard(tileId)          { socket && socket.emit('discard', { tileId }); }
export function emitClaim(type, tileIds = []) { socket && socket.emit('claim', { type, tileIds }); }
export function emitPass()                    { socket && socket.emit('pass'); }
export function emitDeclareWin()              { socket && socket.emit('declareWin'); }
export function emitDeclareKong(tileId)       { socket && socket.emit('declareKong', { tileId }); }
export function emitDeclareAddedKong(tileId)  { socket && socket.emit('declareAddedKong', { tileId }); }
export function emitNextHand()                { socket && socket.emit('nextHand'); }
export function emitEndMatchVote(value)       { socket && socket.emit('endMatchVote', { value }); }
export function emitReturnToLobby()           { socket && socket.emit('returnToLobby'); }
export function emitChat(text)                { socket && socket.emit('chat', { text }); }
export function emitRequestState()            { socket && socket.emit('requestState'); }

// emitPlayerLook(yaw, pitch): NEW. Throttled to ~20 Hz and skipped below epsilon.
// Fire-and-forget; the server relays {playerIndex, yaw, pitch} to other clients.
export function emitPlayerLook(yaw, pitch) {
  if (!socket) return;
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (now - lastLookEmit < LOOK_THROTTLE_MS) return;
  if (lastYaw !== null &&
      Math.abs(yaw - lastYaw) < LOOK_EPS &&
      Math.abs(pitch - lastPitch) < LOOK_EPS) return;
  lastLookEmit = now;
  lastYaw = yaw;
  lastPitch = pitch;
  socket.emit('playerLook', { yaw, pitch });
}

// emitInteractState(object, state): NEW, optional/stub. `object` is a string key
// (e.g. 'teacup-0', 'lamp'); `state` fields are spread into the payload. Safe no-op
// if interact features are stubbed — it just never gets called in that case.
export function emitInteractState(object, state = {}) {
  if (!socket) return;
  socket.emit('interactState', { object, ...state });
}

// getSocket(): escape hatch for chat.js wiring (chat.js takes a raw socket).
export function getSocket() { return socket; }
