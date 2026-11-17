import * as THREE from 'three';

// Canvas-drawn window rendered onto a plane. Widgets are plain objects; the panel owns
// layout, hit testing and drawing. Pointer coordinates arrive in canvas pixels.

const FONT = '"Menlo", "DejaVu Sans Mono", ui-monospace, monospace';
const COLORS = {
  bg: '#14161c', title: '#2b3140', titleText: '#e6e8ef', text: '#d5d8e0', dim: '#8a90a0',
  track: '#2a2e3a', fill: '#4f7cff', knob: '#e6e8ef', button: '#2a2e3a', buttonHot: '#3a4052',
  on: '#3ddc84', off: '#5a6070', tab: '#1c1f27', tabActive: '#2b3140', border: '#3a4052',
};
const TITLE_H = 56;
const TAB_H = 64;
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

const inert = (w) => w.type === 'label' || w.type === 'text';
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
  constructor({ title, width = 800, height = 1100, meters = 0.6, upload }) {
    this.title = title;
    this.upload = upload;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    // No flip: canvas row 0 is texture row 0, and the plane's UVs are flipped instead so
    // partial uploads can use canvas coordinates directly.
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = false;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
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
  }

  // Cut the window's mesh down to the rows of one widget, or back to the whole (null).
  show(w) {
    if (w === this.shown) return;
    this.shown = w;
    const W = this.canvas.width, H = this.canvas.height;
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
    if (this.contentH > this.canvas.height) console.error(`panel tab ${this.tabs[this.tab]?.name} overflows by ${this.contentH - this.canvas.height}px`);
    this.fullDirty = true;
  }

  // Redraw only widgets whose displayed value differs from what was last drawn.
  markAll() {
    for (const w of this.widgets) if (displayKey(w) !== w.drawn) this.markDirty(w);
  }

  layout() {
    const W = this.canvas.width;
    const tw = W / Math.max(1, this.tabs.length);
    for (const t of this.tabHits) {
      const x = Math.round(t.index * tw);
      Object.assign(t, { x, y: TITLE_H, w: Math.round((t.index + 1) * tw) - x - 2, h: TAB_H });
    }
    let y = TITLE_H + TAB_H + PAD;
    for (const w of this.widgets) {
      w.x = PAD;
      w.y = y;
      w.w = W - 2 * PAD;
      if (w.type === 'label') w.h = 40;
      else if (w.type === 'button') w.h = 52;
      else if (w.type === 'toggle') w.h = 52;
      else if (w.type === 'slider') w.h = 78;
      else if (w.type === 'select') {
        w.pills = [];
        let px = w.x, py = w.y + 38;
        const ctx = this.ctx;
        ctx.font = `26px ${FONT}`;
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
    return [uv.x * this.canvas.width, uv.y * this.canvas.height];
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
    this.lastPressed = !w ? 'nothing' : w.type === 'title' ? (x > this.canvas.width - TITLE_H ? 'close' : 'title') : w.type === 'tab' ? `tab ${this.tabs[w.index].name}` : `${w.type} ${w.text ?? ''}`.trim();
    if (!w) return null;
    if (w.type === 'title') {
      if (x > this.canvas.width - TITLE_H) { if (this.onClose) this.onClose(); return 'close'; }
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
    if (!this.mesh.visible) return;
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
      this._box.min.set(w.x, w.y);
      this._box.max.set(w.x + w.w, Math.min(this.canvas.height, w.y + w.h));
      this._pos.set(w.x, w.y);
      this.upload(this.srcTexture, this.texture, this._box, this._pos);
    }
    this.dirtyRects.length = 0;
  }

  clearWidget(w) {
    this.ctx.fillStyle = COLORS.bg;
    this.ctx.fillRect(w.x, w.y, w.w, w.h);
  }

  draw() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, W - 3, H - 3);

    // title bar
    ctx.fillStyle = COLORS.title;
    ctx.fillRect(0, 0, W, TITLE_H);
    ctx.fillStyle = COLORS.titleText;
    ctx.font = `bold 28px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(this.title, PAD, TITLE_H / 2);
    ctx.fillText('×', W - TITLE_H / 2 - 8, TITLE_H / 2);

    // tabs
    for (const t of this.tabHits) this.drawWidget(t);
    for (const w of this.widgets) this.drawWidget(w);
  }

  drawWidget(w) {
    const ctx = this.ctx;
    const hot = this.isHot(w);
    w.drawn = displayKey(w);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    if (w.type === 'tab') {
      const on = w.index === this.tab;
      ctx.fillStyle = on ? COLORS.tabActive : hot ? COLORS.buttonHot : COLORS.tab;
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.fillStyle = on || hot ? COLORS.titleText : COLORS.dim;
      ctx.font = `bold 24px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(this.tabs[w.index].name, w.x + w.w / 2 + 1, w.y + w.h / 2);
    } else if (w.type === 'label') {
      ctx.fillStyle = COLORS.dim;
      ctx.font = `bold 24px ${FONT}`;
      ctx.fillText(w.text.toUpperCase(), w.x, w.y + w.h / 2);
    } else if (w.type === 'button') {
      ctx.fillStyle = w.pressedAt ? COLORS.fill : hot ? COLORS.buttonHot : COLORS.button;
      roundRect(ctx, w.x, w.y, w.w, w.h, 8);
      ctx.fillStyle = COLORS.text;
      ctx.font = `26px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(w.text, w.x + w.w / 2, w.y + w.h / 2);
      ctx.textAlign = 'left';
    } else if (w.type === 'toggle') {
      ctx.fillStyle = hot ? COLORS.buttonHot : COLORS.button;
      roundRect(ctx, w.x, w.y, w.w, w.h, 8);
      ctx.fillStyle = COLORS.text;
      ctx.font = `26px ${FONT}`;
      ctx.fillText(w.text, w.x + 16, w.y + w.h / 2);
      const on = w.get();
      ctx.fillStyle = on ? COLORS.on : COLORS.off;
      roundRect(ctx, w.x + w.w - 96, w.y + 10, 80, 32, 16);
      ctx.fillStyle = COLORS.knob;
      ctx.beginPath();
      ctx.arc(w.x + w.w - 96 + (on ? 64 : 16), w.y + 26, 12, 0, Math.PI * 2);
      ctx.fill();
    } else if (w.type === 'slider') {
      ctx.fillStyle = COLORS.text;
      ctx.font = `26px ${FONT}`;
      ctx.fillText(w.text, w.x, w.y + 20);
      ctx.fillStyle = hot ? COLORS.titleText : COLORS.dim;
      ctx.textAlign = 'right';
      ctx.fillText(w.fmt ? w.fmt(w.get()) : w.get().toFixed(3), w.x + w.w, w.y + 20);
      ctx.textAlign = 'left';
      const tx = w.x + 8, ty = w.y + 52, tw = w.w - 16;
      ctx.fillStyle = COLORS.track;
      roundRect(ctx, tx, ty - 6, tw, 12, 6);
      const f = Math.max(0, Math.min(1, sliderShare(w, w.get())));
      ctx.fillStyle = COLORS.fill;
      // About nought, the bar runs from the middle; else from the left.
      if (w.fine) { if (f !== 0.5) roundRect(ctx, tx + tw * Math.min(0.5, f), ty - 6, tw * Math.abs(f - 0.5), 12, 6); }
      else roundRect(ctx, tx, ty - 6, Math.max(12, tw * f), 12, 6);
      ctx.fillStyle = hot ? COLORS.titleText : COLORS.knob;
      ctx.beginPath();
      ctx.arc(tx + tw * f, ty, 16, 0, Math.PI * 2);
      ctx.fill();
    } else if (w.type === 'select') {
      ctx.fillStyle = COLORS.text;
      ctx.font = `26px ${FONT}`;
      ctx.fillText(w.text, w.x, w.y + 18);
      const cur = w.get();
      for (const p of w.pills) {
        ctx.fillStyle = p.i === cur ? COLORS.fill : COLORS.button;
        roundRect(ctx, p.x, p.y, p.w, p.h, 22);
        ctx.fillStyle = COLORS.text;
        ctx.textAlign = 'center';
        ctx.fillText(w.options[p.i], p.x + p.w / 2, p.y + p.h / 2);
        ctx.textAlign = 'left';
      }
    } else if (w.type === 'text') {
      ctx.fillStyle = COLORS.text;
      ctx.font = `24px ${FONT}`;
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
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 160;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.05), overlayMaterial({ map: this.texture }));
    this.mesh.renderOrder = OVERLAY_ORDER;
    this.mesh.position.set(0, 0.06, -0.02);
    this.mesh.rotation.x = -0.5;
    this.mesh.visible = false;
    this.text = '';
  }

  set(lines) {
    const text = lines.join('\n');
    if (text === this.text) return;
    this.text = text;
    const { ctx, canvas } = this;
    ctx.fillStyle = '#0a0c12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e6e8ef';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let i = 0; i < lines.length; i++) {
      // A line too long for the label is set smaller, to its width.
      ctx.font = `bold 34px ${FONT}`;
      const w = ctx.measureText(lines[i]).width, room = canvas.width - 32;
      if (w > room) ctx.font = `bold ${Math.floor(34 * room / w)}px ${FONT}`;
      ctx.fillText(lines[i], 16, 30 + 46 * i);
    }
    this.texture.needsUpdate = true;
  }
}

// Hand-held list: pages across the top, items below, one highlighted. Driven by a stick
// while a grip or trigger is held; the caller redraws through setPages / setHighlight.
export class ListPanel {
  constructor({ title, width = 640, height = 560, meters = 0.30 }) {
    this.title = title;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
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
    const items = this.items();
    const key = `${this.page}|${this.highlight}|${this.footer}|${this.pages.map((p) => p.name).join(',')}|${items.join('\n')}`;
    if (key === this.key) return;
    this.key = key;
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
    ctx.fillStyle = COLORS.title;
    ctx.fillRect(0, 0, W, 44);
    ctx.fillStyle = COLORS.titleText;
    ctx.font = `bold 26px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(this.title, PAD, 22);
    let y = 44;
    if (this.pages.length > 1) {
      const tw = W / this.pages.length;
      for (let i = 0; i < this.pages.length; i++) {
        ctx.fillStyle = i === this.page ? COLORS.tabActive : COLORS.tab;
        ctx.fillRect(i * tw, y, tw - 2, 40);
        ctx.fillStyle = i === this.page ? COLORS.titleText : COLORS.dim;
        ctx.font = `bold 22px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(this.pages[i].name, i * tw + tw / 2, y + 20);
      }
      y += 44;
    }
    ctx.textAlign = 'left';
    const rowH = 40;
    const rows = Math.floor((H - y - 50) / rowH);
    // Keep the highlight in view.
    let first = 0;
    if (items.length > rows) first = Math.max(0, Math.min(this.highlight - Math.floor(rows / 2), items.length - rows));
    for (let i = first; i < Math.min(items.length, first + rows); i++) {
      const ry = y + 6 + (i - first) * rowH;
      if (i === this.highlight) { ctx.fillStyle = COLORS.fill; roundRect(ctx, PAD - 6, ry, W - 2 * PAD + 12, rowH - 4, 8); }
      ctx.fillStyle = i === this.highlight ? COLORS.titleText : COLORS.text;
      ctx.font = `24px ${FONT}`;
      ctx.fillText(items[i], PAD + 4, ry + rowH / 2 - 2);
    }
    if (!items.length) { ctx.fillStyle = COLORS.dim; ctx.font = `24px ${FONT}`; ctx.fillText('(empty)', PAD + 4, y + 26); }
    ctx.fillStyle = COLORS.dim;
    ctx.font = `22px ${FONT}`;
    ctx.fillText(this.footer, PAD, H - 26);
    this.texture.needsUpdate = true;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

// Opt-in readout pinned to the top right of the view (child of the camera). Desktop gets a DOM copy.
export class Hud {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 768;
    this.canvas.height = 320;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
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
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0a0c12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e6e8ef';
    ctx.textBaseline = 'middle';
    ctx.font = `28px ${FONT}`;
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], 16, 28 + 36 * i);
    this.texture.needsUpdate = true;
  }
}

// Static controller map, shown beside the menu.
export class ControlsPanel {
  constructor() {
    this.title = 'controls';
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024;
    this.canvas.height = 1000;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const mat = overlayMaterial({ map: this.texture });
    this.meters = 0.62;
    this.metersH = this.meters * this.canvas.height / this.canvas.width;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(this.meters, this.metersH), mat);
    this.mesh.renderOrder = OVERLAY_ORDER;
    this.mesh.visible = false;
    this.captures = new Map();
    this.onClose = null;
    this.layout = '';
    this.draw('standard');
  }

  // Pointer interface: only the close box and grab-to-drag matter here.
  uvToPx(uv) { return [uv.x * this.canvas.width, (1 - uv.y) * this.canvas.height]; }
  showCursor() {}
  hideCursor() {}
  pointerMove() {}
  pointerUp() {}
  pointerLeave() {}
  pointerDown(id, x, y) {
    this.took = y < TITLE_H;
    this.lastPressed = y >= TITLE_H ? 'nothing' : x > this.canvas.width - TITLE_H ? 'close' : 'title';
    if (y >= TITLE_H) return null;
    if (x > this.canvas.width - TITLE_H) { if (this.onClose) this.onClose(); return 'close'; }
    return 'title';
  }

  draw(layout) {
    if (layout === this.layout) return;
    this.layout = layout;
    const heli = layout === 'heli';
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
    ctx.fillStyle = COLORS.title;
    ctx.fillRect(0, 0, W, TITLE_H);
    ctx.fillStyle = COLORS.titleText;
    ctx.font = `bold 30px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(`controls (${heli ? 'heli mode 2' : 'standard'})`, PAD, TITLE_H / 2);
    ctx.fillText('×', W - TITLE_H / 2 - 8, TITLE_H / 2);

    const label = (x, y, text, bold) => {
      ctx.fillStyle = bold ? COLORS.titleText : COLORS.text;
      ctx.font = `${bold ? 'bold ' : ''}25px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(text, x, y);
    };
    const tie = (x1, y1, x2, y2) => {
      ctx.strokeStyle = COLORS.dim;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    };

    // One controller per row: diagram on the left, labels to the right.
    const drawController = (top, side) => {
      const left = side === 'left';
      const cx = 150;
      const lx = 300;
      ctx.fillStyle = COLORS.titleText;
      ctx.font = `bold 28px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(left ? 'LEFT' : 'RIGHT', cx, top + 24);
      ctx.fillStyle = COLORS.tab;
      roundRect(ctx, cx - 70, top + 50, 140, 340, 60);

      const sy = top + 130;
      ctx.fillStyle = COLORS.track;
      ctx.beginPath(); ctx.arc(cx, sy, 44, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COLORS.knob;
      ctx.beginPath(); ctx.arc(cx, sy, 26, 0, Math.PI * 2); ctx.fill();
      tie(cx + 44, sy, lx - 12, sy);
      if (left) {
        if (heli) {
          label(lx, sy - 32, 'stick: up/down climb, left/right turn', true);
          label(lx, sy, '2D: up/down zoom, left/right rotate');
        } else {
          label(lx, sy - 32, 'stick: fly forward/back, strafe', true);
          label(lx, sy, '2D: pan the picture; tunnel: forward = zoom');
        }
        label(lx, sy + 32, 'click: hold and twist the hand to turn the colours, tap: spin on / off');
      } else {
        if (heli) {
          label(lx, sy - 32, 'stick: forward/back, strafe', true);
          label(lx, sy, '2D: pan the picture');
        } else {
          label(lx, sy - 32, 'stick: left/right turn, up/down zoom', true);
          label(lx, sy, '2D: left/right rotate, up/down zoom');
        }
        label(lx, sy + 32, 'click and hold: boost');
      }

      const by = top + 225;
      const bx = cx + 30;
      for (let i = 0; i < 2; i++) {
        ctx.fillStyle = COLORS.button;
        ctx.beginPath(); ctx.arc(bx, by + i * 56, 22, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = COLORS.titleText;
        ctx.font = `bold 22px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(left ? (i ? 'X' : 'Y') : (i ? 'A' : 'B'), bx, by + i * 56 + 1);
      }
      tie(bx + 22, by, lx - 12, by);
      tie(bx + 22, by + 56, lx - 12, by + 56);
      if (left) {
        label(lx, by, 'Y: menu on / off', true);
        label(lx, by + 56, 'X: reset view (3D) / recenter (2D)', true);
      } else {
        label(lx, by, 'B: zoom out', true);
        label(lx, by + 56, 'A: zoom in', true);
        label(lx, by + 28, 'both: cruise, then they set its speed');
      }

      const ty = top + 350;
      ctx.fillStyle = COLORS.button;
      roundRect(ctx, cx - 50, ty - 16, 100, 32, 12);
      tie(cx + 50, ty, lx - 12, ty);
      if (left) { label(lx, ty - 16, 'trigger: use the tool (teleport, camera, gps, balls)', true); label(lx, ty + 16, 'hold: aim; the sticks feed the tool'); }
      else { label(lx, ty - 16, 'trigger: hold for the quick menu: tools, marks,', true); label(lx, ty + 16, 'fractals, palettes, actions; stick picks, release chooses'); }

      const gy = top + 250;
      const gx = cx - 95;
      ctx.fillStyle = COLORS.button;
      roundRect(ctx, gx - 14, gy - 50, 28, 100, 12);
      tie(gx, gy + 50, gx, gy + 100);
      ctx.textAlign = 'center';
      ctx.fillStyle = COLORS.text;
      ctx.font = `22px ${FONT}`;
      if (left) {
        ctx.fillText('grip: hold the', gx + 20, gy + 120);
        ctx.fillText('fractal: turn and', gx + 20, gy + 146);
        ctx.fillText('move it by hand', gx + 20, gy + 172);
      } else {
        ctx.fillText('grip: sculpt: move', gx + 20, gy + 120);
        ctx.fillText('the hand to change', gx + 20, gy + 146);
        ctx.fillText('the fractal\'s shape', gx + 20, gy + 172);
      }
    };
    drawController(TITLE_H + 30, 'left');
    drawController(TITLE_H + 470, 'right');

    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.dim;
    ctx.font = `24px ${FONT}`;
    ctx.fillText('while any trigger or grip is held you stay put and the sticks go to that tool', W / 2, H - 100);
    ctx.fillText('a window: triggers click it, grips drag it, and it reopens there', W / 2, H - 66);
    ctx.fillText('the left menu button belongs to the headset', W / 2, H - 32);
    ctx.textAlign = 'left';
    this.texture.needsUpdate = true;
  }
}
