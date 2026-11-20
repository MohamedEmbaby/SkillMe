#!/usr/bin/env node
'use strict';
/**
 * Cuts the generated art sheets in assets/atlas/ into the individual sprites the Arena uses
 * (assets/sprites/*.png + manifest.json). Zero dependencies: a small PNG decoder/encoder on zlib.
 *
 *   node scripts/build-atlas.js
 *
 * Each sheet is a 4x4 grid on a flat magenta (#FF00FF) background (see docs/gui-atlas-prompts.md).
 * Steps: key out the magenta (with despill on the edges) -> find the connected shapes -> group them
 * by grid cell -> crop -> scale down. Characters share one frame per character, bottom-aligned, so
 * their poses line up when the Arena swaps them. Regenerate a sheet, rerun this, and the Arena updates.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'atlas');
const OUT = path.join(ROOT, 'assets', 'sprites');

// name: null = skip (soft glows that can't be keyed cleanly; the Arena draws those in CSS)
const SHEETS = [
  { file: 'Chibi Knight and Monster Sprite Sheet.png', kind: 'characters', max: 300, names: [
    'hero-idle', 'hero-blink', 'hero-attack', 'hero-hurt', 'hero-victory', 'hero-cheer', 'hero-guard', 'hero-levelup',
    'claude-idle', 'claude-blink', 'claude-angry', 'claude-dance-a', 'claude-dance-b', 'claude-shocked', 'claude-sad', 'claude-hit'] },
  { file: 'Glossy Game Achievement Badge Grid.png', max: 192, names: [
    'badge-first_blood', 'badge-on_fire', 'badge-unstoppable', 'badge-gotcha', 'badge-bug_hunter', 'badge-overtake', 'badge-scholar', 'badge-speedster',
    'badge-polymath', 'badge-diamond', 'badge-locked', 'emblem-levelup', 'emblem-app', 'trophy', 'xp-gem', 'streak-flame'] },
  { file: 'Glossy Cartoon Game Icon Grid.png', max: 128, names: [
    'icon-bell', 'icon-volume', 'icon-mute', 'icon-moon', 'icon-sun', 'icon-restart', 'icon-gear', 'icon-pin',
    'icon-chest', 'icon-hat', 'icon-flame', 'icon-target', 'icon-star', 'icon-star-empty', 'icon-check', 'icon-x'] },
  { file: 'Fantasy Game Icon Grid.png', max: 128, names: [
    'icon-flee', 'icon-hourglass', 'icon-flag', 'icon-swords', 'icon-shield', 'icon-crown', 'icon-hammer', 'icon-book',
    'icon-orb', 'icon-quill', 'icon-scroll', 'icon-alert', 'icon-key', 'icon-sword', 'icon-skull', 'icon-cursor'] },
  { file: 'Colourful Cartoon Game Effects Sticker Sheet.png', max: 128, names: [
    'fx-note', 'fx-notes', 'fx-steam', 'fx-spark', 'fx-anger', 'fx-bang', 'fx-sweat', 'fx-impact',
    'fx-slash', 'fx-smoke', 'fx-lightning', 'fx-splash', 'fx-bug', 'fx-rocket', 'icon-chev', 'icon-arrow'] },
  { file: 'Cartoon RPG UI Frames and Buttons.png', max: 0, names: [
    'frame-window', 'frame-window-day', 'frame-dialog', 'frame-plate', 'btn-gold', 'btn-gold-pressed', 'btn-steel', 'btn-red',
    'frame-iconbtn', 'row', 'row-hover', 'row-right', 'row-wrong', 'bar-trough', 'bar-blue', 'bar-orange'] },
  { file: 'Cartoon RPG UI Icon Grid.png', max: 0, names: [
    'ribbon', 'toggle-off', 'toggle-on', 'frame-input', 'frame-chip', 'frame-tooltip', 'bar-gold-fill', 'divider',
    'vs-emblem', 'frame-modal', 'corner', null, null, null, 'dot-gem', 'btn-close'] },
  // The HP fight (optional until generated: the Arena falls back to existing art). Character poses reuse sheet 1's frames.
  { file: 'Game Sticker Icon Grid.png', optional: true, max: 160, names: [
    'hero-ko', 'hero-low', 'hero-crit', 'claude-attack', 'claude-ko', 'claude-low', 'claude-win', 'icon-heart',
    'icon-heart-broken', 'emblem-victory', 'emblem-defeat', 'fx-crit', 'fx-claude-hit', 'fx-dizzy', 'bar-green-fill', 'bar-red-fill'] },
];
const SCENES = { file: 'Day and Night Fantasy Battlefields.png', names: ['bg-night', 'bg-day'] };

// ---------------------------------------------------------------- PNG in/out
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, w, h, depth, type, interlace;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), tag = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (tag === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (tag === 'IDAT') idat.push(data);
    else if (tag === 'IEND') break;
    pos += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !ch || interlace) throw new Error(`unsupported PNG (depth ${depth}, colour type ${type}, interlace ${interlace})`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride), p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = raw[p++];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, s = x * ch;
      if (ch >= 3) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = ch === 4 ? cur[s + 3] : 255; }
      else { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = ch === 2 ? cur[s + 1] : 255; }
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, data: out };
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(tag, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(tag), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG({ w, h, data }, opaque = false) {
  const ch = opaque ? 3 : 4, stride = w * ch;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < w; x++) for (let k = 0; k < ch; k++) raw[y * (stride + 1) + 1 + x * ch + k] = data[(y * w + x) * 4 + k];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- magenta key
// "Magenta-ness": red and blue about equal, green well below both. Shadows on the magenta (dark magenta)
// count as background too; dark outlines and purples don't (green not far below / red and blue unequal).
function key(img) {
  const { w, h, data } = img;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4, r = data[o], g = data[o + 1], b = data[o + 2];
    const mx = Math.max(r, b), mn = Math.min(r, b);
    if (mx < 40) continue;
    const mag = (mn - g) / mx, bal = (mx - mn) / mx;
    if (bal > 0.42) continue;
    const a = Math.max(0, Math.min(1, (0.78 - mag) / 0.36));
    data[o + 3] = Math.round(a * 255);
  }
  // despill: pixels near the background lose their magenta cast (interior purples are untouched)
  const near = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] > 8) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < w && Y < h) near[Y * w + X] = 1;
    }
  }
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (!near[i] || data[o + 3] < 8) continue;
    const r = data[o], g = data[o + 1], b = data[o + 2], m = Math.min(r, b) - g;
    if (m > 0) { data[o] = r - m; data[o + 2] = b - m; }
  }
  return img;
}

// ---------------------------------------------------------------- shapes -> grid cells
function components(img) {
  const { w, h, data } = img;
  const label = new Int32Array(w * h).fill(-1), comps = [], stack = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (label[s] !== -1 || data[s * 4 + 3] < 128) continue;
    let top = 0, n = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    const id = comps.length;
    stack[top++] = s; label[s] = id;
    while (top) {
      const i = stack[--top], x = i % w, y = (i / w) | 0;
      n++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (label[j] === -1 && data[j * 4 + 3] >= 128) { label[j] = id; stack[top++] = j; }
      }
    }
    comps.push({ n, cx: sx / n, cy: sy / n, x0, y0, x1, y1 });
  }
  return comps.filter((c) => c.n >= 40);
}

function cells(img) {
  const groups = Array.from({ length: 16 }, () => null);
  for (const c of components(img)) {
    const col = Math.min(3, Math.floor(c.cx / (img.w / 4))), row = Math.min(3, Math.floor(c.cy / (img.h / 4)));
    const k = row * 4 + col, g = groups[k];
    groups[k] = g ? { x0: Math.min(g.x0, c.x0), y0: Math.min(g.y0, c.y0), x1: Math.max(g.x1, c.x1), y1: Math.max(g.y1, c.y1) } : { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 };
  }
  return groups;
}

function crop(img, b, pad = 2) {
  const x0 = Math.max(0, b.x0 - pad), y0 = Math.max(0, b.y0 - pad), x1 = Math.min(img.w - 1, b.x1 + pad), y1 = Math.min(img.h - 1, b.y1 + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1, data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) img.data.copy(data, y * w * 4, ((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x0 + w) * 4);
  return { w, h, data };
}

/** Centre `img` on a transparent square canvas (for icons). */
function square(img, pad = 6) {
  const side = Math.max(img.w, img.h) + pad * 2, data = Buffer.alloc(side * side * 4);
  const ox = Math.floor((side - img.w) / 2), oy = Math.floor((side - img.h) / 2);
  for (let y = 0; y < img.h; y++) img.data.copy(data, ((oy + y) * side + ox) * 4, y * img.w * 4, (y + 1) * img.w * 4);
  return { w: side, h: side, data };
}

