import { test } from 'node:test';
import assert from 'node:assert/strict';
import { View2D } from '../src/view2d.js';
import { state } from '../src/state.js';
import { dd, ddToNum } from '../src/dd.js';

// A cruise in, steering, from a centre and a scale: the view after some seconds of it.
function cruise(cx, cy, scale, seconds, formula = 'mandel') {
  const v = new View2D();
  v.formula = formula;
  v.cx = dd(cx); v.cy = dd(cy); v.scale = scale;
  v.need = 600;
  state.fall = true; state.fallRate = 0.25; state.autoSteer = true; state.iterAuto = true;
  for (let n = 0; n < seconds * 72; n++) v.update(1 / 72);
  state.fall = false;
  return v;
}

test('steering leaves a centre on the boundary where it is, though it never escapes', () => {
  // The tip of a filament, the end of the antenna, the end of the period doublings.
  for (const [cx, cy] of [[0, 1], [-2, 0], [-1.4011551890920506, 0]]) {
    const v = cruise(cx, cy, 1.4, 4);
    assert.ok(!v.ref.escaped, `${cx}, ${cy} leaves`);
    assert.ok(!v.dark, `${cx}, ${cy} taken for the black`);
    assert.ok(Math.hypot(ddToNum(v.cx) - cx, ddToNum(v.cy) - cy) < 1e-12, `${cx}, ${cy} went to ${ddToNum(v.cx)}, ${ddToNum(v.cy)}`);
  }
});

test('steering takes a centre inside the set out to its boundary', () => {
  // Inside the cardioid, its cusp within the view.
  const v = cruise(0.24, 0, 0.1, 6);
  assert.ok(Math.hypot(ddToNum(v.cx) - 0.24, ddToNum(v.cy)) > 0.005, 'still where it began');
  assert.ok(v.ref.escaped && !v.dark);
  assert.ok(v.ref.dist < 0.05 * v.scale, `${v.ref.dist} from the set in a view of ${v.scale}`);
});

test('a centre deep within the set, no way out in reach, is in the black', () => {
  const v = cruise(-0.1, 0, 0.05, 2);
  assert.ok(v.dark);
  assert.ok(Math.hypot(ddToNum(v.cx) + 0.1, ddToNum(v.cy)) < 1e-12);
});

test('steering brings a centre outside the set in to its boundary', () => {
  const v = cruise(0.5, 0.5, 0.2, 6);
  assert.ok(v.ref.escaped);
  assert.ok(v.ref.dist < 0.05 * v.scale, `${v.ref.dist} from the set in a view of ${v.scale}`);
});

test('a point of the plane held stays at the offset it is held at through zoom and turn, to depth', () => {
  const v = new View2D();
  v.cx = dd(-0.743643887037151); v.cy = dd(0.13182590420533); v.scale = 3e-22; v.rot = 0.4;
  const p = v.at(0.7, -0.3);
  v.zoom(0.37); v.rot += 1.1; v.pan(2, -5);
  v.hold(p, 0.7, -0.3);
  const q = v.at(0.7, -0.3);
  // within a millionth of the view, at a scale doubles alone could not tell apart
  assert.ok(Math.hypot(q[0][0] - p[0][0] + (q[0][1] - p[0][1]), q[1][0] - p[1][0] + (q[1][1] - p[1][1])) < 1e-6 * v.scale);
  // and dragged: the point is where the ray went
  v.hold(p, -1.2, 0.5);
  const r = v.at(-1.2, 0.5);
  assert.ok(Math.hypot(r[0][0] - p[0][0] + (r[0][1] - p[0][1]), r[1][0] - p[1][0] + (r[1][1] - p[1][1])) < 1e-6 * v.scale);
  const moved = v.at(0.7, -0.3);
  assert.ok(Math.hypot(moved[0][0] - p[0][0] + (moved[0][1] - p[0][1]), moved[1][0] - p[1][0] + (moved[1][1] - p[1][1])) > v.scale);
});

test('a cruise goes into a point held, and does not steer from it', () => {
  const v = new View2D();
  v.cx = dd(-0.6); v.cy = dd(0); v.scale = 1.4; v.rot = 0.4; v.need = 600;
  const u = 1.1, w = -0.7, p = v.at(u, w);
  state.fall = true; state.fallRate = 0.5; state.autoSteer = true; state.iterAuto = true;
  for (let n = 0; n < 5 * 72; n++) v.update(1 / 72, { p, u, v: w });
  state.fall = false;
  assert.ok(Math.abs(Math.log2(1.4 / v.scale) - 2.5) < 1e-9);
  const q = v.at(u, w);
  assert.ok(Math.hypot(ddToNum(q[0]) - ddToNum(p[0]), ddToNum(q[1]) - ddToNum(p[1])) < 1e-15);
});
