import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

globalThis.innerWidth = 1600;
globalThis.innerHeight = 900;
const { leg, rng } = await import('../tools/toursim.mjs');
const { Rig } = await import('../src/rig.js');
const { FRACTALS, FORMULAS, FALL_TARGETS, ORDER } = await import('../src/fractals.js');
const { TURN_MAX } = await import('../src/pilot.js');
const { stops, Playlist, boundaryPoint, face, frontOf } = await import('../src/tour.js');
const { escapeIters } = await import('../src/perturb.js');
const { dd } = await import('../src/dd.js');

test('a tour\'s places: the bookmarks, every fractal, the named places of the plane', () => {
  const marks = [{ name: 'mine', fractal: 1 }, { name: 'of a fractal since gone', fractal: 99 }];
  const list = stops(marks);
  assert.equal(list.length, 1 + FRACTALS.length + FALL_TARGETS.length);
  assert.equal(list[0].mark, marks[0]);
  for (const i of ORDER) assert.equal(list.filter((s) => s.fractal === i && (s.home || s.edge)).length, 1);
  for (const s of list) assert.equal(s.kind, FRACTALS[s.fractal].kind);
  for (const s of list.filter((x) => x.target)) assert.equal(FRACTALS[s.fractal].formula, s.target.formula);
});

test('a tour goes to every place before any again, and to no fractal twice running', () => {
  const list = stops([]);
  for (const seed of [1, 2, 3, 4, 5]) {
    const p = new Playlist(list, rng(seed));
    const seen = [];
    for (let n = 0; n < 3 * list.length; n++) seen.push(p.next());
    for (let d = 0; d < 3; d++) assert.equal(new Set(seen.slice(d * list.length, (d + 1) * list.length)).size, list.length);
    for (let n = 1; n < seen.length; n++) assert.notEqual(seen[n].fractal, seen[n - 1].fractal, `${seen[n].name} after ${seen[n - 1].name}`);
  }
});

test('back is the place before, and the first again at the start', () => {
  const p = new Playlist(stops([]), rng(7));
  assert.ok(p.prev()); // before any: the first
  const q = new Playlist(stops([]), rng(7));
  const a = q.next(), b = q.next();
  assert.equal(q.prev(), a);
  assert.equal(q.prev(), a);
  assert.equal(q.next(), b);
});

test('a 2D stop is a point of the boundary: about it some leave, and some stay or take long to', () => {
  for (const i of ORDER) {
    const f = FRACTALS[i];
    if (f.kind !== '2d' || f.formula === 'julia') continue;
    const r = rng(i);
    for (let n = 0; n < 5; n++) {
      const c = boundaryPoint(f, {}, r);
      assert.ok(Math.abs(c[0] - f.home.cx) <= f.home.scale && Math.abs(c[1] - f.home.cy) <= f.home.scale, `${f.name}: out of its home view`);
      let leaves = 0, long = 0;
      for (let k = 0; k < 64; k++) {
        const a = k * 2.399963, rad = 1e-9 * Math.sqrt((k + 1) / 64);
        const count = escapeIters(dd(c[0] + rad * Math.cos(a)), dd(c[1] + rad * Math.sin(a)), FORMULAS[f.formula].step, 2000);
        if (count >= 0) leaves++;
        if (count < 0 || count > 400) long++;
      }
      assert.ok(leaves > 0, `${f.name}: nothing leaves about ${c}`);
      assert.ok(long > 0, `${f.name}: all leave at once about ${c}`);
    }
  }
});

