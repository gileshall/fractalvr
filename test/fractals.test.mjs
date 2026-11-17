import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRACTALS, FORMULAS, ORDER, POLY, BOX_TOL, polyFold, polyDir, kaliEscape } from '../src/fractals.js';

const box = FRACTALS.find((f) => f.name === 'Mandelbox');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// The estimator with every iteration run.
function whole(p, u) {
  let z = [...p], dr = 1;
  for (let i = 0; i < (u.p4 | 0); i++) {
    z = z.map((v) => clamp(v, -u.p3, u.p3) * 2 - v);
    const r2 = z[0] * z[0] + z[1] * z[1] + z[2] * z[2];
    const t = r2 < u.p2 * u.p2 ? 1 / (u.p2 * u.p2) : r2 < 1 ? 1 / r2 : 1;
    z = z.map((v, k) => u.p1 * v * t + p[k]);
    dr = dr * t * Math.abs(u.p1) + 1;
  }
  return Math.hypot(...z) / dr;
}

// Points from far outside the box to deep in its surface: along rays, each a tenth as far from it as the last.
function* points(u, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  for (let n = 0; n < 300; n++) {
    let p = [rnd() * 40, rnd() * 40, rnd() * 40];
    const to = [rnd() * 2, rnd() * 2, rnd() * 2];
    for (let k = 0; k < 40; k++) {
      yield p;
      const d = whole(p, u), l = Math.hypot(to[0] - p[0], to[1] - p[1], to[2] - p[2]);
      if (!(d > 1e-7) || l < 1e-9) break;
      p = p.map((v, i) => v + (to[i] - v) / l * Math.min(d * 0.9, l));
    }
  }
}

test('the Mandelbox estimator, stopping early, stays within its tolerance of all its iterations', () => {
  const sets = [
    { p1: 2, p2: 0.5, p3: 1, p4: 12 },
    { p1: 2.8064669370651245, p2: 0.5873612761497498, p3: 0.8005704283714294, p4: 12 },
    { p1: -1.5, p2: 0.5, p3: 1, p4: 12 },
    { p1: 3, p2: 0.05, p3: 2, p4: 24 },
    { p1: 1.3, p2: 1, p3: 0.5, p4: 20 },
    { p1: -3, p2: 0.3, p3: 1.4, p4: 6 },
  ];
  for (const u of sets) {
    let worst = 0, n = 0;
    for (const p of points(u, 7)) {
      const a = whole(p, u), b = box.de(p, u);
      if (a < 1e-9) continue;
      worst = Math.max(worst, Math.abs(b / a - 1));
      n++;
    }
    assert.ok(n > 2000, `${n} points`);
    assert.ok(worst <= BOX_TOL, `scale ${u.p1}: ${worst}`);
  }
});

test('a Mandelbox that does not grow is iterated to the end', () => {
  for (const u of [{ p1: 1, p2: 0.5, p3: 1, p4: 12 }, { p1: -0.7, p2: 0.5, p3: 1, p4: 12 }, { p1: 0.4, p2: 0.2, p3: 2, p4: 9 }]) {
    for (const p of [[30, -2, 5], [0.3, 0.2, 0.1], [900, 900, 900], [-1.2, 4, 0]]) assert.ok(Math.abs(box.de(p, u) - whole(p, u)) <= 1e-12 * whole(p, u));
  }
});

const byName = (n) => FRACTALS.find((f) => f.name === n);
const defaults = (f) => Object.fromEntries(f.params.map((p) => [p.key, p.def]));
const lcg = (seed) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); };

test('the catalogue: old places keep their numbers, each kind has what its shader needs', () => {
  // Sessions and bookmarks hold these numbers.
  assert.deepEqual(FRACTALS.slice(0, 9).map((f) => f.name), ['Mandelbulb', 'Mandelbox', 'Menger', 'Sierpinski', 'Quaternion Julia', 'Apollonian', 'Mandelbrot', 'Burning Ship', 'Julia']);
  assert.deepEqual([...ORDER].sort((a, b) => a - b), FRACTALS.map((_, i) => i));
  assert.ok(ORDER.every((i, k) => k === 0 || FRACTALS[ORDER[k - 1]].kind === '3d' || FRACTALS[i].kind === '2d'), '3D first');
  assert.equal(new Set(FRACTALS.map((f) => f.name)).size, FRACTALS.length);
  assert.equal(new Set(Object.values(FORMULAS).map((f) => f.id)).size, Object.keys(FORMULAS).length);
  const steps = Object.entries(FORMULAS).filter(([k]) => k !== 'julia').map(([, f]) => f.step);
  assert.equal(new Set(steps).size, steps.length, 'no two formulas are one iteration');
  for (const f of FRACTALS) {
    if (f.kind === '2d') { assert.ok(FORMULAS[f.formula], f.name); continue; }
    assert.match(f.glsl, /^de[A-Z]\w+$/, f.name);
    assert.ok(f.params.length <= 8 && f.params.every((p, i) => p.key === `p${i + 1}`), `${f.name}: parameters p1.. in order`);
    const d = f.de([f.start[0], f.start[1] + 1.6, f.start[2]], defaults(f));
    assert.ok(d > 0.05, `${f.name}: the head starts ${d} from the surface`);
  }
});

