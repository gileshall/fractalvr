import * as THREE from 'three';
import { ddAddD, ddSub, ddToNum } from './dd.js';
import { planeVertex, planeFragment, statsFragment, probeStatsFragment, MAX_LEVELS, PROBE_P, PROBE_ROWS } from './shaders2d.js';
import { Readback } from './readback.js';
import {
  octaveBase, layerOctave, refineTo, fillCost, refineCost, shiftPlan, spans, advance, capFor,
  TEXEL_COST, UNKNOWN_INTERIOR, PROBE_EDGES, EPS_MOVE, EPS_STILL,
} from './planeplan.js';

// Plane-space pyramid of iteration counts for the 2D fractals. Level k is a T x T toroidal
// window of texels TEXEL0 * 2^k complex units wide, centred on where the head looks. The
// twelve octaves from the view's scale up are held: zooming in by a doubling brings one new
// level into use and leaves the rest as they are. A window follows the gaze in blocks of
// columns or rows; holding still re-runs the texels that did not escape with a higher cap.
//
// All of it is paced by a budget of iterations a frame: what a texel costs is taken from
// what the levels are measured to hold (statsFragment), not from the cap.
//
// The caps themselves come from probes: a sparse grid of points over each level's window,
// run to the ceiling, tells what cap leaves how many of them short of their escape.

export const PLANE_T = 1024;
export const PLANE_LEVELS = MAX_LEVELS;
export const PLANE_EMIN = 0.5;
export const JULIA_RES = 512;
export const JULIA_EXTENT = 2.2;
const TEXEL0 = PLANE_EMIN / PLANE_T; // complex units per texel of octave 0
const REBASE_LIMIT = 1 << 16;
const MEASURE_EVERY = 12; // frames between measurements, at least
const JULIA_SHARE = 0.5; // of a frame's budget the Julia sky may take
const JULIA_ITER = 0.5; // a plain iteration against a perturbed one
const RESTART_GAP = 24; // frames
const PROBE_SHARE = 0.25; // of a frame's budget the probes take ahead of the levels
const NEAR_LEVELS = 6; // levels, from the finest in use, a moving view's cap is taken from

export class PlaneCache {
  constructor(renderer) {
    this.renderer = renderer;
    this.T = PLANE_T;
    this.NL = PLANE_LEVELS;
    const opts = {
      format: THREE.RedFormat, type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      generateMipmaps: false, depthBuffer: false, stencilBuffer: false,
    };
    // Two arrays so a level can be refined from its own contents: a level lives in its layer
    // of arrays[lv.arr]; a refine writes the other array and swaps.
    this.arrays = [new THREE.WebGLArrayRenderTarget(this.T, this.T, this.NL, opts), new THREE.WebGLArrayRenderTarget(this.T, this.T, this.NL, opts)];
    this.julia = [new THREE.WebGLRenderTarget(JULIA_RES, JULIA_RES, opts), new THREE.WebGLRenderTarget(JULIA_RES, JULIA_RES, opts)];
    this.probes = new THREE.WebGLRenderTarget(this.NL * PROBE_P, PROBE_P, opts);
    // The sky before its first build: inside the set, which shades black.
    const colour = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha(), target = renderer.getRenderTarget();
    renderer.setClearColor(new THREE.Color().setRGB(-1, 0, 0), 1);
    for (const rt of this.julia) { renderer.setRenderTarget(rt); renderer.clear(true, false, false); }
    renderer.setClearColor(colour, alpha);
    renderer.setRenderTarget(target);
    this.levels = [];
    for (let j = 0; j < this.NL; j++) this.levels.push({ j });
    this.uniforms = {
      uT: { value: this.T }, uWin: { value: new THREE.Vector2() }, uOrigOff: { value: new THREE.Vector2() }, uTexel: { value: 1 },
      uOld: { value: this.arrays[1].texture }, uOldLayer: { value: 0 }, uRefine: { value: 0 },
      uFormula: { value: 0 }, uStep: { value: 0 }, uCenterF: { value: new THREE.Vector2() }, uJuliaC: { value: new THREE.Vector2() },
      uMaxIter: { value: 100 }, uRef: { value: null }, uRefLen: { value: 0 },
    };
    this.statUniforms = {
      uLevels0: { value: this.arrays[0].texture }, uLevels1: { value: this.arrays[1].texture }, uJulia: { value: null },
      uT: { value: this.T }, uJuliaRes: { value: JULIA_RES },
      uArr: { value: new Int32Array(this.NL) }, uRect: { value: new Int32Array(4 * this.NL) }, uNext: { value: new Float32Array(this.NL) },
      uJit: { value: new THREE.Vector2() },
    };
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const scene = (fragmentShader, uniforms) => {
      const mesh = new THREE.Mesh(geom, new THREE.ShaderMaterial({ vertexShader: planeVertex, fragmentShader, uniforms, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false }));
      mesh.frustumCulled = false;
      return new THREE.Scene().add(mesh);
    };
    this.scene = scene(planeFragment, this.uniforms);
    this.statScene = scene(statsFragment, this.statUniforms);
    this.probeScene = scene(probeStatsFragment, { uProbe: { value: this.probes.texture } });
    this.cam = new THREE.Camera();
    this.reader = new Readback(renderer, this.NL + 1, 2);
    this.probeReader = new Readback(renderer, this.NL, PROBE_ROWS);
    this.frame = 0;
    this.asked = -1e9;
    this.of = '';
    this.formula = -1;
    this.heldC = [0, 0];
    this.began = -1e9;
    this.centre = null;
    this.stats = { texels: 0, units: 0, budget: 0, valid: 0, filling: 0, refining: 0, idle: 0 };
    // Caps the levels in use are measured to need, 0 where no probe says; how many say.
    this.need = { move: PROBE_EDGES[0], still: 0, probed: 0 };
    this.reset();
  }

