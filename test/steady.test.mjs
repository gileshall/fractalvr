import test from 'node:test';
import assert from 'node:assert/strict';
import { Steady, HOLD_MAX } from '../src/steady.js';

const DT = 1 / 72;
const STRAY = 80;

// A pull: the trigger from `v0` to `v1` over `frames`, the ray going from `a` to `b` with it.
function* pull(a, b, v0, v1, frames) {
  for (let i = 1; i <= frames; i++) {
    const f = i / frames;
    yield { at: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], value: v0 + (v1 - v0) * f };
  }
}
const rest = (at, value, frames) => Array.from({ length: frames }, () => ({ at, value }));
const run = (s, steps, pressedAt = 0.5) => {
  const out = [];
  for (const { at, value } of steps) {
    const pressed = value >= pressedAt;
    out.push({ p: s.update({ at, value, pressed, stray: STRAY, dt: DT }), pressed, at });
  }
  return out;
};

test('a press lands where the ray was before the trigger began to travel', () => {
  const s = new Steady();
  const out = run(s, [...rest([100, 100], 0, 20), ...pull([100, 100], [103, 114], 0, 1, 8)]);
  const press = out.find((o) => o.pressed);
  assert.deepEqual(press.p, [100, 100]);
  assert.ok(press.at[1] > 105);
  assert.ok(Math.abs(s.slip - Math.hypot(press.at[0] - 100, press.at[1] - 100)) < 1e-9);
  assert.deepEqual(out.at(-1).p, [100, 100]); // and stays there to the end of the pull
});

test('a hand that arrives as it pulls lands where it had got to', () => {
  const s = new Steady();
  // 3 a frame toward the mark, then the pull turns it away
  const out = run(s, [...pull([40, 100], [100, 100], 0, 0, 20), ...pull([100, 100], [92, 97], 0, 1, 3)]);
  const press = out.find((o) => o.pressed);
  assert.ok(Math.hypot(press.p[0] - 100, press.p[1] - 100) <= 6 + 1e-9, `landed at ${press.p}`);
  assert.equal(press.p[1], 100);
});

test('letting go after a short press lands where the trigger began to fall', () => {
  const s = new Steady();
  const out = run(s, [...rest([300, 200], 0, 20), ...pull([300, 200], [300, 200], 0, 1, 2), ...pull([300, 200], [330, 200], 1, 1, 30), ...pull([330, 200], [322, 190], 1, 0, 4)]);
  const up = out.findIndex((o, i) => i > 0 && !o.pressed && out[i - 1].pressed);
  assert.ok(Math.abs(out[up].p[0] - 330) <= 2 + 1e-9, `let go at ${out[up].p}`);
  assert.equal(out[up].p[1], 200);
});

test('a still hand is not moved, a moving one followed', () => {
  const s = new Steady();
  for (const o of run(s, [...rest([5, 6], 0, 30), ...rest([5, 6], 1, 30)])) assert.deepEqual(o.p, [5, 6]);
  const t = new Steady();
  for (const o of run(t, [...pull([0, 0], [300, 0], 0, 0, 40)])) assert.deepEqual(o.p, o.at);
});

test('held, the point goes on from where it was pressed, with no jump, and the ray makes it up', () => {
  const s = new Steady();
  const out = run(s, [
    ...rest([100, 100], 0, 20), ...pull([100, 100], [100, 112], 0, 1, 8),
    ...rest([100, 112], 1, 30), ...pull([100, 112], [200, 112], 1, 1, 50),
  ]);
  for (let i = 1; i < out.length; i++) {
    const step = Math.hypot(out[i].p[0] - out[i - 1].p[0], out[i].p[1] - out[i - 1].p[1]);
    assert.ok(step <= 2 * 2 + 1e-9, `jump of ${step} at ${i}`); // the ray moves 2 a frame
  }
  assert.deepEqual(out[57].p, [100, 100]); // still, after the pull
  assert.deepEqual(out.at(-1).p, [200, 112]);
});

test('letting go does not move what was being dragged', () => {
  const s = new Steady();
  const out = run(s, [...rest([400, 50], 1, 30), ...pull([400, 50], [394, 41], 1, 0, 8)]);
  const up = out.findIndex((o, i) => i > 0 && !o.pressed && out[i - 1].pressed);
  assert.ok(up > 30);
  assert.deepEqual(out[up].p, [400, 50]);
});

test('a sweep with the trigger travelling is not held back', () => {
  const s = new Steady();
  const out = run(s, [...rest([0, 0], 0, 20), ...pull([0, 0], [400, 0], 0, 1, 10)]);
  const gap = Math.abs(out.at(-1).p[0] - out.at(-1).at[0]);
  assert.ok(gap <= STRAY + 40 + 1e-9);
  const on = run(s, [...pull([400, 0], [700, 0], 1, 1, 30)]);
  assert.deepEqual(on.at(-1).p, [700, 0]);
});

test('a trigger that never settles holds the point no longer than HOLD_MAX', () => {
  const s = new Steady();
  const steps = [];
  for (let i = 0; i < 200; i++) steps.push({ at: [10, 10 + i * 0.1], value: 0.3 + 0.2 * Math.sin(i * 0.9) });
  const out = run(s, steps, 2);
  const held = out.filter((o) => o.p[1] === out[0].p[1]).length;
  assert.ok(held * DT <= HOLD_MAX + 3 * DT, `held ${held} frames`);
  assert.ok(Math.abs(out.at(-1).p[1] - out.at(-1).at[1]) < 1e-9);
});

test('off the surface there is no point, and what was held is forgotten', () => {
  const s = new Steady();
  run(s, [...rest([100, 100], 0, 20), ...pull([100, 100], [100, 110], 0, 0.4, 4)]);
  assert.ok(s.hold);
  assert.equal(s.update({ at: null, value: 0.5, pressed: true, stray: STRAY, dt: DT }), null);
  assert.equal(s.hold, null);
  assert.deepEqual(s.update({ at: [7, 7], value: 0.5, pressed: true, stray: STRAY, dt: DT }), [7, 7]);
});

test('a press in the middle of a fast sweep lands on the ray', () => {
  const s = new Steady();
  const steps = [...pull([0, 0], [800, 0], 0, 0, 20), ...pull([800, 0], [1000, 0], 1, 1, 5)];
  const out = run(s, steps);
  for (const o of out) assert.deepEqual(o.p, o.at);
  assert.equal(s.slip, 0);
});

test('let go, the point is back on the ray in a moment though the hand is still', () => {
  const s = new Steady();
  // a release that turned the hand, then a jump of the ray past the stray, then stillness
  const out = run(s, [...rest([400, 50], 1, 30), ...pull([400, 50], [394, 41], 1, 0, 8), ...rest([394, 41], 0, 40)]);
  assert.deepEqual(out.at(-1).p, [394, 41]);
  for (let i = 31; i < out.length; i++) {
    const step = Math.hypot(out[i].p[0] - out[i - 1].p[0], out[i].p[1] - out[i - 1].p[1]);
    assert.ok(step <= 3, `step of ${step} at ${i}`);
  }
  const far = run(s, [...pull([394, 41], [394, 41], 0, 1, 1), ...rest([394, 41], 1, 20), ...pull([394, 41], [394, 41], 1, 0, 1), ...rest([700, 300], 0, 40)]);
  assert.deepEqual(far.at(-1).p, [700, 300]);
  assert.equal(s.engaged, false);
});
