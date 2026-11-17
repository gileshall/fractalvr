// A tour's 3D legs flown without a headset: each 3D fractal from its start, as the page
// would, and what the flight was like in numbers.
//
//   node tools/toursim.mjs [seconds] [rate] [name ...]
//
// turned: degrees the room turned in all; busy: seconds it turned faster than 10 degrees a
// second. floor: seconds until the room was as small as the fractal allows. near: the nearest surface
// in room metres (least, median). turn: the heading's turning in degrees a second (most), and
// how fast that changed (most, degrees a second squared). solid: the share of the ways
// probed within 40 degrees of the heading that ended on a surface. lost: seconds with nothing
// in reach. inside: frames the head was under a surface. went: room metres travelled.
import * as THREE from 'three';

globalThis.innerWidth = 1600;
globalThis.innerHeight = 900;
const { Rig, SCALE_MIN } = await import('../src/rig.js');
const { state, setFractal, currentFractal } = await import('../src/state.js');
const { FRACTALS, ORDER } = await import('../src/fractals.js');
const { Pilot } = await import('../src/pilot.js');
const { fly, face, frontOf } = await import('../src/tour.js');

const PIXEL = 0.0015; // radians a history pixel, as a Quest 3 has it

export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// One leg. Returns the numbers, and the track where asked.
export function leg(index, { seconds = 80, rate = 0.5, seed = 1, track = false } = {}) {
  setFractal(index);
  const f = currentFractal();
  const rig = new Rig();
  const arm = state.armLength, dt = 1 / 72;
  rig.reset(f);
  const floorOf = () => Math.max(SCALE_MIN, f.precision * Math.max(1, rig.headWorld().length()) / (3 * arm * PIXEL));
  rig.minScale = floorOf();
  for (let i = 0; i < 400 && !rig.autoZoom(dt, arm); i++) rig.dolly.updateMatrixWorld(true);
  rig.dolly.updateMatrixWorld(true);
  const pilot = new Pilot(rng(seed));
  const front = frontOf(rig.camera);
  const head = rig.headWorld().clone();
  const start = f.bound(state.params) > 0 && head.length() > 1e-6 ? head.clone().negate().normalize() : new THREE.Vector3(0, 0, -1);
  pilot.reset(start.toArray());
  face(rig, pilot.heading, front);

  const out = { fractal: f.name, turned: 0, busy: 0, floor: null, near: [], turn: 0, ease: 0, yaw: 0, solid: 0, lost: 0, inside: 0, went: 0, scale: [rig.scale, 0], path: [] };
  let was = pilot.heading, wasRate = 0, solid = 0, seen = 0;
  for (let n = 0; n < seconds / dt; n++) {
    const yaw = fly(rig, pilot, front, arm, rate * arm * 0.7 * dt, dt);
    rig.minScale = floorOf();
    rig.autoZoom(dt, arm);
    rig.resolveCollision(state.standoff);
    rig.dolly.updateMatrixWorld(true);
    const de = rig.deAtHead();
    const h = pilot.heading;
    const turn = Math.acos(Math.min(1, h[0] * was[0] + h[1] * was[1] + h[2] * was[2])) / dt;
    out.turn = Math.max(out.turn, turn);
    if (n > 0) out.ease = Math.max(out.ease, Math.abs(turn - wasRate) / dt);
    out.yaw = Math.max(out.yaw, Math.abs(yaw) / dt);
    out.turned += Math.abs(yaw);
    if (Math.abs(yaw) / dt > 0.175) out.busy += dt;
    was = h; wasRate = turn;
    out.near.push(de / rig.scale);
    if (!(de > 0)) out.inside++;
    if (pilot.lost) out.lost += dt;
    if (out.floor === null && rig.scale <= rig.minScale * 1.05) out.floor = n * dt;
    out.went += rate * arm * 0.7 * dt;
    for (const r of pilot.rays) {
      if (!r || r.dir[0] * h[0] + r.dir[1] * h[1] + r.dir[2] * h[2] < Math.cos(0.7)) continue;
      seen++;
      if (!r.open) solid++;
    }
    if (track && n % 72 === 0) out.path.push({ t: Math.round(n * dt), scale: +rig.scale.toExponential(2), near: +(de / rig.scale).toFixed(2), head: rig.headWorld().toArray().map((v) => +v.toFixed(4)), heading: h.map((v) => +v.toFixed(2)), lost: pilot.lost });
  }
  out.scale[1] = rig.scale;
  out.solid = solid / seen;
  const s = out.near.slice().sort((a, b) => a - b);
  out.near = [s[0], s[s.length >> 1]];
  out.deg = (v) => v * 180 / Math.PI;
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seconds = +(process.argv[2] ?? 80), rate = +(process.argv[3] ?? 0.5), only = process.argv.slice(4);
  const rows = [];
  for (const i of ORDER) {
    const f = FRACTALS[i];
    if (f.kind !== '3d' || (only.length && !only.includes(f.name))) continue;
    for (const seed of [1, 2, 3]) {
      const r = leg(i, { seconds, rate, seed, track: only.length > 0 && seed === 1 });
      rows.push({
        fractal: r.fractal, seed, 'scale from': +r.scale[0].toExponential(2), to: +r.scale[1].toExponential(2), floor: r.floor === null ? '-' : +r.floor.toFixed(0),
        'near least': +r.near[0].toFixed(2), median: +r.near[1].toFixed(2), 'turn most': +r.deg(r.turn).toFixed(1), ease: +r.deg(r.ease).toFixed(0), 'yaw most': +r.deg(r.yaw).toFixed(1),
        turned: +r.deg(r.turned).toFixed(0), busy: +r.busy.toFixed(0), solid: +r.solid.toFixed(2), lost: +r.lost.toFixed(1), inside: r.inside, went: +r.went.toFixed(1),
      });
      if (r.path.length) console.table(r.path);
    }
  }
  console.table(rows);
}