  reset() {
    this.base = null;
    this.fine = 0;
    for (const lv of this.levels) this.clear(lv, null);
    this.jul = { cur: 0, key: '', build: null, stats: null };
    this.dirty = false;
    this.blind = true;
    this.need.move = PROBE_EDGES[0]; this.need.still = 0; this.need.probed = 0;
  }

  // An empty level for octave k.
  clear(lv, k) {
    lv.k = k;
    lv.texel = k === null ? 0 : TEXEL0 * Math.pow(2, k);
    lv.arr = 0;
    lv.origin = null;
    lv.x = 0; lv.y = 0; lv.w = 0; lv.h = 0; // grid indices held
    lv.cap = 0; // every texel held has run at least this far
    lv.next = 0; // the cap its refine goes to, 0 for none
    lv.fill = null;
    lv.refine = null;
    lv.stats = null;
    lv.probe = null; // { gaze, cap, tails, inside }: the last probe read
    lv.probing = null; // the one being made in the level's tile
  }

  level(k) { return this.levels[((k % this.NL) + this.NL) % this.NL]; }

  // Iteration uniforms shared by every render this frame.
  setIteration({ formula, step, centerF, juliaC, ref, refLen }) {
    const u = this.uniforms;
    // A Julia set's levels are of one c: when it changes they start again, with a third of a
    // second between starts so one dragged along still shows.
    const of = formula === 2 ? `2,${juliaC[0]},${juliaC[1]}` : `${formula}`;
    if (of !== this.of && (formula !== this.formula || this.frame - this.began >= RESTART_GAP)) {
      this.of = of;
      this.formula = formula;
      this.heldC = [juliaC[0], juliaC[1]];
      this.reset();
      this.began = this.frame;
    }
    const c = formula === 2 ? this.heldC : juliaC;
    u.uFormula.value = formula;
    u.uStep.value = step;
    u.uCenterF.value.set(centerF[0], centerF[1]);
    u.uJuliaC.value.set(c[0], c[1]);
    u.uRef.value = ref;
    u.uRefLen.value = refLen;
  }

  renderRect(rt, layer, x, y, w, h) {
    rt.scissor.set(x, y, w, h);
    rt.scissorTest = true;
    this.renderer.setRenderTarget(rt, layer);
    this.renderer.render(this.scene, this.cam);
  }

