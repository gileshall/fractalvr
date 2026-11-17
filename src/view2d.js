import { dd, ddAdd, ddAddD, ddMulD, ddToNum, ddToString } from './dd.js';
import { ReferenceOrbit, escapeIters } from './perturb.js';
import { state } from './state.js';
import { FORMULAS } from './fractals.js';

// View state for the 2D fractals: a double-double centre, a float scale and a rotation.
// The surface point (u, v) in metres maps to c = centre + rot(u, v) * scale.

export const SCALE2D_MIN = 1e-30;
export const SCALE2D_MAX = 8;

function parseDD(str) {
  let s = str.trim();
  let neg = false;
  if (s[0] === '-') { neg = true; s = s.slice(1); }
  const [ip, fp = ''] = s.split('.');
  let v = dd(parseInt(ip || '0', 10));
  let place = dd(1);
  for (const ch of fp) {
    place = ddMulD(place, 0.1);
    v = ddAdd(v, ddMulD(place, parseInt(ch, 10)));
  }
  return neg ? [-v[0], -v[1]] : v;
}

export class View2D {
  constructor() {
    this.cx = dd(-0.6);
    this.cy = dd(0);
    this.scale = 1.4;
    this.rot = 0;
    this.formula = 'mandel';
    this.ref = new ReferenceOrbit();
    this.maxIter = 600;
    this.need = 100;
    this.lastSteer = 0;
    this.dark = false; // as steering last found it: the centre within the set, and all right about it
  }

  home(f) {
    this.formula = f.formula;
    this.cx = dd(f.home.cx);
    this.cy = dd(f.home.cy);
    this.scale = f.home.scale;
    this.rot = 0;
    this.dark = false;
  }

  setTarget(t) {
    this.cx = parseDD(t.cx);
    this.cy = parseDD(t.cy);
  }

  centerFloat() {
    return [ddToNum(this.cx), ddToNum(this.cy)];
  }

  // Shift the centre by a surface-space offset in metres.
  pan(u, v) {
    const c = Math.cos(this.rot), s = Math.sin(this.rot);
    const du = (c * u - s * v) * this.scale;
    const dv = (s * u + c * v) * this.scale;
    this.cx = ddAddD(this.cx, du);
    this.cy = ddAddD(this.cy, dv);
  }

  // The point of the plane at a surface-space offset in metres, in double-doubles.
  at(u, v) {
    const c = Math.cos(this.rot), s = Math.sin(this.rot);
    return [ddAddD(this.cx, (c * u - s * v) * this.scale), ddAddD(this.cy, (s * u + c * v) * this.scale)];
  }

  // Put the centre where the point `p` of the plane is at the offset (u, v).
  hold(p, u, v) {
    const c = Math.cos(this.rot), s = Math.sin(this.rot);
    this.cx = ddAddD(p[0], -(c * u - s * v) * this.scale);
    this.cy = ddAddD(p[1], -(s * u + c * v) * this.scale);
  }

  zoom(factor) {
    this.scale = Math.max(SCALE2D_MIN, Math.min(SCALE2D_MAX, this.scale * factor));
  }

  doublings() {
    return Math.log2(1.4 / this.scale);
  }

  // The cap new texels are run to: what the view is measured to need (`need`, from the plane's
  // probes) under the menu's ceiling.
  effectiveIter() {
    return state.iterAuto ? Math.min(state.maxIter, this.need) : state.maxIter;
  }

  // held: { p, u, v }, a point of the plane kept at an offset: a cruise goes into it, unsteered.
  update(dt, held = null) {
    if (state.fall) {
      this.zoom(Math.pow(2, -state.fallRate * dt));
      if (held) this.hold(held.p, held.u, held.v);
    }
    this.maxIter = this.effectiveIter();
    if (this.formula !== 'julia') {
      // Steer with last frame's orbit, then refresh. Orbit length is quantised so the
      // creeping iteration cap does not force a recompute every frame.
      if (state.fall && state.fallRate > 0 && state.autoSteer && this.ref.key && !held) this.steer(dt);
      this.ref.update(this.cx, this.cy, FORMULAS[this.formula].step, Math.ceil(this.maxIter / 512) * 512);
    }
  }

  // Keep the centre on the boundary while cruising in: outside, drift toward the set along the
  // potential gradient; inside, hop toward the nearest escaping ring sample. A point of the
  // boundary itself may never leave (the tip of a filament): it is inside only where what is
  // right about it stays too.
  steer(dt) {
    const ref = this.ref;
    const view = this.scale;
    if (ref.escaped) {
      this.dark = false;
      if (ref.dist < 0.02 * view) return;
      const step = Math.min(ref.dist, 0.6 * view * dt);
      this.cx = ddAddD(this.cx, ref.steer[0] * step);
      this.cy = ddAddD(this.cy, ref.steer[1] * step);
    } else {
      this.lastSteer += dt;
      if (this.lastSteer < 0.15) return;
      this.lastSteer = 0;
      const step = FORMULAS[this.formula].step;
      // The sample of a ring that takes longest to leave, of those that do.
      const ring = (r, n, turn) => {
        let best = -1, bx = 0, by = 0;
        for (let k = 0; k < n; k++) {
          const a = (k / n + turn) * Math.PI * 2;
          const count = escapeIters(ddAddD(this.cx, r * Math.cos(a)), ddAddD(this.cy, r * Math.sin(a)), step, this.maxIter);
          if (count > best) { best = count; bx = Math.cos(a); by = Math.sin(a); }
        }
        return best < 0 ? null : [bx, by];
      };
      this.dark = !ring(0.05 * view, 4, 0.07);
      if (!this.dark) return;
      const r = 0.7 * view;
      const out = ring(r, 8, 0);
      if (!out) return;
      this.cx = ddAddD(this.cx, out[0] * r * 0.5);
      this.cy = ddAddD(this.cy, out[1] * r * 0.5);
    }
  }

  describe() {
    return [
      `re ${ddToString(this.cx, 30)}`,
      `im ${ddToString(this.cy, 30)}`,
      `scale ${this.scale.toExponential(3)} /m  (${this.doublings().toFixed(1)} doublings)`,
      `iterations ${this.maxIter}  ref ${this.ref.length}${this.ref.escaped ? ' esc' : ''}`,
      `boundary dist ${this.ref.escaped ? this.ref.dist.toExponential(2) : 'inside'}`,
    ];
  }
}
