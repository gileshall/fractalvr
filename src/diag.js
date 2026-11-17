import * as THREE from 'three';

// Headset diagnostics: a ring buffer of per-frame head poses and rig state (saved with a
// report), and desktop head motion (simulated sway and tracking noise, or a recorded trace)
// so headset conditions can be reproduced without one.

const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r7 = (v) => Math.round(v * 1e7) / 1e7;

export class HeadTrace {
  constructor(n = 1000) { this.n = n; this.buf = []; this.i = 0; }

  push(e) {
    if (this.buf.length < this.n) this.buf.push(e);
    else { this.buf[this.i] = e; this.i = (this.i + 1) % this.n; }
  }

  // Head pose is room space (the XR reference space); dolly is fractal space.
  record({ t, dt, camera, dolly, intent, still, dynScale, fps }) {
    const p = camera.position, q = camera.quaternion, dp = dolly.position;
    this.push({
      t: Math.round(t), dt: r5(dt),
      head: [r5(p.x), r5(p.y), r5(p.z)], q: [r7(q.x), r7(q.y), r7(q.z), r7(q.w)],
      dolly: [dp.x, dp.y, dp.z], scale: dolly.scale.x,
      fly: intent.fly.map(r5), climb: r5(intent.climb), turn: r5(intent.turn), zoom: r5(intent.zoom),
      still: still.level, dyn: r5(dynScale), fps: Math.round(fps),
    });
  }

  dump() { return this.buf.slice(this.i).concat(this.buf.slice(0, this.i)); }
}

// Deterministic per-frame noise in [-1, 1].
function hash(n, k) {
  const s = Math.sin(n * 12.9898 + k * 78.233) * 43758.5453;
  return 2 * (s - Math.floor(s)) - 1;
}

// Desktop head motion applied on top of mouse look, advanced once per frame.
//   sim:    { sway, jitter, rot, rotJitter }  metres and degrees; slow sway plus per-frame noise
//   replay: a HeadTrace dump, looped
export class HeadMotion {
  constructor() { this.sim = null; this.replay = null; this.frame = 0; this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); }

  simulate(opts) {
    this.replay = null;
    this.sim = opts ? { sway: 0.004, jitter: 0.0002, rot: 0.3, rotJitter: 0.02, ...opts } : null;
    this.frame = 0;
  }

  play(trace) {
    this.sim = null;
    this.replay = trace && trace.length ? trace : null;
    this.frame = 0;
  }

  get active() { return !!(this.sim || this.replay); }

  // camera has had its desktop look orientation and base position applied.
  apply(camera, base) {
    const n = this.frame++;
    if (this.replay) {
      // Recorded poses are absolute room space and replace the desktop look.
      const e = this.replay[n % this.replay.length];
      camera.position.fromArray(e.head);
      camera.quaternion.fromArray(e.q);
      return;
    }
    const s = this.sim;
    const t = n / 72;
    const sway = (a, b, c) => Math.sin(t * a + c) * 0.6 + Math.sin(t * b + 2 * c) * 0.4;
    camera.position.set(
      base.x + s.sway * sway(1.3, 3.1, 0.2) + s.jitter * hash(n, 1),
      base.y + s.sway * 0.5 * sway(1.7, 4.3, 1.1) + s.jitter * hash(n, 2),
      base.z + s.sway * sway(0.9, 2.3, 2.7) + s.jitter * hash(n, 3));
    const d = THREE.MathUtils.degToRad;
    this._e.set(d(s.rot * sway(0.7, 2.9, 0.5) + s.rotJitter * hash(n, 4)), d(s.rot * sway(0.5, 1.9, 1.7) + s.rotJitter * hash(n, 5)),
      d(s.rot * 0.3 * sway(0.8, 2.1, 2.2) + s.rotJitter * hash(n, 6)), 'YXZ');
    camera.quaternion.multiply(this._q.setFromEuler(this._e));
  }
}