  // readArr: the array not being written (a texture bound to the framebuffer may not be sampled).
  levelUniforms(lv, win, cap, refine, readArr) {
    const u = this.uniforms;
    u.uWin.value.set(win[0], win[1]);
    u.uOrigOff.value.set(ddToNum(ddSub(lv.origin[0], this.centre[0])), ddToNum(ddSub(lv.origin[1], this.centre[1])));
    u.uTexel.value = lv.texel;
    u.uMaxIter.value = cap;
    u.uRefine.value = refine ? 1 : 0;
    u.uOld.value = this.arrays[readArr].texture;
    u.uOldLayer.value = lv.j;
    u.uT.value = this.T;
  }

  // Where a level's window should start for the gaze to be at its middle.
  desired(lv, gaze) {
    const T = this.T;
    return [
      Math.round(ddToNum(ddSub(gaze[0], lv.origin[0])) / lv.texel) - (T >> 1),
      Math.round(ddToNum(ddSub(gaze[1], lv.origin[1])) / lv.texel) - (T >> 1),
    ];
  }

  // Keep grid indices small: move the origin by a multiple of T texels (contents unchanged).
  rebase(lv) {
    const T = this.T;
    for (let a = 0; a < 2; a++) {
      const at = a === 0 ? lv.x : lv.y;
      if (Math.abs(at) < REBASE_LIMIT) continue;
      const k = Math.floor(at / T) * T;
      lv.origin[a] = ddAddD(lv.origin[a], k * lv.texel);
      if (a === 0) lv.x -= k; else lv.y -= k;
    }
  }

  // The level's own measurement, else that of the nearest coarser level that has one.
  measured(lv) {
    if (lv.stats) return lv;
    for (let k = lv.k + 1; k < this.base + this.NL; k++) if (this.level(k).stats) return this.level(k);
    return null;
  }

  // What the level is missing: all of it, or the block its window is to move over. A window
  // gives up the far side at once and takes the near side when the block is done; a new one
  // grows from its middle row, where the gaze is, both ways, and is not begun unless `sure`.
  planFill(lv, gaze, cap, sure) {
    const T = this.T;
    if (lv.w === 0 || lv.h === 0) {
      if (!sure) return;
      lv.origin = [this.centre[0], this.centre[1]];
      const [x, y] = this.desired(lv, gaze);
      lv.x = x; lv.y = y + (T >> 1); lv.w = T; lv.h = 0;
      lv.cap = cap;
      lv.refine = null;
      lv.stats = null;
      lv.fill = { x, y, w: T, h: T, cap, land: 'grow', up: { done: 0, col: 0 }, down: { done: 0, col: 0 } };
      return;
    }
    this.rebase(lv);
    const want = this.desired(lv, gaze);
    const move = shiftPlan(want[0] - lv.x, want[1] - lv.y, T);
    if (!move) return;
    if (move === 'far') { lv.w = 0; lv.h = 0; this.planFill(lv, gaze, cap, sure); return; }
    const n = Math.abs(move.c), fwd = move.c > 0;
    if (move.axis === 0) {
      if (fwd) lv.x += n;
      lv.w = T - n;
      lv.fill = { x: fwd ? lv.x + lv.w : lv.x - n, y: lv.y, w: n, h: T, done: 0, col: 0, cap, land: 'x' };
    } else {
      if (fwd) lv.y += n;
      lv.h = T - n;
      lv.fill = { x: lv.x, y: fwd ? lv.y + lv.h : lv.y - n, w: T, h: n, done: 0, col: 0, cap, land: 'y' };
    }
    lv.cap = Math.min(lv.cap, cap);
    if (lv.refine) lv.refine.low = Math.min(lv.refine.low, cap);
  }

  // The next n texels of a fill, as rects of grid indices.
  fillPieces(f, n) {
    const out = [];
    if (f.land !== 'grow') {
      for (const [bx, by, bw, bh] of advance(f, f.w, f.h, n)) out.push([f.x + bx, f.y + by, bw, bh]);
      return out;
    }
    const half = f.h >> 1;
    const nUp = f.up.done >= half ? 0 : f.down.done >= half ? n : n - (n >> 1);
    for (const [bx, by, bw, bh] of advance(f.up, f.w, half, nUp)) out.push([f.x + bx, f.y + half + by, bw, bh]);
    for (const [bx, by, bw, bh] of advance(f.down, f.w, half, n - nUp)) out.push([f.x + bx, f.y + half - by - bh, bw, bh]);
    return out;
  }

