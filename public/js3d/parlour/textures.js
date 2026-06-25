// parlour/textures.js — procedural CanvasTexture painters for the room shell.
//
// Ported from _from-open-design/js/parlour.js:
//   terrazzoTexture ~line 298 (700-chip stone repeat 5×5)
//   wallTexture     ~line 271 (cream plaster + jade ceramic dado, repeat 8×1)
//   ceilingTexture  ~line 315 (pressed-tin 2-panel tile, repeat 6×6)
//
// All textures: CanvasTexture, SRGBColorSpace, anisotropy 8.
// Decor painters added incrementally per Task 4 group. This file currently holds
// the room shell (Task 3) + GROUP A centrepieces (neon glyph, faan chart,
// skyline). Later groups (4b/4c/4d) add tinAd/menu/tv/alley/etc.

import * as THREE from 'three';

// Shared CJK font stack for every painted Chinese glyph (parlour.js HK_CJK ~668).
// Microsoft YaHei ships on the Windows target; the rest are graceful fallbacks.
export const HK_CJK = '"Microsoft YaHei","Songti SC","Noto Sans SC","SimHei",sans-serif';

// Polished 石米 terrazzo floor — warm grey base flecked with multi-colour stone chips.
export function terrazzoTexture() {
  const S = 256;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const x = c.getContext('2d');
  x.fillStyle = '#cfc8b6'; x.fillRect(0, 0, S, S);
  const chips = ['#8a8270', '#b5ac95', '#6a6456', '#9a5a3a', '#3a5a4a', '#7a3a3a', '#cabf9a', '#5a5448'];
  for (let i = 0; i < 700; i++) {
    x.fillStyle = chips[i % chips.length];
    const cx = (i * 53) % S, cy = (i * 89) % S, r = 1.6 + (i % 4);
    x.beginPath(); x.ellipse(cx, cy, r, r * 0.7, (i % 6), 0, Math.PI * 2); x.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(5, 5);
  return tex;
}

// Wall surface: warm cream plaster up top + a jade ceramic-tile dado on the
// lower ~1 m — baked into one texture (no protruding trim to slice wall signs).
// Tiles sit at the canvas BOTTOM (flipY → wall floor side).
export function wallTexture() {
  const W = 256, H = 512, dadoTop = 340;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#d6cdb4'; x.fillRect(0, 0, W, H);                   // warm cream plaster
  x.fillStyle = 'rgba(150,135,100,0.05)';                             // faint mottling
  for (let i = 0; i < 36; i++) {
    x.beginPath();
    x.arc((i * 61) % W, (i * 97) % dadoTop, 7 + (i % 5) * 4, 0, Math.PI * 2);
    x.fill();
  }
  x.fillStyle = '#15705a'; x.fillRect(0, dadoTop, W, H - dadoTop);   // grout base
  const tw = 60, th = 24, gr = 4;
  for (let ry = dadoTop + 4, row = 0; ry < H; ry += th + gr, row++) {
    const off = (row % 2) * ((tw + gr) / 2);
    for (let rx = -tw; rx < W + tw; rx += tw + gr) {
      const g = x.createLinearGradient(rx + off, ry, rx + off, ry + th);
      g.addColorStop(0, '#2aa07a'); g.addColorStop(1, '#1d8a66');
      x.fillStyle = g; x.fillRect(rx + off, ry, tw, th);
      x.fillStyle = 'rgba(255,255,255,0.12)'; x.fillRect(rx + off + 3, ry + 3, tw - 6, 4); // gloss highlight
    }
  }
  x.fillStyle = '#0e5a44'; x.fillRect(0, dadoTop - 5, W, 5);         // dado cap shadow
  x.fillStyle = '#caa14e'; x.fillRect(0, dadoTop - 8, W, 3);         // brass trim line
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(8, 1); // ~0.2 m subway tiles across each 6.4 m wall
  return tex;
}

// Pressed-tin panelled ceiling — warm off-white with inset panel shadows.
export function ceilingTexture() {
  const S = 256, n = 2, cell = S / n;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d');
  x.fillStyle = '#cdc6b4'; x.fillRect(0, 0, S, S);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const px = i * cell, py = j * cell;
      x.strokeStyle = 'rgba(80,72,56,0.35)'; x.lineWidth = 4;
      x.strokeRect(px + 6, py + 6, cell - 12, cell - 12);
      x.strokeStyle = 'rgba(255,250,235,0.5)'; x.lineWidth = 2;
      x.strokeRect(px + 10, py + 10, cell - 20, cell - 20);
      x.fillStyle = 'rgba(80,72,56,0.18)';
      x.beginPath(); x.arc(px + cell / 2, py + cell / 2, 6, 0, Math.PI * 2); x.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  return tex;
}

// ── GROUP A decor painters (centrepieces) ────────────────────────────────────

// neonGlyphTexture(text, fontPx) — a WHITE neon-tube glyph on black, returned
// with its aspect ratio so the caller can size the plane. Ported from neonMask
// (parlour.js ~line 509). The glyph is painted white (glow + outline stroke) so
// the colour comes from the material's `emissive` (see materials.neonMaterial,
// single-colour convention). The black background → fully transparent via alphaMap.
export function neonGlyphTexture(text, fontPx = 180) {
  const pad = 40;
  const c = document.createElement('canvas');
  const probe = c.getContext('2d');
  probe.font = `700 ${fontPx}px ${HK_CJK}`;
  const measured = Math.max(probe.measureText(text).width, fontPx * 0.5); // guard a 0/degenerate measure
  const w = Math.ceil(measured) + pad * 2;
  const h = fontPx + pad * 2;
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
  x.font = `700 ${fontPx}px ${HK_CJK}`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.shadowColor = '#fff'; x.shadowBlur = 22;   // the soft tube halo
  x.fillStyle = '#fff';
  x.fillText(text, w / 2, h / 2);
  x.shadowBlur = 0; x.lineWidth = 5; x.strokeStyle = '#fff';
  x.strokeText(text, w / 2, h / 2);            // crisp tube core
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, aspect: w / h };
}