/** Place `img` on a w x h transparent canvas, bottom-centred. */
function frame(img, w, h) {
  const data = Buffer.alloc(w * h * 4), ox = Math.floor((w - img.w) / 2), oy = h - img.h;
  for (let y = 0; y < img.h; y++) img.data.copy(data, ((oy + y) * w + ox) * 4, y * img.w * 4, (y + 1) * img.w * 4);
  return { w, h, data };
}

// ---------------------------------------------------------------- area-averaging downscale (premultiplied alpha)
function resize(img, nw, nh) {
  const pass = (src, sw, sh, tw, horizontal) => {
    const dw = horizontal ? tw : sw, dh = horizontal ? sh : tw, out = new Float64Array(dw * dh * 4);
    const len = horizontal ? sw : sh, scale = len / tw;
    for (let t = 0; t < tw; t++) {
      const a = t * scale, b = a + scale;
      for (let s = Math.floor(a); s < Math.min(len, Math.ceil(b)); s++) {
        const wgt = (Math.min(b, s + 1) - Math.max(a, s)) / scale;
        if (wgt <= 0) continue;
        const lines = horizontal ? sh : sw;
        for (let l = 0; l < lines; l++) {
          const si = horizontal ? (l * sw + s) * 4 : (s * sw + l) * 4;
          const di = horizontal ? (l * dw + t) * 4 : (t * dw + l) * 4;
          for (let k = 0; k < 4; k++) out[di + k] += src[si + k] * wgt;
        }
      }
    }
    return out;
  };
  const pre = new Float64Array(img.w * img.h * 4);
  for (let i = 0; i < img.w * img.h; i++) {
    const a = img.data[i * 4 + 3] / 255;
    pre[i * 4] = img.data[i * 4] * a; pre[i * 4 + 1] = img.data[i * 4 + 1] * a; pre[i * 4 + 2] = img.data[i * 4 + 2] * a; pre[i * 4 + 3] = img.data[i * 4 + 3];
  }
  const h1 = pass(pre, img.w, img.h, nw, true);
  const v = pass(h1, nw, img.h, nh, false);
  const data = Buffer.alloc(nw * nh * 4);
  for (let i = 0; i < nw * nh; i++) {
    const a = v[i * 4 + 3];
    const k = a > 0 ? 255 / a : 0;
    data[i * 4] = Math.round(Math.min(255, v[i * 4] * k)); data[i * 4 + 1] = Math.round(Math.min(255, v[i * 4 + 1] * k));
    data[i * 4 + 2] = Math.round(Math.min(255, v[i * 4 + 2] * k)); data[i * 4 + 3] = Math.round(Math.min(255, a));
  }
  return { w: nw, h: nh, data };
}
const fit = (img, max) => {
  if (!max || (img.w <= max && img.h <= max)) return img;
  const s = max / Math.max(img.w, img.h);
  return resize(img, Math.max(1, Math.round(img.w * s)), Math.max(1, Math.round(img.h * s)));
};

