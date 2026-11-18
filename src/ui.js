import * as THREE from 'three';

// Canvas-drawn window rendered onto a plane. Widgets are plain objects; the panel owns
// layout, hit testing and drawing. Pointer coordinates arrive in layout pixels.

// The FractalVR brand: Void the ground, Abyss the panels, Dusk the tracks, Glow the accent,
// Ember for warnings, Bone the text, Mist the quiet text. Space Grotesk for words, Space Mono
// for labels and numbers.
export const BRAND = { void: '#06080F', abyss: '#111833', dusk: '#3A3F7A', glow: '#46E0D4', ember: '#FF8A3D', bone: '#F1ECE2', mist: '#AAB0CE' };
const COLORS = {
  bg: BRAND.abyss, title: BRAND.void, strip: '#0B1022', text: BRAND.bone, dim: BRAND.mist, accent: BRAND.glow, ink: BRAND.void,
  track: BRAND.dusk, border: BRAND.dusk, raised: '#1B2245', raisedHot: '#282D5A',
};
const SANS = '"Space Grotesk"';
const MONO = '"Space Mono"';

// Texels per layout pixel. Windows are drawn at twice their layout size and mipmapped, so text
// holds its edges near to and far from them.
const S = 2;

const FONT_FILES = [
  ['Space Grotesk', '400', 'space-grotesk-latin-400-normal'],
  ['Space Grotesk', '500', 'space-grotesk-latin-500-normal'],
  ['Space Mono', '400', 'space-mono-latin-400-normal'],
];
let fontsLoaded = false;
const onFonts = [];
const whenFonts = (fn) => { if (fontsLoaded) fn(); else onFonts.push(fn); };

// Loads the brand's faces (public/fonts); windows draw nothing until they are in.
export function loadFonts(base) {
  return Promise.all(FONT_FILES.map(([family, weight, file]) => {
    const face = new FontFace(family, `url(${base}fonts/${file}.woff2)`, { weight });
    document.fonts.add(face);
    return face.load();
  })).then(() => {
    fontsLoaded = true;
    for (const fn of onFonts.splice(0)) fn();
  });
}

// Sets a face: `track` is letter spacing in ems.
function type(ctx, px, { mono = false, weight = 400, track = 0 } = {}) {
  ctx.font = `${weight} ${px}px ${mono ? MONO : SANS}`;
  ctx.letterSpacing = `${track * px}px`;
}

// A canvas `width` by `height` layout pixels, S texels to each.
function surface(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width * S;
  canvas.height = height * S;
  const ctx = canvas.getContext('2d');
  ctx.scale(S, S);
  return { canvas, ctx };
}

function sharpTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8; // three holds it to what the GPU allows
  return t;
}

// The lines `text` takes set `width` wide in the current face.
function wrap(ctx, text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    const t = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(t).width > width) { out.push(line); line = word; } else line = t;
  }
  if (line) out.push(line);
  return out;
}

// "Fractal" in Bone and "VR" in Glow, Space Grotesk 500 set tight, its baseline's middle at y.
function wordmark(ctx, x, y, px) {
  type(ctx, px, { weight: 500, track: -0.035 });
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = BRAND.bone;
  ctx.fillText('Fractal', x, y);
  const w = ctx.measureText('Fractal').width;
  ctx.fillStyle = BRAND.glow;
  ctx.fillText('VR', x + w, y);
  return x + w + ctx.measureText('VR').width;
}

// The Gasket mark, `h` tall from its top left (x, y): a Sierpinski triangle in Glow, its top in
// Ember. Returns where it ends on the right.
function gasket(ctx, x, y, h) {
  const w = h * 2 / Math.sqrt(3);
  const tris = [];
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const split = (a, b, c, d) => {
    if (d === 0) { tris.push([a, b, c]); return; }
    split(a, mid(a, b), mid(a, c), d - 1);
    split(mid(a, b), b, mid(b, c), d - 1);
    split(mid(a, c), mid(b, c), c, d - 1);
  };
  split([x + w / 2, y], [x, y + h], [x + w, y + h], 2);
  tris.forEach((t, i) => {
    const cx = (t[0][0] + t[1][0] + t[2][0]) / 3, cy = (t[0][1] + t[1][1] + t[2][1]) / 3;
    ctx.fillStyle = i === 0 ? BRAND.ember : BRAND.glow;
    ctx.beginPath();
    t.forEach(([px, py], j) => { const X = cx + (px - cx) * 0.9, Y = cy + (py - cy) * 0.9; if (j) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
    ctx.closePath();
    ctx.fill();
  });
  return x + w;
}

// A window's title bar, `h` tall: Void, the mark, then the wordmark (brand) or a title, a quiet
// note on the right, and the close box.
function titleBar(ctx, W, h, { brand = false, title = '', note = '', close = true }) {
  ctx.fillStyle = COLORS.title;
  ctx.fillRect(0, 0, W, h);
  const x = gasket(ctx, PAD, h / 2 - 12, 24) + 12;
  if (brand) wordmark(ctx, x, h / 2 + 1, 28);
  else {
    type(ctx, 25, { weight: 500, track: -0.01 });
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, x, h / 2 + 1);
  }
  if (note) {
    type(ctx, 15, { mono: true, track: 0.1 });
    ctx.fillStyle = COLORS.dim;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(note, W - (close ? h : PAD) - 6, h / 2 + 1);
    ctx.textAlign = 'left';
  }
  if (close) {
    const cx = W - h / 2, cy = h / 2, r = 8;
    ctx.strokeStyle = COLORS.dim;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
    ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r);
    ctx.stroke();
  }
}

