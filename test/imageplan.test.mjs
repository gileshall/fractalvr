import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { tune, createMotion, stepMotion, headFrom, bare, dropWithin, planSize, planView, CYCLE_MAX } from '../src/imageplan.js';

const DT = 1 / 72;
const UP = new THREE.Vector3(0, 1, 0);
const origin = new THREE.Vector3();

// A head turning about an axis at rate(t) for n frames; the stick turning the room at stick.
function turned(n, { rate = () => 0, stick = 0, axis = UP } = {}) {
  const motion = createMotion();
  const q = new THREE.Quaternion(), room = new THREE.Quaternion(), head = new THREE.Quaternion(), d = new THREE.Quaternion();
  for (let i = 0; i < n; i++) {
    head.premultiply(d.setFromAxisAngle(axis, rate(i * DT) * DT));
    room.premultiply(d.setFromAxisAngle(UP, stick * DT));
    stepMotion(motion, q.copy(room).multiply(head), origin, DT, { yaw: stick * DT });
  }
  return motion;
}
const size = (motion, over = {}) => planSize(motion, { share: 20, level: 0, dt: DT, was: 1, ...over }, { m: 0, k: 0 });
const view = (motion, k) => planView(motion, k, DT, { wider: 0, lead: 0, q: new THREE.Quaternion() });
const angleOf = (q) => 2 * Math.acos(Math.min(1, Math.abs(q.w)));

test('the head\'s turn is measured, the stick\'s is known from its first frame', () => {
  const head = turned(72, { rate: () => 0.8 });
  assert.ok(Math.abs(head.headVel.y - 0.8) < 0.01);
  assert.equal(head.stickRate, 0);
  assert.ok(Math.abs(head.turn - 0.8) < 0.01);

  const stick = turned(2, { stick: -1.2 });
  assert.ok(Math.abs(stick.stickRate + 1.2) < 1e-9);
  assert.ok(stick.headVel.length() < 1e-6);
  assert.ok(Math.abs(stick.turn - 1.2) < 1e-6);
});

test('in a tilted room the stick\'s turn is about the room\'s up', () => {
  const up = new THREE.Vector3(0.6, 0.8, 0);
  const motion = createMotion();
  const q = new THREE.Quaternion(), d = new THREE.Quaternion();
  for (let i = 0; i < 20; i++) stepMotion(motion, q.premultiply(d.setFromAxisAngle(up, 0.9 * DT)), origin, DT, { yaw: 0.9 * DT, up });
  assert.ok(motion.headVel.length() < 1e-6);
  assert.ok(motion.angVel.distanceTo(up.clone().multiplyScalar(0.9)) < 1e-6);
  const v = view(motion, 9);
  const axis = new THREE.Vector3(v.q.x, v.q.y, v.q.z).normalize();
  assert.ok(axis.distanceTo(up) < 1e-6);
});

test('the head turning against the stick is the view standing still', () => {
  const m = turned(72, { rate: () => 0.7, stick: -0.7 });
  assert.ok(Math.abs(m.headVel.y - 0.7) < 0.01);
  assert.ok(m.turn < 0.01);
});

test('a still view gets a full image; a turn shrinks it further than travel may', () => {
  assert.deepEqual(size(turned(72)), { m: 1, k: 20 });
  // A heavy scene: a full image is 160 display frames.
  assert.equal(size(turned(72, { rate: () => 1 }), { share: 160 }).m, 0.3);
  const turning = size(turned(72, { rate: () => 2 }), { share: 160 });
  assert.equal(turning.m, tune.smallTurn);
  assert.equal(turning.k, Math.ceil(160 * tune.smallTurn ** 2));
  const flying = createMotion();
  for (let i = 0; i < 72; i++) stepMotion(flying, new THREE.Quaternion(), new THREE.Vector3(i * DT, 0, 0), DT, { near: 1 });
  assert.ok(Math.abs(flying.parallax - 1) < 0.01);
  assert.equal(size(flying, { share: 160 }).m, tune.small);
});

