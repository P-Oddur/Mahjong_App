// parlour/decor.js — procedural decor for the Neon Parlour room.
//
// Ported from _from-open-design/js/parlour.js buildDecor() ~line 450 and its
// helpers. This module owns everything that hangs on the walls / over the table:
// the live-tuning slider panel from the source was dropped, so every baked value
// (TUNE.def) and the MASTER-DIMMER coupling are folded in at construction here.
//
// GROUP A (this dispatch) builds: the pendant lamp, the three neon signs (麻雀
// magenta / 香港 jade / 番數表 faan chart + green frame) with their companion spill
// lights, and the back-wall skyline panel. Later groups (4b/4c/4d) add the wall
// fixtures, door/bar/shrine, and ambiance/dust — they extend the SAME `animated`
// registry and `pickables` list this module returns.
//
// buildDecor(scene) → { animated, pickables }
//   animated  : the animate.js registry (this group fills animated.neon)
//   pickables : interactable toys for Task 5 (empty [] in GROUP A)

import * as THREE from 'three';
import { mat, box, neonMaterial } from './materials.js';
import {
  neonGlyphTexture, faanTexture, skylineWallTexture,
  scrollTexture, menuTexture, tvBroadcastTexture,
  alleyBackdropTexture, neonBoardTexture,
  tinAdTexture, doorStreetTexture, coupletTexture, fuDiamondTexture,
  openSignTexture, shrineTex, pipTexture,
} from './textures.js';
import { makeRegistry } from './animate.js';

// ── Palette (COL from parlour.js ~line 13) ───────────────────────────────────
const COL = {
  magenta:   0xff2e96,
  jade:      0x18e39a,
  amber:     0xffb24d,
  tungsten:  0xffd49a,
  woodLight: 0x3c2718, // GROUP B: clock ring + hand colour
  wood:      0x2a1a11, // GROUP C: bar body
};

// ── Baked look values (TUNE.def from parlour.js ~line 86) ─────────────────────
// Only the GROUP A subset. Neon-sign brightness AND companion-light spill ratios
// live here so the dropped master dimmer is baked: each companion PointLight's
// intensity = sign brightness × its spill ratio (so a sign and its spill move
// together, and a 0-brightness sign would also kill its spill).
const TUNE = {
  bulbGlow: 2.6, rimGlow: 1.0,
  // neon-sign emissive intensities (the "master brightness" per sign)
  signMahjong: 5.45, signHongKong: 2.6, signChart: 11.55,
  // per-sign companion light: spill ratio (× brightness), reach (distance), decay
  signMahjongLight: 0.15, signMahjongReach: 6.1, signMahjongDecay: 0.5,
  signHongKongLight: 0.3, signHongKongReach: 6.1, signHongKongDecay: 0.5,
  signChartLight:    0.2, signChartReach:    1.6, signChartDecay:    2.0,
  // GROUP B: wall fixtures
  windowSpill: 2.0, // magenta spill from alley window
  tvGlow:      0.7, // cool screen glow from wall TV
  // GROUP C: front wall + corners
  doorSpill:   1.8, // warm spill from outside through glass door
  barLight:    1.2, // warm bar light in front-left corner
  shrineGlow:  1.0, // red glow from shrine candles
  // GROUP D: ambiance & nook
  tubeEmissive: 2.2,  // emissiveIntensity of the tube phosphor (default lit)
  tubeLight:    2.1,  // cool fill PointLight intensity when tubes are on
};

const TABLE_TOP = 0.78;              // table frame top (matches lights.js / furniture.js)
const FELT_TOP  = TABLE_TOP + 0.011; // green felt's TOP surface (furniture.js felt slab)

// ── buildDecor(scene) ─────────────────────────────────────────────────────────
export function buildDecor(scene) {
  const animated  = makeRegistry();
  const pickables = []; // GROUP A: nothing interactable yet (Task 5)

  buildPendantLamp(scene);

  // Three neon signs. 麻雀 (magenta) on the −X (west/left) wall, 香港 (jade) on the
  // +X (east/right) wall — exact positions from parlour.js lines 452–453.
  buildNeonSign(scene, animated, '麻雀', COL.magenta, {
    x: -3.13, y: 1.62, z: 1.9, ry: Math.PI / 2, scale: 1.05,
    base: TUNE.signMahjong,
    light: { ratio: TUNE.signMahjongLight, reach: TUNE.signMahjongReach, decay: TUNE.signMahjongDecay,
             pos: [-2.92, 1.62, 1.9] },
  });
  buildNeonSign(scene, animated, '香港', COL.jade, {
    x: 3.13, y: 1.72, z: 2.15, ry: -Math.PI / 2, scale: 0.95,
    base: TUNE.signHongKong,
    light: { ratio: TUNE.signHongKongLight, reach: TUNE.signHongKongReach, decay: TUNE.signHongKongDecay,
             pos: [2.92, 1.72, 2.15] },
  });

  // Back-wall centrepieces.
  buildFaanChart(scene, animated);
  buildSkylineWall(scene);

  // GROUP B — wall fixtures (Step 2 of Task 4).
  // Animated handles assigned directly (SCALAR — not register/array):
  //   animated.clockHands = { hour: Group, minute: Group, second: Group }
  //   animated.wallFanBlades = Group
  // 運氣 luck scroll removed from the back wall per user request (was left of the
  // 番數表 faan chart). buildScroll() is left defined below but no longer called.
  buildClock(scene, animated);
  buildMenuBoard(scene);
  buildWallTV(scene);
  buildAlleyWindow(scene);
  buildWallFan(scene, animated);

  // GROUP C — front wall + corners (Step 3 of Task 4)
  buildTinAds(scene);
  buildDoor(scene);
  buildOpenSign(scene, animated, pickables);
  buildBar(scene);
  buildShrine(scene, animated, pickables);
  buildBirdcage(scene);

  // GROUP D — ambiance & nook (Step 4 of Task 4)
  buildFluorescentTubes(scene, animated, pickables);
  // Dice bowl removed from the static table per user request. The dice-roll feature
  // will spawn dice transiently (roll → show result on screen → hide), so they are
  // NOT permanent table decor. buildDiceBowl() is kept defined below for that reuse.
  buildDiningTable(scene, 1.85, -1.7);
  buildDust(scene, animated);

  return { animated, pickables };
}