test('the Kalibox estimator, stopping early, stays within its tolerance of all its iterations', () => {
  const kali = byName('Kalibox');
  const all = (p, u) => {
    let z = [...p], dr = 1;
    for (let i = 0; i < (u.p8 | 0); i++) {
      z = [Math.abs(z[0]) + u.p3, Math.abs(z[1]) + u.p4, Math.abs(z[2]) + u.p3];
      const k = u.p1 / clamp(z[0] * z[0] + z[1] * z[1] + z[2] * z[2], u.p2 * u.p2, 1);
      z = [z[0] * k + u.p5, z[1] * k + u.p6, z[2] * k + u.p7];
      dr = dr * k + 1;
    }
    return (Math.hypot(...z) - kaliEscape(u)) / dr;
  };
  const sets = [defaults(kali), { ...defaults(kali), p1: 1.3, p8: 20 }, { ...defaults(kali), p1: 3, p2: 0.2, p3: -0.4, p4: -1.7, p5: -1.2, p6: 0.6, p7: 1.9 }, { ...defaults(kali), p1: 2.4, p3: 0.5, p4: 0.3, p8: 6 }];
  for (const u of sets) {
    const rnd = lcg(11);
    let worst = 0, n = 0;
    for (let r = 0; r < 300; r++) {
      let p = [rnd() * 80 - 40, rnd() * 80 - 40, rnd() * 80 - 40];
      const to = [rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2];
      for (let k = 0; k < 40; k++) {
        const a = all(p, u), l = Math.hypot(to[0] - p[0], to[1] - p[1], to[2] - p[2]);
        if (!(a > 1e-7) || l < 1e-9) break;
        worst = Math.max(worst, Math.abs(kali.de(p, u) / a - 1));
        n++;
        p = p.map((v, i) => v + (to[i] - v) / l * Math.min(a * 0.9, l));
      }
    }
    assert.ok(n > 1000, `${n} points`);
    assert.ok(worst <= BOX_TOL, `scale ${u.p1}: ${worst}`);
  }
});

test('the Kalibox is solid: under zero wherever the iterations leave a point within the escape radius', () => {
  const kali = byName('Kalibox');
  const within = (p, u) => {
    let z = [...p];
    for (let i = 0; i < (u.p8 | 0); i++) {
      z = [Math.abs(z[0]) + u.p3, Math.abs(z[1]) + u.p4, Math.abs(z[2]) + u.p3];
      const k = u.p1 / clamp(z[0] * z[0] + z[1] * z[1] + z[2] * z[2], u.p2 * u.p2, 1);
      z = [z[0] * k + u.p5, z[1] * k + u.p6, z[2] * k + u.p7];
    }
    return Math.hypot(...z) <= kaliEscape(u);
  };
  for (const u of [defaults(kali), { ...defaults(kali), p8: 6 }, { ...defaults(kali), p1: 1.6, p2: 0.3, p8: 16 }]) {
    const rnd = lcg(5);
    let inside = 0, outside = 0, met = 0;
    // Rays walked by the estimate come to the solid, however thin, and do not creep through it.
    for (let r = 0; r < 200; r++) {
      const o = [rnd() * 6 - 3, rnd() * 6 - 3, rnd() * 6 - 3], to = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
      const l = Math.hypot(to[0] - o[0], to[1] - o[1], to[2] - o[2]), d = to.map((v, i) => (v - o[i]) / l);
      let t = 0;
      for (let i = 0; i < 3000 && t < 12; i++) {
        const p = o.map((v, a) => v + d[a] * t), e = kali.de(p, u);
        assert.equal(e <= 0, within(p, u), `${p}: ${e}`);
        if (e <= 0) { met++; break; }
        outside++;
        t += Math.max(e * 0.9, 1e-12);
      }
      for (let k = 1; k <= 20 && t < 12; k++) {
        const p = o.map((v, a) => v + d[a] * (t + k * 1e-6)), e = kali.de(p, u);
        assert.equal(e <= 0, within(p, u), `${p}: ${e}`);
        if (e <= 0) inside++;
      }
    }
    assert.ok(met > 150, `scale ${u.p1}, ${u.p8} iterations: ${met} rays of 200 met it`);
    assert.ok(inside > 1000 && outside > 1000, `${inside} inside, ${outside} outside`);
  }
});

