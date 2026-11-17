import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMULAS, STEP_ABS_RE, STEP_ABS_X, STEP_ABS_Y, STEP_NEG } from '../src/fractals.js';
import { ReferenceOrbit, stepJacobian, escapeIters } from '../src/perturb.js';
import { dd, ddAdd, ddAddD, ddSub, ddMul, ddMulD, ddAbs, ddNeg } from '../src/dd.js';

const f = Math.fround;
const STEPS = Object.entries(FORMULAS).filter(([k]) => k !== 'julia').map(([name, v]) => ({ name, step: v.step }));
const MAX = 3000;

// The shader's arithmetic (iterChunk in shaders2d.js) in its 32-bit floats.
function diffabs(a, d) {
  if (a >= 0) return f(a + d) >= 0 ? d : f(-f(f(2 * a) + d));
  return f(a + d) > 0 ? f(f(2 * a) + d) : -d;
}
function stepDelta(Z, d, step) {
  let re = f(f(2 * f(f(Z[0] * d[0]) - f(Z[1] * d[1]))) + f(f(d[0] * d[0]) - f(d[1] * d[1])));
  if (step & STEP_ABS_RE) re = diffabs(Z[2], re);
  let x = Z[0], y = Z[1], ex = d[0], ey = d[1];
  if (step & STEP_ABS_X) { ex = diffabs(x, ex); x = Math.abs(x); }
  if (step & STEP_ABS_Y) { ey = diffabs(y, ey); y = Math.abs(y); }
  const im = f(2 * f(f(x * ey) + f(ex * f(y + ey))));
  return [re, step & STEP_NEG ? -im : im];
}
const smooth = (i, zz) => i + 1 - Math.log2(Math.log2(zz)) + 4;

// Smooth iteration count of the reference's c plus dc, as the shader finds it; tallied, how
// often the orbit and the reference were on two sides of a fold.
function perturbed(ref, dc, step, maxIter, tally) {
  const Zat = (m) => [ref.data[4 * m], ref.data[4 * m + 1], ref.data[4 * m + 2]];
  let d = [0, 0], m = 0, Z = Zat(0);
  for (let i = 0; i < maxIter; i++) {
    if (tally) {
      // The squares' difference at the orbit's own precision: the reference's and the delta's.
      const re = Z[2] + 2 * (Z[0] * d[0] - Z[1] * d[1]) + d[0] * d[0] - d[1] * d[1];
      let across = 0;
      if (step & STEP_ABS_RE && Z[2] * re < 0) across++;
      if (step & STEP_ABS_X && Z[0] * (Z[0] + d[0]) < 0) across++;
      if (step & STEP_ABS_Y && Z[1] * (Z[1] + d[1]) < 0) across++;
      tally.folds += across;
      if (Math.hypot(d[0], d[1]) < 1e-4 * Math.hypot(Z[0], Z[1])) tally.deepFolds += across;
    }
    const s = stepDelta(Z, d, step);
    d = [f(s[0] + dc[0]), f(s[1] + dc[1])];
    m++;
    Z = Zat(m);
    const z = [f(Z[0] + d[0]), f(Z[1] + d[1])];
    const zz = f(f(z[0] * z[0]) + f(z[1] * z[1]));
    if (zz > 256) return smooth(i, zz);
    if (zz < f(f(d[0] * d[0]) + f(d[1] * d[1])) || m >= ref.length - 1) { d = z; m = 0; Z = Zat(0); if (tally) tally.rebases++; }
  }
  return -1;
}

// The same count by the iteration itself, in double-double.
function direct(cx, cy, step, maxIter) {
  let zx = dd(0), zy = dd(0);
  for (let i = 0; i < maxIter; i++) {
    const sq = ddSub(ddMul(zx, zx), ddMul(zy, zy));
    const im = ddMulD(ddMul(step & STEP_ABS_X ? ddAbs(zx) : zx, step & STEP_ABS_Y ? ddAbs(zy) : zy), 2);
    zx = ddAdd(step & STEP_ABS_RE ? ddAbs(sq) : sq, cx);
    zy = ddAdd(step & STEP_NEG ? ddNeg(im) : im, cy);
    const zz = zx[0] * zx[0] + zy[0] * zy[0];
    if (zz > 256) return smooth(i, zz);
  }
  return -1;
}

