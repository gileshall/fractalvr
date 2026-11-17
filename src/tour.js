import * as THREE from 'three';
import { state, currentFractal } from './state.js';
import { FRACTALS, FORMULAS, FALL_TARGETS, ORDER, STEP_ABS_RE, STEP_ABS_X, STEP_ABS_Y, STEP_NEG } from './fractals.js';

// A tour: a cruise that steers itself, from one place to the next. The places are the
// bookmarks, each 3D fractal from its start, the named places of the plane, and a point of
// each 2D fractal's boundary; none twice until all have been.

export const LEG = 80; // seconds of travel at a stop
export const LEG_FLOOR = 20; // seconds more, at most, once a 3D stop is as small as it gets
export const LEG_LOST = 5; // seconds with nothing to see before a stop is given up
export const TOUR_RATE = { '3d': 0.5, '2d': 0.25 }; // doublings a second a tour sets off at
export const TOUR_SPIN = 0.02; // palette turns a second, where the colours were still
export const JULIA_FLOOR = 1e-12; // a Julia stop's point is known in doubles: no deeper
const YAW_MAX = 0.3; // radians a second the room turns to keep the way in front, at most
const YAW_EASE = 0.3; // seconds it takes to close on it

const _v = new THREE.Vector3(), _h = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3();

// A frame of a 3D tour: the room goes `metres` along the pilot's heading, and turns about the
// head so the heading stays over `front`, a level direction of the room. Returns the turn.
// Nearer a surface than the arm (the room as small as it gets), it goes slower by as much.
export function fly(rig, pilot, front, arm, metres, dt) {
  rig.dolly.updateMatrixWorld(true);
  const head = rig.headWorld(), up = rig.up();
  const P = state.params, f = currentFractal();
  const h = pilot.step({
    pos: [head.x, head.y, head.z], scale: rig.scale, floor: rig.minScale, up: [up.x, up.y, up.z], arm, dt,
    de: (x, y, z) => f.de([x, y, z], P),
  });
  rig.fly(_v.fromArray(h), metres * THREE.MathUtils.clamp(pilot.near / arm, 0.1, 1));
  return face(rig, h, front, YAW_MAX * dt, 1 - Math.exp(-dt / YAW_EASE));
}

// Turn the room about the head so `front` (room, level) is over the heading (world): by
// `share` of the way, and `most` radians at most.
export function face(rig, heading, front, most = Infinity, share = 1) {
  const up = _u.copy(rig.up());
  _h.fromArray(heading).addScaledVector(up, -_h.fromArray(heading).dot(up));
  _f.copy(front).applyQuaternion(rig.dolly.quaternion);
  _f.addScaledVector(up, -_f.dot(up));
  if (_h.lengthSq() < 1e-12 || _f.lengthSq() < 1e-12) return 0;
  const off = Math.atan2(_v.crossVectors(_f, _h).dot(up), _f.dot(_h));
  const angle = Math.sign(off) * Math.min(Math.abs(off) * share, most);
  if (angle) rig.turn(angle);
  return angle;
}

// The level direction of the room the head faces: what a tour keeps its way under.
export function frontOf(camera) {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  f.y = 0;
  return f.lengthSq() < 1e-6 ? f.set(0, 0, -1) : f.normalize();
}

// One step of a 2D fractal in doubles, as the plane's.
function escapes(zx, zy, cx, cy, bits, cap) {
  for (let i = 0; i < cap; i++) {
    const x2 = zx * zx, y2 = zy * zy;
    if (x2 + y2 > 256) return true;
    const sq = x2 - y2;
    const im = 2 * (bits & STEP_ABS_X ? Math.abs(zx) : zx) * (bits & STEP_ABS_Y ? Math.abs(zy) : zy);
    zx = (bits & STEP_ABS_RE ? Math.abs(sq) : sq) + cx;
    zy = (bits & STEP_NEG ? -im : im) + cy;
  }
  return false;
}

