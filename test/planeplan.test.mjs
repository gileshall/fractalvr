import test from 'node:test';
import assert from 'node:assert/strict';
import {
  octaveBase, layerOctave, refineTo, reached, fillCost, refineCost, shiftPlan, spans, advance, capFor,
  PROBE_EDGES, EPS_MOVE, EPS_STILL,
  CAP_STEP, CATCH_UP, TEXEL_COST, UNKNOWN_INTERIOR, BORROWED_INTERIOR, SHIFT_MIN, SHIFT_MAX,
} from '../src/planeplan.js';

test('octaveBase: the floor of the scale in octaves at first', () => {
  assert.equal(octaveBase(1, null), 0);
  assert.equal(octaveBase(0.3, null), -2);
  assert.equal(octaveBase(5, null), 2);
});

test('octaveBase: held through a quarter octave either side', () => {
  assert.equal(octaveBase(Math.pow(2, -3.2), -3), -3);
  assert.equal(octaveBase(Math.pow(2, -3.3), -3), -4);
  assert.equal(octaveBase(Math.pow(2, -1.8), -3), -3);
  assert.equal(octaveBase(Math.pow(2, -1.7), -3), -2);
  // A scale wobbling about a power of two keeps its base.
  let b = octaveBase(Math.pow(2, -5.01), null);
  for (const e of [-4.99, -5.02, -4.98, -5.1, -4.9]) b = octaveBase(Math.pow(2, e), b);
  assert.equal(b, -6);
});

test('layerOctave: every octave held has one layer, the same whatever the base', () => {
  for (const base of [-40, -7, 0, 5]) {
    const ks = [];
    for (let j = 0; j < 12; j++) ks.push(layerOctave(j, base, 12));
    assert.deepEqual([...ks].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => base + i));
    for (let j = 0; j < 12; j++) if (ks[j] !== base) assert.equal(layerOctave(j, base + 1, 12), ks[j]);
  }
});

test('refineTo: nothing to do at the target', () => {
  assert.equal(refineTo(4000, null, 300, 4000), 0);
  assert.equal(refineTo(300, null, 300, 300), 0);
});

test('refineTo: while moving, only a level well under the view\'s cap is brought up', () => {
  assert.equal(refineTo(280, null, 300, 300), 0);
  assert.equal(refineTo(CATCH_UP * 300 - 1, null, 300, 300), 300);
});

test('refineTo: the ladder to a still view\'s cap', () => {
  const caps = [];
  let cap = 300;
  for (;;) {
    const next = refineTo(cap, null, 300, 16000);
    if (!next) break;
    caps.push(next);
    cap = next;
  }
  assert.deepEqual(caps, [300 * CAP_STEP, 300 * CAP_STEP * CAP_STEP, 16000]);
  assert.equal(refineTo(300, null, 300, 2000), 2000);
});

test('refineTo: a level refined but for a block goes to the target in one go', () => {
  // Interior texels have run to 3900 on average; the block the window moved over, to 300.
  const stats = { W: 40, I: 0.2, D: 0, C: 0.2 * 3900, next: 0 };
  assert.equal(reached(stats, 300), 3900);
  assert.equal(refineTo(300, stats, 300, 4000), 4000);
  // And is still refined when the mean is at the target but a block is not.
  assert.equal(refineTo(300, { ...stats, C: 0.2 * 4000 }, 300, 4000), 4000);
});

test('reached: the cap where nothing is inside or measured', () => {
  assert.equal(reached(null, 300), 300);
  assert.equal(reached({ W: 10, I: 0, C: 0 }, 300), 300);
  assert.equal(reached({ W: 10, I: 0.5, C: 50 }, 300), 300);
});

test('fillCost', () => {
  assert.equal(fillCost(null, false, 1000), UNKNOWN_INTERIOR * 1000 + TEXEL_COST);
  assert.equal(fillCost({ W: 50, I: 0.25 }, true, 1000), 50 + 250 + TEXEL_COST);
  assert.equal(fillCost({ W: 50, I: 0 }, true, 1000), 50 + TEXEL_COST);
  assert.equal(fillCost({ W: 50, I: 0 }, false, 1000), 50 + BORROWED_INTERIOR * 1000 + TEXEL_COST);
});

test('refineCost: the measurement where it was made for this cap', () => {
  assert.equal(refineCost(null, 1000), UNKNOWN_INTERIOR * 1000 + TEXEL_COST);
  assert.equal(refineCost({ I: 0.25, D: 77, next: 1000 }, 1000), 77 + TEXEL_COST);
  assert.equal(refineCost({ I: 0.25, D: 77, next: 500 }, 1000), 250 + TEXEL_COST);
});

