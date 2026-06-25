// public/shared/indicator-dom.js — DOM widgets shared by the 2D board (game.js) and
// the 3D HUD (hud.js). Pure of sockets/Three.js; styling in /shared/indicator.css.
import { tileImageSrc, tileLabel } from '/shared/rules-client.js';
import { TIMING, RAMP, haloDashArray, timerFraction, secondsLeft, rampColor } from '/shared/indicator-core.js';

const SVGNS = 'http://www.w3.org/2000/svg';

export function makePerimeterHalo(tileW, tileH, { gap = 3, stroke = 3, radius = 6 } = {}) {
  const pad = gap + stroke;
  const W = tileW + 2 * pad, H = tileH + 2 * pad;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'ind-halo');
  const rect = document.createElementNS(SVGNS, 'rect');
  rect.setAttribute('x', stroke); rect.setAttribute('y', stroke);
  rect.setAttribute('width', tileW + 2 * gap); rect.setAttribute('height', tileH + 2 * gap);
  rect.setAttribute('rx', radius + gap); rect.setAttribute('ry', radius + gap);
  rect.setAttribute('fill', 'none'); rect.setAttribute('pathLength', '100');
  rect.setAttribute('stroke-width', stroke); rect.setAttribute('stroke-linecap', 'round');
  rect.setAttribute('class', 'ind-halo-rect');
  svg.appendChild(rect);
  return {
    svg,
    update(frac, color) {
      rect.setAttribute('stroke-dasharray', haloDashArray(frac));
      rect.style.stroke = color;
      svg.style.filter = `drop-shadow(0 0 3px ${color})`;
    },
  };
}

// Low-level dock-styled panel view. `claimable` toggles the halo digit + outline.
export function buildDiscardPanel() {
  const el = document.createElement('div'); el.className = 'ind-discard-panel';
  const wrap = document.createElement('div'); wrap.className = 'ind-dp-tilewrap';
  const tileEl = document.createElement('div'); tileEl.className = 'tile';
  const img = document.createElement('img'); img.className = 'tile-face'; img.draggable = false;
  tileEl.appendChild(img);
  const halo = makePerimeterHalo(128, 176, { gap: 7, stroke: 5, radius: 10 });
  wrap.append(halo.svg, tileEl);
  const num = document.createElement('div'); num.className = 'ind-dp-num';
  const cap = document.createElement('div'); cap.className = 'ind-dp-cap';
  // Stacked + centred: the revealed tile is the hero, the countdown sits beneath it,
  // the caption last — so the tile is always centred in the panel (no side-by-side gap).
  el.append(wrap, num, cap);
  el.style.display = 'none';
  return {
    el,
    update({ tile, frac, color, seconds, caption, claimable }) {
      img.src = tile ? (tileImageSrc(tile) || '') : ''; img.alt = tile ? tileLabel(tile) : '';
      halo.svg.style.display = claimable ? '' : 'none';
      if (claimable) halo.update(frac, color);
      num.textContent = claimable ? seconds : '';
      num.style.color = color;
      num.style.display = claimable ? '' : 'none';   // collapse so tile + caption stay centred
      cap.textContent = caption;
      el.style.display = 'flex';
    },
    hide() { el.style.display = 'none'; },
  };
}

// Stateful controller: reveal-every-discard + min-dwell + claim/rob upgrade. Shared by
// both clients so behaviour is identical. Self-ticks at 80ms while visible.
export function makeDiscardController({ onBoardHalo } = {}) {
  const panel = buildDiscardPanel();
  let cur = null;       // { id, tile, caption }
  let claim = null;     // { clock, action, onClaim, ambiguous } | null
  let shownAt = 0;
  let timer = null;
  const now = () => Date.now();

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  // Brief, text-free flare on an ambiguous-chow tap — restart the CSS animation by
  // removing the class, forcing a reflow, then re-adding it; drop it again when the
  // animation finishes so no stale class lingers on the element.
  panel.el.addEventListener('animationend', e => {
    if (e.animationName === 'ind-flash') panel.el.classList.remove('ind-flash');
  });
  function flash() {
    panel.el.classList.remove('ind-flash');
    void panel.el.offsetWidth;
    panel.el.classList.add('ind-flash');
  }

  function clear() {
    cur = null; claim = null; stop();
    panel.hide(); onBoardHalo && onBoardHalo(false, 0, RAMP.full);
  }

  function render() {
    if (!cur) { clear(); return; }
    if (claim && claim.clock) {
      const left = Math.max(0, claim.clock.deadline - now());
      const frac = timerFraction(left, claim.clock.totalMs);
      const color = rampColor(frac);
      panel.update({ tile: cur.tile, frac, color, seconds: secondsLeft(left),
        caption: cur.caption, claimable: true });
      onBoardHalo && onBoardHalo(true, frac, color);
      if (left <= 0) claim = null;     // window ended → fall back to plain reveal
    } else {
      panel.update({ tile: cur.tile, frac: 0, color: RAMP.full, seconds: '',
        caption: cur.caption, claimable: false });
      onBoardHalo && onBoardHalo(false, 0, RAMP.full);
      if (now() - shownAt >= TIMING.discardRevealMs) { cur = null; panel.hide(); stop(); }
    }
  }

  return {
    el: panel.el,
    // Call every gameUpdate. tile/tileId is the revealed tile (the discard, or the kong
    // tile during a rob). claim carries the live clock + optional tap action: the
    // countdown shows whenever claim.clock is set, the tap fires only with an action,
    // and claim.ambiguous makes the panel flare (no claim) to point at the buttons.
    update({ tile, tileId, caption, claim: c }) {
      if (!tile || tileId == null) {
        // No current discard (the claim/rob window resolved, or the turn advanced). Stop any
        // live countdown immediately so a resolved window doesn't keep ticking, but let an
        // in-progress reveal finish its min-dwell instead of vanishing — render()'s dwell
        // branch then hides it and stops the 80ms timer. (Was a bare early-return that left a
        // stale tile + countdown + timer running until the dwell happened to elapse.)
        claim = null;
        if (cur) render(); else clear();
        return;
      }
      if (!cur || cur.id !== tileId) { cur = { id: tileId, tile, caption }; shownAt = now(); }
      else { cur.tile = tile; cur.caption = caption; }
      claim = (c && c.clock) ? c : null;            // countdown whenever a window is live for us
      const clickable = !!(c && c.action && c.onClaim);
      const ambiguous = !!(c && c.ambiguous);
      panel.el.classList.toggle('claimable', clickable);
      panel.el.classList.toggle('ind-ambiguous', ambiguous && !clickable);
      panel.el.onclick = clickable ? () => c.onClaim() : ambiguous ? flash : null;
      if (!timer) timer = setInterval(render, 80);
      render();
    },
    // Drop the reveal immediately (e.g. game over — no stale tile lingering).
    hide: clear,
  };
}

// 2D turn-token: a puck with a conic pie-dial. setSlideMs drives the glide duration.
export function buildToken() {
  const el = document.createElement('div'); el.className = 'ind-token';
  el.style.transitionDuration = TIMING.tokenSlideMs + 'ms';
  const ring = document.createElement('div'); ring.className = 'ind-token-ring';
  const num = document.createElement('div'); num.className = 'ind-token-num';
  el.append(ring, num);
  return {
    el,
    update({ frac, color, seconds }) {
      ring.style.setProperty('--frac', frac);
      ring.style.setProperty('--col', color);
      num.textContent = seconds;
    },
    setIdle(idle) { el.classList.toggle('idle', idle); },
    setSlideMs(ms) { el.style.transitionDuration = ms + 'ms'; },
  };
}