  // Continue a fill; returns the budget left.
  stepFill(lv, left) {
    const f = lv.fill, T = this.T;
    const from = this.measured(lv);
    const per = fillCost(from && from.stats, from === lv, f.cap);
    const n = Math.floor(left / per);
    if (n < 1) return left;
    const rects = [];
    let texels = 0;
    for (const [gx, gy, bw, bh] of this.fillPieces(f, n)) {
      texels += bw * bh;
      for (const [tx, w] of spans(gx, gx + bw, T)) for (const [ty, h] of spans(gy, gy + bh, T)) rects.push([tx, ty, w, h]);
    }
    this.levelUniforms(lv, [f.x, f.y], f.cap, false, 1 - lv.arr);
    for (const [x, y, w, h] of rects) this.renderRect(this.arrays[lv.arr], lv.j, x, y, w, h);
    // A refine under way has read or will read these texels by position: it gets them too.
    if (lv.refine) {
      this.levelUniforms(lv, [f.x, f.y], 0, true, lv.arr);
      for (const [x, y, w, h] of rects) this.renderRect(this.arrays[1 - lv.arr], lv.j, x, y, w, h);
    }
    if (f.land === 'grow') {
      lv.y = f.y + (f.h >> 1) - f.down.done;
      lv.h = f.down.done + f.up.done;
      if (lv.h >= f.h) lv.fill = null;
    } else if (f.done >= f.h) {
      if (f.land === 'x') { lv.x = Math.min(lv.x, f.x); lv.w = T; } else { lv.y = Math.min(lv.y, f.y); lv.h = T; }
      lv.fill = null;
    }
    this.stats.texels += texels;
    this.dirty = true;
    return left - texels * per;
  }

  // Continue a refine into the spare layer, by texture rows; returns the budget left.
  stepRefine(lv, left) {
    const r = lv.refine, T = this.T;
    const per = refineCost(lv.stats, r.cap);
    const n = Math.floor(left / per);
    if (n < 1) return left;
    this.levelUniforms(lv, [lv.x, lv.y], r.cap, true, lv.arr);
    let texels = 0;
    for (const [x, y, w, h] of advance(r, T, T, n)) {
      texels += w * h;
      this.renderRect(this.arrays[1 - lv.arr], lv.j, x, y, w, h);
    }
    if (r.done >= T) {
      lv.arr = 1 - lv.arr;
      lv.cap = Math.min(r.cap, r.low);
      lv.refine = null;
      // Measured before the refine: its interior is at most what it was, and has run this far.
      if (lv.stats) lv.stats = { ...lv.stats, D: 0, next: r.cap, C: lv.stats.I * r.cap };
    }
    this.stats.texels += texels;
    this.dirty = true;
    return left - texels * per;
  }

  // The Julia set of c (float), remade a few rows a frame in the spare target when c has
  // moved. Returns the budget spent.
  stepJulia({ c, cap }, allowed) {
    const J = this.jul;
    const key = `${c[0]},${c[1]},${cap},${this.uniforms.uStep.value}`;
    if (!J.build && key !== J.key) J.build = { key, c: [c[0], c[1]], cap, rows: 0 };
    const b = J.build;
    if (!b) return 0;
    const s = J.stats;
    const per = JULIA_ITER * (s ? s.W + s.I * b.cap : UNKNOWN_INTERIOR * b.cap) + TEXEL_COST;
    const rows = Math.min(JULIA_RES - b.rows, Math.max(1, Math.floor(allowed / (per * JULIA_RES))));
    const u = this.uniforms;
    const saved = [u.uFormula.value, u.uCenterF.value.clone(), u.uJuliaC.value.clone()];
    u.uFormula.value = 2;
    u.uCenterF.value.set(0, 0);
    u.uJuliaC.value.set(b.c[0], b.c[1]);
    const texel = 2 * JULIA_EXTENT / JULIA_RES;
    u.uWin.value.set(0, 0);
    u.uOrigOff.value.set(-JULIA_EXTENT + texel / 2, -JULIA_EXTENT + texel / 2);
    u.uTexel.value = texel;
    u.uMaxIter.value = b.cap;
    u.uRefine.value = 0;
    u.uOld.value = this.arrays[0].texture;
    u.uT.value = JULIA_RES;
    this.renderRect(this.julia[1 - J.cur], 0, 0, b.rows, JULIA_RES, rows);
    u.uFormula.value = saved[0];
    u.uCenterF.value.copy(saved[1]);
    u.uJuliaC.value.copy(saved[2]);
    u.uT.value = this.T;
    b.rows += rows;
    if (b.rows >= JULIA_RES) { J.cur = 1 - J.cur; J.key = b.key; J.build = null; }
    this.stats.texels += rows * JULIA_RES;
    this.dirty = true;
    return rows * JULIA_RES * per;
  }