const TITLE_H = 56;
const TAB_H = 64;
const PILL_PX = 21;
const PAD = 18;
const REACH = 14; // pixels off a thing that can be pressed a press still takes it
const FLASH = 180; // ms a button pressed stays lit
const PEEK = 250; // ms a slider is held before the rest of its window gets out of the way

const REST = 0.08; // of half a slider about nought, each side of its middle: nought itself

// A slider's value at the share `f` of its track, and the share its value is at. `log`: equal
// lengths are equal ratios. `fine` (the least a value is, short of nought; min is -max): from
// the middle out each way, equal lengths are equal ratios from `fine` to max, and the middle
// is nought, so the small values have as much of the track as the large.
export function sliderValue(w, f) {
  if (w.fine) {
    const u = 2 * f - 1, a = Math.abs(u);
    return a < REST - 1e-9 ? 0 : Math.sign(u) * w.fine * Math.pow(w.max / w.fine, Math.max(0, a - REST) / (1 - REST));
  }
  return w.log ? w.min * Math.pow(w.max / w.min, f) : w.min + f * (w.max - w.min);
}
export function sliderShare(w, v) {
  if (w.fine) {
    if (Math.abs(v) < w.fine / 2) return 0.5;
    const a = REST + (1 - REST) * Math.max(0, Math.log(Math.abs(v) / w.fine) / Math.log(w.max / w.fine));
    return 0.5 + Math.sign(v) * Math.min(1, a) / 2;
  }
  return w.log ? Math.log(v / w.min) / Math.log(w.max / w.min) : (v - w.min) / (w.max - w.min);
}
// The value a slider takes for one asked of it: on its steps (`fine`: to two figures), in its range.
export function sliderSnap(w, v) {
  if (w.fine) v = Math.abs(v) < w.fine / 2 ? 0 : Number(v.toPrecision(2));
  else if (w.step) v = w.log ? Math.round(v / w.step) * w.step : w.min + Math.round((v - w.min) / w.step) * w.step;
  return Math.max(w.min, Math.min(w.max, v));
}

const inert = (w) => w.type === 'label' || w.type === 'text' || w.type === 'heading';
const off = (r, x, y) => Math.hypot(Math.max(0, r.x - x, x - r.x - r.w), Math.max(0, r.y - y, y - r.y - r.h));

// Overlays draw on top of the fractal composite (renderOrder -1) but before the controller
// models (0). Depth test is left on with AlwaysDepth so depth is still written: the headset
// compositor reprojects with the depth buffer, and depth-less overlays wobble.
export const OVERLAY_ORDER = -0.5;
export function overlayMaterial(opts = {}) {
  return new THREE.MeshBasicMaterial({
    toneMapped: false, depthTest: true, depthFunc: THREE.AlwaysDepth, depthWrite: true,
    transparent: false, side: THREE.DoubleSide, ...opts,
  });
}

export class Panel {
  // `upload(srcTexture, dstTexture, box, position)` performs a partial canvas upload
  // (renderer.copyTextureToTexture); full uploads only happen on rebuild.
  // `brand`: the title bar carries the wordmark in place of `title`.
  constructor({ title, brand = false, note = '', width = 800, height = 1100, meters = 0.6, upload }) {
    this.title = title;
    this.brand = brand;
    this.note = note; // quiet, in the title bar beside the close box
    this.upload = upload;
    this.width = width;
    this.height = height;
    ({ canvas: this.canvas, ctx: this.ctx } = surface(width, height));
    // No flip: canvas row 0 is texture row 0, and the plane's UVs are flipped instead so
    // partial uploads can use canvas coordinates directly.
    this.texture = sharpTexture(this.canvas);
    this.texture.flipY = false;
    this.srcTexture = new THREE.Texture(this.canvas); // never rendered: keeps the canvas upload path
    this.srcTexture.flipY = false;
    const mat = overlayMaterial({ map: this.texture });
    const hm = meters * height / width;
    const geom = new THREE.PlaneGeometry(meters, hm);
    const uv = geom.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    this.mesh = new THREE.Mesh(geom, mat);
    this.mesh.renderOrder = OVERLAY_ORDER;
    this.mesh.visible = false;
    this.meters = meters;
    this.metersH = hm;
    this.tabs = [];
    this.tab = 0;
    this.fullDirty = true;
    this.dirtyRects = [];
    this.hot = new Map(); // pointerId -> widget
    this.captures = new Map(); // pointerId -> widget
    this.onClose = null;
    this.lastLiveCheck = 0;
    this.cursors = new Map();
    this.titleHit = { type: 'title' };
    this.tabHits = [];
    this._box = new THREE.Box2();
    this._pos = new THREE.Vector2();
    this.heldAt = 0; // when a slider was taken hold of
    this.shown = null; // the widget the window is cut down to, or null for all of it
    whenFonts(() => { if (this.tabs.length) this.rebuild(); });
  }