// ── Pendant lamp (parlour.js buildPendantLamp ~line 465) ──────────────────────
// Brass cone shade over the table, a glowing tungsten bulb underside, and an
// amber inner-rim ring glow. The shadow-casting key SpotLight + warm fill that
// actually light the table live in lights.js (Task 3); this is the visible fixture.
function buildPendantLamp(scene) {
  const g = new THREE.Group();

  const cord = box(0.012, 0.62, 0.012, mat(0x111111, 0.8), 0, 2.89, 0, false, false);
  g.add(cord);

  // brass shade — open cone, double-sided so the inside reads lit
  const shade = new THREE.Mesh(
    new THREE.ConeGeometry(0.28, 0.26, 28, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x3a2c12, roughness: 0.4, metalness: 0.7, side: THREE.DoubleSide }),
  );
  shade.position.set(0, 2.45, 0); shade.castShadow = true; g.add(shade);

  // glowing bulb underside
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 20, 16),
    new THREE.MeshStandardMaterial({ color: 0x1a1408, emissive: new THREE.Color(COL.tungsten), emissiveIntensity: TUNE.bulbGlow }),
  );
  glow.position.set(0, 2.37, 0); g.add(glow);

  // inner shade rim glow
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(0.1, 0.27, 28),
    new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(COL.amber), emissiveIntensity: TUNE.rimGlow, side: THREE.DoubleSide }),
  );
  rim.position.set(0, 2.35, 0); rim.rotation.x = Math.PI / 2; g.add(rim);

  scene.add(g);
}

// ── Neon sign (parlour.js buildNeonSign ~line 531) ────────────────────────────
// A single-colour neon-tube glyph plane + a companion PointLight so the sign
// reads as a real light source in the dark room. MASTER-DIMMER coupling (baked):
// companion intensity = base × spill-ratio, sign emissiveIntensity = base.
// Registers { m, base } on animated.neon so animate.js flickers it.
function buildNeonSign(scene, animated, text, color, opts) {
  const { tex, aspect } = neonGlyphTexture(text, 180);
  const h = 0.6 * (opts.scale || 1);
  const w = h * aspect;
  const base = opts.base;

  // single-colour convention: white glyph texture tinted by the tube colour via emissive
  const m = neonMaterial(tex, base, color);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
  sign.position.set(opts.x || 0, opts.y, opts.z);
  if (opts.ry !== undefined) sign.rotation.y = opts.ry; // side-wall mounting
  scene.add(sign);

  // companion spill light (master-dimmer coupled): intensity = base × ratio
  if (opts.light) {
    const L = opts.light;
    const spill = new THREE.PointLight(color, base * L.ratio, L.reach, L.decay);
    spill.position.set(...L.pos);
    scene.add(spill);
  }

  // hand the material + its baked base to the flicker loop
  animated.neon.push({ m, base });
}

// ── Faan chart (parlour.js buildFaanChart ~line 861) ──────────────────────────
// 番數表 poster (low-emissive so it's readable, not blown out) framed by a green
// neon rectangle (the back-wall centrepiece) + a jade companion spill light.
// Master-dimmer baked: frame emissiveIntensity = signChart, light = signChart × ratio.
function buildFaanChart(scene, animated) {
  const tex = faanTexture();
  const W = 1.0, H = 1.4; // sized so the neon frame leaves a gap above the tile dado

  // poster — white emissive + painted texture (multi-colour convention) at low intensity
  const poster = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.32 }),
  );
  poster.position.set(0, 1.96, -3.12);
  scene.add(poster);

  // green neon frame — a solid emissive tube material (not glyph-mapped); flickers
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x041a12, emissive: new THREE.Color(COL.jade), emissiveIntensity: TUNE.signChart,
  });
  const nW = W + 0.12, nH = H + 0.12, nt = 0.03, ng = new THREE.Group();
  ng.add(box(nW, nt, 0.02, frameMat, 0,  nH / 2, 0, false, false));
  ng.add(box(nW, nt, 0.02, frameMat, 0, -nH / 2, 0, false, false));
  ng.add(box(nt, nH, 0.02, frameMat, -nW / 2, 0, 0, false, false));
  ng.add(box(nt, nH, 0.02, frameMat,  nW / 2, 0, 0, false, false));
  ng.position.set(0, 1.96, -3.1);
  scene.add(ng);

  // jade companion spill (master-dimmer coupled)
  const chartGlow = new THREE.PointLight(COL.jade, TUNE.signChart * TUNE.signChartLight, TUNE.signChartReach, TUNE.signChartDecay);
  chartGlow.position.set(0, 1.96, -2.78);
  scene.add(chartGlow);

  // the frame flickers with the other neon
  animated.neon.push({ m: frameMat, base: TUNE.signChart });
}

// ── Skyline wall (parlour.js buildSkylineWall ~line 367) ──────────────────────
// Abstract red-on-white HK skyline on the upper back wall (above the tile dado),
// faintly backlit (emissiveIntensity 0.18) so it reads in the near-black room.
function buildSkylineWall(scene) {
  const W = 6.3, H = 1.9, tex = skylineWallTexture();
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshStandardMaterial({ map: tex, emissive: new THREE.Color(0xffffff), emissiveMap: tex, emissiveIntensity: 0.18, roughness: 0.85 }),
  );
  panel.position.set(0, 2.05, -3.14); // covers the cream; tile dado shows below
  scene.add(panel);
}

// ── GROUP B wall fixtures ─────────────────────────────────────────────────────

// buildScroll (parlour.js ~line 550) — 運氣 hanging luck scroll, back-left wall.
// Parchment with gold top/bottom bars and two large Chinese brush characters.
// Static — no animation.
function buildScroll(scene) {
  const tex = scrollTexture();
  const scroll = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 1.15),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }),
  );
  scroll.position.set(-2.4, 1.78, -3.10); // moved 4 cm proud of skyline panel (z=-3.14)
  scene.add(scroll);
}

// buildClock (parlour.js ~line 564) — wood-ringed wall clock, −X wall upper.
// Dark cylinder face, 12 amber tick marks, wood torus ring, brass minute hand,
// MAGENTA emissive second hand. Hands sweep in updateParlour.
// Animated handles: animated.clockHands = { minute: Group, second: Group }
// (direct-assign on animated, NOT register(), because they are scalar objects).
function buildClock(scene, animated) {
  const g = new THREE.Group();

  // face disk: dark cylinder, face toward +Z (rotated so it faces the room interior)
  const face = new THREE.Mesh(
    new THREE.CylinderGeometry(0.26, 0.26, 0.04, 36),
    mat(0x101615, 0.5, 0.2),
  );
  face.rotation.x = Math.PI / 2; g.add(face);

  // wood torus ring
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.02, 12, 40), mat(COL.woodLight, 0.4, 0.3));
  g.add(ring);

  // 12 tick marks
  const tickMat = mat(0xb9a36a, 0.4, 0.4);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.add(box(0.012, 0.012, 0.04, tickMat, Math.cos(a) * 0.21, Math.sin(a) * 0.21, 0.02, false, false));
  }

  // minute hand pivot group — hand offset so it sweeps around the centre
  const minPivot = new THREE.Group();
  minPivot.add(box(0.014, 0.2, 0.012, mat(0xd9cba0, 0.4, 0.3), 0, 0.08, 0.03, false, false));
  g.add(minPivot);

  // second hand pivot group — MAGENTA emissive (feeds emissive-MRT bloom)
  const secPivot = new THREE.Group();
  secPivot.add(box(0.006, 0.22, 0.006,
    new THREE.MeshStandardMaterial({
      color: COL.magenta, roughness: 0.4, metalness: 0.2,
      emissive: new THREE.Color(COL.magenta), emissiveIntensity: 1.2,
    }),
    0, 0.09, 0.035, false, false));
  g.add(secPivot);

  // Direct-assign scalar handles — updateParlour checks for these with guarded blocks
  animated.clockHands = { minute: minPivot, second: secPivot };

  // −X wall, upper cream band, above the 麻雀 neon sign
  g.position.set(-3.13, 2.5, 1.9); g.rotation.y = Math.PI / 2;
  scene.add(g);
}