  // Whether a level's probe is of another place than the gaze: by `share` of its window or more.
  probeOff(p, lv, gaze, share) {
    const far = share * this.T * lv.texel;
    return Math.abs(ddToNum(ddSub(gaze[0], p.gaze[0]))) >= far || Math.abs(ddToNum(ddSub(gaze[1], p.gaze[1]))) >= far;
  }

  // Make the probes the levels lack or have left behind, the finest first; returns the budget spent.
  stepProbes(levels, gaze, ceiling, allowed) {
    const T = this.T, P = PROBE_P, s = T / P;
    let left = allowed;
    for (const lv of levels) {
      if (left <= 0) break;
      let b = lv.probing;
      if (b && b.cap < ceiling && !b.whole) b = lv.probing = null;
      if (!b) {
        const p = lv.probe;
        if (p && p.cap >= ceiling && !this.probeOff(p, lv, gaze, 0.25)) continue;
        b = lv.probing = { gaze: [gaze[0], gaze[1]], cap: ceiling, done: 0, col: 0, whole: false };
      }
      if (b.whole) continue;
      const from = this.measured(lv);
      const per = fillCost(from && from.stats, from === lv, b.cap);
      const n = Math.floor(left / per);
      if (n < 1) break;
      const u = this.uniforms;
      u.uT.value = P;
      u.uWin.value.set(lv.j * P, 0);
      u.uTexel.value = s * lv.texel;
      // Point (a, b) of the tile is (a + 1/2, b + 1/2) * s texels from the corner of a window about the gaze.
      const corner = (0.5 * s - 0.5 * T) * lv.texel;
      u.uOrigOff.value.set(
        ddToNum(ddSub(b.gaze[0], this.centre[0])) + corner - lv.j * P * s * lv.texel,
        ddToNum(ddSub(b.gaze[1], this.centre[1])) + corner,
      );
      u.uMaxIter.value = b.cap;
      u.uRefine.value = 0;
      u.uOld.value = this.arrays[0].texture;
      let points = 0;
      for (const [x, y, w, h] of advance(b, P, P, n)) {
        points += w * h;
        this.renderRect(this.probes, 0, lv.j * P + x, y, w, h);
      }
      u.uT.value = T;
      if (b.done >= P) b.whole = true;
      left -= points * per;
    }
    return allowed - left;
  }

  // The caps the levels' probes ask for, the most of them: a still view's of every level in
  // use, a moving one's of the nearest few. A probe of somewhere else has no say.
  updateNeed(levels, gaze, ceiling) {
    const n = PROBE_P * PROBE_P, need = this.need;
    need.move = PROBE_EDGES[0]; need.still = 0; need.probed = 0;
    levels.forEach((lv, i) => {
      const p = lv.probe;
      if (!p || this.probeOff(p, lv, gaze, 0.5)) return;
      need.probed++;
      if (i < NEAR_LEVELS) need.move = Math.max(need.move, capFor(p.tails, n, EPS_MOVE, ceiling));
      need.still = Math.max(need.still, capFor(p.tails, n, EPS_STILL, ceiling));
    });
  }

