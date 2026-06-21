// audio.js — minimal WebAudio placeholder audio manager for the 3D client.
//
// Contract §5.11. Five named exports, all synthesized with the Web Audio API so
// there is NO asset/licensing dependency in v1:
//
//   initAudio()        create the AudioContext lazily, on first user gesture.
//   playTileClick()    a short synthesized click for discard/draw.
//   startAmbient()     a soft looping parlor ambient (synth stub).
//   stopAmbient()      stop the ambient bed.
//   setMuted(muted)    master mute toggle.
//
// Design notes:
//  - Browsers require the AudioContext to be created/resumed inside a user
//    gesture (click / keydown / pointerdown). main.js calls initAudio() during
//    boot, but the context may start 'suspended'; we ALSO bind one-shot gesture
//    listeners that resume it on the first real interaction, so SFX work without
//    the caller having to think about autoplay policy.
//  - Everything routes through a single master GainNode so setMuted() is trivial
//    and so a real audio layer can later be dropped in behind the same interface
//    (swap the synth bodies for buffer playback; the exported shape stays identical).
//  - All functions are no-op-safe before initAudio() / when WebAudio is missing.

// ── Module-private state ──────────────────────────────────────────────────────
let ctx = null;            // AudioContext (created lazily in initAudio)
let masterGain = null;     // master bus -> destination (mute lives here)
let muted = false;         // master mute flag (persists across init)

// Ambient bed handles (so startAmbient/stopAmbient can tear it down cleanly).
let ambientGain = null;    // ambient sub-bus under masterGain
let ambientNodes = null;   // { sources:[...], lfo, lfoGain } while running
let ambientRunning = false;

// Target levels (kept low — this is a soft placeholder, not a finished mix).
const MASTER_LEVEL = 0.9;
const AMBIENT_LEVEL = 0.045;

// One-shot gesture listener bookkeeping so we can unbind after first resume.
let gestureBound = false;

// Resolve a usable AudioContext constructor (standard or webkit-prefixed).
function AudioCtor() {
  return (typeof window !== 'undefined') &&
    (window.AudioContext || window.webkitAudioContext) || null;
}