// buildMenuBoard (parlour.js ~line 824) — 美都餐室 cha-chaan-teng menu board,
// backlit (emissive), −X wall at z −2.2. Metal frame, two columns of menu items.
function buildMenuBoard(scene) {
  const g = new THREE.Group();
  const W = 1.4, H = 1.05, tex = menuTexture();
  g.add(new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshStandardMaterial({ map: tex, emissive: new THREE.Color(0xffffff), emissiveMap: tex, emissiveIntensity: 0.3, roughness: 0.6 }),
  ));
  const fm = mat(0x2a2f33, 0.4, 0.6), t = 0.05;
  g.add(box(W + t, t, 0.05, fm, 0,  H / 2 + t / 2, 0, false, false));
  g.add(box(W + t, t, 0.05, fm, 0, -H / 2 - t / 2, 0, false, false));
  g.add(box(t, H + t * 3, 0.05, fm, -W / 2 - t / 2, 0, 0, false, false));
  g.add(box(t, H + t * 3, 0.05, fm,  W / 2 + t / 2, 0, 0, false, false));
  // −X wall, vertically centred on the cream band
  g.position.set(-3.13, 2.05, -2.2); g.rotation.y = Math.PI / 2;
  scene.add(g);
}

// buildWallTV (parlour.js ~line 1367) — sleek OLED TV above menu on the −X wall,
// emissive 賽馬直播 horse-race broadcast canvas + cool screen glow PointLight.
// Static emissive (no runtime canvas re-draw). Screen feeds emissive-MRT bloom.
function buildWallTV(scene) {
  const g = new THREE.Group();
  const W = 2.3, H = 1.45;
  const shell = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.35, metalness: 0.4 });
  // thin bezel (slightly larger than screen)
  g.add(box(W + 0.03, H + 0.03, 0.04, shell, 0, 0, 0, false, false));
  const tex = tvBroadcastTexture();
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshStandardMaterial({ map: tex, emissive: new THREE.Color(0xffffff), emissiveMap: tex, emissiveIntensity: 1.0 }),
  );
  screen.position.z = 0.025; g.add(screen);
  // −X wall, above menu board, clear of ceiling trim
  g.position.set(-3.13, 2.0, 0); g.rotation.y = Math.PI / 2;
  scene.add(g);
  // companion cool screen glow (baked — no panel)
  const sg = new THREE.PointLight(0x9fd8ff, TUNE.tvGlow, 2.8, 2);
  sg.position.set(-2.85, 2.0, 0);
  scene.add(sg);
}

// buildAlleyWindow (parlour.js ~line 759) — +X wall: shallow fake-depth diorama.
// Emissive tong-lau/neon backdrop, two protruding neon board 招牌 signs for
// parallax, faint glass sheen, dark frame with mullions, + magenta spill light.
// neonBoard signs use neonMaterial via neonBoardTexture (multi-colour via emissive).
function buildAlleyWindow(scene) {
  const g = new THREE.Group();
  const W = 2.9, H = 1.85, fdepth = 0.12;

  // emissive alley backdrop (the "depth" illusion)
  const backdropTex = alleyBackdropTexture();
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(W - 0.18, H - 0.18),
    new THREE.MeshStandardMaterial({ map: backdropTex, emissive: new THREE.Color(0xffffff), emissiveMap: backdropTex, emissiveIntensity: 1.25 }),
  );
  back.position.z = -0.006; g.add(back);

  // two protruding neon board signs for parallax — 幸運 magenta, 美食 jade
  const texA = neonBoardTexture('幸運');
  const signA = new THREE.Mesh(
    new THREE.PlaneGeometry(0.26, 0.86),
    new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: new THREE.Color(COL.magenta), emissiveIntensity: 1.4,
      emissiveMap: texA, alphaMap: texA, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  signA.position.set(-0.78, 0.06, 0.06); g.add(signA);

  const texB = neonBoardTexture('美食');
  const signB = new THREE.Mesh(
    new THREE.PlaneGeometry(0.24, 0.7),
    new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: new THREE.Color(COL.jade), emissiveIntensity: 1.4,
      emissiveMap: texB, alphaMap: texB, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  signB.position.set(0.82, -0.05, 0.09); g.add(signB);

  // faint glass sheen plane (very low opacity physical material)
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(W - 0.18, H - 0.18),
    new THREE.MeshPhysicalMaterial({ transparent: true, opacity: 0.05, roughness: 0.12, metalness: 0, color: 0x9fd8ff }),
  );
  glass.position.z = 0.105; g.add(glass);

  // dark wood frame
  const fm = mat(0x1a1410, 0.5, 0.2);
  const t = 0.09, zc = 0.05;
  g.add(box(W,  t, fdepth, fm, 0,  H / 2 - t / 2, zc, false, false));
  g.add(box(W,  t, fdepth, fm, 0, -H / 2 + t / 2, zc, false, false));
  g.add(box(t,  H, fdepth, fm, -W / 2 + t / 2, 0, zc, false, false));
  g.add(box(t,  H, fdepth, fm,  W / 2 - t / 2, 0, zc, false, false));
  // storefront mullions
  [-W / 6, W / 6].forEach((mx) => g.add(box(0.025, H, 0.06, fm, mx, 0, 0.06, false, false)));
  g.add(box(W, 0.025, 0.06, fm, 0, 0.05, 0.06, false, false));
  // window sill
  g.add(box(W + 0.08, 0.06, 0.18, mat(0x241a12, 0.6, 0.1), 0, -H / 2 - 0.02, 0.04, false, false));

  // magenta spill light (baked — no panel)
  const spill = new THREE.PointLight(COL.magenta, TUNE.windowSpill, 4.0, 2);
  spill.position.set(0, 0, 0.35); g.add(spill);

  // +X wall, horizontally centred
  g.position.set(3.14, 1.6, 0); g.rotation.y = -Math.PI / 2;
  scene.add(g);
}

// ── GROUP C front wall + corners ─────────────────────────────────────────────