  // view: its centre and scale. gaze: dd complex the levels centre on. base: the view's
  // iteration cap, for new texels. target: the cap to refine to (base while the view moves).
  // rho: the smallest footprint of a pixel on the surface, metres. budget: iterations.
  // julia: { c, cap } for the sky, or null. ceiling: the cap probes run to, 0 for no probes.
  update({ view, gaze, base, target, rho, budget, julia, ceiling }) {
    const NL = this.NL;
    this.centre = [view.cx, view.cy];
    this.frame++;
    this.stats.texels = 0;
    this.base = octaveBase(view.scale, this.base);
    for (const lv of this.levels) {
      const k = layerOctave(lv.j, this.base, NL);
      if (lv.k !== k) this.clear(lv, k);
    }
    // The finest level a pixel looks at, with half an octave in hand; one below it is kept
    // ready for a zoom, and finer ones are left as they are.
    const top = this.base + NL - 1;
    const fine = Math.min(top, Math.max(this.base, Math.floor(Math.log2(rho * view.scale / TEXEL0) - 0.5)));
    this.fine = fine;
    let left = budget;
    if (julia) left -= this.stepJulia(julia, budget * JULIA_SHARE);
    // The levels worked on, finest first: those in use and the one kept ready below them.
    const used = [];
    for (let k = Math.max(this.base, fine - 1); k <= top; k++) used.push(this.level(k));
    // The cap to fill at is the near levels' probes' to say. Until each has one of hereabouts
    // (a zoom brought a level in, the gaze left one behind) no level is begun, and with none
    // at all (a start, a jump) nothing is done but probe: a wrong cap is work twice.
    const near = used.slice(0, NEAR_LEVELS);
    const seen = (lv) => lv.probe !== null && !this.probeOff(lv.probe, lv, gaze, 0.5);
    const sure = ceiling <= 0 || near.every(seen);
    if (sure) this.blind = false;
    else if (!near.some(seen)) this.blind = true;
    if (ceiling > 0) left -= this.stepProbes(used, gaze, ceiling, this.blind ? left : Math.min(left, budget * PROBE_SHARE));

    // Fills, coarse to fine: the coarse levels are what shows where a finer one is behind.
    // Windows that follow the gaze come before levels that are new, so a costly new level
    // (a zoom out into a place that does not escape) does not hold up what is looked at.
    const fills = [];
    for (const lv of this.blind ? [] : used.slice().reverse()) {
      if (!lv.fill) this.planFill(lv, gaze, base, sure);
      if (lv.fill) fills.push(lv);
    }
    const filling = fills.length;
    const fresh = fills.filter((lv) => lv.fill.land === 'grow');
    for (const lv of fills) if (!fresh.includes(lv)) left = this.stepFill(lv, left);
    for (const lv of fresh) left = this.stepFill(lv, left);

    // Refines of the levels in use, the lowest cap first, then fine to coarse. One begun is
    // seen through; one past the target (the view moved) waits as it is.
    const todo = [];
    for (const lv of this.levels) {
      const held = lv.k >= fine && lv.w > 0 && lv.h > 0;
      const want = held ? refineTo(lv.cap, lv.stats, base, target) : 0;
      if (lv.refine && lv.refine.cap > target && want > 0) lv.refine = null;
      const next = lv.refine ? lv.refine.cap : want;
      if (next !== lv.next) { lv.next = next; this.dirty = true; }
      if (!held || lv.fill || next === 0 || next > target || this.blind) continue;
      if (!lv.refine) lv.refine = { done: 0, col: 0, cap: next, low: Infinity };
      todo.push(lv);
    }
    todo.sort((a, b) => a.refine.cap - b.refine.cap || a.k - b.k);
    for (const lv of todo) left = this.stepRefine(lv, left);
    if (ceiling > 0 && left > 0) left -= this.stepProbes(used, gaze, ceiling, left);
    this.updateNeed(ceiling > 0 ? used : [], gaze, ceiling);

    const s = this.stats;
    s.units = budget - left;
    s.budget = budget;
    s.valid = this.levels.filter((l) => l.w > 0 && l.h > 0).length;
    s.filling = filling;
    s.refining = todo.length;
    s.idle = fine - this.base;
  }

  // Ask for what has changed since it was last measured: the levels' contents, the probes made.
  measure() {
    if (this.dirty && !this.reader.busy && this.frame - this.asked >= MEASURE_EVERY) this.measureLevels();
    if (!this.probeReader.busy) {
      const made = this.levels.filter((lv) => lv.probing && lv.probing.whole).map((lv) => ({ lv, probing: lv.probing }));
      if (made.length) this.probeReader.request(this.probeScene, this.cam, made);
    }
  }