/** The coloured fill inside a combined bar image (trough + fill): bbox of pixels matching `test`. */
function fillOf(img, test) {
  let x0 = img.w, y0 = img.h, x1 = 0, y1 = 0;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const o = (y * img.w + x) * 4;
    if (img.data[o + 3] > 200 && test(img.data[o], img.data[o + 1], img.data[o + 2])) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 > x0 ? crop(img, { x0, y0, x1, y1 }, 0) : null;
}

// ---------------------------------------------------------------- build
fs.mkdirSync(OUT, { recursive: true });
const manifest = {};
const cut = {}; // name -> image, for the recolour pass
const save = (name, img, opaque = false) => {
  fs.writeFileSync(path.join(OUT, name + '.png'), encodePNG(img, opaque));
  manifest[name] = { w: img.w, h: img.h };
  cut[name] = img;
};
const problems = [];
const charFrame = {}; // per character: the shared frame from sheet 1
/** Scale down only if it doesn't fit the frame (keeps the same scale as sheet 1 otherwise). */
const shrinkTo = (img, W, H) => (img.w <= W && img.h <= H ? img : resize(img, Math.max(1, Math.floor(img.w * Math.min(W / img.w, H / img.h))), Math.max(1, Math.floor(img.h * Math.min(W / img.w, H / img.h)))));