// Points on the boundary: between c = -0.1, inside every one of these sets, and a ring outside.
function boundary(step, turn) {
  const inside = (x, y) => escapeIters(dd(x), dd(y), step, 600) < 0;
  assert.ok(inside(-0.1, 0));
  let a = [-0.1, 0], b = [-0.1 + 3 * Math.cos(turn), 3 * Math.sin(turn)];
  assert.ok(!inside(b[0], b[1]));
  for (let k = 0; k < 44; k++) {
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (inside(mid[0], mid[1])) a = mid; else b = mid;
  }
  return b;
}

// The counts of a 7 x 7 view about (cx, cy) against the iteration itself, where a tenth of a
// pixel (of a view 1000 across) does not change the count: elsewhere it is finer than any image.
function compare(ref, cx, cy, span, step, tally) {
  ref.update(cx, cy, step, MAX);
  let resolved = 0, worst = 0;
  for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) {
    const dc = [f(span * i / 3.1), f(span * j / 3.3)], px = span / 5000;
    let lo = Infinity, hi = -Infinity;
    for (const [a, b] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const w = direct(ddAddD(ddAddD(cx, dc[0]), a * px), ddAddD(ddAddD(cy, dc[1]), b * px), step, MAX);
      lo = Math.min(lo, w < 0 ? Infinity : w);
      hi = Math.max(hi, w < 0 ? Infinity : w);
    }
    if (!(hi - lo < 0.25)) continue;
    resolved++;
    const got = perturbed(ref, dc, step, MAX, tally);
    worst = Math.max(worst, got < 0 ? Infinity : Math.max(lo - got, got - hi, 0));
  }
  return { resolved, worst };
}

test('the perturbed iteration counts as the iteration itself does, for every formula, deep and shallow', () => {
  for (const { name, step } of STEPS) {
    const ref = new ReferenceOrbit();
    const tally = { folds: 0, deepFolds: 0, rebases: 0 };
    let resolved = 0, worst = 0;
    for (const turn of [0.4, 1.3, 2.2, 3.5, 4.4, 5.6]) {
      const c = boundary(step, turn);
      for (const span of [3e-3, 1e-5, 1e-7, 1e-9, 1e-11]) {
        // The view's centre a little off the boundary point.
        const r = compare(ref, ddAddD(dd(c[0]), span * 0.37), ddAddD(dd(c[1]), -span * 0.21), span, step, tally);
        resolved += r.resolved;
        worst = Math.max(worst, r.worst);
      }
    }
    assert.ok(resolved > 500 && tally.rebases > 100, `${name}: ${resolved} counts, ${tally.rebases} rebases`);
    if (step & ~STEP_NEG) assert.ok(tally.folds > 100, `${name}: ${tally.folds} steps across a fold`);
    assert.ok(worst < 1e-3, `${name}: a count ${worst} from the iteration's`);
  }
});

// Points c outside the set whose orbit is on a fold at its kth point: where g, the folded
// quantity there, is zero. Each between two points a little outside the boundary.
function* onFold(step, bit) {
  const g = (k, cx, cy) => {
    let zx = dd(0), zy = dd(0);
    for (let i = 0; i < k; i++) {
      const sq = ddSub(ddMul(zx, zx), ddMul(zy, zy));
      const im = ddMulD(ddMul(step & STEP_ABS_X ? ddAbs(zx) : zx, step & STEP_ABS_Y ? ddAbs(zy) : zy), 2);
      zx = ddAdd(step & STEP_ABS_RE ? ddAbs(sq) : sq, cx);
      zy = ddAdd(step & STEP_NEG ? ddNeg(im) : im, cy);
    }
    return bit === STEP_ABS_RE ? ddSub(ddMul(zx, zx), ddMul(zy, zy))[0] : bit === STEP_ABS_X ? zx[0] : zy[0];
  };
  const out = (t) => { const c = boundary(step, t); return [dd(c[0] + (c[0] + 0.1) * 0.05), dd(c[1] + c[1] * 0.05)]; };
  let k = 6;
  for (let t = 0.5; t < 0.5 + 2 * Math.PI; t += 0.01) {
    let a = out(t), b = out(t + 0.01);
    if (!(g(k, ...a) * g(k, ...b) < 0)) continue;
    for (let n = 0; n < 100; n++) {
      const mid = [ddMulD(ddAdd(a[0], b[0]), 0.5), ddMulD(ddAdd(a[1], b[1]), 0.5)];
      if (g(k, ...mid) * g(k, ...a) > 0) a = mid; else b = mid;
    }
    if (direct(a[0], a[1], step, MAX) < k + 4) continue;
    yield a;
    k += 3;
    t += 1.3;
  }
}