test('an image is never planned past its level\'s longest', () => {
  for (const level of [0, 1, 2]) assert.equal(size(turned(72), { share: 500, level }).k, CYCLE_MAX[level]);
});

test('a held stick: the camera is aimed half way to where it would turn the view, wide enough for it let go', () => {
  const m = turned(10, { stick: 1.2 });
  const k = 9, T = (k - 1) * DT;
  const v = view(m, k);
  assert.ok(Math.abs(angleOf(v.q) - 1.2 * T) < 1e-6);
  assert.ok(v.q.y > 0);
  assert.ok(v.wider >= 1.2 * T - 0.25 * 0.03 && v.wider <= tune.widerMax);
  assert.equal(v.lead, 0);
  // Covered whether the stick is held to the end of the image's time on show or was let go at its start.
  assert.ok(v.wider + tune.bare >= Math.abs(1.2 * 2 * T - 1.2 * T) - 0.25 * 0.03);
});

test('a head speeding up is given more room, and the camera aimed further, than one holding its rate', () => {
  const steady = turned(72, { rate: () => 0.5 });
  const gaining = turned(72, { rate: (t) => 0.5 * t / (71 * DT) });
  assert.ok(Math.abs(gaining.headVel.y - steady.headVel.y) < 0.06);
  const a = view(steady, 12), b = view(gaining, 12);
  assert.ok(b.wider > a.wider);
  assert.ok(angleOf(b.q) > angleOf(a.q));
});

test('one frame\'s image is the eyes\' own view', () => {
  const v = view(turned(72, { rate: () => 1, stick: 1 }), 1);
  assert.equal(v.wider, 0);
  assert.equal(v.lead, 0);
  assert.ok(angleOf(v.q) < 1e-9);
});

test('an image is bare once the view has turned past what it sees', () => {
  const m = turned(72, { rate: () => 0.5 });
  const img = { q: m.q.clone(), p: origin.clone(), wider: 0.06 };
  assert.equal(bare(m, img), false);
  const q = new THREE.Quaternion();
  stepMotion(m, q.setFromAxisAngle(UP, 0.08).multiply(m.q), origin, DT);
  headFrom(m, img);
  assert.ok(Math.abs(m._o.y - 0.08) < 1e-6);
  assert.equal(bare(m, img), true);
});

test('an image in progress is kept while it will cover the view, dropped for a sooner one when it will not, and for a later one when it would arrive bare', () => {
  const m = turned(72, { rate: () => 0.5 });
  const img = { q: m.q.clone(), p: origin.clone(), wider: 0.06 };
  assert.equal(dropWithin(m, img, null, Infinity, 0.2), -1); // 0.1 rad on, within its 0.06 and the slack
  assert.equal(dropWithin(m, img, null, Infinity, 0.3), 0);
  assert.equal(dropWithin(m, img, null, Infinity, 0.4), tune.dropFrames); // 0.2 rad on: 0.14 past its border
  // The image on show already bare: no reason to wait longer than a new one takes.
  const shown = { q: new THREE.Quaternion().setFromAxisAngle(UP, -0.1).multiply(m.q), p: origin.clone(), wider: 0.06 };
  assert.equal(dropWithin(m, img, shown, Infinity, 0.2), 0);
  // The nearest surface shifting past what the image holds.
  const flying = createMotion();
  for (let i = 0; i < 72; i++) stepMotion(flying, new THREE.Quaternion(), new THREE.Vector3(i * DT, 0, 0), DT, { near: 1 });
  const here = { q: flying.q.clone(), p: flying.p.clone(), wider: 0 };
  assert.equal(dropWithin(flying, here, null, 1, 0.05), -1);
  assert.equal(dropWithin(flying, here, null, 1, 0.1), 0);
});