for (const sheet of SHEETS) {
  const file = path.join(SRC, sheet.file);
  if (!fs.existsSync(file)) {
    if (sheet.optional) console.log(`skipped ${sheet.file} (not generated yet)`); else problems.push(`missing ${sheet.file}`);
    continue;
  }
  const img = key(decodePNG(fs.readFileSync(file)));
  const groups = cells(img);
  const crops = groups.map((g, i) => (g && sheet.names[i] ? crop(img, g) : null));
  sheet.names.forEach((n, i) => { if (n && !crops[i]) problems.push(`${sheet.file}: nothing found in cell ${i + 1} (${n})`); });

  if (sheet.kind === 'characters') {
    // one shared frame per character (cells 1-8 hero, 9-16 Claude), bottom-centred, same scale for every pose
    for (const [from, to] of [[0, 8], [8, 16]]) {
      const set = crops.slice(from, to).filter(Boolean);
      const W = Math.max(...set.map((c) => c.w)), H = Math.max(...set.map((c) => c.h));
      const s = Math.min(1, sheet.max / Math.max(W, H)), fw = Math.round(W * s), fh = Math.round(H * s);
      charFrame[sheet.names[from].split('-')[0]] = { W, H, fw, fh }; // later sheets' poses of this character use the same frame
      for (let i = from; i < to; i++) if (crops[i]) save(sheet.names[i], resize(frame(crops[i], W, H), fw, fh));
    }
    // The app's icon (taskbar, title bar, tab, notifications): the knight in idle pose, centred in a square.
    const idle = crops[sheet.names.indexOf('hero-idle')];
    if (idle) save('icon-player', fit(square(idle), 256));
  } else {
    sheet.names.forEach((n, i) => {
      if (!n || !crops[i]) return;
      const cf = charFrame[n.split('-')[0]];
      if (/^(hero|claude)-/.test(n) && cf) save(n, resize(frame(shrinkTo(crops[i], cf.W, cf.H), cf.W, cf.H), cf.fw, cf.fh));
      else save(n, /^bar-/.test(n) ? crops[i] : fit(crops[i], sheet.max));
    });
  }
  if (sheet.names.includes('bar-blue')) {
    const blue = crops[sheet.names.indexOf('bar-blue')], orange = crops[sheet.names.indexOf('bar-orange')];
    const b = blue && fillOf(blue, (r, g, bl) => bl > 200 && r < 120 && g > 90);
    const o = orange && fillOf(orange, (r, g, bl) => r > 210 && g > 100 && bl < 90);
    if (b) save('bar-blue-fill', b); else problems.push('could not find the blue bar fill');
    if (o) save('bar-orange-fill', o); else problems.push('could not find the orange bar fill');
  }
  console.log(`cut ${sheet.file}`);
}