// buildTinAds (parlour.js ~line 897) — 10 glossy enamel ad plates on front wall.
// z=+3.13, each slightly rotated and offset. MeshPhysicalMaterial for clearcoat.
function buildTinAds(scene) {
  const F = 3.13;
  const ads = [
    { txt: '維他奶', sub: '維記',    bg: '#0f7a44', fg: '#ffffff', t: [-2.68, 2.18, F, Math.PI, 0.06],  w: 0.5  },
    { txt: '樂聲牌', sub: 'NATIONAL', bg: '#b1182a', fg: '#f4e3c0', t: [-1.96, 2.02, F, Math.PI, -0.05], w: 0.44 },
    { txt: '紅A',   sub: '塑膠',    bg: '#c8202a', fg: '#fff3d8', t: [-1.18, 2.2,  F, Math.PI, 0.09],  w: 0.4  },
    { txt: '雙妹嚜', sub: '花露水',  bg: '#1d6f8c', fg: '#fdeecb', t: [1.16,  2.14, F, Math.PI, -0.07], w: 0.46 },
    { txt: '嘉頓',  sub: '生命麵包', bg: '#d98a1f', fg: '#3a230c', t: [1.94,  2.04, F, Math.PI, 0.05],  w: 0.5  },
    { txt: '白花油', sub: '和興',    bg: '#c8202a', fg: '#fff3d8', t: [2.66,  2.2,  F, Math.PI, -0.09], w: 0.4  },
    { txt: '益力多', sub: 'YAKULT',  bg: '#e0532a', fg: '#ffffff', t: [-2.4,  1.5,  F, Math.PI, -0.06], w: 0.48 },
    { txt: '黑人',  sub: '牙膏',    bg: '#14202c', fg: '#ffffff', t: [-1.5,  1.46, F, Math.PI, 0.1],   w: 0.4  },
    { txt: '生力啤', sub: 'BEER',    bg: '#d9a23a', fg: '#3a230c', t: [1.52,  1.52, F, Math.PI, -0.05], w: 0.48 },
    { txt: '京都',  sub: '念慈菴',  bg: '#9a2030', fg: '#f4e3c0', t: [2.36,  1.46, F, Math.PI, 0.08],  w: 0.42 },
  ];
  ads.forEach(({ txt, sub, bg, fg, t, w }) => {
    const h = w * 0.75; // canvas is 200×150 = 4:3 ratio
    const tex = tinAdTexture(txt, sub, bg, fg);
    const adMat = new THREE.MeshPhysicalMaterial({
      map: tex, roughness: 0.35, metalness: 0.1,
      clearcoat: 0.6, clearcoatRoughness: 0.25,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), adMat);
    mesh.position.set(t[0], t[1], t[2]);
    mesh.rotation.y = t[3];
    if (t[4] !== undefined) mesh.rotation.z = t[4];
    scene.add(mesh);
  });
}

// buildDoor (parlour.js ~line 1012) — glass shop door on the front wall.
// Dark anodised metal frame, emissive street view, glass leaf, push-bar handle,
// 揮春 couplets, 福 diamond, warm door spill PointLight.
function buildDoor(scene) {
  const g = new THREE.Group();
  const DW = 1.04, DH = 2.10, TRH = 0.42, jb = 0.07, dep = 0.1, zc = dep / 2;
  const totalH = DH + TRH;

  // dark anodised metal frame — MeshPhysicalMaterial (clearcoat)
  const frameM = new THREE.MeshPhysicalMaterial({ color: 0x2b2722, roughness: 0.45, metalness: 0.45, clearcoat: 0.2 });
  const railM = mat(0x35302a, 0.4, 0.5);

  // outer frame + transom divider + base rail
  g.add(box(jb, totalH + jb, dep, frameM, -(DW / 2 + jb / 2), totalH / 2, zc, false, false));
  g.add(box(jb, totalH + jb, dep, frameM,  DW / 2 + jb / 2, totalH / 2, zc, false, false));
  g.add(box(DW + jb * 2, jb, dep, frameM, 0, totalH + jb / 2, zc, false, false));
  g.add(box(DW + jb * 2, jb, dep, frameM, 0, DH + jb / 2, zc, false, false));
  g.add(box(DW + jb * 2, jb, dep, frameM, 0, jb / 2, zc, false, false));

  // emissive street view through glass
  const stTex = doorStreetTexture();
  const street = new THREE.Mesh(
    new THREE.PlaneGeometry(DW, DH - 0.04),
    new THREE.MeshStandardMaterial({ map: stTex, emissive: new THREE.Color(0xffffff), emissiveMap: stTex, emissiveIntensity: 0.85 }),
  );
  street.position.set(0, DH / 2 + 0.02, 0.012); g.add(street);

  // glass door leaf
  const glassM = new THREE.MeshPhysicalMaterial({ color: 0xaecfca, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.2 });
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(DW - 0.08, DH - 0.2), glassM);
  glass.position.set(0, DH / 2 + 0.02, 0.05); g.add(glass);

  // leaf stiles + rails (thin metal frame around the glass)
  g.add(box(0.05, DH, 0.04, railM, -(DW / 2 - 0.025), DH / 2, 0.06, false, false));
  g.add(box(0.05, DH, 0.04, railM,  DW / 2 - 0.025, DH / 2, 0.06, false, false));
  g.add(box(DW, 0.06, 0.04, railM, 0, DH - 0.05, 0.06, false, false));
  g.add(box(DW, 0.16, 0.04, railM, 0, 0.09, 0.06, false, false));

  // push-bar handle
  g.add(box(0.03, 0.92, 0.03, mat(0xb9b2a4, 0.3, 0.7), DW / 2 - 0.14, DH * 0.5, 0.1, false, false));

  // transom fanlight
  const tg = new THREE.Mesh(new THREE.PlaneGeometry(DW - 0.04, TRH - 0.06), glassM);
  tg.position.set(0, DH + TRH / 2, 0.05); g.add(tg);

  // threshold
  g.add(box(DW + jb * 2, 0.04, 0.18, mat(0x241a12, 0.6, 0.1), 0, 0.02, 0.08, false, false));

  // warm door spill from outside
  const spill = new THREE.PointLight(0xffcf9a, TUNE.doorSpill, 2.2, 2);
  spill.position.set(0, 1.0, 0.32); g.add(spill);

  // 揮春 couplets down the jambs
  const coupletMat = (text) => new THREE.MeshStandardMaterial({ map: coupletTexture(text), roughness: 0.85 });
  const cL = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.62), coupletMat('招財進寶'));
  cL.position.set(-(DW / 2 + jb + 0.12), 1.5, 0.14); g.add(cL);
  const cR = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.62), coupletMat('出入平安'));
  cR.position.set(DW / 2 + jb + 0.12, 1.5, 0.14); g.add(cR);

  // 福 diamond above door
  const fuTex = fuDiamondTexture();
  const fu = new THREE.Mesh(
    new THREE.PlaneGeometry(0.26, 0.26),
    new THREE.MeshStandardMaterial({ map: fuTex, transparent: true, roughness: 0.85 }),
  );
  fu.position.set(0, totalH + jb + 0.18, 0.14); g.add(fu);

  g.position.set(0, 0, 3.14); g.rotation.y = Math.PI;
  scene.add(g);
}