test('a deep view lying across a fold of the orbit counts as the iteration itself does', () => {
  for (const { name, step } of STEPS) {
    for (const bit of [STEP_ABS_RE, STEP_ABS_X, STEP_ABS_Y]) {
      if (!(step & bit)) continue;
      const ref = new ReferenceOrbit();
      const tally = { folds: 0, deepFolds: 0, rebases: 0 };
      let resolved = 0, worst = 0;
      for (const c of onFold(step, bit)) {
        for (const span of [1e-8, 1e-12]) {
          // The fold through the view and the reference a little off it: what it folds is then
          // small, and not nothing.
          const r = compare(ref, ddAddD(c[0], 0.4 * span), ddAddD(c[1], 0.3 * span), span, step, tally);
          resolved += r.resolved;
          worst = Math.max(worst, r.worst);
        }
      }
      assert.ok(resolved > 50, `${name}, fold ${bit}: ${resolved} counts`);
      assert.ok(tally.deepFolds >= 15, `${name}, fold ${bit}: ${tally.deepFolds} steps across a fold far below the orbit's size`);
      assert.ok(worst < 1e-3, `${name}, fold ${bit}: a count ${worst} from the iteration's`);
    }
  }
});

test('the iteration\'s derivative is what a small step finds', () => {
  let s = 17;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 4 - 2;
  const at = (x, y, step) => {
    let re = x * x - y * y;
    if (step & STEP_ABS_RE) re = Math.abs(re);
    const im = 2 * (step & STEP_ABS_X ? Math.abs(x) : x) * (step & STEP_ABS_Y ? Math.abs(y) : y);
    return [re, step & STEP_NEG ? -im : im];
  };
  for (const { name, step } of STEPS) {
    for (let k = 0; k < 200; k++) {
      const x = rnd(), y = rnd(), h = 1e-6;
      if (Math.min(Math.abs(x), Math.abs(y), Math.abs(Math.abs(x) - Math.abs(y))) < 1e-3) continue; // on a fold
      const [a, b, c, d] = stepJacobian(x, y, step);
      const px = at(x + h, y, step), mx = at(x - h, y, step), py = at(x, y + h, step), my = at(x, y - h, step);
      const num = [(px[0] - mx[0]) / (2 * h), (py[0] - my[0]) / (2 * h), (px[1] - mx[1]) / (2 * h), (py[1] - my[1]) / (2 * h)];
      [a, b, c, d].forEach((v, i) => assert.ok(Math.abs(v - num[i]) < 1e-7, `${name} at ${x}, ${y}: ${[a, b, c, d]} for ${num}`));
    }
  }
});

test('outside a set the reference knows how far it is and which way', () => {
  for (const { name, step } of STEPS) {
    const ref = new ReferenceOrbit();
    let n = 0, clear = 0, steered = 0, worst = 0;
    for (let k = 0; k < 40; k++) {
      const c = boundary(step, 0.3 + k * 0.157);
      // A little way out along the ray the boundary point was found on.
      const out = [c[0] + (c[0] + 0.1) * 0.02, c[1] + c[1] * 0.02];
      ref.update(dd(out[0]), dd(out[1]), step, MAX);
      if (!ref.escaped) continue;
      n++;
      assert.ok(ref.dist > 0 && Math.abs(Math.hypot(...ref.steer) - 1) < 1e-9, `${name}: ${ref.dist}, ${ref.steer}`);
      const count = (x, y) => direct(dd(x), dd(y), step, MAX);
      // Nothing of the set within the distance, whichever way.
      let hit = false;
      for (let a = 0; a < 16; a++) if (count(out[0] + Math.cos(a * 0.3927) * ref.dist * 0.9, out[1] + Math.sin(a * 0.3927) * ref.dist * 0.9) < 0) hit = true;
      if (!hit) clear++;
      // The way to the set is the way the count climbs, where a double can step that finely.
      if (ref.dist < 1e-9) continue;
      const h = ref.dist * 1e-3;
      const gx = count(out[0] + h, out[1]) - count(out[0] - h, out[1]), gy = count(out[0], out[1] + h) - count(out[0], out[1] - h);
      const cos = (gx * ref.steer[0] + gy * ref.steer[1]) / Math.hypot(gx, gy);
      steered++;
      worst = Math.max(worst, Math.acos(Math.min(1, cos)) * 180 / Math.PI);
    }
    assert.ok(n >= 30 && steered >= 15, `${name}: ${n} points outside, the way checked at ${steered}`);
    assert.ok(clear >= n * 0.9, `${name}: clear of the set at ${clear} of ${n}`);
    assert.ok(worst < 5, `${name}: ${worst} degrees off the way the count climbs`);
  }
});