  measureLevels() {
    const u = this.statUniforms;
    const tag = { levels: [], julia: this.jul.key };
    for (const lv of this.levels) {
      u.uArr.value[lv.j] = lv.arr;
      u.uRect.value.set([lv.x, lv.y, lv.w, lv.h], 4 * lv.j);
      u.uNext.value[lv.j] = lv.next;
      tag.levels.push({ k: lv.k, next: lv.next, held: lv.w > 0 && lv.h > 0 });
    }
    u.uJulia.value = this.julia[this.jul.cur].texture;
    u.uJit.value.set(Math.random(), Math.random());
    this.reader.request(this.statScene, this.cam, tag);
    this.dirty = false;
    this.asked = this.frame;
  }

  // Take up the measurements the GPU has ready.
  poll() {
    const made = this.probeReader.poll();
    if (made) {
      const b = this.probeReader.bytes, W = this.NL;
      for (const { lv, probing } of made) {
        if (lv.probing !== probing) continue;
        const count = (at) => { const i = 4 * ((at >> 1) * W + lv.j) + 2 * (at & 1); return b[i] * 256 + b[i + 1]; };
        lv.probe = { gaze: probing.gaze, cap: probing.cap, tails: PROBE_EDGES.map((_, e) => count(e)), inside: count(PROBE_EDGES.length) };
        lv.probing = null;
      }
    }
    const tag = this.reader.poll();
    if (!tag) return;
    const b = this.reader.bytes, W = this.NL + 1;
    const word = (j, row, at) => b[4 * (row * W + j) + at] * 256 + b[4 * (row * W + j) + at + 1];
    for (const lv of this.levels) {
      const t = tag.levels[lv.j];
      if (!t.held || t.k !== lv.k || lv.w === 0 || lv.h === 0) continue;
      lv.stats = { W: word(lv.j, 0, 0), I: word(lv.j, 0, 2) / 65535, D: word(lv.j, 1, 0), C: word(lv.j, 1, 2), next: t.next };
    }
    if (tag.julia !== '') this.jul.stats = { W: word(this.NL, 0, 0), I: word(this.NL, 0, 2) / 65535 };
  }

  // Per-level lookup uniforms for the eye pass, finest first, in metres at the current view scale.
  fillEyeUniforms(u, view) {
    const NL = this.NL;
    let any = 0;
    for (let L = 0; L < NL; L++) {
      const lv = this.level(this.base + L);
      const valid = lv.w > 0 && lv.h > 0;
      u.uLvArr.value[L] = lv.arr;
      u.uLvLayer.value[L] = lv.j;
      u.uLvWin.value[2 * L] = lv.x;
      u.uLvWin.value[2 * L + 1] = lv.y;
      u.uLvSize.value[2 * L] = lv.w;
      u.uLvSize.value[2 * L + 1] = lv.h;
      u.uLvValid.value[L] = valid ? 1 : 0;
      if (valid) {
        any = 1;
        u.uLvOff.value[2 * L] = ddToNum(ddSub(lv.origin[0], view.cx)) / view.scale;
        u.uLvOff.value[2 * L + 1] = ddToNum(ddSub(lv.origin[1], view.cy)) / view.scale;
        u.uLvTexel.value[L] = lv.texel / view.scale;
      } else {
        u.uLvOff.value[2 * L] = 0;
        u.uLvOff.value[2 * L + 1] = 0;
        u.uLvTexel.value[L] = 1;
      }
    }
    u.uAnyValid.value = any;
    u.uNL.value = NL;
    u.uT.value = this.T;
    u.uTexel0.value = TEXEL0 * Math.pow(2, this.base) / view.scale;
    u.uLevels0.value = this.arrays[0].texture;
    u.uLevels1.value = this.arrays[1].texture;
    u.uJulia.value = this.julia[this.jul.cur].texture;
    u.uJuliaExtent.value = JULIA_EXTENT;
    u.uJuliaRes.value = JULIA_RES;
  }

  describe() {
    const s = this.stats;
    return `plane ${s.valid}/${this.NL} levels (${s.idle} out of use), ${Math.round(s.texels / 1000)}k texels, ${(s.units / 1e6).toFixed(1)} of ${(s.budget / 1e6).toFixed(1)}M iterations, ${s.filling} filling, ${s.refining} refining, ${this.need.probed} probed`;
  }
}