// buildOpenSign (parlour.js ~line 1067) — flippable 營業中/休息中 sign on door glass.
// Front: green 營業中 OPEN, Back: red 休息中 CLOSED. Both emissive.
// Tagged pickType:'opensign' and pushed into pickables (click handler in Task 5).
function buildOpenSign(scene, animated, pickables) {
  const g = new THREE.Group();
  const W = 0.3, H = 0.18;
  const ot = openSignTexture(true), ct = openSignTexture(false);
  const front = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshStandardMaterial({ map: ot, emissive: new THREE.Color(0xffffff), emissiveMap: ot, emissiveIntensity: 0.3 }),
  );
  front.position.z = 0.004; g.add(front);
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshStandardMaterial({ map: ct, emissive: new THREE.Color(0xffffff), emissiveMap: ct, emissiveIntensity: 0.3 }),
  );
  back.position.z = -0.004; back.rotation.y = Math.PI; g.add(back);

  // small metal frame
  const fm = mat(0x2a2622, 0.5, 0.3), t = 0.014;
  g.add(box(W + t, t, 0.012, fm, 0,  H / 2, 0, false, false));
  g.add(box(W + t, t, 0.012, fm, 0, -H / 2, 0, false, false));
  g.add(box(t, H, 0.012, fm, -W / 2, 0, 0, false, false));
  g.add(box(t, H, 0.012, fm,  W / 2, 0, 0, false, false));
  // hanging cord above
  g.add(box(0.004, 0.18, 0.004, mat(0x222222, 0.6), 0, H / 2 + 0.09, 0, false, false));

  g.position.set(0.2, 1.55, 3.0); g.rotation.y = Math.PI;
  g.userData = { pickType: 'opensign' };
  scene.add(g);
  pickables.push(g);

  // Task 5: flip handles. animate.js eases g.rotation.y fromY→toY over 0.5s while
  // `flipping`. A click sets flipRequested (one-shot); animate.js converts it to a
  // half-turn: fromY = current rotation.y, toY = fromY + π, toggling `open`.
  animated.openSign = {
    g, open: true, flipping: false,
    fromY: g.rotation.y, toY: g.rotation.y, startT: 0,
    flipRequested: false,
  };
}

// buildBar (parlour.js ~line 1089) — L-shaped water bar in front-left corner.
// Wood body + jade strip + laminate top + steel edge. Calls buildDimSum for food.
function buildBar(scene) {
  const TOP = 0.95, D = 0.5;
  const woodM  = new THREE.MeshPhysicalMaterial({ color: COL.wood, roughness: 0.5, metalness: 0.05, clearcoat: 0.2 });
  const jadeM  = new THREE.MeshPhysicalMaterial({ color: 0x1f7a5e, roughness: 0.4, metalness: 0.1, clearcoat: 0.4 });
  const topM   = new THREE.MeshPhysicalMaterial({ color: 0xe7decb, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.2 });
  const steelM = mat(0xc8ccce, 0.3, 0.7);

  // arm A — along the left wall (runs in z), length Lz=2.4
  const aA = new THREE.Group(), Lz = 2.4;
  aA.add(box(D, TOP - 0.05, Lz, woodM, 0, (TOP - 0.05) / 2, 0, true, true));
  aA.add(box(0.03, 0.36, Lz, jadeM, D / 2 - 0.01, 0.34, 0, false, false));
  aA.add(box(D + 0.06, 0.05, Lz + 0.06, topM, 0, TOP, 0, true, true));
  aA.add(box(D + 0.07, 0.02, Lz + 0.07, steelM, 0, TOP - 0.035, 0, false, false));
  aA.position.set(-2.88, 0, 1.65); // z[0.45, 2.85]

  // arm B — along the front wall (runs in x), length Lx=1.7
  const aB = new THREE.Group(), Lx = 1.7;
  aB.add(box(Lx, TOP - 0.05, D, woodM, 0, (TOP - 0.05) / 2, 0, true, true));
  aB.add(box(Lx, 0.36, 0.03, jadeM, 0, 0.34, -(D / 2 - 0.01), false, false));
  aB.add(box(Lx + 0.06, 0.05, D + 0.06, topM, 0, TOP, 0, true, true));
  aB.add(box(Lx + 0.07, 0.02, D + 0.07, steelM, 0, TOP - 0.035, 0, false, false));
  aB.position.set(-1.95, 0, 2.88); // x[-2.8, -1.1]

  const barGroup = new THREE.Group();
  barGroup.add(aA); barGroup.add(aB);
  scene.add(barGroup);

  // warm bar light
  const bl = new THREE.PointLight(0xffc289, TUNE.barLight, 2.8, 2);
  bl.position.set(-2.3, 1.7, 2.5);
  scene.add(bl);

  buildDimSum(scene, -2.0, 2.85, TOP + 0.026);
}

// buildDimSum (parlour.js ~line 1113) — dim sum steamers + plates on the bar corner.
function buildDimSum(scene, cx, cz, topY) {
  const bamboo = mat(0xc9a05a, 0.6, 0.05);
  const steamer = (dx, dz, n) => {
    const grp = new THREE.Group();
    for (let i = 0; i < n; i++) {
      const tier = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.034, 20, 1, true), bamboo);
      tier.position.y = 0.017 + i * 0.036; tier.castShadow = true; grp.add(tier);
    }
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.064, 0.06, 0.022, 20), bamboo);
    lid.position.y = 0.017 + n * 0.036; grp.add(lid);
    grp.position.set(cx + dx, topY, cz + dz); scene.add(grp);
  };
  steamer(-0.04, -0.16, 2);
  steamer(0.06, 0.02, 3);

  const plateMat = new THREE.MeshPhysicalMaterial({ color: 0xf0ece0, roughness: 0.3, clearcoat: 0.5 });

  // har gow plate + 3 dumplings
  const harGow = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.012, 20), plateMat);
  harGow.position.set(cx - 0.2, topY, cz + 0.08); scene.add(harGow);
  [[-0.03, -0.02], [0.03, -0.02], [0, 0.03]].forEach(([dx, dz]) => {
    const d = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), mat(0xf2e6c4, 0.45));
    d.scale.set(1, 0.65, 1); d.position.set(cx - 0.2 + dx, topY + 0.012, cz + 0.08 + dz);
    d.castShadow = true; scene.add(d);
  });

  // siu mai plate + 3 siu mai
  const siuMaiPlate = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.012, 18), plateMat);
  siuMaiPlate.position.set(cx + 0.2, topY, cz + 0.1); scene.add(siuMaiPlate);
  [[-0.02, -0.02], [0.02, 0.0], [0, 0.03]].forEach(([dx, dz]) => {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.021, 0.026, 12), mat(0xe0b840, 0.5));
    s.position.set(cx + 0.2 + dx, topY + 0.014, cz + 0.1 + dz); s.castShadow = true; scene.add(s);
  });
}