test('shiftPlan', () => {
  assert.equal(shiftPlan(SHIFT_MIN - 1, -(SHIFT_MIN - 1), 1024), null);
  assert.deepEqual(shiftPlan(SHIFT_MIN, 3, 1024), { axis: 0, c: SHIFT_MIN });
  assert.deepEqual(shiftPlan(-60, -300, 1024), { axis: 1, c: -SHIFT_MAX });
  assert.deepEqual(shiftPlan(-400, 100, 1024), { axis: 0, c: -SHIFT_MAX });
  assert.equal(shiftPlan(512, 0, 1024), 'far');
  assert.equal(shiftPlan(10, -9000, 1024), 'far');
});

test('spans: split at the wrap', () => {
  assert.deepEqual(spans(10, 20, 1024), [[10, 10]]);
  assert.deepEqual(spans(1020, 1030, 1024), [[1020, 4], [0, 6]]);
  assert.deepEqual(spans(-6, 4, 1024), [[1018, 6], [0, 4]]);
  assert.deepEqual(spans(-2048 + 5, -2048 + 7, 1024), [[5, 2]]);
  assert.deepEqual(spans(0, 1024, 1024), [[0, 1024]]);
  assert.deepEqual(spans(7, 7, 1024), []);
});

test('advance: every texel of a block once, whatever the steps', () => {
  for (const [w, h, steps] of [[8, 5, [3, 3, 3, 100]], [128, 16, [1, 127, 129, 500, 5000]], [4, 4, [0, 16]], [5, 3, [2, 2, 2, 2, 2, 2, 2, 2]]]) {
    const seen = new Uint8Array(w * h), p = { done: 0, col: 0 };
    for (const n of steps) {
      let took = 0;
      for (const [x, y, pw, ph] of advance(p, w, h, n)) {
        assert.ok(x >= 0 && y >= 0 && x + pw <= w && y + ph <= h && pw > 0 && ph > 0);
        for (let j = y; j < y + ph; j++) for (let i = x; i < x + pw; i++) seen[j * w + i]++;
        took += pw * ph;
      }
      assert.ok(took <= n);
      if (p.done < h) assert.equal(took, n);
    }
    assert.equal(p.done, h);
    assert.equal(p.col, 0);
    assert.ok(seen.every((v) => v === 1));
  }
});

// Tails of a probe whose points escaped at the given counts.
const tailsOf = (counts) => PROBE_EDGES.map((e) => counts.filter((c) => c >= e).length);

test('capFor: the least cap when nothing escapes late, or nothing escapes', () => {
  assert.equal(capFor(tailsOf([3, 20, 60, 99]), 4, 0, 4000), PROBE_EDGES[0]);
  assert.equal(capFor(tailsOf([]), 4096, EPS_STILL, 4000), PROBE_EDGES[0]);
});

test('capFor: the first edge that leaves no more than the share short', () => {
  // 100 points: 90 escape early, 6 by 250, 3 by 1000, 1 at 5000.
  const counts = [...Array(90).fill(20), ...Array(6).fill(250), ...Array(3).fill(1000), 5000];
  const tails = tailsOf(counts);
  assert.equal(capFor(tails, 100, 0.05, 16000), 283); // 4 short
  assert.equal(capFor(tails, 100, 0.02, 16000), 1131); // 1 short
  assert.equal(capFor(tails, 100, 0, 16000), 6400);
  assert.equal(capFor(tails, 100, 0.2, 16000), PROBE_EDGES[0]);
});

test('capFor: never over the ceiling, and the ceiling where no edge under it does', () => {
  const tails = tailsOf([...Array(50).fill(20), ...Array(50).fill(9000)]);
  assert.equal(capFor(tails, 100, 0.05, 4000), 4000);
  assert.equal(capFor(tails, 100, 0.05, 16000), 9051);
  assert.equal(capFor(tailsOf([20, 20]), 2, 0, 80), 80);
  assert.ok(EPS_STILL < EPS_MOVE);
});

test('one step of the probe edges is not a catch-up; two are', () => {
  for (let b = 0; b + 2 < PROBE_EDGES.length; b++) {
    assert.equal(refineTo(PROBE_EDGES[b], null, PROBE_EDGES[b + 1], PROBE_EDGES[b + 1]), 0);
    assert.equal(refineTo(PROBE_EDGES[b], null, PROBE_EDGES[b + 2], PROBE_EDGES[b + 2]), PROBE_EDGES[b + 2]);
  }
});