// Resume a suspended context (best-effort; ignores the rejected promise that
// some browsers throw when called outside a gesture).
function tryResume() {
  if (ctx && ctx.state === 'suspended') {
    const p = ctx.resume();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
}

// Bind one-shot user-gesture listeners that resume the context. Many browsers
// only allow audio to start from within a gesture, so this guarantees the first
// click/key/tap unlocks sound regardless of when initAudio() was called.
function bindGestureUnlock() {
  if (gestureBound || typeof window === 'undefined') return;
  gestureBound = true;
  const unlock = () => {
    tryResume();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
    window.removeEventListener('touchstart', unlock);
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
  window.addEventListener('touchstart', unlock, { once: true });
}

// ── Public interface ──────────────────────────────────────────────────────────

// initAudio(): create the AudioContext + master bus lazily, on first user gesture.
// Idempotent — safe to call multiple times. main.js calls this once during boot.
export function initAudio() {
  if (ctx) { tryResume(); return; }            // already initialized
  const Ctor = AudioCtor();
  if (!Ctor) { console.warn('[audio] WebAudio unavailable; audio disabled'); return; }

  try {
    ctx = new Ctor();
  } catch (err) {
    console.warn('[audio] failed to create AudioContext', err);
    ctx = null;
    return;
  }

  // Master bus: all sound flows through here so mute is a single gain change.
  masterGain = ctx.createGain();
  masterGain.gain.value = muted ? 0 : MASTER_LEVEL;
  masterGain.connect(ctx.destination);

  // The context often starts 'suspended' under autoplay policy — unlock on the
  // first real gesture.
  tryResume();
  bindGestureUnlock();
}

// playTileClick(): a short synthesized click for discard/draw — a quick burst of
// filtered noise plus a tiny pitched tick, shaped by a fast decay envelope to read
// as a hard ceramic/bamboo tile tap. Cheap and self-cleaning (nodes stop & GC).
export function playTileClick() {
  if (!ctx || !masterGain) return;
  tryResume();

  const now = ctx.currentTime;

  // Local mixer for this one shot so we can fade the whole click at once.
  const clickGain = ctx.createGain();
  clickGain.connect(masterGain);

  // 1) Noise burst — the "clack" body. A very short white-noise buffer through a
  //    band-pass filter to give it a woody/ceramic timbre.
  const noiseLen = 0.05; // seconds
  const frames = Math.max(1, Math.floor(ctx.sampleRate * noiseLen));
  const noiseBuf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2200; // emphasize a hard, clicky midrange
  bp.Q.value = 0.8;

  noise.connect(bp).connect(clickGain);

  // 2) Pitched tick — a brief high sine that adds a crisp transient on top.
  const tick = ctx.createOscillator();
  tick.type = 'sine';
  tick.frequency.setValueAtTime(1400, now);
  tick.frequency.exponentialRampToValueAtTime(700, now + 0.03);
  tick.connect(clickGain);

  // Fast percussive envelope: near-instant attack, ~60 ms exponential decay.
  const peak = 0.6;
  clickGain.gain.setValueAtTime(0.0001, now);
  clickGain.gain.exponentialRampToValueAtTime(peak, now + 0.002);
  clickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);

  // Schedule playback and self-cleanup.
  noise.start(now);
  noise.stop(now + noiseLen);
  tick.start(now);
  tick.stop(now + 0.06);

  // Disconnect the local bus shortly after it goes silent to avoid node buildup.
  const cleanup = () => { try { clickGain.disconnect(); } catch (e) {} };
  noise.onended = cleanup;
}

// startAmbient(): a soft, slowly-modulated parlor ambient bed (synth stub). Two
// detuned low oscillators through a low-pass filter, with a gentle LFO breathing
// the level so it doesn't sit perfectly static. Idempotent — calling twice while
// already running is a no-op.
export function startAmbient() {
  if (!ctx || !masterGain) return;
  if (ambientRunning) return;
  tryResume();

  const now = ctx.currentTime;

  // Ambient sub-bus, faded in to avoid a click on start.
  ambientGain = ctx.createGain();
  ambientGain.gain.setValueAtTime(0.0001, now);
  ambientGain.gain.exponentialRampToValueAtTime(AMBIENT_LEVEL, now + 1.5);
  ambientGain.connect(masterGain);

  // Warm, dark bed: keep only low frequencies so it reads as room tone.
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 320;
  lp.Q.value = 0.3;
  lp.connect(ambientGain);

  // Two slightly-detuned low drones for a subtle chorus/beating.
  const droneA = ctx.createOscillator();
  droneA.type = 'sine';
  droneA.frequency.value = 110;        // ~A2
  const droneB = ctx.createOscillator();
  droneB.type = 'triangle';
  droneB.frequency.value = 110 * 1.003; // tiny detune -> slow beat
  droneA.connect(lp);
  droneB.connect(lp);

  // Slow LFO breathing the ambient level for a living-room feel.
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.07;          // ~14 s period
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = AMBIENT_LEVEL * 0.4; // modulation depth
  lfo.connect(lfoGain).connect(ambientGain.gain);

  droneA.start(now);
  droneB.start(now);
  lfo.start(now);

  ambientNodes = { sources: [droneA, droneB], lfo, lfoGain, lp };
  ambientRunning = true;
}

// stopAmbient(): fade out and tear down the ambient bed. Safe if not running.
export function stopAmbient() {
  if (!ctx || !ambientRunning || !ambientGain) { ambientRunning = false; return; }

  const now = ctx.currentTime;
  const FADE = 0.8; // seconds

  // Cancel any scheduled (LFO) automation, then ramp to silence.
  try {
    ambientGain.gain.cancelScheduledValues(now);
    ambientGain.gain.setValueAtTime(Math.max(0.0001, ambientGain.gain.value), now);
    ambientGain.gain.exponentialRampToValueAtTime(0.0001, now + FADE);
  } catch (e) {}

  const nodes = ambientNodes;
  const busToKill = ambientGain;
  const stopAt = now + FADE + 0.05;

  if (nodes) {
    for (const src of nodes.sources) { try { src.stop(stopAt); } catch (e) {} }
    try { nodes.lfo.stop(stopAt); } catch (e) {}
  }

  // Disconnect the sub-bus after the fade completes.
  setTimeout(() => { try { busToKill.disconnect(); } catch (e) {} },
             (FADE + 0.1) * 1000);

  ambientNodes = null;
  ambientGain = null;
  ambientRunning = false;
}

// setMuted(muted): master mute toggle. Persists even before initAudio() so an
// early call is honored once the context exists. Smoothly ramps to avoid clicks.
export function setMuted(value) {
  muted = !!value;
  if (!ctx || !masterGain) return; // remembered; applied at init
  const now = ctx.currentTime;
  const target = muted ? 0 : MASTER_LEVEL;
  try {
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setValueAtTime(masterGain.gain.value, now);
    masterGain.gain.linearRampToValueAtTime(target, now + 0.05);
  } catch (e) {
    masterGain.gain.value = target;
  }
}