// buildShrine (parlour.js ~line 1186) — 土地財神 floor shrine, scaled ×2, near door.
// Red body, gold shelf, shrine texture panel (emissive orange), oranges, candles,
// incense pot. Shrine glow PointLight INSIDE g (scales with group).
// Tagged pickType:'shrine', pushed into pickables. Candle flicker via animate.js.
function buildShrine(scene, animated, pickables) {
  const g = new THREE.Group();
  const red  = mat(0xa01828, 0.5, 0.05);
  const gold = mat(0xc9a23a, 0.4, 0.5);

  // body + gold shelf
  g.add(box(0.34, 0.30, 0.22, red,  0, 0.15,  0, true, true));
  g.add(box(0.38, 0.03, 0.26, gold, 0, 0.315, 0, false, false));

  // shrine texture panel (emissive orange tint)
  const tex = shrineTex();
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(0.28, 0.2),
    new THREE.MeshStandardMaterial({ map: tex, emissive: new THREE.Color(0xff7a3c), emissiveMap: tex, emissiveIntensity: 0.5 }),
  );
  back.position.set(0, 0.22, -0.1); g.add(back);

  // oranges
  const orMat = mat(0xff8a2a, 0.5, 0);
  [-0.08, 0, 0.08].forEach((dx) => {
    const o = new THREE.Mesh(new THREE.SphereGeometry(0.028, 14, 12), orMat);
    o.position.set(dx, 0.345, 0.06); o.castShadow = true; g.add(o);
  });

  // candles (flicker animation driven by animate.js)
  const candleMat = new THREE.MeshStandardMaterial({
    color: 0xd02828,
    emissive: new THREE.Color(0xff5020),
    emissiveIntensity: 1.4,
  });
  [-0.12, 0.12].forEach((dx) => {
    const cd = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.07, 10), candleMat);
    cd.position.set(dx, 0.355, 0.02); g.add(cd);
  });

  // incense pot (gold box)
  g.add(box(0.07, 0.04, 0.05, gold, 0, 0.335, 0.085, false, false));

  // shrine glow — added INSIDE g before scale so it scales with the group
  const glow = new THREE.PointLight(0xff6a30, TUNE.shrineGlow, 2.2, 2);
  glow.position.set(0, 0.42, 0.1); g.add(glow);

  g.scale.setScalar(2); // IMPORTANT: scale ×2
  g.position.set(2.65, 0, 2.9); g.rotation.y = Math.PI;
  g.userData = { pickType: 'shrine' };
  scene.add(g);
  pickables.push(g);

  // candle flicker — direct scalar assigns on animated (not register/array)
  animated.shrineCandles    = candleMat;
  animated.shrineCandleBase = 1.4;

  // Task 5: incense warm-glow pulse handles. animate.js pulses shrineGlow.intensity
  // above shrineBase while elapsed < shrineUntil (set by a click via interact.js).
  // shrineUntil = -1 → never lit at rest. shrineRequested is the one-shot flag the
  // click sets; animate.js converts it to a timed `shrineUntil` using its own clock.
  animated.shrineGlow      = glow;     // the incense PointLight (intensity pulses)
  animated.shrineBase      = TUNE.shrineGlow; // resting intensity (1.0)
  animated.shrineUntil     = -1;       // elapsed deadline of the current pulse
  animated.shrineRequested = false;    // one-shot: a click asks for a fresh pulse
}

// buildBirdcage (parlour.js ~line 1328) — hanging 雀籠 wire cage + yellow bird.
// Hangs at y=2.3 in front-left (−2.65, 2.3, 2.4). No animation (static).
function buildBirdcage(scene) {
  const g = new THREE.Group();
  const wood    = mat(0x6a4a2a, 0.5, 0.1);
  const wire    = mat(0xc9b88a, 0.4, 0.5);
  const feather = mat(0xf0d05a, 0.5);
  const R = 0.13, Hc = 0.34;

  // top + bottom rings
  [0, Hc].forEach((y) => {
    const r = new THREE.Mesh(new THREE.TorusGeometry(R, 0.006, 8, 24), wood);
    r.position.y = y; r.rotation.x = Math.PI / 2; g.add(r);
  });

  // middle ring
  const mr = new THREE.Mesh(new THREE.TorusGeometry(R, 0.005, 8, 24), wire);
  mr.position.y = Hc * 0.6; mr.rotation.x = Math.PI / 2; g.add(mr);

  // 16 vertical bars
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, Hc, 5), wire);
    bar.position.set(Math.cos(a) * R, Hc / 2, Math.sin(a) * R); g.add(bar);
  }

  // dome cap
  const dome = new THREE.Mesh(new THREE.ConeGeometry(R, 0.12, 16, 1, true), wire);
  dome.position.y = Hc + 0.06; g.add(dome);

  // hook
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.004, 6, 12, Math.PI), wood);
  hook.position.y = Hc + 0.13; g.add(hook);

  // cage base
  const base = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.96, R * 0.96, 0.02, 20), wood);
  base.position.y = 0.01; g.add(base);

  // perch
  g.add(box(0.012, 0.006, 0.18, wood, 0, 0.12, 0, false, false));

  // bird body
  const bird = new THREE.Mesh(new THREE.SphereGeometry(0.032, 12, 10), feather);
  bird.scale.set(1, 0.95, 1.3); bird.position.set(0, 0.15, 0); bird.castShadow = true; g.add(bird);

  // bird head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.02, 10, 8), feather);
  head.position.set(0, 0.185, 0.03); g.add(head);

  // beak
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.006, 0.018, 8), mat(0xe07a2a, 0.5));
  beak.position.set(0, 0.185, 0.055); beak.rotation.x = Math.PI / 2; g.add(beak);

  // hanging cord up to ceiling
  g.add(box(0.003, 0.28, 0.003, mat(0x1a1a1a, 0.6), 0, Hc + 0.27, 0, false, false));

  g.position.set(-2.65, 2.3, 2.4);
  scene.add(g);
}

// ── GROUP D — ambiance & nook ─────────────────────────────────────────────────