  // Cut the window's mesh down to the rows of one widget, or back to the whole (null).
  show(w) {
    if (w === this.shown) return;
    this.shown = w;
    const W = this.width, H = this.height;
    const y0 = w ? Math.max(0, w.y - PAD) : 0, y1 = w ? Math.min(H, w.y + w.h + PAD) : H;
    const { position, uv } = this.mesh.geometry.attributes;
    for (let i = 0; i < 4; i++) {
      const x = i % 2 ? W : 0, y = i < 2 ? y0 : y1;
      position.setXYZ(i, (x / W - 0.5) * this.meters, (0.5 - y / H) * this.metersH, 0);
      uv.setXY(i, x / W, y / H);
    }
    position.needsUpdate = true;
    uv.needsUpdate = true;
    this.mesh.geometry.computeBoundingSphere();
    this.mesh.geometry.computeBoundingBox();
  }

  setTabs(tabs) {
    this.tabs = tabs; // [{ name, widgets: () => [...] }]
    this.tabHits = tabs.map((t, index) => ({ type: 'tab', index }));
    this.rebuild();
  }

  rebuild() {
    this.widgets = this.tabs.length ? this.tabs[this.tab].widgets() : [];
    // Widgets from the old layout must not keep receiving drags or dirty-rect redraws.
    this.hot.clear();
    this.captures.clear();
    this.dirtyRects.length = 0;
    this.layout();
    if (fontsLoaded && this.contentH > this.height) console.error(`panel tab ${this.tabs[this.tab]?.name} overflows by ${this.contentH - this.height}px`);
    this.fullDirty = true;
  }

  // Redraw only widgets whose displayed value differs from what was last drawn.
  markAll() {
    for (const w of this.widgets) if (displayKey(w) !== w.drawn) this.markDirty(w);
  }

  layout() {
    const W = this.width;
    const tw = (W - 4) / Math.max(1, this.tabs.length);
    for (const t of this.tabHits) {
      const x = 2 + Math.round(t.index * tw);
      Object.assign(t, { x, y: TITLE_H, w: 2 + Math.round((t.index + 1) * tw) - x, h: TAB_H });
    }
    let y = TITLE_H + TAB_H + PAD;
    for (const w of this.widgets) {
      w.x = PAD;
      w.y = y;
      w.w = W - 2 * PAD;
      if (w.type === 'label') w.h = 40;
      else if (w.type === 'heading') w.h = 128;
      else if (w.type === 'button') w.h = 52;
      else if (w.type === 'toggle') w.h = 52;
      else if (w.type === 'slider') w.h = 78;
      else if (w.type === 'select') {
        w.pills = [];
        let px = w.x, py = w.y + 38;
        const ctx = this.ctx;
        type(ctx, PILL_PX, { weight: 500 }); // the chosen one's face, the wider
        for (let i = 0; i < w.options.length; i++) {
          const tw = ctx.measureText(w.options[i]).width + 32;
          if (px + tw > w.x + w.w) { px = w.x; py += 50; }
          w.pills.push({ i, x: px, y: py, w: tw, h: 42 });
          px += tw + 8;
        }
        w.h = py + 50 - w.y;
      } else if (w.type === 'text') {
        w.cache = w.lines();
        w.h = w.cache.length * 32 + 16;
      }
      y += w.h + 6;
    }
    this.contentH = y - 6 + PAD;
  }

  cursorMesh(id) {
    let c = this.cursors.get(id);
    if (!c) {
      c = new THREE.Mesh(new THREE.RingGeometry(0.004, 0.007, 24), overlayMaterial({ color: 0xffffff }));
      c.renderOrder = OVERLAY_ORDER + 0.1;
      c.position.z = 0.002;
      c.visible = false;
      this.mesh.add(c);
      this.cursors.set(id, c);
    }
    return c;
  }

  // uv from a raycast hit -> canvas pixels (UVs are flipped, so v runs top to bottom)
  uvToPx(uv) {
    return [uv.x * this.width, uv.y * this.height];
  }

  showCursor(id, uv) {
    const c = this.cursorMesh(id);
    c.visible = true;
    c.position.x = (uv.x - 0.5) * this.meters;
    c.position.y = (0.5 - uv.y) * this.metersH;
  }

  hideCursor(id) {
    const c = this.cursors.get(id);
    if (c) c.visible = false;
  }

  widgetAt(x, y) {
    if (y < TITLE_H) return this.titleHit;
    if (y < TITLE_H + TAB_H) {
      return this.tabHits.findLast((t) => x >= t.x) ?? null;
    }
    for (const w of this.widgets) {
      if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return w;
    }
    return null;
  }