// faanTexture() — 番數表 scoring chart. Dark lacquer board, gold border, gold
// title, names in warm white, numeric values in bright jade, 限 (limit) in red.
// Ported from faanTexture (parlour.js ~line 839).
//
// CORRECTED ROWS: the values mirror the CURRENT default HK Standard ruleset in
// scoring.js PATTERNS. 小三元 is 3番 (hkFaan: 3) — the parlour source had a stale
// 4. Cross-checked: 平糊 1, 對對糊 3, 混一色 3, 清一色 7, 七對 4, 小三元 3, 門前清 1,
// 自摸 1, 搶槓 1, 槓上開花 1, 大三元/十三幺/字一色 = 限 (13-faan limit).
export function faanTexture() {
  const c = document.createElement('canvas'); c.width = 300; c.height = 420;
  const x = c.getContext('2d');
  x.fillStyle = '#10201c'; x.fillRect(0, 0, 300, 420);                       // dark lacquer board (pops against the bright wall)
  x.strokeStyle = '#caa14e'; x.lineWidth = 6; x.strokeRect(8, 8, 284, 404);  // gold border
  x.fillStyle = '#f0d27a'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = `700 38px ${HK_CJK}`; x.fillText('番 數 表', 150, 50);
  x.strokeStyle = 'rgba(202,161,78,0.4)'; x.lineWidth = 1; x.beginPath(); x.moveTo(24, 72); x.lineTo(276, 72); x.stroke();
  const rows = [['平糊', '1'], ['對對糊', '3'], ['混一色', '3'], ['清一色', '7'], ['七對', '4'],
                ['小三元', '3'], ['門前清', '1'], ['自摸', '1'], ['搶槓', '1'], ['槓上開花', '1'],
                ['大三元', '限'], ['十三幺', '限'], ['字一色', '限']];
  x.font = `600 23px ${HK_CJK}`; let yy = 98;
  rows.forEach(([n, v]) => {
    x.fillStyle = '#ece6d4'; x.textAlign = 'left'; x.fillText(n, 26, yy);                 // names in warm white
    x.fillStyle = v === '限' ? '#ff5a52' : '#3fd89a'; x.textAlign = 'right';              // values: bright red / bright jade
    x.fillText(v === '限' ? '限' : v + '番', 274, yy);
    yy += 24;
  });
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

// ── GROUP B decor painters (wall fixtures) ───────────────────────────────────

// scrollTexture() — 運氣 hanging luck scroll: warm parchment with gold top/bottom
// bars and two large brush-script characters. Ported from buildScroll (~line 550).
export function scrollTexture() {
  const c = document.createElement('canvas'); c.width = 200; c.height = 460;
  const x = c.getContext('2d');
  x.fillStyle = '#e9dcc0'; x.fillRect(0, 0, 200, 460);
  x.fillStyle = '#caa14e'; x.fillRect(0, 0, 200, 22); x.fillRect(0, 438, 200, 22);
  x.fillStyle = '#1c1c1c'; x.font = `700 110px "Songti SC","SimSun",serif`;
  x.textAlign = 'center';
  x.fillText('運', 100, 150); x.fillText('氣', 100, 300);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

// menuTexture() — 美都餐室 cha-chaan-teng backlit menu board.
// Ported from menuTexture (~line 798). Two columns: drinks / 常餐 set meals with prices.
export function menuTexture() {
  const c = document.createElement('canvas'); c.width = 480; c.height = 360;
  const x = c.getContext('2d');
  x.fillStyle = '#f1e7cd'; x.fillRect(0, 0, 480, 360);
  x.fillStyle = 'rgba(150,110,60,0.05)';
  for (let i = 0; i < 6; i++) { x.beginPath(); x.arc((i * 97) % 480, (i * 131) % 360, 24 + (i * 13) % 30, 0, Math.PI * 2); x.fill(); }
  x.fillStyle = '#b5232f'; x.fillRect(0, 0, 480, 80);
  x.fillStyle = '#f7efda'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = `700 44px ${HK_CJK}`; x.fillText('美 都 餐 室', 240, 30);
  x.font = `600 17px ${HK_CJK}`; x.fillText('CHA CHAAN TENG · 自 一 九 五 〇', 240, 60);
  const column = (cx, title, rows, y0) => {
    x.fillStyle = '#7a1d12'; x.textAlign = 'left'; x.font = `700 26px ${HK_CJK}`; x.fillText(title, cx, y0);
    x.strokeStyle = '#b5232f'; x.lineWidth = 2; x.beginPath(); x.moveTo(cx, y0 + 15); x.lineTo(cx + 182, y0 + 15); x.stroke();
    let yy = y0 + 42; x.font = `600 21px ${HK_CJK}`;
    rows.forEach(([n, p]) => {
      x.fillStyle = '#26221b'; x.textAlign = 'left'; x.fillText(n, cx, yy);
      x.fillStyle = '#b5232f'; x.textAlign = 'right'; x.fillText('$' + p, cx + 182, yy);
      yy += 35;
    });
  };
  column(34, '飲 品', [['凍奶茶', '19'], ['熱奶茶', '17'], ['鴛鴦', '20'], ['凍檸茶', '18'], ['好立克', '20'], ['阿華田', '20']], 110);
  column(266, '常 餐', [['火腿通粉', '30'], ['餐蛋麵', '32'], ['菠蘿油', '15'], ['西多士', '24'], ['蛋撻', '9'], ['沙嗲牛麵', '36']], 110);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

// tvBroadcastTexture() — 賽馬直播 horse-race broadcast canvas.
// Ported from tvBroadcastTex (~line 1348). Green turf, five horses mid-race, red banner.
export function tvBroadcastTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 150;
  const x = c.getContext('2d');
  x.fillStyle = '#1f6b3a'; x.fillRect(0, 0, 256, 150);
  x.fillStyle = '#2a7d46'; for (let i = 0; i < 256; i += 16) x.fillRect(i, 0, 8, 150);
  x.fillStyle = '#e8e2d0'; x.fillRect(0, 96, 256, 5);
  const cols = ['#c0202a', '#2050c0', '#e0a020', '#202020', '#a040a0'];
  cols.forEach((col, i) => {
    const hx = 28 + i * 44, hy = 70 - (i % 2) * 6;
    x.fillStyle = col; x.fillRect(hx, hy, 22, 9);
    x.fillStyle = '#3a2a18'; x.fillRect(hx + 1, hy + 9, 3, 8); x.fillRect(hx + 18, hy + 9, 3, 8);
    x.fillRect(hx + 20, hy - 4, 5, 6);
  });
  x.fillStyle = '#c8202a'; x.fillRect(0, 124, 256, 26);
  x.fillStyle = '#fff'; x.textAlign = 'left'; x.textBaseline = 'middle'; x.font = `700 18px ${HK_CJK}`;
  x.fillText('賽馬直播 · 第七場', 8, 138);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

// alleyBackdropTexture() — night alley tong-lau diorama with neon 招牌 signs
// and lit windows for the +X wall alley window backdrop.
// Ported from alleyTexture (~line 703).
export function alleyBackdropTexture() {
  const W = 512, H = 336;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  const sky = x.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#0a0e1a'); sky.addColorStop(0.55, '#140a1a'); sky.addColorStop(1, '#1c0f14');
  x.fillStyle = sky; x.fillRect(0, 0, W, H);
  // hazy moon
  const moon = x.createRadialGradient(424, 58, 4, 424, 58, 48);
  moon.addColorStop(0, 'rgba(255,238,210,0.7)'); moon.addColorStop(1, 'rgba(255,238,210,0)');
  x.fillStyle = moon; x.fillRect(360, 0, 130, 120);
  // tong-lau silhouettes with lit windows, two depth layers
  const layer = (base, cols, density) => {
    let bx = -10, i = 0;
    while (bx < W) {
      const bw = 46 + ((bx * 53 + i * 17) % 56), bh = base + ((bx * 29 + i * 41) % 120);
      x.fillStyle = cols[i % cols.length]; x.fillRect(bx, H - bh, bw, bh);
      for (let wy = H - bh + 12; wy < H - 12; wy += 18)
        for (let wx = bx + 7; wx < bx + bw - 7; wx += 16) {
          if ((wx * 7 + wy * 3) % 5 < density) continue;
          x.fillStyle = (wx + wy) % 2 ? 'rgba(255,210,140,0.85)' : 'rgba(150,220,255,0.65)';
          x.fillRect(wx, wy, 8, 10);
        }
      bx += bw + 7; i++;
    }
  };
  layer(150, ['#10202c', '#161320'], 3);
  layer(110, ['#1a2430', '#201826', '#12201d'], 2);
  // vertical neon 招牌 hung off the buildings
  const neons = [
    ['#ff2e96', ['茶', '餐', '廳'], 56, 60], ['#18e39a', ['麻', '雀', '館'], 152, 86],
    ['#ffb24d', ['酒', '家'], 252, 70], ['#5cd0ff', ['冰', '室'], 332, 98], ['#ff5a3c', ['大', '排', '檔'], 432, 64],
  ];
  neons.forEach(([col, chars, nx, ny]) => {
    x.fillStyle = 'rgba(0,0,0,0.55)'; x.fillRect(nx - 20, ny - 6, 42, chars.length * 40 + 12);
    x.fillStyle = col; x.shadowColor = col; x.shadowBlur = 14;
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = `700 32px ${HK_CJK}`;
    chars.forEach((ch, i) => x.fillText(ch, nx + 1, ny + 16 + i * 40));
    x.shadowBlur = 0;
  });
  // horizontal signboards
  [['#ffd14d', 176, 150, '凍檸茶'], ['#7cffb0', 58, 214, '生力啤']].forEach(([col, sx, sy, txt]) => {
    x.fillStyle = 'rgba(0,0,0,0.5)'; x.fillRect(sx - 8, sy - 18, 104, 32);
    x.fillStyle = col; x.shadowColor = col; x.shadowBlur = 10;
    x.textAlign = 'left'; x.textBaseline = 'middle'; x.font = `700 24px ${HK_CJK}`; x.fillText(txt, sx, sy);
    x.shadowBlur = 0;
  });
  // magenta wet-ground spill at the bottom
  const wet = x.createLinearGradient(0, H - 64, 0, H);
  wet.addColorStop(0, 'rgba(255,46,150,0)'); wet.addColorStop(1, 'rgba(255,46,150,0.26)');
  x.fillStyle = wet; x.fillRect(0, H - 64, W, 64);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

// neonBoardTexture(text) — vertical 招牌 neon sign for alley parallax.
// Ported from neonBoard (~line 688). Returns a bare CanvasTexture — caller builds the mesh.
export function neonBoardTexture(text) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#0a0a0a'; x.fillRect(0, 0, 128, 256);
  x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.shadowColor = '#fff'; x.shadowBlur = 16; x.font = `700 64px ${HK_CJK}`;
  text.split('').forEach((ch, i) => x.fillText(ch, 64, 56 + i * 96));
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

// ── GROUP C decor painters (front wall + corners) ────────────────────────────

// tinAdTexture(txt, sub, bg, fg) — glossy enamel ad plate canvas.
// Canvas 200×150, coloured bg, white inner border, main text + sub text centred.
export function tinAdTexture(txt, sub, bg, fg) {
  const c = document.createElement('canvas'); c.width = 200; c.height = 150;
  const x = c.getContext('2d');
  x.fillStyle = bg; x.fillRect(0, 0, 200, 150);
  x.strokeStyle = 'rgba(255,255,255,0.55)'; x.lineWidth = 6; x.strokeRect(9, 9, 182, 132);
  x.fillStyle = fg; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = `700 50px ${HK_CJK}`; x.fillText(txt, 100, 62);
  x.font = `600 21px ${HK_CJK}`; x.fillText(sub, 100, 112);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

// doorStreetTexture() — 128×256 sidewalk/street view for the door glass.
// Ported from doorStreetTex (~line 950 in parlour.js).
export function doorStreetTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 256;
  const x = c.getContext('2d');
  const sky = x.createLinearGradient(0, 0, 0, 80);
  sky.addColorStop(0, '#26354a'); sky.addColorStop(1, '#4a3a36');
  x.fillStyle = sky; x.fillRect(0, 0, 128, 80);
  x.fillStyle = '#2a2620'; x.fillRect(0, 64, 128, 64);
  x.fillStyle = '#7a2a2a'; x.fillRect(0, 64, 128, 9);
  x.fillStyle = '#3a342e'; x.fillRect(12, 82, 44, 46);
  x.fillStyle = 'rgba(255,210,140,0.6)'; x.fillRect(16, 86, 36, 30);
  x.fillStyle = '#5a4a2a'; x.fillRect(70, 80, 26, 48);
  x.fillStyle = '#18e39a'; x.shadowColor = '#18e39a'; x.shadowBlur = 8;
  x.textAlign = 'left'; x.textBaseline = 'middle'; x.font = `700 13px ${HK_CJK}`; x.fillText('士多', 64, 100); x.shadowBlur = 0;
  x.fillStyle = '#15171a'; x.fillRect(0, 128, 128, 28);
  x.strokeStyle = 'rgba(230,220,120,0.5)'; x.lineWidth = 2; x.setLineDash([8, 8]);
  x.beginPath(); x.moveTo(0, 142); x.lineTo(128, 142); x.stroke(); x.setLineDash([]);
  x.fillStyle = '#3a3c3e'; x.fillRect(0, 156, 128, 6);
  x.fillStyle = '#5c5c5a'; x.fillRect(0, 162, 128, 94);
  x.strokeStyle = 'rgba(0,0,0,0.28)'; x.lineWidth = 1.5;
  for (let i = 0; i <= 4; i++) { const yy = 162 + i * 23; x.beginPath(); x.moveTo(0, yy); x.lineTo(128, yy); x.stroke(); }
  for (let sx = -64; sx <= 192; sx += 30) { x.beginPath(); x.moveTo(64 + (sx - 64) * 0.18, 162); x.lineTo(sx, 256); x.stroke(); }
  x.fillStyle = '#1c1c1c'; x.fillRect(106, 56, 5, 106);
  x.fillStyle = 'rgba(255,210,140,0.9)'; x.beginPath(); x.arc(108, 56, 7, 0, Math.PI * 2); x.fill();
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

// coupletTexture(text) — 64×256 red couplet with gold border and gold Chinese characters.
export function coupletTexture(text) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#c01828'; x.fillRect(0, 0, 64, 256);
  x.strokeStyle = '#e8c659'; x.lineWidth = 3; x.strokeRect(4, 4, 56, 248);
  x.fillStyle = '#f7e6b0'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = `700 34px ${HK_CJK}`;
  text.split('').forEach((ch, i) => x.fillText(ch, 32, 34 + i * 56));
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

// fuDiamondTexture() — 140×140 red diamond with 福 character.
export function fuDiamondTexture() {
  const c = document.createElement('canvas'); c.width = 140; c.height = 140;
  const x = c.getContext('2d');
  x.save(); x.translate(70, 70); x.rotate(Math.PI / 4);
  x.fillStyle = '#c01828'; x.fillRect(-46, -46, 92, 92);
  x.strokeStyle = '#e8c659'; x.lineWidth = 4; x.strokeRect(-46, -46, 92, 92); x.restore();
  x.fillStyle = '#e8c659'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = `700 64px ${HK_CJK}`;
  x.fillText('福', 70, 74);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

// openSignTexture(open) — canvas 200×120 open/closed sign.
// Green bg for 營業中 OPEN, red bg for 休息中 CLOSED. White border + text.
export function openSignTexture(open) {
  const c = document.createElement('canvas'); c.width = 200; c.height = 120;
  const x = c.getContext('2d');
  x.fillStyle = open ? '#1f8a4d' : '#b5232f'; x.fillRect(0, 0, 200, 120);
  x.strokeStyle = '#f4efe2'; x.lineWidth = 7; x.strokeRect(9, 9, 182, 102);
  x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = `700 50px ${HK_CJK}`; x.fillText(open ? '營業中' : '休息中', 100, 46);
  x.font = `700 26px Arial, sans-serif`; x.fillText(open ? 'OPEN' : 'CLOSED', 100, 92);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

// shrineTex() — 96×72 shrine panel: red bg, gold text '土地財神'.
export function shrineTex() {
  const c = document.createElement('canvas'); c.width = 96; c.height = 72;
  const x = c.getContext('2d');
  x.fillStyle = '#7a0f16'; x.fillRect(0, 0, 96, 72);
  x.fillStyle = '#e8c659'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = `700 22px ${HK_CJK}`;
  x.fillText('土地財神', 48, 38);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

// ── GROUP D decor painters (ambiance & nook) ─────────────────────────────────

// pipTexture(n) — 64×64 white die face with n pips arranged per standard Western
// die layout. The 1-pip is red (Chinese dice convention). Canvas square, cream
// background, dark or red pips. Ported from pipTex (parlour.js ~line 1216).
export function pipTexture(n) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#f6f3ea'; x.fillRect(0, 0, 64, 64);
  x.fillStyle = n === 1 ? '#c01828' : '#1a1a1a'; // the 1-pip is red (Chinese dice)
  const P = {
    1: [[32, 32]],
    2: [[20, 20], [44, 44]],
    3: [[18, 18], [32, 32], [46, 46]],
    4: [[20, 20], [44, 20], [20, 44], [44, 44]],
    5: [[20, 20], [44, 20], [32, 32], [20, 44], [44, 44]],
    6: [[20, 18], [44, 18], [20, 32], [44, 32], [20, 46], [44, 46]],
  };
  P[n].forEach(([px, py]) => { x.beginPath(); x.arc(px, py, 7, 0, Math.PI * 2); x.fill(); });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// skylineWallTexture() — abstract red-on-warm-white HK skyline for the upper back
// wall (above the jade tile dado). Ported from skylineWallTexture (~line 347).
// Flat graphic; mounted at low emissiveIntensity (0.18) so it reads as a faint
// backlit panel against the near-black room.
export function skylineWallTexture() {
  const W = 1024, H = 300;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#f2ece0'; x.fillRect(0, 0, W, H);                                 // warm white sky
  x.fillStyle = '#c8202a'; x.beginPath(); x.arc(W * 0.78, H * 0.3, 36, 0, Math.PI * 2); x.fill(); // red sun
  const reds = ['#b51d27', '#c8202a', '#9a1820', '#d83440'];
  let bx = -20, i = 0;
  while (bx < W) {
    const bw = 40 + ((bx * 37 + i * 53) % 66), bh = 90 + ((bx * 29 + i * 41) % 180), top = H - bh;
    x.fillStyle = reds[i % reds.length]; x.fillRect(bx, top, bw, bh);              // buildings rise from the bottom (the dado line)
    const r = (bx + i) % 4;
    if (r === 0) { x.beginPath(); x.moveTo(bx, top); x.lineTo(bx + bw / 2, top - 28); x.lineTo(bx + bw, top); x.closePath(); x.fill(); }
    else if (r === 1) { x.fillRect(bx + bw / 2 - 3, top - 38, 6, 38); }
    else if (r === 2) { x.fillRect(bx + 8, top - 14, bw - 16, 14); }
    bx += bw + 12; i++;
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}