// buildFluorescentTubes (parlour.js ~line 917) — twin 光管 emissive ceiling tubes
// flanking the pendant + a cool fill PointLight. Tagged pickType:'tubes', pushed
// into pickables (Task 5 wires the on/off toggle + startup flicker).
// Ambient mains-buzz is handled in updateParlour (animate.js); Task 5 owns the
// click-toggle — this function only builds the geometry and sets DEFAULT state.
function buildFluorescentTubes(scene, animated, pickables) {
  const g = new THREE.Group();
  const tubeMats = [];

  const make = (z) => {
    const fixture = new THREE.Group();
    // housing channel — light grey aluminium extrusion
    fixture.add(box(1.9, 0.06, 0.12, mat(0xcfd6d8, 0.5, 0.3), 0, 0.03, 0, false, false));
    // phosphor tube — cool white emissive cylinder (feeds bloom)
    const tubeMat = new THREE.MeshStandardMaterial({
      color: 0x141a22,
      emissive: new THREE.Color(0xdfe9ff),
      emissiveIntensity: TUNE.tubeEmissive,
    });
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.8, 12), tubeMat);
    tube.rotation.z = Math.PI / 2; tube.position.y = -0.01;
    fixture.add(tube);
    tubeMats.push(tubeMat);
    fixture.position.set(0, 0, z);
    return fixture;
  };

  g.add(make(-1.05)); g.add(make(1.05));
  g.position.set(0, 3.0, 0);
  g.userData = { pickType: 'tubes' };
  scene.add(g);
  pickables.push(g);

  // cool fill PointLight — tracks tube glow in updateParlour
  const cool = new THREE.PointLight(0xcfe0ff, TUNE.tubeLight, 7, 2);
  cool.position.set(0, 2.9, 0);
  scene.add(cool);

  // direct-assign scalar handles for the animate loop (NOT arrays — scalar objects)
  animated.tubeMats    = tubeMats;
  animated.tubeLight   = cool;
  animated.tubesOn     = true;
  animated.tubeBase    = TUNE.tubeEmissive;
  animated.tubeLightOn = TUNE.tubeLight;

  // Task 5: startup-flicker handles. When a click toggles the tubes ON, interact.js
  // sets tubeFlickerRequested; animate.js converts it to a timed `tubeFlickerUntil`
  // (elapsed + 0.9) and, while elapsed < tubeFlickerUntil, drives the random
  // strike-on flicker on top of the ambient mains buzz. -1 = no flicker pending.
  animated.tubeFlickerUntil     = -1;
  animated.tubeFlickerRequested = false;
}

// buildDiceBowl (parlour.js ~line 1230) — 骰盅: white porcelain bowl + 3 dice at
// TABLE CENTRE. BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z → opposite faces
// sum to 7 (1↔6, 2↔5, 3↔4). Tagged pickType:'dice', pushed into pickables.
// No ambient animation — dice are static until Task 5 wires the roll click.
function buildDiceBowl(scene, animated, pickables) {
  const g = new THREE.Group();

  // bowl body
  const bowl = new THREE.Mesh(
    new THREE.CylinderGeometry(0.075, 0.05, 0.04, 28),
    new THREE.MeshPhysicalMaterial({ color: 0xf2efe6, roughness: 0.3, clearcoat: 0.5 }),
  );
  bowl.position.y = 0.02; bowl.castShadow = true; bowl.receiveShadow = true; g.add(bowl);

  // red inner liner disc
  const inner = new THREE.Mesh(
    new THREE.CylinderGeometry(0.066, 0.045, 0.006, 28),
    mat(0x9a2030, 0.5),
  );
  inner.position.y = 0.04; g.add(inner);

  // pip textures 1-6
  const pip = [1, 2, 3, 4, 5, 6].map((n) => pipTexture(n));

  // BoxGeometry face order: px(+X)=1, nx(-X)=6, py(+Y)=2, ny(-Y)=5, pz(+Z)=3, nz(-Z)=4
  // opposite faces: 1↔6, 2↔5, 3↔4 → all pairs sum to 7. ✓
  const dieMats = [pip[0], pip[5], pip[1], pip[4], pip[2], pip[3]].map(
    (tx) => new THREE.MeshStandardMaterial({ map: tx, roughness: 0.4 }),
  );

  // Task 5: collect each die + an angular-velocity vector so animate.js can tumble
  // them. av is zero at rest; a roll click fills it with random spin.
  const dice = [];
  for (let i = 0; i < 3; i++) {
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.026, 0.026), dieMats);
    const a = i * 2.1;
    d.position.set(Math.cos(a) * 0.03, 0.058, Math.sin(a) * 0.03);
    d.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    d.castShadow = true; g.add(d);
    dice.push({ mesh: d, av: new THREE.Vector3() });
  }

  g.position.set(0, FELT_TOP, 0); // rest the bowl ON the felt top, not sunk into it
  g.userData = { pickType: 'dice' };
  scene.add(g);
  pickables.push(g);

  // Task 5: roll handles. rolling/until drive the tumble→snap in animate.js;
  // rollRequested is the one-shot flag a click sets (animate.js converts it to a
  // timed `until` = elapsed + 0.9 and seeds each die's av with random spin).
  animated.dice = { dice, rolling: false, until: 0, rollRequested: false };
}

// buildDiningTable (parlour.js ~line 1131) — round cha-chaan-teng table with edge
// torus, central column + base. Called with cx=1.85, cz=-1.7 (source line ~462).
function buildDiningTable(scene, cx, cz) {
  const TY = 0.74;
  const g = new THREE.Group();

  const woodM = new THREE.MeshPhysicalMaterial({
    color: COL.woodLight, roughness: 0.5, metalness: 0.08, clearcoat: 0.2,
  });
  const topM = new THREE.MeshPhysicalMaterial({
    color: 0xe9e0cd, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.2,
  });

  // tabletop
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.04, 32), topM);
  top.position.y = TY; top.castShadow = true; top.receiveShadow = true; g.add(top);

  // dark wood edge banding torus
  const edge = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.018, 10, 32), mat(COL.wood, 0.5));
  edge.position.y = TY - 0.015; edge.rotation.x = Math.PI / 2; g.add(edge);

  // central column
  g.add(box(0.08, TY - 0.04, 0.08, woodM, 0, (TY - 0.04) / 2, 0, true, false));

  // pedestal base
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.03, 20), mat(COL.wood, 0.5));
  base.position.y = 0.015; g.add(base);

  g.position.set(cx, 0, cz);
  scene.add(g);

  // three red stools at 120° apart (radians 0.5, 2.5, 4.4 from source)
  [0.5, 2.5, 4.4].forEach((a) => buildRedStool(scene, cx + Math.cos(a) * 0.72, cz + Math.sin(a) * 0.72));

  // leftover food on the table surface
  buildLeftovers(scene, cx, cz, TY + 0.02);
}