  // What a press at (x, y) takes: what is under it, or by nothing, the nearest thing within REACH
  // that can be pressed (of a row of choices, the nearest choice).
  target(x, y) {
    const under = this.widgetAt(x, y);
    if (under && !inert(under)) return under;
    let best = under, least = REACH;
    for (const w of [...this.tabHits, ...this.widgets]) {
      if (inert(w)) continue;
      const d = w.type === 'select' ? Math.min(...w.pills.map((p) => off(p, x, y))) : off(w, x, y);
      if (d < least) { least = d; best = w; }
    }
    return best;
  }

  markDirty(w) {
    if (!w || w.type === 'title') return;
    if (!this.dirtyRects.includes(w)) this.dirtyRects.push(w);
  }

  setHot(id, w) {
    const prev = this.hot.get(id);
    if (prev === w) return;
    if (w) this.hot.set(id, w); else this.hot.delete(id);
    this.markDirty(prev);
    this.markDirty(w);
  }

  isHot(w) {
    for (const h of this.hot.values()) if (h === w) return true;
    return false;
  }

  // Returns 'close' or 'title' for title-bar presses so the caller can drag the window.
  pointerDown(id, x, y) {
    const w = this.target(x, y);
    this.took = !!w && !inert(w); // the press did something
    this.lastPressed = !w ? 'nothing' : w.type === 'title' ? (x > this.width - TITLE_H ? 'close' : 'title') : w.type === 'tab' ? `tab ${this.tabs[w.index].name}` : `${w.type} ${w.text ?? ''}`.trim();
    if (!w) return null;
    if (w.type === 'title') {
      if (x > this.width - TITLE_H) { if (this.onClose) this.onClose(); return 'close'; }
      return 'title';
    }
    if (w.type === 'tab') {
      if (w.index !== this.tab) { this.tab = w.index; this.rebuild(); }
      return null;
    }
    if (w.type === 'button') { w.onClick(); w.pressedAt = performance.now(); this.markDirty(w); }
    else if (w.type === 'toggle') { w.set(!w.get()); this.markDirty(w); }
    else if (w.type === 'select') {
      // The choice pressed, or the nearest by a press in the gap between them.
      let best = null, least = REACH;
      for (const p of w.pills) {
        const d = off(p, x, y);
        if (d < least) { least = d; best = p; }
      }
      this.lastPressed += best ? `: ${w.options[best.i]}` : ': none';
      if (best) { w.set(best.i); this.markDirty(w); } else this.took = false;
    } else if (w.type === 'slider') {
      if (!this.captures.size) this.heldAt = performance.now();
      this.captures.set(id, w);
      this.sliderTo(w, x);
    }
    return null;
  }

  pointerMove(id, x, y) {
    const cap = this.captures.get(id);
    if (cap) { this.sliderTo(cap, x); return; }
    this.setHot(id, this.target(x, y));
  }

  pointerUp(id) {
    this.captures.delete(id);
  }

  pointerLeave(id) {
    this.hideCursor(id);
    this.setHot(id, null);
  }

  // Nudge the slider under the pointer by a fraction of its range (thumbstick fine control).
  nudge(x, y, frac) {
    const w = this.target(x, y);
    if (!w || w.type !== 'slider') return false;
    this.setSlider(w, sliderValue(w, Math.max(0, Math.min(1, sliderShare(w, w.get()) + frac))));
    return true;
  }

  setSlider(w, v) {
    v = sliderSnap(w, v);
    if (v === w.get()) return;
    w.set(v);
    this.markDirty(w);
  }

  sliderTo(w, x) {
    const tx = w.x + 8, tw = w.w - 16;
    const f = Math.max(0, Math.min(1, (x - tx) / tw));
    this.setSlider(w, sliderValue(w, f));
  }

  update(now) {
    // A slider held a moment: only its rows are left, so what it changes can be seen.
    const held = this.captures.size && now - this.heldAt > PEEK ? this.captures.values().next().value : null;
    this.show(held);
    if (!this.mesh.visible || !fontsLoaded) return;
    for (const w of this.widgets) if (w.pressedAt && now - w.pressedAt > FLASH) { w.pressedAt = 0; this.markDirty(w); }
    if (now - this.lastLiveCheck > 500) {
      this.lastLiveCheck = now;
      for (const w of this.widgets) {
        if (w.type !== 'text') continue;
        const lines = w.lines();
        if (lines.length !== w.cache.length) { w.cache = lines; this.layout(); this.fullDirty = true; break; }
        if (lines.join('\n') !== w.cache.join('\n')) { w.cache = lines; this.markDirty(w); }
      }
    }
    if (this.fullDirty) {
      this.draw();
      this.texture.needsUpdate = true;
      this.fullDirty = false;
      this.dirtyRects.length = 0;
      return;
    }
    if (this.dirtyRects.length === 0) return;
    for (const w of this.dirtyRects) {
      this.clearWidget(w);
      this.drawWidget(w);
      this._box.min.set(w.x * S, w.y * S);
      this._box.max.set((w.x + w.w) * S, Math.min(this.height, w.y + w.h) * S);
      this._pos.set(w.x * S, w.y * S);
      this.upload(this.srcTexture, this.texture, this._box, this._pos);
    }
    this.dirtyRects.length = 0;
  }

  clearWidget(w) {
    this.ctx.fillStyle = w.type === 'tab' ? COLORS.strip : COLORS.bg;
    this.ctx.fillRect(w.x, w.y, w.w, w.h);
  }

