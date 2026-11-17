import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { wristTurn } from '../src/wrist.js';

const pose = (yaw, pitch, roll) => new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
// The turn summed along a path of poses.
const along = (poses) => poses.slice(1).reduce((sum, q, i) => sum + wristTurn(poses[i], q), 0);
const steps = (n, f) => Array.from({ length: n + 1 }, (_, i) => f(i / n));

test('a roll of the wrist is that much of a turn, clockwise, wherever the hand points', () => {
  for (const [yaw, pitch] of [[0, 0], [1.1, 0.4], [-2, -0.7], [0.3, -1.5], [0.3, 1.5]]) {
    const turn = along(steps(20, (f) => pose(yaw, pitch, -0.6 * f)));
    assert.ok(Math.abs(turn - 0.6) < 1e-9, `${yaw}, ${pitch}: ${turn}`);
  }
});

test('a level hand swept about is no turn, though it points up or down', () => {
  for (const pitch of [0.5, -0.5, -1]) {
    const turn = along(steps(60, (f) => pose(-0.8 + 1.6 * f, pitch, 0.1)));
    assert.ok(Math.abs(turn) < 1e-9, `pitch ${pitch}: ${turn}`);
  }
  // round a loop and back where it began
  const loop = steps(200, (f) => pose(0.6 * Math.cos(f * 2 * Math.PI), 0.3 + 0.5 * Math.sin(f * 2 * Math.PI), 0));
  assert.ok(Math.abs(along(loop)) < 1e-9);
});

test('pointing straight down, the hand turned about its ray is the turn', () => {
  // about the room's upright, which is the ray: seen from behind the hand, clockwise
  const turn = along(steps(20, (f) => pose(-0.5 * f, -Math.PI / 2 + 0.02, 0)));
  assert.ok(Math.abs(turn - 0.5) < 0.01, `${turn}`);
});

test('no step of it is wild near straight down', () => {
  const path = steps(100, (f) => pose(0.2, -Math.PI / 2 + 0.4 * (f - 0.5), 0.1));
  for (let i = 1; i < path.length; i++) assert.ok(Math.abs(wristTurn(path[i - 1], path[i])) < 0.02, `step ${i}`);
});
