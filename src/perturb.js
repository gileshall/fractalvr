import * as THREE from 'three';
import { dd, ddAdd, ddSub, ddMul, ddMulD, ddAbs, ddNeg, ddToNum } from './dd.js';
import { STEP_ABS_RE, STEP_ABS_X, STEP_ABS_Y, STEP_NEG } from './fractals.js';

// Reference orbit for perturbation rendering of the 2D iterations (FORMULAS in fractals.js).
// The orbit is iterated in double-double on the CPU and uploaded as float32; the shader
// iterates per-pixel deltas relative to it (with rebasing).

export const REF_TEX_W = 1024;
export const REF_MAX = 16384;

// One iteration without its c, in double-double: [re, im, x^2 - y^2].
function stepDD(zx, zy, step) {
  const sq = ddSub(ddMul(zx, zx), ddMul(zy, zy));
  const x = step & STEP_ABS_X ? ddAbs(zx) : zx, y = step & STEP_ABS_Y ? ddAbs(zy) : zy;
  const im = ddMulD(ddMul(x, y), 2);
  return [step & STEP_ABS_RE ? ddAbs(sq) : sq, step & STEP_NEG ? ddNeg(im) : im, sq];
}

// The iteration's derivative at (x, y), as the rows [a, b], [c, d] of its matrix.
export function stepJacobian(x, y, step) {
  const sr = step & STEP_ABS_RE && x * x - y * y < 0 ? -2 : 2;
  const sx = step & STEP_ABS_X && x < 0 ? -1 : 1, sy = step & STEP_ABS_Y && y < 0 ? -1 : 1;
  const si = step & STEP_NEG ? -2 : 2;
  return [sr * x, -sr * y, si * sx * (sy * y), si * (sx * x) * sy];
}

export class ReferenceOrbit {
  constructor() {
    this.data = new Float32Array(REF_TEX_W * (REF_MAX / REF_TEX_W) * 4);
    this.texture = new THREE.DataTexture(this.data, REF_TEX_W, REF_MAX / REF_TEX_W, THREE.RGBAFormat, THREE.FloatType);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    this.length = 0;
    this.escaped = false;
    this.dist = Infinity; // exterior distance estimate at the reference point
    this.steer = [0, 0]; // unit direction toward the set (exterior only)
    this.key = '';
  }

  // Recompute if the center, iteration or length changed. Returns true when uploaded.
  update(cx, cy, step, maxIter) {
    const key = `${cx[0]},${cx[1]},${cy[0]},${cy[1]},${step},${maxIter}`;
    if (key === this.key) return false;
    this.key = key;
    const n = Math.min(maxIter, REF_MAX - 1);
    let zx = dd(0), zy = dd(0);
    let ja = 0, jb = 0, jc = 0, jd = 0; // d z / d c in double, for the distance estimate
    const data = this.data;
    let i = 0;
    let escaped = false;
    const bail = 1e8;
    for (; i <= n; i++) {
      const [re, im, sq] = stepDD(zx, zy, step);
      data[4 * i] = ddToNum(zx);
      data[4 * i + 1] = ddToNum(zy);
      data[4 * i + 2] = ddToNum(sq);
      const zxh = zx[0], zyh = zy[0];
      if (zxh * zxh + zyh * zyh > bail) { escaped = true; i++; break; }
      const [a, b, c, d] = stepJacobian(zxh, zyh, step);
      [ja, jb, jc, jd] = [a * ja + b * jc + 1, a * jb + b * jd, c * ja + d * jc, c * jb + d * jd + 1];
      zx = ddAdd(re, cx);
      zy = ddAdd(im, cy);
    }
    this.length = i;
    this.escaped = escaped;
    if (escaped) {
      // The potential log|z| / 2^n falls along -J^T z; the distance is the potential over its slope.
      const zxh = zx[0], zyh = zy[0];
      const r = Math.hypot(zxh, zyh);
      const gx = ja * zxh + jc * zyh, gy = jb * zxh + jd * zyh;
      const g = Math.hypot(gx, gy);
      this.dist = 0.5 * r * r * Math.log(r) / g;
      this.steer = [-gx / g, -gy / g];
    } else {
      this.dist = 0;
      this.steer = [0, 0];
    }
    this.texture.needsUpdate = true;
    return true;
  }
}

// Escape iteration count for a single point, double-double. Used for steering from inside the set.
export function escapeIters(cx, cy, step, maxIter) {
  let zx = dd(0), zy = dd(0);
  for (let i = 0; i < maxIter; i++) {
    const r2 = zx[0] * zx[0] + zy[0] * zy[0];
    if (r2 > 256) return i;
    const [re, im] = stepDD(zx, zy, step);
    zx = ddAdd(re, cx);
    zy = ddAdd(im, cy);
  }
  return -1;
}
