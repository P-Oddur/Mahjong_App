// parlour/animate.js — per-frame animation for the procedural parlour decor.
//
// Ported from the parlour.js render loop (~line 1879+). GROUP A scope is the
// neon-flicker loop (~line 1884); later groups (4b/4c/4d) extend the SAME
// registry with their own animated handles (fan spin, clock hands, dust drift,
// tube buzz, candle flicker, …).
//
// ── The animated registry (cross-module contract) ────────────────────────────
// buildDecor(scene) (decor.js) builds an `animated` registry object and returns
// it. scene.js stores that object and passes it back into updateParlour every
// frame. The registry is a plain object keyed by animation CATEGORY:
//
//   animated.neon  : Array<{ m: Material, base: number }>   ← GROUP A
//   animated.fan   : Object3D                               ← 4b (later)
//   animated.dust  : Points                                 ← 4d (later)
//   ...etc
//
// updateParlour only touches categories that are present (every block is guarded),
// so each group can add its handles without editing the others. Two ways to
// register, both supported:
//   • buildDecor fills the arrays/handles directly (GROUP A does this), or
//   • call register(animated, 'neon', entry) to push onto a category array.
//
// updateParlour(dt, elapsed, animated): dt = seconds since last frame,
// elapsed = total seconds (a monotonic clock), animated = the registry.

// makeRegistry() — a fresh, empty animated registry. decor.js calls this so the
// shape is owned in one place. GROUP A only needs `neon`; later groups add keys.
export function makeRegistry() {
  return {
    neon: [],   // [{ m: MeshStandardMaterial, base: number }] — flickering neon
    // 4b/4c/4d will add: fan, secHand, minHand, dust, tubes, candle, tv, …
  };
}

// register(animated, key, entry) — append `entry` to a category array (creating
// it if absent). Convenience for later groups that build incrementally; GROUP A
// pushes directly onto animated.neon in decor.js, so this is mostly for 4b+.
export function register(animated, key, entry) {
  if (!Array.isArray(animated[key])) animated[key] = [];
  animated[key].push(entry);
  return entry;
}

