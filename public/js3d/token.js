// public/js3d/token.js — the 3D turn-token: a gliding puck that rests in front of the
// active player and chases to the next seat as the turn passes, carrying the turn clock.
import * as THREE from 'three';
import * as seats from '/js3d/seats.js';
import * as state from '/js3d/state.js';
import { TIMING, liveClock, timerFraction, secondsLeft, rampColor } from '/shared/indicator-core.js';
import { easeOutCubic } from '/js3d/lib/tile-math.js';

const R = 0.05, THICK = 0.012;
let mesh = null, mat = null, ctx = null, tex = null;
let fromPos = null, toPos = null, tweenT = 1, lastSeat = null, lastSec = -1, idle = false;

function drawDial(frac, color, seconds, dim) {
  ctx.clearRect(0, 0, 256, 256);
  ctx.fillStyle = dim ? 'rgba(40,46,54,0.85)' : 'rgba(12,16,22,0.9)';
  ctx.beginPath(); ctx.arc(128, 128, 120, 0, Math.PI * 2); ctx.fill();
  if (!dim) {
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 26;
    ctx.beginPath(); ctx.arc(128, 128, 96, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = 26; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(128, 128, 96, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); ctx.stroke();
    if (seconds !== '') {
      ctx.fillStyle = '#fff'; ctx.font = '800 96px system-ui,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(seconds), 128, 132);
    }
  }
  tex.needsUpdate = true;
}

export function initToken(sceneRoot) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
  ctx = canvas.getContext('2d');
  tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
  mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex,
    emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.4 });
  const side = new THREE.MeshStandardMaterial({ color: 0x10151b, roughness: 0.5 });
  const geo = new THREE.CylinderGeometry(R, R, THICK, 40);
  mesh = new THREE.Mesh(geo, [side, mat, side]);   // [side, top cap, bottom cap]
  mesh.visible = false; sceneRoot.add(mesh);
  drawDial(1, rampColor(1), '', false);
}

function seatPos(absSeat) {
  const p = seats.seatTransform(state.relativeSeat(absSeat)).discardSlot.clone();
  p.y += THICK / 2 + 0.001;
  return p;
}

// Per gameUpdate: glide to the active seat (chase from current pos); dim in a reaction
// window (claim/rob) where the live clock moves to the discard/rob panel instead.
export function onUpdate(store) {
  const s = store.gameState; if (!s || s.currentTurn == null) { if (mesh) mesh.visible = false; return; }
  mesh.visible = true;
  idle = (s.phase === 'claim' || s.phase === 'rob');
  if (s.currentTurn !== lastSeat) {
    toPos = seatPos(s.currentTurn);
    if (lastSeat == null) { mesh.position.copy(toPos); tweenT = 1; }      // first placement snaps
    else { fromPos = mesh.position.clone(); tweenT = 0; }                 // else chase from here
    lastSeat = s.currentTurn;
  }
}

// Per frame: advance the chase + redraw the dial when the second changes.
export function update(dt, store) {
  if (!mesh || !mesh.visible) return;
  if (tweenT < 1 && fromPos && toPos) {
    tweenT = Math.min(1, tweenT + dt / (TIMING.tokenSlideMs / 1000));
    mesh.position.lerpVectors(fromPos, toPos, easeOutCubic(tweenT));
  }
  if (idle) { if (lastSec !== -2) { lastSec = -2; drawDial(0, '#888', '', true); mat.emissiveIntensity = 0.25; } return; }
  mat.emissiveIntensity = 0.9;
  const clock = liveClock(store.gameState);
  if (clock && clock.kind === 'turn') {
    const left = Math.max(0, clock.deadline - Date.now());
    const sec = secondsLeft(left);
    if (sec !== lastSec) { lastSec = sec; drawDial(timerFraction(left, clock.totalMs), rampColor(timerFraction(left, clock.totalMs)), sec, false); }
  } else if (lastSec !== -1) { lastSec = -1; drawDial(1, rampColor(1), '', false); } // bot/no clock: ring only
}