// A point of a 2D fractal's boundary within its home view: between a point that stays and a
// point that leaves, both drawn at random.
export function boundaryPoint(f, params, rng) {
  if (f.formula === 'julia') return juliaPoint(params.p1, params.p2, rng);
  const bits = FORMULAS[f.formula].step;
  const draw = () => [f.home.cx + (2 * rng() - 1) * f.home.scale, f.home.cy + (2 * rng() - 1) * f.home.scale];
  let a = null, b = null;
  for (let n = 0; n < 4000 && !(a && b); n++) {
    const p = draw();
    if (escapes(0, 0, p[0], p[1], bits, 500)) b ??= p; else a ??= p;
  }
  if (!a || !b) throw new Error(`${f.name}: no boundary in its home view`);
  for (let k = 0; k < 60; k++) {
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (escapes(0, 0, m[0], m[1], bits, 500)) b = m; else a = m;
  }
  return b;
}

// A point of the Julia set of z^2 + c, whether it is of a piece or dust: its repelling fixed
// point taken back through the map by one square root or the other, at random. Those are of
// the set, and all over it.
function juliaPoint(cx, cy, rng) {
  if (FORMULAS.julia.step !== 0) throw new Error('the Julia set is not of z^2 + c');
  const root = (x, y) => {
    const r = Math.hypot(x, y);
    return [Math.sqrt((r + x) / 2), (y < 0 ? -1 : 1) * Math.sqrt((r - x) / 2)];
  };
  const d = root(1 - 4 * cx, -4 * cy);
  let z = [(1 + d[0]) / 2, d[1] / 2];
  for (let n = 0; n < 60; n++) {
    z = root(z[0] - cx, z[1] - cy);
    if (rng() < 0.5) z = [-z[0], -z[1]];
  }
  return z;
}

// The places of a tour. A stop: { name, fractal, kind, mark | target | home | edge }.
export function stops(bookmarks) {
  const list = [];
  for (const m of bookmarks) {
    if (FRACTALS[m.fractal]) list.push({ name: m.name, fractal: m.fractal, kind: FRACTALS[m.fractal].kind, mark: m });
  }
  for (const i of ORDER) {
    const f = FRACTALS[i];
    if (f.kind === '3d') list.push({ name: f.name, fractal: i, kind: '3d', home: true });
    else list.push({ name: f.name, fractal: i, kind: '2d', edge: true });
  }
  for (const t of FALL_TARGETS) {
    list.push({ name: t.name, fractal: FRACTALS.findIndex((f) => f.formula === t.formula), kind: '2d', target: t });
  }
  return list;
}

// The order they are visited in: all of them, shuffled, no fractal twice running where there
// is another to go to; then all of them again, shuffled anew.
export class Playlist {
  constructor(list, rng = Math.random) {
    if (!list.length) throw new Error('a tour of no places');
    this.list = list;
    this.rng = rng;
    this.seq = []; // indices into list, as visited
    this.at = -1;
  }

  deal() {
    const left = this.list.map((_, i) => i);
    let last = this.seq.length ? this.list[this.seq[this.seq.length - 1]].fractal : -1;
    while (left.length) {
      // The fractal with most places left goes now if it could not be kept apart later.
      const count = new Map();
      for (const i of left) count.set(this.list[i].fractal, (count.get(this.list[i].fractal) ?? 0) + 1);
      const [most, n] = [...count].sort((a, b) => b[1] - a[1])[0];
      const other = left.filter((i) => this.list[i].fractal !== last);
      const from = !other.length ? left : most !== last && n > left.length - n ? left.filter((i) => this.list[i].fractal === most) : other;
      const pick = from[Math.floor(this.rng() * from.length)];
      left.splice(left.indexOf(pick), 1);
      this.seq.push(pick);
      last = this.list[pick].fractal;
    }
  }

  next() {
    this.at++;
    if (this.at >= this.seq.length) this.deal();
    return this.list[this.seq[this.at]];
  }

  // The stop before, or the first again.
  prev() {
    this.at = Math.max(0, this.at - 1);
    if (!this.seq.length) this.deal();
    return this.list[this.seq[this.at]];
  }
}
