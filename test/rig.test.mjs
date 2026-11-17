import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

globalThis.innerWidth = 1600;
globalThis.innerHeight = 900;
const { Rig, SCALE_MAX } = await import('../src/rig.js');
const { state, setFractal } = await import('../src/state.js');
const { FRACTALS } = await import('../src/fractals.js');

const near = (a, b, eps = 1e-9) => assert.ok(a.distanceTo(b) < eps, `${a.toArray()} is not ${b.toArray()}`);

// A room somewhere in the world, turned and scaled.
function room() {
  const rig = new Rig();
  rig.dolly.position.set(0.3, -1.2, 2);
  rig.dolly.quaternion.setFromEuler(new THREE.Euler(0.9, -1.1, 0.6));
  rig.dolly.scale.setScalar(0.02);
  rig.dolly.updateMatrixWorld(true);
  return rig;
}
const inRoom = (rig, world) => { rig.dolly.updateMatrixWorld(true); return rig.dolly.worldToLocal(world.clone()); };

test('carried, the world turns about the place held and moves with the hand', () => {
  const rig = room();
  const held = new THREE.Vector3(0.31, -1.19, 1.97), other = new THREE.Vector3(0.36, -1.25, 1.99);
  const c = inRoom(rig, held), x = inRoom(rig, other);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.2, 1, -0.4).normalize(), 0.3);
  const t = new THREE.Vector3(0.02, -0.01, 0.05);
  assert.equal(rig.carry(c.clone(), q, t), true);
  near(inRoom(rig, held), c.clone().add(t));
  near(inRoom(rig, other), x.clone().sub(c).applyQuaternion(q).add(c).add(t));
  assert.equal(rig.scale, 0.02);
});

test('a hand that jumps carries nothing', () => {
  const rig = room();
  const p = rig.dolly.position.clone(), r = rig.dolly.quaternion.clone();
  const c = new THREE.Vector3(0, 1.2, -0.8);
  assert.equal(rig.carry(c, new THREE.Quaternion(), new THREE.Vector3(0.4, 0, 0)), false);
  assert.equal(rig.carry(c, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7), new THREE.Vector3()), false);
  assert.ok(rig.dolly.position.equals(p));
  assert.ok(rig.dolly.quaternion.equals(r));
});

test('the stick turns a tilted room about its own up, through the head', () => {
  const rig = room();
  const head = rig.headWorld().clone(), up = rig.up().clone();
  assert.ok(Math.abs(up.y) < 0.95); // tilted
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.dolly.quaternion);
  rig.turn(0.5);
  rig.dolly.updateMatrixWorld(true);
  near(rig.headWorld(), head);
  near(rig.up(), up);
  const now = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.dolly.quaternion);
  assert.ok(Math.abs(fwd.angleTo(now) - 0.5) < 1e-9);
});

// The room at a fractal's start, its size settled with the nearest surface kept at `arm`.
function settled(i, arm) {
  setFractal(i);
  const rig = new Rig();
  rig.reset(FRACTALS[i]);
  for (let n = 0; n < 2000 && !rig.autoZoom(1 / 72, arm); n++) rig.dolly.updateMatrixWorld(true);
  rig.dolly.updateMatrixWorld(true);
  return rig;
}

test('however near the surface is held, the room never grows until the fractal is a pea', () => {
  for (let i = 0; i < FRACTALS.length; i++) {
    const f = FRACTALS[i];
    if (f.kind !== '3d') continue;
    const home = settled(i, 1);
    assert.ok(home.scale < home.maxScale * 0.75, `${f.name}: its start (${home.scale}) is at the most the room may be (${home.maxScale})`);
    const rig = settled(i, 0.05);
    assert.ok(rig.scale <= rig.maxScale && rig.maxScale <= SCALE_MAX);
    rig.zoom(1e6);
    assert.equal(rig.scale, rig.maxScale);
    const bound = f.bound(state.params);
    if (bound > 0) assert.ok(2 * bound / rig.scale > 0.3, `${f.name}: ${2 * bound / rig.scale} m across`);
    // And it is in front of the head, not about it: further off than it is across the middle.
    const away = rig.headWorld().length() / rig.scale;
    assert.ok(away > 0.25, `${f.name}: its middle ${away} m from the head`);
  }
});