if (fs.existsSync(path.join(SRC, SCENES.file))) {
  const img = decodePNG(fs.readFileSync(path.join(SRC, SCENES.file)));
  const half = Math.floor(img.h / 2), inset = 4; // skip the seam between the two scenes
  const top = crop(img, { x0: 0, y0: 0, x1: img.w - 1, y1: half - inset }, 0);
  const bottom = crop(img, { x0: 0, y0: half + inset, x1: img.w - 1, y1: img.h - 1 }, 0);
  save(SCENES.names[0], top, true);
  save(SCENES.names[1], bottom, true);
  console.log(`cut ${SCENES.file}`);
} else problems.push(`missing ${SCENES.file}`);

// ---------------------------------------------------------------- warm recolours
// The UI sheets came out navy; the game look uses light-brown panels instead. Each navy sprite gets a
// "-warm" twin: blue fills turn light brown (shading kept), dark outlines stay dark
// (brown), and gold, white and other colours are left alone. Silver rims become wood brown. 'hue' keeps the lightness (dark troughs stay dark).
const WARM = {
  'frame-window': { mode: 'panel' }, 'frame-dialog': { mode: 'panel', base: 0.75, sat: 0.55 }, 'frame-plate': { mode: 'panel' },
  'frame-chip': { mode: 'panel', base: 0.7 }, 'frame-input': { mode: 'panel', base: 0.83, sat: 0.42 }, 'frame-iconbtn': { mode: 'panel', base: 0.72 },
  'frame-modal': { mode: 'panel' }, 'frame-tooltip': { mode: 'panel' }, 'row': { mode: 'panel', base: 0.8, sat: 0.45 },
  'row-hover': { mode: 'panel', hue: 42, sat: 0.8, base: 0.79 },
  'bar-trough': { mode: 'hue', hue: 28, dark: 1.05 }, 'ribbon': { mode: 'hue', hue: 22, dark: 0.82 }, 'toggle-off': { mode: 'hue', hue: 30, dark: 1 },
};
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
function hsl2rgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function warm(img, { mode, hue = 33, sat = 0.5, base = 0.74, dark = 1 }) {
  const out = { w: img.w, h: img.h, data: Buffer.from(img.data) };
  for (let o = 0; o < out.data.length; o += 4) {
    if (!out.data[o + 3]) continue;
    const [h, s, l] = rgb2hsl(out.data[o], out.data[o + 1], out.data[o + 2]);
    const bluish = h >= 185 && h <= 275 && s >= 0.05;
    const rim = mode === 'panel' && l > 0.42 && (s < 0.05 || (bluish && s < 0.32)); // the silver rim (grey or blue-grey)
    if (!bluish && !rim) continue; // gold, red, green, dark outlines... stay
    let H = hue, S, L;
    if (mode === 'hue') { S = s * 0.75; L = clamp(l * dark, 0, 1); }
    else if (rim) { H = hue - 3; S = 0.42; L = clamp(0.2 + l * 0.52, 0, 0.8); } // silver rim -> wood brown
    else if (s < 0.38) { H = hue - 6; S = 0.4; L = l * 0.72; } // slate outlines -> dark brown
    else {
      const t = smooth(0.07, 0.15, l); // outlines (very dark) stay dark; fills (darker than mid) turn light
      const lit = clamp(base + (l - 0.22) * 0.42, base - 0.08, 0.94);
      L = (1 - t) * l * 1.1 + t * lit;
      S = (1 - t) * 0.45 + t * sat;
    }
    const [r, g, b] = hsl2rgb(H, clamp(S, 0, 1), clamp(L, 0, 1));
    out.data[o] = r; out.data[o + 1] = g; out.data[o + 2] = b;
  }
  return out;
}
for (const [name, opts] of Object.entries(WARM)) {
  if (cut[name]) save(name + '-warm', warm(cut[name], opts)); else problems.push(`no ${name} to recolour`);
}
console.log(`recoloured ${Object.keys(WARM).length} navy sprites to light brown (*-warm)`);

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`\n${Object.keys(manifest).length} sprites in assets/sprites/`);
if (problems.length) { console.log('Problems:\n- ' + problems.join('\n- ')); process.exitCode = 1; }