test('a Julia stop is a point of the set, of a piece or dust, and not the same one each time', () => {
  // The distance to the set, as estimated from a point outside it; 0 from one that never leaves.
  const dist = (zx, zy, c) => {
    let dx = 1, dy = 0;
    for (let i = 0; i < 5000; i++) {
      const r2 = zx * zx + zy * zy;
      if (r2 > 1e12) return Math.sqrt(r2) * Math.log(r2) / (2 * Math.hypot(dx, dy));
      [dx, dy] = [2 * (zx * dx - zy * dy), 2 * (zx * dy + zy * dx)];
      [zx, zy] = [zx * zx - zy * zy + c.p1, 2 * zx * zy + c.p2];
    }
    return 0;
  };
  const f = FRACTALS.find((x) => x.formula === 'julia');
  // The fractal's own, a dendrite, a dust far out, a rabbit.
  for (const c of [Object.fromEntries(f.params.map((p) => [p.key, p.def])), { p1: 0, p2: 1 }, { p1: 0.4, p2: 0.4 }, { p1: -0.123, p2: 0.745 }]) {
    const r = rng(11);
    const seen = new Set();
    for (let n = 0; n < 8; n++) {
      const z = boundaryPoint(f, c, r);
      seen.add(z.map((v) => v.toFixed(6)).join());
      assert.ok(dist(z[0], z[1], c) < 1e-11, `c ${c.p1}, ${c.p2}: ${z} is ${dist(z[0], z[1], c)} from the set`);
      // Of its edge, not its inside: beside it some leave.
      let leave = 0;
      for (let k = 0; k < 64; k++) {
        const a = k * 2.399963, rad = 1e-4 * Math.sqrt((k + 1) / 64);
        if (dist(z[0] + rad * Math.cos(a), z[1] + rad * Math.sin(a), c) > 1e-7) leave++;
      }
      assert.ok(leave > 0, `c ${c.p1}, ${c.p2}: nothing leaves about ${z}`);
    }
    assert.ok(seen.size >= 6, 'the same point again and again');
  }
});

test('the room turns to keep its front over the heading, no faster than asked', () => {
  const rig = new Rig();
  rig.dolly.position.set(0.3, -1.2, 2);
  rig.dolly.quaternion.setFromEuler(new THREE.Euler(0.4, -1.1, 0.3));
  rig.dolly.scale.setScalar(0.02);
  rig.dolly.updateMatrixWorld(true);
  rig.camera.quaternion.setFromEuler(new THREE.Euler(0.2, 0.9, 0));
  const front = frontOf(rig.camera);
  assert.ok(Math.abs(front.y) < 1e-12 && Math.abs(front.length() - 1) < 1e-12);
  const head = rig.headWorld().clone();
  const heading = new THREE.Vector3(-0.6, 0.4, -0.3).normalize();
  const off = () => {
    const up = rig.up().clone();
    const f = front.clone().applyQuaternion(rig.dolly.quaternion);
    const h = heading.clone().addScaledVector(up, -heading.dot(up));
    return Math.atan2(f.clone().cross(h).length(), f.dot(h)); // acos is blind this near nothing
  };
  const before = off();
  assert.ok(before > 0.3);
  const turned = face(rig, heading.toArray(), front, 0.1);
  assert.ok(Math.abs(Math.abs(turned) - 0.1) < 1e-12);
  assert.ok(Math.abs(off() - (before - 0.1)) < 1e-9);
  face(rig, heading.toArray(), front);
  assert.ok(off() < 1e-9);
  rig.dolly.updateMatrixWorld(true);
  assert.ok(rig.headWorld().distanceTo(head) < 1e-9); // about the head
});

test('a tour flies every 3D fractal: down into it, by its surfaces, never through one, gently', () => {
  for (const i of ORDER) {
    if (FRACTALS[i].kind !== '3d') continue;
    const r = leg(i, { seconds: 40, seed: 1 });
    const name = r.fractal;
    assert.equal(r.inside, 0, `${name}: the head went under a surface`);
    assert.ok(r.lost < 1, `${name}: ${r.lost} s with nothing in reach`);
    assert.ok(r.near[0] > 0.05, `${name}: came within ${r.near[0]} m of a surface`);
    assert.ok(r.solid > 0.5, `${name}: only ${r.solid} of the ways ahead end on a surface`);
    assert.ok(r.scale[1] < r.scale[0] / 4, `${name}: the room went from ${r.scale[0]} to ${r.scale[1]}`);
    assert.ok(r.turn <= TURN_MAX * 1.05, `${name}: the heading turned at ${r.turn} rad/s`);
    assert.ok(r.yaw <= 0.3 * 1.01, `${name}: the room turned at ${r.yaw} rad/s`);
  }
});
