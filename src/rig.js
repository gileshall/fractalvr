import * as THREE from 'three';
import { state, currentFractal } from './state.js';

// The room (dolly) placed and scaled in fractal space. World space == fractal space.
// dolly.scale = fractal units per room metre.

export const SCALE_MIN = 1e-4;
export const SCALE_MAX = 50;
// The room is no bigger than this many times the distance a fractal is first seen from: at
// its biggest the whole of the fractal is still a thing half a metre or so across, not a pea.
export const ROOM_MOST = 2;
const EYE = 1.6; // metres up the room a fractal's start puts the head
const CARRY_MAX = [0.25, 0.5]; // metres, radians a hand may move in one frame: more is its tracking jumping

export class Rig {
  constructor() {
    this.dolly = new THREE.Group();
    this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.01, 1000);
    this.camera.position.set(0, 1.6, 0);
    this.dolly.add(this.camera);
    this._head = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this.lastDE = Infinity; // fractal units, at the head
    this.lastSafe = null; // dolly position where the head last had clearance
    this.minScale = SCALE_MIN; // raised by the app where the estimator runs out of precision
    this.maxScale = SCALE_MAX; // lowered by reset() to what the fractal's size allows
    this.settle = false; // auto zoom may run without locomotion until it converges (reset, teleport)
  }

  get scale() { return this.dolly.scale.x; }

  headWorld() {
    return this.camera.getWorldPosition(this._head);
  }

  reset(f) {
    this.dolly.position.fromArray(f.start ?? [0, 0, 0]);
    this.dolly.quaternion.identity();
    this.dolly.scale.setScalar(1);
    this.dolly.updateMatrixWorld(true);
    // A 2D fractal has no start: the room is its own size there.
    this.maxScale = f.start ? Math.min(SCALE_MAX, ROOM_MOST * Math.hypot(f.start[0], f.start[1] + EYE, f.start[2])) : SCALE_MAX;
    this.lastSafe = null;
    this.settle = true;
  }

  // Distance estimate at the head, in fractal units.
  deAt(p) {
    const f = currentFractal();
    return f.de([p.x, p.y, p.z], state.params);
  }

  deAtHead() {
    this.lastDE = this.deAt(this.headWorld());
    return this.lastDE;
  }

  // Outward unit normal of the distance field at p.
  normalAt(p, eps) {
    const f = currentFractal();
    const P = state.params;
    const d = (dx, dy, dz) => f.de([p.x + dx, p.y + dy, p.z + dz], P);
    const n = new THREE.Vector3(d(eps, 0, 0) - d(-eps, 0, 0), d(0, eps, 0) - d(0, -eps, 0), d(0, 0, eps) - d(0, 0, -eps));
    return n.lengthSq() > 0 ? n.normalize() : n.set(0, 1, 0);
  }

  // Move the room by a room-space displacement expressed in world direction units.
  fly(dirWorld, metres) {
    this.dolly.position.addScaledVector(dirWorld, metres * this.scale);
  }

  // The room's up in the world: a grab may leave the room turned any way.
  up() { return this._up.set(0, 1, 0).applyQuaternion(this.dolly.quaternion); }

  turn(angle) {
    const h = this.headWorld().clone(), up = this.up();
    this.dolly.position.sub(h).applyAxisAngle(up, angle).add(h);
    this.dolly.quaternion.premultiply(this._q.setFromAxisAngle(up, angle)).normalize();
  }

  // The world carried as a thing in the room: turned by q about the room point c and shifted
  // by t (room frame, metres). False, and nothing moved, where that is no hand's motion.
  carry(c, q, t) {
    if (t.length() > CARRY_MAX[0] || 2 * Math.acos(Math.min(1, Math.abs(q.w))) > CARRY_MAX[1]) return false;
    const inv = this._q.copy(q).invert();
    const m = this._v.copy(c).add(t).applyQuaternion(inv).negate().add(c);
    this.dolly.position.add(m.multiplyScalar(this.scale).applyQuaternion(this.dolly.quaternion));
    this.dolly.quaternion.multiply(inv).normalize();
    return true;
  }

  // Scale the room about the head. factor > 1 = world shrinks (zoom out).
  zoom(factor) {
    const s = THREE.MathUtils.clamp(this.scale * factor, this.minScale, this.maxScale);
    const k = s / this.scale;
    if (k === 1) return;
    const h = this.headWorld().clone();
    this.dolly.position.sub(h).multiplyScalar(k).add(h);
    this.dolly.scale.setScalar(s);
  }

  setScale(s) {
    this.zoom(s / this.scale);
  }

  // Push the head out of surfaces so at least standoff (room metres) stays clear. Inside
  // solid material the field gives no way out, so the room goes back to where it last had
  // clearance; holes wider than the standoff stay passable.
  resolveCollision(standoff) {
    const want = standoff * this.scale;
    for (let i = 0; i < 3; i++) {
      this.dolly.updateMatrixWorld(true);
      const h = this.headWorld().clone();
      const de = this.deAt(h);
      if (de >= want) { this.lastDE = de; this.lastSafe = this.dolly.position.clone(); return; }
      const n = this.normalAt(h, Math.max(want * 0.1, 1e-6));
      this.dolly.position.addScaledVector(n, want - de);
    }
    this.dolly.updateMatrixWorld(true);
    this.lastDE = this.deAt(this.headWorld());
    if (this.lastDE < 0.3 * want && this.lastSafe) {
      this.dolly.position.copy(this.lastSafe);
      this.dolly.updateMatrixWorld(true);
      this.lastDE = this.deAt(this.headWorld());
    }
  }

  // Ease the scale so the nearest surface sits armLength room metres away. Returns true once
  // converged.
  autoZoom(dt, armLength) {
    const de = this.deAtHead();
    if (!(de > 0) || !isFinite(de)) return true;
    const target = THREE.MathUtils.clamp(de / armLength, this.minScale, this.maxScale);
    // Settled: leave the scale exactly alone so a still room reads as still.
    if (Math.abs(Math.log(target / this.scale)) < 2e-3) return true;
    const k = 1 - Math.exp(-dt * 2.5);
    const s = Math.exp(THREE.MathUtils.lerp(Math.log(this.scale), Math.log(target), k));
    this.setScale(s);
    return false;
  }

  // Sphere-trace along a world-space ray. Returns { point, normal, t } or null.
  // `coarse` (room metres) widens the hit threshold so aiming lands on a smoothed surface.
  march(origin, dir, maxSteps = 200, coarse = 0) {
    const f = currentFractal();
    const P = state.params;
    const s = this.scale;
    let t = 0;
    const tmax = 80 * s + 6;
    const p = new THREE.Vector3();
    for (let i = 0; i < maxSteps; i++) {
      p.copy(origin).addScaledVector(dir, t);
      const d = f.de([p.x, p.y, p.z], P);
      const eps = Math.max(t * 0.002, s * 1e-4, coarse * s);
      if (d < eps) return { point: p.clone(), normal: this.normalAt(p, Math.max(eps * 2, coarse * s)), t };
      t += d * 0.9;
      if (t > tmax) break;
    }
    return null;
  }

  // Whether there is open room from p out along n for `reach` (fractal units): the estimate
  // grows with the way gone, as it does off a surface and does not inside one or toward
  // another.
  openAlong(p, n, reach) {
    const q = new THREE.Vector3();
    for (let k = 1; k <= 4; k++) {
      const d = reach * k / 4;
      if (!(this.deAt(q.copy(p).addScaledVector(n, d)) >= 0.25 * d)) return false;
    }
    return true;
  }

  // The point of a ray at t or before, as near t as has `clear` (fractal units) of room:
  // back from a hit to where one can stand. The ray up to its hit is open, whatever is past it.
  standOn(origin, dir, t, clear) {
    const p = new THREE.Vector3();
    for (let i = 0; i < 32 && t > 0; i++) {
      const d = this.deAt(p.copy(origin).addScaledVector(dir, t));
      if (d >= clear) break;
      t = Math.max(0, t - Math.max(clear - d, clear * 0.05));
    }
    return p.copy(origin).addScaledVector(dir, t);
  }

  // Move so the head lands at the target (world space).
  teleportTo(target) {
    const h = this.headWorld();
    this.dolly.position.add(this._v.copy(target).sub(h));
    this.dolly.updateMatrixWorld(true);
  }
}