  draw() {
    const ctx = this.ctx;
    const W = this.width, H = this.height;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    titleBar(ctx, W, TITLE_H, { brand: this.brand, title: this.title, note: this.note });
    ctx.fillStyle = COLORS.strip;
    ctx.fillRect(0, TITLE_H, W, TAB_H);
    for (const t of this.tabHits) this.drawWidget(t);
    for (const w of this.widgets) this.drawWidget(w);
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);
  }

  drawWidget(w) {
    const ctx = this.ctx;
    const hot = this.isHot(w);
    w.drawn = displayKey(w);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    if (w.type === 'tab') {
      const on = w.index === this.tab;
      ctx.fillStyle = on ? COLORS.bg : hot ? COLORS.raised : COLORS.strip;
      ctx.fillRect(w.x, w.y, w.w, w.h);
      if (on) { ctx.fillStyle = COLORS.accent; ctx.fillRect(w.x + 12, w.y + w.h - 4, w.w - 24, 4); }
      type(ctx, 16, { mono: true, track: 0.12 });
      ctx.fillStyle = on || hot ? COLORS.text : COLORS.dim;
      ctx.textAlign = 'center';
      ctx.fillText(this.tabs[w.index].name.toUpperCase(), w.x + w.w / 2 + 1, w.y + w.h / 2);
    } else if (w.type === 'label') {
      type(ctx, 16, { mono: true, track: 0.2 });
      ctx.fillStyle = COLORS.dim;
      const t = w.text.toUpperCase();
      ctx.fillText(t, w.x, w.y + w.h / 2 + 2);
      const end = w.x + ctx.measureText(t).width + 8;
      ctx.fillStyle = COLORS.border;
      ctx.fillRect(end, w.y + w.h / 2 + 2, w.x + w.w - end, 1);
    } else if (w.type === 'heading') {
      wordmark(ctx, w.x, w.y + 44, 60);
      type(ctx, 24);
      ctx.fillStyle = COLORS.dim;
      ctx.fillText(w.text, w.x + 2, w.y + 102);
    } else if (w.type === 'button') {
      ctx.fillStyle = w.pressedAt ? COLORS.accent : hot ? COLORS.raisedHot : COLORS.raised;
      roundRect(ctx, w.x, w.y, w.w, w.h, 8);
      type(ctx, 23, { weight: 500 });
      ctx.fillStyle = w.pressedAt ? COLORS.ink : COLORS.text;
      ctx.textAlign = 'center';
      ctx.fillText(w.text, w.x + w.w / 2, w.y + w.h / 2);
    } else if (w.type === 'toggle') {
      ctx.fillStyle = hot ? COLORS.raisedHot : COLORS.raised;
      roundRect(ctx, w.x, w.y, w.w, w.h, 8);
      type(ctx, 23);
      ctx.fillStyle = COLORS.text;
      ctx.fillText(w.text, w.x + 16, w.y + w.h / 2);
      const on = w.get();
      ctx.fillStyle = on ? COLORS.accent : COLORS.track;
      roundRect(ctx, w.x + w.w - 96, w.y + 10, 80, 32, 16);
      ctx.fillStyle = on ? COLORS.ink : COLORS.dim;
      ctx.beginPath();
      ctx.arc(w.x + w.w - 96 + (on ? 64 : 16), w.y + 26, 11, 0, Math.PI * 2);
      ctx.fill();
    } else if (w.type === 'slider') {
      type(ctx, 23);
      ctx.fillStyle = COLORS.text;
      ctx.fillText(w.text, w.x, w.y + 20);
      type(ctx, 19, { mono: true });
      ctx.fillStyle = hot ? COLORS.accent : COLORS.dim;
      ctx.textAlign = 'right';
      ctx.fillText(w.fmt ? w.fmt(w.get()) : w.get().toFixed(3), w.x + w.w, w.y + 20);
      ctx.textAlign = 'left';
      const tx = w.x + 8, ty = w.y + 52, tw = w.w - 16;
      ctx.fillStyle = COLORS.track;
      roundRect(ctx, tx, ty - 4, tw, 8, 4);
      const f = Math.max(0, Math.min(1, sliderShare(w, w.get())));
      ctx.fillStyle = COLORS.accent;
      // About nought, the bar runs from the middle; else from the left.
      if (w.fine) { if (f !== 0.5) roundRect(ctx, tx + tw * Math.min(0.5, f), ty - 4, tw * Math.abs(f - 0.5), 8, 4); }
      else roundRect(ctx, tx, ty - 4, Math.max(8, tw * f), 8, 4);
      if (hot) {
        ctx.strokeStyle = COLORS.accent;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(tx + tw * f, ty, 18, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = COLORS.text;
      ctx.beginPath();
      ctx.arc(tx + tw * f, ty, 13, 0, Math.PI * 2);
      ctx.fill();
    } else if (w.type === 'select') {
      type(ctx, 23);
      ctx.fillStyle = COLORS.text;
      ctx.fillText(w.text, w.x, w.y + 18);
      const cur = w.get();
      ctx.textAlign = 'center';
      for (const p of w.pills) {
        const on = p.i === cur;
        ctx.fillStyle = on ? COLORS.accent : COLORS.raised;
        roundRect(ctx, p.x, p.y, p.w, p.h, p.h / 2);
        type(ctx, PILL_PX, { weight: on ? 500 : 400 });
        ctx.fillStyle = on ? COLORS.ink : COLORS.text;
        ctx.fillText(w.options[p.i], p.x + p.w / 2, p.y + p.h / 2);
      }
      ctx.textAlign = 'left';
    } else if (w.type === 'text') {
      if (w.prose) { type(ctx, 22); ctx.fillStyle = COLORS.text; } else { type(ctx, 19, { mono: true }); ctx.fillStyle = COLORS.dim; }
      const lines = w.cache;
      for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], w.x, w.y + 22 + i * 32);
    }
  }
}