// updateParlour(dt, elapsed, animated) — advance every present animation by one
// frame. Each category is independently guarded so groups compose cleanly.
export function updateParlour(dt, elapsed, animated) {
  if (!animated) return;
  const t = elapsed;

  // ── Neon flicker (GROUP A) ─────────────────────────────────────────────────
  // Mostly steady with a tiny high-frequency shimmer and an occasional brownout
  // dip. emissiveIntensity scales with each sign's baked `base`, and is clamped
  // at 0 so a sign whose base is 0 (fully dimmed) stays dark. Ported verbatim
  // from parlour.js ~line 1884.
  if (Array.isArray(animated.neon)) {
    for (const n of animated.neon) {
      const buzz = Math.sin(t * 90) * 0.04;                                            // tiny shimmer
      const dip = (Math.sin(t * 0.7) > 0.985 || Math.sin(t * 3.1) > 0.997) ? -0.4 : 0; // occasional brownout
      const v = n.base * (1 + buzz + dip);
      n.m.emissiveIntensity = Number.isFinite(v) ? Math.max(0, v) : 0;                  // guard NaN (Math.max won't); base 0 → dark
    }
  }

  // ── GROUP B — wall fixtures (4b) ──────────────────────────────────────────

  // Clock hands — second hand sweeps at real-time rate (2π per 60 s = 0.1047 rad/s).
  // Minute hand one-sixtieth of that. Hour hand stub (no hour tracking needed for deco).
  // Negative rotation.z = clockwise sweep on the face (face is rotated π/2 on X, so
  // Z-axis = the face's 12-o'clock direction; subtracting t makes it go clockwise).
  if (animated.clockHands) {
    animated.clockHands.second.rotation.z = -(t % 60)  * (Math.PI * 2 / 60);
    animated.clockHands.minute.rotation.z = -(t % 3600) * (Math.PI * 2 / 3600);
  }

  // Exhaust fan blades — spin continuously at ~9 rad/s (matches source line 1932).
  // No oscillation (it's an exhaust fan, not a ceiling fan).
  if (animated.wallFanBlades) {
    // Wrap at 2π so the angle never grows unbounded over a long session (float precision
    // degrades at large magnitudes, making the spin visibly step/jitter).
    animated.wallFanBlades.rotation.z = (animated.wallFanBlades.rotation.z + dt * 9) % (Math.PI * 2);
  }

  // ── Shrine candle flicker (GROUP C) ──────────────────────────────────────
  // Dual-frequency sine flicker — the two periods desync quickly so it never
  // feels perfectly periodic. Clamped at 0 so a base of 0 stays dark.
  if (animated.shrineCandles) {
    const cf = 0.9 + Math.sin(t * 13.7) * 0.08 + Math.sin(t * 7.3) * 0.05;
    animated.shrineCandles.emissiveIntensity = Math.max(0, animated.shrineCandleBase * cf);
  }

  // ── GROUP D — ambiance & nook ─────────────────────────────────────────────

  // Fluorescent tubes — startup flicker (Task 5) + faint mains buzz, cool fill
  // PointLight tracks them. The FACTOR is kept separate from tubeBase so a
  // tube-glow of 0 never produces 0/0 = NaN. The self-heal guards the fill
  // intensity in case a stale NaN ever slipped through (would black-hole the
  // room permanently). On/off toggle is set by interact.js (animated.tubesOn).
  if (animated.tubeMats) {
    // Consume a one-shot flicker request from a click: arm a 0.9 s strike-on
    // window relative to THIS module's clock (interact.js can't see `elapsed`).
    if (animated.tubeFlickerRequested) {
      animated.tubeFlickerRequested = false;
      animated.tubeFlickerUntil = t + 0.9; // authentic startup flicker
    }
    let factor;
    if (!animated.tubesOn) {
      factor = 0;
    } else if (animated.tubeFlickerUntil >= 0 && t < animated.tubeFlickerUntil) {
      // STARTUP FLICKER: stutter between a dim strike and full while warming up
      factor = (Math.random() < 0.45 ? 0.12 : 1);
    } else {
      // ALWAYS-ON ambient mains buzz: a rare brief dip (50 Hz mains shimmer)
      factor = (Math.sin(t * 120) > 0.992 ? 0.55 : 1);
    }
    // Guard the material emissive too (not just the fill light below): a NaN here
    // would propagate into the emissive-MRT bloom pass and black-hole the room.
    const tubeEmissive = animated.tubeBase * factor;
    const safeEmissive = Number.isFinite(tubeEmissive) ? tubeEmissive : 0;
    for (const m of animated.tubeMats) {
      m.emissiveIntensity = safeEmissive;
    }
    const coolTarget = animated.tubeLightOn * factor;
    // self-heal: if intensity is NaN (stale from a bad frame), snap to target
    if (!Number.isFinite(animated.tubeLight.intensity)) {
      animated.tubeLight.intensity = coolTarget;
    }
    // frame-rate-independent smoothing (≈0.4/frame at 60 Hz but consistent across
    // refresh rates) so the fill settle-time doesn't vary with fps.
    const k = 1 - Math.exp(-30 * dt);
    animated.tubeLight.intensity += (coolTarget - animated.tubeLight.intensity) * k;
  }

  // Dust motes — drift UPWARD at 0.02 m/s with a tiny lateral wobble.
  // Wrap at y > 2.4 back to y = 0.8 (matches source line 1895).
  if (animated.dust) {
    const p = animated.dust.geometry.attributes.position;
    const a = p.array;
    for (let i = 0; i < a.length; i += 3) {
      a[i + 1] += dt * 0.02;                             // rise
      a[i]     += Math.sin(t * 0.4 + i) * 0.0006;       // gentle lateral drift
      if (a[i + 1] > 2.4) a[i + 1] = 0.8;              // wrap — teleport back to low
    }
    p.needsUpdate = true;
  }

  // ── Task 5 — interactive toy eases (driven by interact.js via the registry) ──

  // Shrine incense pulse — a click sets shrineRequested; arm a 4 s warm-glow
  // window. While lit, boost the incense PointLight above its resting base with a
  // sine pulse, and add a little extra candle flicker ON TOP of the ambient
  // candle block above (which already ran this frame). Source ~line 1935.
  if (animated.shrineGlow) {
    if (animated.shrineRequested) {
      animated.shrineRequested = false;
      animated.shrineUntil = t + 4; // light the incense
    }
    const lit = animated.shrineUntil >= 0 && t < animated.shrineUntil;
    animated.shrineGlow.intensity = animated.shrineBase + (lit ? 0.9 + Math.sin(t * 9) * 0.5 : 0);
    if (lit && animated.shrineCandles) {
      // additive boost on top of the resting flicker the candle block set; clamped ≥ 0
      animated.shrineCandles.emissiveIntensity = Math.max(0, animated.shrineCandles.emissiveIntensity + Math.sin(t * 14) * 0.5);
    }
  }

  // Dice tumble → snap — a click sets rollRequested; arm a 0.9 s roll and seed
  // each die with random angular velocity. While rolling, integrate rotation by
  // av·dt and bounce the dice; at the deadline snap each die's rotation to the
  // π/2 grid so a pip face lands up. Source ~line 1942.
  if (animated.dice) {
    const D = animated.dice;
    if (D.rollRequested) {
      D.rollRequested = false;
      if (!D.rolling) {
        D.rolling = true;
        D.until = t + 0.9;
        for (const d of D.dice) {
          d.av.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30);
        }
      }
    }
    if (D.rolling) {
      for (const d of D.dice) {
        d.mesh.rotation.x += d.av.x * dt;
        d.mesh.rotation.y += d.av.y * dt;
        d.mesh.rotation.z += d.av.z * dt;
        d.mesh.position.y = 0.058 + 0.02 * Math.abs(Math.sin(t * 22)); // little bounce
      }
      if (t >= D.until) {
        D.rolling = false;
        const q = Math.PI / 2;
        for (const d of D.dice) {
          d.mesh.rotation.set(
            Math.round(d.mesh.rotation.x / q) * q,
            Math.round(d.mesh.rotation.y / q) * q,
            Math.round(d.mesh.rotation.z / q) * q,
          ); // snap so a flat face is up
          d.mesh.position.y = 0.058;
        }
      }
    }
  }

  // OPEN / CLOSED sign flip — a click sets flipRequested; arm a half-turn from the
  // current rotation.y. Ease rotation.y fromY→toY over 0.5 s (easeInOutQuad).
  // interact.js owns the `open` boolean toggle (so it can carry/resync the value
  // across the relay); this block only drives the visual flip. Source ~line 1958.
  if (animated.openSign) {
    const o = animated.openSign;
    if (o.flipRequested) {
      o.flipRequested = false;
      if (!o.flipping) {
        o.flipping = true;
        o.fromY = o.g.rotation.y;
        o.toY = o.fromY + Math.PI;
        o.startT = t;
      }
    }
    if (o.flipping) {
      const k = Math.min((t - o.startT) / 0.5, 1);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      o.g.rotation.y = o.fromY + (o.toY - o.fromY) * e;
      if (k >= 1) {
        o.flipping = false;
        // Normalize resting rotation into [0, 2π) so accumulated toY never grows unbounded.
        // Only done once the ease completes — no mid-ease jump.
        const TWO_PI = Math.PI * 2;
        o.g.rotation.y = ((o.g.rotation.y % TWO_PI) + TWO_PI) % TWO_PI;
        o.fromY = o.g.rotation.y;
        o.toY   = o.g.rotation.y;
      }
    }
  }
}
