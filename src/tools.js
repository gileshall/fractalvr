import * as THREE from 'three';

// Tools used with the left trigger. The ball gun and the bookmark store live here; the
// camera needs the renderer and stays in main.js.

export const TOOLS = [
  { key: 'teleport', name: 'teleport', hint: 'hold to aim, release to jump' },
  { key: 'camera', name: 'camera', hint: 'release to take a picture' },
  { key: 'gps', name: 'gps', hint: 'press to bookmark this view' },
  { key: 'balls', name: 'ball gun', hint: 'hold to fire, stick sets speed' },
];

export const BACKGROUNDS = ['starfield', 'sky', 'clouds', 'water', 'gradient', 'passthrough'];

const MAX_BALLS = 96;
const GRAVITY = 9.8; // room m/s^2

// Bouncy balls: world-space spheres that fall in room gravity and bounce off the distance
// field. Radius and speed are room metres at firing time, so a ball keeps its world size.
export class BallGun {
  constructor(scene) {
    const geom = new THREE.SphereGeometry(1, 14, 10);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.1 });
    this.mesh = new THREE.InstancedMesh(geom, mat, MAX_BALLS);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    this.balls = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this.hue = 0;
  }

  fire(origin, dir, speedRoom, radiusRoom, scale) {
    if (this.balls.length >= MAX_BALLS) this.balls.shift();
    this.hue = (this.hue + 0.13) % 1;
    this.balls.push({
      p: origin.clone().addScaledVector(dir, radiusRoom * 2 * scale),
      v: dir.clone().multiplyScalar(speedRoom * scale),
      r: radiusRoom * scale,
      age: 0,
      color: this._c.setHSL(this.hue, 0.8, 0.55).getHex(),
      rest: 0,
    });
  }

  clear() { this.balls.length = 0; this.mesh.count = 0; }

  // de(p) and normalAt(p, eps) work in world units. up: the room's, in the world.
  update(dt, de, normalAt, scale, up) {
    const g = GRAVITY * scale;
    const steps = 2;
    const h = dt / steps;
    for (const b of this.balls) {
      b.age += dt;
      for (let s = 0; s < steps; s++) {
        b.v.addScaledVector(up, -g * h);
        b.p.addScaledVector(b.v, h);
        const d = de(b.p);
        if (d < b.r) {
          const n = normalAt(b.p, Math.max(b.r * 0.5, 1e-6));
          b.p.addScaledVector(n, b.r - d);
          const vn = b.v.dot(n);
          if (vn < 0) {
            b.v.addScaledVector(n, -(1.75) * vn); // restitution 0.75
            b.v.multiplyScalar(0.97);
            const hit = -vn / scale;
            if (hit < 0.15) b.rest += h; else b.rest = 0;
          }
        }
      }
    }
    // Retire old balls and those that have settled or fallen away.
    this.balls = this.balls.filter((b) => b.age < 40 && b.rest < 3 && b.p.y > -200 * scale);
    let i = 0;
    for (const b of this.balls) {
      this._m.compose(b.p, this._q, this._s.setScalar(b.r));
      this.mesh.setMatrixAt(i, this._m);
      this.mesh.setColorAt(i, this._c.setHex(b.color));
      i++;
    }
    this.mesh.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// Bookmarked views, kept in localStorage.
export class Bookmarks {
  constructor(key = 'fractalvr.bookmarks') {
    this.key = key;
    const raw = localStorage.getItem(key);
    this.list = raw ? JSON.parse(raw) : [];
  }

  save() { localStorage.setItem(this.key, JSON.stringify(this.list)); }

  add(entry) {
    this.list.push(entry);
    this.save();
    return this.list.length - 1;
  }

  remove(i) {
    this.list.splice(i, 1);
    this.save();
  }

  clear() { this.list.length = 0; this.save(); }
}