function displayKey(w) {
  if (w.type === 'slider' || w.type === 'toggle' || w.type === 'select') return w.get();
  if (w.type === 'text') return w.cache.join('\n');
  return null;
}

// Small readout floating above a hand.
export class HandLabel {
  constructor() {
    this.width = 512;
    this.height = 160;
    ({ canvas: this.canvas, ctx: this.ctx } = surface(this.width, this.height));
    this.texture = sharpTexture(this.canvas);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.05), overlayMaterial({ map: this.texture }));
    this.mesh.renderOrder = OVERLAY_ORDER;
    this.mesh.position.set(0, 0.06, -0.02);
    this.mesh.rotation.x = -0.5;
    this.mesh.visible = false;
    this.text = '';
  }

  set(lines) {
    if (!fontsLoaded) return;
    const text = lines.join('\n');
    if (text === this.text) return;
    this.text = text;
    const { ctx } = this;
    const W = this.width, H = this.height;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);
    ctx.fillStyle = COLORS.text;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let i = 0; i < lines.length; i++) {
      // A line too long for the label is set smaller, to its width.
      type(ctx, 34, { weight: 500 });
      const w = ctx.measureText(lines[i]).width, room = W - 32;
      if (w > room) type(ctx, Math.floor(34 * room / w), { weight: 500 });
      ctx.fillText(lines[i], 16, 32 + 46 * i);
    }
    this.texture.needsUpdate = true;
  }
}

// Hand-held list: pages across the top, items below, one highlighted. Driven by a stick
// while a grip or trigger is held; the caller redraws through setPages / setHighlight.
export class ListPanel {
  constructor({ title, width = 640, height = 560, meters = 0.30 }) {
    this.title = title;
    this.width = width;
    this.height = height;
    ({ canvas: this.canvas, ctx: this.ctx } = surface(width, height));
    this.texture = sharpTexture(this.canvas);
    this.meters = meters;
    this.metersH = meters * height / width;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(this.meters, this.metersH), overlayMaterial({ map: this.texture }));
    this.mesh.renderOrder = OVERLAY_ORDER;
    this.mesh.visible = false;
    this.pages = [];
    this.page = 0;
    this.highlight = 0;
    this.footer = '';
    this.key = '';
  }

  // pages: [{ name, items: [string], footer? }]
  setPages(pages) { this.pages = pages; this.page = Math.min(this.page, Math.max(0, pages.length - 1)); }

  items() { return this.pages.length ? this.pages[this.page].items : []; }

  step(d) {
    const n = this.items().length;
    if (!n) return;
    this.highlight = ((this.highlight + d) % n + n) % n;
  }

  setPage(i) {
    if (!this.pages.length) return;
    this.page = ((i % this.pages.length) + this.pages.length) % this.pages.length;
    this.highlight = Math.min(this.highlight, Math.max(0, this.items().length - 1));
  }

  update() {
    if (!fontsLoaded) return;
    const items = this.items();
    const key = `${this.page}|${this.highlight}|${this.footer}|${this.pages.map((p) => p.name).join(',')}|${items.join('\n')}`;
    if (key === this.key) return;
    this.key = key;
    const { ctx } = this;
    const W = this.width, H = this.height;
    const BAR = 48;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    titleBar(ctx, W, BAR, { title: this.title, close: false });
    let y = BAR;
    if (this.pages.length > 1) {
      ctx.fillStyle = COLORS.strip;
      ctx.fillRect(0, y, W, 44);
      const tw = (W - 4) / this.pages.length;
      for (let i = 0; i < this.pages.length; i++) {
        const x = 2 + i * tw, on = i === this.page;
        if (on) {
          ctx.fillStyle = COLORS.bg;
          ctx.fillRect(x, y, tw, 44);
          ctx.fillStyle = COLORS.accent;
          ctx.fillRect(x + 10, y + 40, tw - 20, 4);
        }
        type(ctx, 15, { mono: true, track: 0.12 });
        ctx.fillStyle = on ? COLORS.text : COLORS.dim;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.pages[i].name.toUpperCase(), x + tw / 2 + 1, y + 22);
      }
      y += 44;
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const rowH = 40;
    const rows = Math.floor((H - y - 50) / rowH);
    // Keep the highlight in view.
    let first = 0;
    if (items.length > rows) first = Math.max(0, Math.min(this.highlight - Math.floor(rows / 2), items.length - rows));
    for (let i = first; i < Math.min(items.length, first + rows); i++) {
      const ry = y + 6 + (i - first) * rowH;
      const on = i === this.highlight;
      if (on) { ctx.fillStyle = COLORS.accent; roundRect(ctx, PAD - 6, ry, W - 2 * PAD + 12, rowH - 4, 8); }
      type(ctx, 23, { weight: on ? 500 : 400 });
      ctx.fillStyle = on ? COLORS.ink : COLORS.text;
      ctx.fillText(items[i], PAD + 4, ry + rowH / 2 - 2);
    }
    if (!items.length) { type(ctx, 23); ctx.fillStyle = COLORS.dim; ctx.fillText('(empty)', PAD + 4, y + 26); }
    type(ctx, 16, { mono: true });
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(this.footer, PAD, H - 26);
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);
    this.texture.needsUpdate = true;
  }
}

function roundPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function roundRect(ctx, x, y, w, h, r) {
  roundPath(ctx, x, y, w, h, r);
  ctx.fill();
}

// Opt-in readout pinned to the top right of the view (child of the camera). Desktop gets a DOM copy.
export class Hud {
  constructor() {
    this.width = 768;
    this.height = 320;
    ({ canvas: this.canvas, ctx: this.ctx } = surface(this.width, this.height));
    this.texture = sharpTexture(this.canvas);
    const mat = overlayMaterial({ map: this.texture });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.15), mat);
    this.mesh.renderOrder = OVERLAY_ORDER;
    this.mesh.position.set(0.34, 0.24, -1.0);
    this.mesh.rotation.set(-0.15, -0.25, 0);
    this.mesh.visible = false;
    this.dom = document.createElement('div');
    this.dom.id = 'hud';
    document.body.appendChild(this.dom);
    this.lines = [];
    this.last = 0;
  }

  set(lines, now) {
    if (now - this.last < 500) return;
    this.last = now;
    if (lines.join('\n') === this.lines.join('\n')) return;
    this.lines = lines;
    this.dom.textContent = lines.join('\n');
    if (!fontsLoaded) { this.lines = []; return; } // drawn once the faces are in
    const { ctx } = this;
    ctx.fillStyle = COLORS.title;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.fillStyle = COLORS.dim;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    type(ctx, 25, { mono: true });
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], 16, 28 + 36 * i);
    this.texture.needsUpdate = true;
  }
}

// What each control does, by row of the controller map: the text, and whether it is the lead line.
const CONTROLS = {
  left: (heli) => ({
    stick: heli
      ? [['stick: up / down climb, left / right turn', 1], ['2D: up / down zoom, left / right rotate']]
      : [['stick: fly forward / back, strafe', 1], ['2D: pan the picture; tunnel: forward is zoom']],
    stickMore: [['click: hold and twist the hand to turn the colours; tap: spin on / off']],
    top: [['Y: menu on / off', 1]],
    bottom: [['X: reset view (3D), recenter (2D)', 1]],
    trigger: [['trigger: use the tool (teleport, camera, gps, balls)', 1], ['hold: aim; the sticks feed the tool']],
    grip: 'grip: hold the fractal, turn and move it by hand',
    letters: ['Y', 'X'],
  }),
  right: (heli) => ({
    stick: heli
      ? [['stick: forward / back, strafe', 1], ['2D: pan the picture']]
      : [['stick: left / right turn, up / down zoom', 1], ['2D: left / right rotate, up / down zoom']],
    stickMore: [['click and hold: boost']],
    top: [['B: zoom out', 1]],
    bottom: [['A: zoom in', 1], ['both: cruise, then they set its speed']],
    trigger: [['trigger: hold for the quick menu of tools, marks, fractals, palettes and actions', 1], ['the stick picks; let go to choose']],
    grip: 'grip: sculpt, the hand moving changes the fractal\'s shape',
    letters: ['B', 'A'],
  }),
};
const FOOTER = [
  'While any trigger or grip is held you stay put, and the sticks go to that tool.',
  'A window: triggers click it, grips drag it, and it reopens where you leave it.',
  'The left menu button belongs to the headset.',
];