// buildRedStool (parlour.js ~line 1145) — squat red stool, 4 slightly splayed legs.
function buildRedStool(scene, x, z) {
  const g = new THREE.Group();
  const red = new THREE.MeshPhysicalMaterial({ color: 0xc0202a, roughness: 0.5, metalness: 0.05, clearcoat: 0.3 });
  const SH = 0.44;

  const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.14, 0.04, 20), red);
  seat.position.y = SH; seat.castShadow = true; g.add(seat);

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, SH, 8), red);
    leg.position.set(Math.cos(a) * 0.1, SH / 2, Math.sin(a) * 0.1);
    leg.rotation.x = Math.sin(a) * 0.12;
    leg.rotation.z = -Math.cos(a) * 0.12;
    leg.castShadow = true; g.add(leg);
  }

  g.position.set(x, 0, z);
  scene.add(g);
}

// buildLeftovers (parlour.js ~line 1157) — rice bowls, chopsticks, char siu plate,
// teapot + 2 cups on the dining table surface.
function buildLeftovers(scene, cx, cz, ty) {
  const cer = () => new THREE.MeshPhysicalMaterial({
    color: 0xeae3d2, roughness: 0.22, clearcoat: 0.7, clearcoatRoughness: 0.15,
  });
  const bowlMat = new THREE.MeshPhysicalMaterial({ color: 0xf2efe6, roughness: 0.3, clearcoat: 0.5 });

  // two rice bowls with a little food left
  [[-0.18, -0.1], [0.16, 0.12]].forEach(([dx, dz]) => {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.035, 0.05, 18), bowlMat);
    b.position.set(cx + dx, ty + 0.025, cz + dz); b.castShadow = true; scene.add(b);
    const food = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.04, 0.018, 16), mat(0xece5d0, 0.6));
    food.position.set(cx + dx, ty + 0.038, cz + dz); scene.add(food);
  });

  // chopsticks across the first bowl
  [-0.01, 0.012].forEach((o) => {
    const cstk = box(0.005, 0.005, 0.19, mat(0xc9a25a, 0.6), cx - 0.18 + o, ty + 0.052, cz - 0.1, false, false);
    cstk.rotation.y = 0.5; scene.add(cstk);
  });

  // plate of leftover char siu (BBQ pork slices)
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.07, 0.012, 20), bowlMat);
  plate.position.set(cx + 0.02, ty + 0.006, cz - 0.04); scene.add(plate);
  [[-0.03, 0], [0.02, 0.03], [0.04, -0.03]].forEach(([dx, dz]) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.02, 0.026), mat(0x8a2420, 0.5));
    m.position.set(cx + 0.02 + dx, ty + 0.02, cz - 0.04 + dz);
    m.rotation.y = dx * 7; scene.add(m);
  });

  // teapot (squashed sphere + spout + lid)
  const pot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 18, 14), cer());
  pot.scale.y = 0.8; pot.position.set(cx - 0.04, ty + 0.04, cz + 0.26); pot.castShadow = true; scene.add(pot);
  const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.012, 0.06, 10), cer());
  spout.position.set(cx - 0.11, ty + 0.04, cz + 0.26); spout.rotation.z = Math.PI / 3; scene.add(spout);
  const lid = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 10), cer());
  lid.position.set(cx - 0.04, ty + 0.085, cz + 0.26); scene.add(lid);

  // two small cups
  [[0.06, 0.22], [0.16, 0.1]].forEach(([dx, dz]) => {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.018, 0.026, 14), cer());
    cup.position.set(cx + dx, ty + 0.013, cz + dz); cup.castShadow = true; scene.add(cup);
  });
}

// buildDust (parlour.js ~line 640) — 340 additive dust motes. ~55% inside the
// pendant light cone over the table, the rest drifting the wider room. Upward drift
// wrapped at y > 2.4 → back to y = 0.8 in updateParlour.
// Direct-assign handle: animated.dust = Points.
function buildDust(scene, animated) {
  const N = 340;
  const pos = new Float32Array(N * 3);

  for (let i = 0; i < N; i++) {
    const inBeam = i < N * 0.55;
    const ang = Math.random() * Math.PI * 2;
    const rad = inBeam ? Math.random() * 0.5 : 0.5 + Math.random() * 1.1;
    pos[i * 3]     = Math.cos(ang) * rad;
    pos[i * 3 + 1] = inBeam ? 0.85 + Math.random() * 1.0 : 0.8 + Math.random() * 1.4;
    pos[i * 3 + 2] = Math.sin(ang) * rad;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));

  const m = new THREE.PointsMaterial({
    color: COL.tungsten,
    size: 0.007,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const pts = new THREE.Points(geo, m);
  scene.add(pts);

  // direct-assign scalar handle (not register/array — it's a single Points object)
  animated.dust = pts;
}

// buildWallFan (parlour.js ~line 1259) — square through-wall exhaust fan, +X wall
// top-left corner. Set INTO a dark recessed duct so no wall shows behind the blades.
// 5 pitched blades, protective grille bars, metal frame.
// Animated: blades spin in updateParlour (direct-assign handle animated.wallFanBlades).
function buildWallFan(scene, animated) {
  const g = new THREE.Group();
  const frameM = mat(0xb4b8bc, 0.5, 0.4);
  const dark   = mat(0x070809, 0.7, 0.1);
  const S = 0.44;

  // recessed dark duct — hides the wall behind it
  g.add(box(S, S, 0.03, dark, 0, 0, -0.05, false, false));

  // 5 pitched blades on individual wrap groups so they spin as a unit
  const blades = new THREE.Group();
  const bladeMat = mat(0x4a5256, 0.45, 0.5);
  for (let i = 0; i < 5; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(S * 0.4, 0.07, 0.004), bladeMat);
    b.position.x = S * 0.2; b.rotation.x = 0.45; // pitched
    const wrap = new THREE.Group(); wrap.add(b); wrap.rotation.z = (i / 5) * Math.PI * 2;
    blades.add(wrap);
  }
  blades.position.z = -0.02; g.add(blades);

  // hub
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.04, 14), mat(0x14181a, 0.5));
  hub.rotation.x = Math.PI / 2; hub.position.z = -0.01; g.add(hub);

  // square outer frame, flush with the wall
  const ft = 0.05;
  g.add(box(S + ft, ft, 0.05, frameM, 0,  S / 2, 0, false, false));
  g.add(box(S + ft, ft, 0.05, frameM, 0, -S / 2, 0, false, false));
  g.add(box(ft, S + ft, 0.05, frameM, -S / 2, 0, 0, false, false));
  g.add(box(ft, S + ft, 0.05, frameM,  S / 2, 0, 0, false, false));

  // protective grille bars across the face
  for (let yy = -S / 2 + 0.07; yy < S / 2 - 0.02; yy += 0.08)
    g.add(box(S, 0.01, 0.012, frameM, 0, yy, 0.02, false, false));

  // +X wall, top-left corner, set into the wall
  g.position.set(3.14, 2.68, -2.68); g.rotation.y = -Math.PI / 2;
  scene.add(g);

  // direct-assign scalar handle (NOT register — it's a single Object3D, not an array)
  animated.wallFanBlades = blades;
}