test('a polyhedral fold brings every image of a point under its mirrors to one place in its chamber', () => {
  const reflect = (z, n) => { const d = 2 * (z[0] * n[0] + z[1] * n[1] + z[2] * n[2]); return [z[0] - d * n[0], z[1] - d * n[1], z[2] - d * n[2]]; };
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const r2 = Math.SQRT1_2;
  const mirrors = { true: [...axes, POLY.icosa.n1, POLY.icosa.n2], false: [...axes, [r2, -r2, 0], [0, r2, -r2], [r2, 0, -r2]] };
  for (const icosa of [true, false]) {
    const rnd = lcg(5), M = mirrors[icosa];
    const images = new Set();
    for (let k = 0; k < 400; k++) {
      const p = [rnd() * 6 - 3, rnd() * 6 - 3, rnd() * 6 - 3];
      const home = [...p];
      polyFold(home, icosa);
      assert.ok(Math.abs(Math.hypot(...home) - Math.hypot(...p)) < 1e-12);
      let q = p;
      for (let j = 0; j < 40; j++) {
        q = reflect(q, M[rnd() * M.length | 0]);
        const f = [...q];
        polyFold(f, icosa);
        assert.ok(Math.hypot(f[0] - home[0], f[1] - home[1], f[2] - home[2]) < 1e-11, `${icosa ? 'icosahedral' : 'octahedral'}: ${p} folds to two places`);
        if (k === 0) images.add(q.map((v) => v.toFixed(6)).join());
      }
      for (let j = 0; j < 2000 && k === 0; j++) { q = reflect(q, M[rnd() * M.length | 0]); images.add(q.map((v) => v.toFixed(6)).join()); }
    }
    assert.equal(images.size, icosa ? 120 : 48, 'images of a point');
    // The chamber's corners are where it says, and a direction between them is one of length 1.
    for (const c of POLY[icosa ? 'icosa' : 'octa'].corners) { const f = [...c]; polyFold(f, icosa); assert.ok(Math.hypot(f[0] - c[0], f[1] - c[1], f[2] - c[2]) < 1e-12); }
    for (const t of [0, 0.3, 1, 1.7, 2]) assert.ok(Math.abs(Math.hypot(...polyDir(t, icosa)) - 1) < 1e-12);
  }
});

// From the start over a wide view, along each ray: the steepest the estimator fell within 0.9 of
// what it said, and the share of those balls with a point at or under the surface in them.
function vouched(f, u) {
  const rnd = lcg(99), o = [f.start[0], f.start[1] + 1.6, f.start[2]];
  let steepest = 0, balls = 0, breached = 0;
  for (let j = 0; j < 12; j++) for (let i = 0; i < 12; i++) {
    const d = [(i + 0.5) / 6 - 1, (j + 0.5) / 6 - 1, -1], l = Math.hypot(...d);
    let t = 0;
    for (let k = 0; k < 300 && t < 60; k++) {
      const p = o.map((v, a) => v + d[a] / l * t), de = f.de(p, u);
      if (!(de > Math.max(t * 1e-3, 1e-5))) break;
      balls++;
      let under = false;
      for (let m = 0; m < 30; m++) {
        const v = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], vl = Math.hypot(...v);
        const dq = f.de(p.map((x, a) => x + v[a] / vl * de * 0.9), u);
        if (dq <= 0) under = true;
        steepest = Math.max(steepest, (de - dq) / (0.9 * de));
      }
      if (under) breached++;
      t += de * 0.9;
    }
  }
  return { steepest, balls, breached: breached / balls };
}

test('the new estimators vouch for no more than is clear', () => {
  // These fall no faster than the distance does: a step of the estimate cannot pass a surface.
  for (const name of ['Kalibox', 'Icosahedron', 'Octahedron']) {
    const f = byName(name);
    for (const u of [defaults(f), ...variants(f)]) {
      const v = vouched(f, u);
      assert.ok(v.balls > 500, `${name}: ${v.balls} balls`);
      assert.ok(v.steepest <= 1 + 1e-9, `${name} ${JSON.stringify(u)}: falls ${v.steepest} a unit`);
    }
  }
  // These are estimates, as the Mandelbulb's is: a ball in a hundred or so reaches the surface,
  // and the step after it lands on it.
  for (const name of ['Mandelbulb', 'Julia Bulb', 'Pseudo-Kleinian']) {
    const f = byName(name), v = vouched(f, defaults(f));
    assert.ok(v.balls > 500, `${name}: ${v.balls} balls`);
    assert.ok(v.breached < 0.03, `${name}: ${v.breached} of its balls reach the surface`);
  }
});

// A fractal's parameters each at a quarter and three quarters of its range, the others as set.
function variants(f) {
  const out = [];
  for (const p of f.params) {
    if (p.name === 'iterations') continue;
    for (const t of [0.25, 0.75]) out.push({ ...defaults(f), [p.key]: p.min + (p.max - p.min) * t });
  }
  return out;
}

test('every 3D estimator is a number over its parameters\' ranges', () => {
  const rnd = lcg(3);
  for (const f of FRACTALS.filter((x) => x.kind === '3d')) {
    for (const u of [defaults(f), ...variants(f)]) {
      assert.ok(Number.isFinite(f.bound(u)) && f.bound(u) >= 0, `${f.name}: bound`);
      for (const p of [[1000.3, -999.1, 1000.7], ...Array.from({ length: 200 }, () => [rnd() * 8 - 4, rnd() * 8 - 4, rnd() * 8 - 4])]) {
        assert.ok(!Number.isNaN(f.de(p, u)), `${f.name} at ${p} with ${JSON.stringify(u)}`);
      }
    }
  }
});