// Static controller map, shown beside the menu.
export class ControlsPanel {
  constructor() {
    this.title = 'controls';
    this.width = 1024;
    this.height = 1240;
    ({ canvas: this.canvas, ctx: this.ctx } = surface(this.width, this.height));
    this.texture = sharpTexture(this.canvas);
    const mat = overlayMaterial({ map: this.texture });
    this.meters = 0.62;
    this.metersH = this.meters * this.height / this.width;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(this.meters, this.metersH), mat);
    this.mesh.renderOrder = OVERLAY_ORDER;
    this.mesh.visible = false;
    this.captures = new Map();
    this.onClose = null;
    this.layout = '';
    this.draw('standard');
  }

  // Pointer interface: only the close box and grab-to-drag matter here.
  uvToPx(uv) { return [uv.x * this.width, (1 - uv.y) * this.height]; }
  showCursor() {}
  hideCursor() {}
  pointerMove() {}
  pointerUp() {}
  pointerLeave() {}
  pointerDown(id, x, y) {
    this.took = y < TITLE_H;
    this.lastPressed = y >= TITLE_H ? 'nothing' : x > this.width - TITLE_H ? 'close' : 'title';
    if (y >= TITLE_H) return null;
    if (x > this.width - TITLE_H) { if (this.onClose) this.onClose(); return 'close'; }
    return 'title';
  }

  draw(layout) {
    if (!fontsLoaded || layout === this.layout) return;
    this.layout = layout;
    const heli = layout === 'heli';
    const { ctx } = this;
    const W = this.width, H = this.height;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    titleBar(ctx, W, TITLE_H, { title: 'Controls', note: heli ? 'HELI MODE 2' : 'STANDARD' });
    ctx.textBaseline = 'middle';

    const LX = 300, LW = W - LX - PAD, LINE = 30;
    const face = (lead) => type(ctx, lead ? 23 : 21, { weight: lead ? 500 : 400 });
    const tie = (x1, y1, x2, y2) => {
      ctx.strokeStyle = COLORS.dim;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.globalAlpha = 1;
    };
    // A row of text in the label column, tied to (fx, fy) on the controller: its first line at
    // `at`, or below what came before. Returns where the row ends.
    const row = (fx, fy, at, after, items) => {
      const lines = items.flatMap(([t, lead]) => { face(lead); return wrap(ctx, t, LW).map((l) => [l, lead]); });
      const y0 = Math.max(at, after + 10 + LINE / 2);
      if (fx !== null) tie(fx, fy, LX - 12, y0);
      ctx.textAlign = 'left';
      lines.forEach(([l, lead], i) => { face(lead); ctx.fillStyle = lead ? COLORS.text : COLORS.dim; ctx.fillText(l, LX, y0 + i * LINE); });
      return y0 + (lines.length - 1) * LINE + LINE / 2;
    };

    // One controller per block: the diagram on the left, what each part does to its right.
    const controller = (top, side) => {
      const c = CONTROLS[side](heli);
      const cx = 150;
      type(ctx, 16, { mono: true, track: 0.2 });
      ctx.fillStyle = COLORS.dim;
      ctx.textAlign = 'center';
      ctx.fillText(side.toUpperCase(), cx + 2, top + 18);
      ctx.fillStyle = COLORS.raised;
      roundPath(ctx, cx - 70, top + 44, 140, 340, 60);
      ctx.fill();
      ctx.strokeStyle = COLORS.border;
      ctx.lineWidth = 2;
      ctx.stroke();

      const sy = top + 120;
      ctx.fillStyle = COLORS.track;
      ctx.beginPath(); ctx.arc(cx, sy, 42, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COLORS.text;
      ctx.beginPath(); ctx.arc(cx, sy, 24, 0, Math.PI * 2); ctx.fill();
      let end = row(cx + 42, sy, sy, -Infinity, [...c.stick, ...c.stickMore]);

      const bx = cx + 30, by = top + 236;
      for (let i = 0; i < 2; i++) {
        ctx.fillStyle = COLORS.track;
        ctx.beginPath(); ctx.arc(bx, by + i * 56, 21, 0, Math.PI * 2); ctx.fill();
        type(ctx, 19, { mono: true });
        ctx.fillStyle = COLORS.text;
        ctx.textAlign = 'center';
        ctx.fillText(c.letters[i], bx + 0.5, by + i * 56 + 1);
      }
      end = row(bx + 21, by, by, end, c.top);
      end = row(bx + 21, by + 56, by + 56, end, c.bottom);

      const ty = top + 352;
      ctx.fillStyle = COLORS.track;
      roundRect(ctx, cx - 46, ty - 14, 92, 28, 12);
      end = row(cx + 46, ty, ty, end, c.trigger);

      // The grip, on the controller's side: its words under the controller.
      const gx = cx - 92, gy = top + 250;
      ctx.fillStyle = COLORS.track;
      roundRect(ctx, gx - 13, gy - 48, 26, 96, 12);
      tie(gx, gy + 48, gx, top + 400);
      face(false);
      const grip = wrap(ctx, c.grip, LX - 2 * PAD - 12);
      ctx.fillStyle = COLORS.dim;
      ctx.textAlign = 'left';
      grip.forEach((l, i) => ctx.fillText(l, PAD + 4, top + 418 + i * 28));
      return Math.max(end, top + 418 + (grip.length - 1) * 28 + 14);
    };
    let y = controller(TITLE_H + 24, 'left');
    y = controller(y + 36, 'right');

    ctx.fillStyle = COLORS.border;
    ctx.fillRect(PAD, y + 24, W - 2 * PAD, 1);
    type(ctx, 20);
    ctx.fillStyle = COLORS.dim;
    ctx.textAlign = 'center';
    y += 56;
    for (const t of FOOTER) for (const l of wrap(ctx, t, W - 2 * PAD)) { ctx.fillText(l, W / 2, y); y += 28; }
    if (y > H) console.error(`controls map overflows by ${Math.round(y - H)}px`);
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);
    ctx.textAlign = 'left';
    this.texture.needsUpdate = true;
  }
}
