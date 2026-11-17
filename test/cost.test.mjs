import test from 'node:test';
import assert from 'node:assert/strict';
import { cumulate, heightAt } from '../src/cost.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

test('even work: equal shares of rows', () => {
  const rows = new Float32Array(8).fill(50), cum = new Float64Array(9);
  const total = cumulate(cum, rows, 0.02, 1000, 4000);
  near(total, 4000 + 0.02 * 50 * 1000);
  for (let k = 0; k <= 10; k++) near(heightAt(cum, k / 10), k / 10, 1e-6);
});

test('no geometry work: equal shares of rows', () => {
  const cum = new Float64Array(5);
  cumulate(cum, new Float32Array(4), 0.02, 1000, 4000);
  near(heightAt(cum, 0.3), 0.3, 1e-6);
});

test('work in the upper half: fewer rows per share there', () => {
  // The accumulate pass costs 1 a band, the geometry 3 a band in the upper two: 1 1 4 4.
  const rows = Float32Array.from([0, 0, 300, 300]), cum = new Float64Array(5);
  const total = cumulate(cum, rows, 0.01, 4000, 4000);
  near(total, 10000);
  near(heightAt(cum, 0.1), 0.25, 1e-6);
  near(heightAt(cum, 0.2), 0.5, 1e-6);
  near(heightAt(cum, 0.6), 0.75, 1e-6);
  near(heightAt(cum, 0.8), 0.875, 1e-6);
});

test('every share of the cost is the same size', () => {
  const rows = Float32Array.from([0, 3, 18, 39, 44, 45, 48, 48, 45, 44, 38, 18, 3, 0, 0, 900]), cum = new Float64Array(17);
  const total = cumulate(cum, rows, 0.02, 2000, 6000);
  const costBelow = (y) => {
    let c = 0;
    for (let j = 0; j < 16; j++) c += Math.max(0, Math.min(1, y * 16 - j)) * (6000 + 0.02 * rows[j] * 2000) / 16;
    return c;
  };
  let last = 0;
  for (let n = 1; n <= 24; n++) {
    const y = heightAt(cum, n / 24);
    assert.ok(y > last);
    near(costBelow(y) - costBelow(last), total / 24, total * 1e-5);
    last = y;
  }
  near(last, 1);
});
