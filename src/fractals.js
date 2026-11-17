// Fractal catalogue. Each 3D entry has a JS distance estimator mirroring the shader
// (used for collision, speed control and teleport). Params are live sliders.
// iterCost: one iteration of the estimator in accumulate pixels, on the headset: rough, from
// its sessions. The budget controller takes up the error.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// The Mandelbox estimator stops iterating where what is left would move it by less than this share.
export const BOX_TOL = 0.03;

function rot2(x, y, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * x - s * y, s * x + c * y];
}

// The 2D iterations: z -> (re, im) + c, with re = x^2 - y^2 and im = 2xy but for what a
// step's bits change. A formula's id is what the shaders and the plane know it by.
export const STEP_ABS_RE = 1; // re = |x^2 - y^2|
export const STEP_ABS_X = 2; // im of |x|
export const STEP_ABS_Y = 4; // im of |y|
export const STEP_NEG = 8; // im negated
export const FORMULAS = {
  mandel: { id: 0, step: 0 },
  ship: { id: 1, step: STEP_ABS_X | STEP_ABS_Y },
  julia: { id: 2, step: 0 },
  tricorn: { id: 3, step: STEP_NEG },
  celtic: { id: 4, step: STEP_ABS_RE },
  buffalo: { id: 5, step: STEP_ABS_RE | STEP_ABS_X | STEP_ABS_Y },
  heart: { id: 6, step: STEP_ABS_X },
  perp: { id: 7, step: STEP_ABS_X | STEP_NEG },
  perpship: { id: 8, step: STEP_ABS_Y },
};

// The polyhedral groups as folds onto one chamber: the point is mirrored in the planes
// through the origin with these normals wherever it is on their side, between taking its
// absolute value (the icosahedral) or after it and sorting (the octahedral). The chamber's
// corners are the axes of the group: for the icosahedral of 5, 3 and 2 turns, for the
// octahedral of 4, 3 and 2.
const PHI = (1 + Math.sqrt(5)) / 2;
const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
export const POLY = {
  icosa: { n1: unit([-PHI, PHI - 1, 1]), n2: unit([1, -PHI, PHI + 1]), corners: [unit([PHI, 1, 0]), unit([1, PHI * PHI, 0]), unit([1, PHI, PHI - 1])] },
  octa: { corners: [[1, 0, 0], unit([1, 1, 1]), unit([1, 1, 0])] },
};

export function polyFold(z, icosa) {
  let x = Math.abs(z[0]), y = Math.abs(z[1]), w = Math.abs(z[2]);
  if (icosa) {
    const { n1, n2 } = POLY.icosa;
    for (let k = 0; k < 2; k++) {
      let t = 2 * Math.max(x * n1[0] + y * n1[1] + w * n1[2], 0);
      x -= t * n1[0]; y -= t * n1[1]; w -= t * n1[2];
      t = 2 * Math.max(x * n2[0] + y * n2[1] + w * n2[2], 0);
      x = Math.abs(x - t * n2[0]); y = Math.abs(y - t * n2[1]); w = Math.abs(w - t * n2[2]);
    }
  } else {
    if (x < y) [x, y] = [y, x];
    if (x < w) [x, w] = [w, x];
    if (y < w) [y, w] = [w, y];
  }
  z[0] = x; z[1] = y; z[2] = w;
}

// A direction of the chamber: 0, 1 and 2 its corners, between them the way from one to the next.
export function polyDir(t, icosa) {
  const c = (icosa ? POLY.icosa : POLY.octa).corners;
  const a = c[t < 1 ? 0 : 1], b = c[t < 1 ? 1 : 2], f = t < 1 ? t : t - 1;
  return unit([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
}

// A solid with faces across `faces`, and at each step smaller copies of it set at `corners`
// of it, where that direction meets a face.
// most: the scale past which the copies are dust too fine to see.
function polyParams(scale, most, corners, faces) {
  return [
    { key: 'p1', name: 'scale', def: scale, min: 1.5, max: most, step: 0.01 },
    { key: 'p2', name: 'copies at (corner 0 .. 2)', def: corners, min: 0, max: 2, step: 0.01 },
    { key: 'p3', name: 'faces across (corner 0 .. 2)', def: faces, min: 0, max: 2, step: 0.01 },
    { key: 'p4', name: 'rotation', def: 0, min: -1.2, max: 1.2, step: 0.01 },
    { key: 'p5', name: 'iterations', def: 8, min: 0, max: 14, step: 1 },
  ];
}
function polyBound(u, icosa) {
  const n = polyDir(u.p3, icosa);
  let r = 0;
  for (const c of (icosa ? POLY.icosa : POLY.octa).corners) r = Math.max(r, 1 / (c[0] * n[0] + c[1] * n[1] + c[2] * n[2]));
  return 1.02 * r;
}
function polyDE(p, u, icosa) {
  const scale = u.p1, rot = u.p4, iters = u.p5 | 0;
  const n = polyDir(u.p3, icosa), o = polyDir(u.p2, icosa);
  const k = (scale - 1) / (o[0] * n[0] + o[1] * n[1] + o[2] * n[2]);
  const z = [p[0], p[1], p[2]];
  let sc = 1;
  for (let i = 0; i < iters; i++) {
    [z[0], z[2]] = rot2(z[0], z[2], rot);
    polyFold(z, icosa);
    z[0] = z[0] * scale - o[0] * k; z[1] = z[1] * scale - o[1] * k; z[2] = z[2] * scale - o[2] * k;
    sc *= scale;
  }
  polyFold(z, icosa);
  return (z[0] * n[0] + z[1] * n[1] + z[2] * n[2] - 1) / sc;
}

// The radius past which a step of the Kalibox only takes a point further out.
export const kaliEscape = (u) => (u.p1 * Math.hypot(u.p3, u.p4, u.p3) + Math.hypot(u.p5, u.p6, u.p7)) / (u.p1 - 1);

// The smallest radius past which a Julia bulb's iteration only grows.
function bulbEscape(power, c) {
  let r = 1;
  for (let i = 0; i < 40 && r ** power - r < c; i++) r *= 1.02;
  return r;
}

export const FRACTALS = [
  {
    name: 'Mandelbulb',
    kind: '3d',
    glsl: 'deMandelbulb',
    iterCost: 0.02,
    params: [
      { key: 'p1', name: 'power', def: 8, min: 2, max: 16, step: 0.01 },
      { key: 'p2', name: 'twist', def: 0, min: -3.14, max: 3.14, step: 0.01 },
      { key: 'p3', name: 'iterations', def: 8, min: 2, max: 20, step: 1 },
    ],
    start: [0, -1.6, 2.6],
    bound: () => 1.3,
    colorFreq: 0.9,
    precision: 1.5e-5, // float32 noise of the estimator near the surface, relative to |p| (tools/precision.mjs)
    de(p, u) {
      const power = u.p1, twist = u.p2, iters = u.p3 | 0;
      let zx = p[0], zy = p[1], zz = p[2];
      let dr = 1, r = 0;
      for (let i = 0; i < iters; i++) {
        r = Math.hypot(zx, zy, zz);
        if (r > 2) break;
        const theta = Math.acos(clamp(zz / r, -1, 1)) * power;
        const phi = Math.atan2(zy, zx) * power + twist;
        dr = Math.pow(r, power - 1) * power * dr + 1;
        const zr = Math.pow(r, power);
        zx = zr * Math.sin(theta) * Math.cos(phi) + p[0];
        zy = zr * Math.sin(phi) * Math.sin(theta) + p[1];
        zz = zr * Math.cos(theta) + p[2];
      }
      return 0.5 * Math.log(r) * r / dr;
    },
  },
  {
    name: 'Mandelbox',
    kind: '3d',
    glsl: 'deMandelbox',
    iterCost: 0.007,
    params: [
      { key: 'p1', name: 'scale', def: 2, min: -3, max: 3, step: 0.01 },
      { key: 'p2', name: 'min radius', def: 0.5, min: 0.05, max: 1, step: 0.01 },
      { key: 'p3', name: 'fold', def: 1, min: 0.5, max: 2, step: 0.01 },
      { key: 'p4', name: 'iterations', def: 12, min: 2, max: 24, step: 1 },
    ],
    // The box spans about +-6 at scale 2; interior corridors are ~0.1 wide, so fly in with auto zoom.
    start: [0, -1.6, 13],
    // Conservative: the box spans about fold*(|s|+1)/(|s|-1) per axis for |s|>1.
    bound: (u) => (Math.abs(u.p1) > 1.2 ? u.p3 * 2 * (Math.abs(u.p1) + 1) / (Math.abs(u.p1) - 1) * 1.74 : 0),
    colorFreq: 0.35,
    precision: 1e-6,
    de(p, u) {
      const scale = u.p1, minR2 = u.p2 * u.p2, fold = u.p3, iters = u.p4 | 0;
      let zx = p[0], zy = p[1], zz = p[2];
      let dr = 1;
      const as = Math.abs(scale);
      const far = as > 1 ? ((3.4642 * fold * as + Math.hypot(p[0], p[1], p[2])) / ((as - 1) * BOX_TOL)) ** 2 : Infinity;
      for (let i = 0; i < iters; i++) {
        zx = clamp(zx, -fold, fold) * 2 - zx;
        zy = clamp(zy, -fold, fold) * 2 - zy;
        zz = clamp(zz, -fold, fold) * 2 - zz;
        const r2 = zx * zx + zy * zy + zz * zz;
        if (r2 < minR2) { const t = 1 / minR2; zx *= t; zy *= t; zz *= t; dr *= t; }
        else if (r2 < 1) { const t = 1 / r2; zx *= t; zy *= t; zz *= t; dr *= t; }
        zx = scale * zx + p[0];
        zy = scale * zy + p[1];
        zz = scale * zz + p[2];
        dr = dr * as + 1;
        if (zx * zx + zy * zy + zz * zz > far) { dr += (1 - as ** (i + 1 - iters)) / (as - 1); break; }
      }
      return Math.hypot(zx, zy, zz) / dr;
    },
  },
  {
    name: 'Menger',
    kind: '3d',
    glsl: 'deMenger',
    iterCost: 0.007,
    params: [
      { key: 'p1', name: 'offset', def: 1, min: 0.5, max: 2, step: 0.01 },
      { key: 'p2', name: 'rotation', def: 0, min: -1.2, max: 1.2, step: 0.01 },
      { key: 'p3', name: 'iterations', def: 8, min: 1, max: 12, step: 1 },
    ],
    start: [0, -1.6, 3.2],
    bound: (u) => 1.8 * u.p1,
    colorFreq: 0.5,
    precision: 1e-6,
    de(p, u) {
      const off = u.p1, rot = u.p2, iters = u.p3 | 0;
      let x = p[0], y = p[1], z = p[2];
      let sc = 1;
      for (let i = 0; i < iters; i++) {
        [x, z] = rot2(x, z, rot);
        x = Math.abs(x); y = Math.abs(y); z = Math.abs(z);
        if (x < y) [x, y] = [y, x];
        if (x < z) [x, z] = [z, x];
        if (y < z) [y, z] = [z, y];
        x = x * 3 - off * 2; y = y * 3 - off * 2; z = z * 3 - off * 2;
        if (z < -off) z += 2 * off;
        sc *= 3;
      }
      return (Math.hypot(x, y, z) - 1) / sc;
    },
  },
  {
    name: 'Sierpinski',
    kind: '3d',
    glsl: 'deSierpinski',
    iterCost: 0.008,
    params: [
      { key: 'p1', name: 'scale', def: 2, min: 1.5, max: 3, step: 0.01 },
      { key: 'p2', name: 'rotation', def: 0, min: -1.2, max: 1.2, step: 0.01 },
      { key: 'p3', name: 'iterations', def: 12, min: 1, max: 16, step: 1 },
    ],
    start: [0, -1.6, 3.2],
    bound: () => 1.8,
    colorFreq: 0.5,
    precision: 1e-6,
    de(p, u) {
      const scale = u.p1, rot = u.p2, iters = u.p3 | 0;
      let x = p[0], y = p[1], z = p[2];
      let sc = 1;
      for (let i = 0; i < iters; i++) {
        [x, y] = rot2(x, y, rot);
        if (x + y < 0) { const t = -y; y = -x; x = t; }
        if (x + z < 0) { const t = -z; z = -x; x = t; }
        if (y + z < 0) { const t = -z; z = -y; y = t; }
        x = x * scale - (scale - 1);
        y = y * scale - (scale - 1);
        z = z * scale - (scale - 1);
        sc *= scale;
      }
      return Math.hypot(x, y, z) / sc;
    },
  },
  {
    name: 'Quaternion Julia',
    kind: '3d',
    glsl: 'deQuatJulia',
    iterCost: 0.012,
    params: [
      { key: 'p1', name: 'c.x', def: -0.2, min: -1, max: 1, step: 0.005 },
      { key: 'p2', name: 'c.y', def: 0.6, min: -1, max: 1, step: 0.005 },
      { key: 'p3', name: 'c.z', def: 0.2, min: -1, max: 1, step: 0.005 },
      { key: 'p4', name: 'iterations', def: 12, min: 2, max: 20, step: 1 },
    ],
    start: [0, -1.6, 2.6],
    bound: () => 1.6,
    colorFreq: 0.6,
    precision: 4e-6,
    de(p, u) {
      const cx = u.p1, cy = u.p2, cz = u.p3, cw = 0, iters = u.p4 | 0;
      let x = p[0], y = p[1], z = p[2], w = 0;
      let md2 = 1, mz2 = x * x + y * y + z * z;
      for (let i = 0; i < iters; i++) {
        md2 *= 4 * mz2;
        const nx = x * x - y * y - z * z - w * w + cx;
        const ny = 2 * x * y + cy;
        const nz = 2 * x * z + cz;
        const nw = 2 * x * w + cw;
        x = nx; y = ny; z = nz; w = nw;
        mz2 = x * x + y * y + z * z + w * w;
        if (mz2 > 4) break;
      }
      return 0.25 * Math.sqrt(mz2 / md2) * Math.log(mz2);
    },
  },
  {
    name: 'Apollonian',
    kind: '3d',
    glsl: 'deApollonian',
    iterCost: 0.006,
    params: [
      { key: 'p1', name: 'fold', def: 1.25, min: 1.02, max: 1.6, step: 0.005 },
      { key: 'p2', name: 'rotation', def: 0, min: -1.5, max: 1.5, step: 0.01 },
      { key: 'p3', name: 'iterations', def: 8, min: 1, max: 12, step: 1 },
    ],
    start: [0.5, -1.1, 0.5],
    bound: () => 0,
    colorFreq: 1.2,
    precision: 4e-6,
    de(p, u) {
      const s = u.p1, rot = u.p2, iters = u.p3 | 0;
      let [x, z] = rot2(p[0], p[2], rot);
      let y = p[1];
      let scale = 1;
      const f = (v) => -1 + 2 * (0.5 * v + 0.5 - Math.floor(0.5 * v + 0.5));
      for (let i = 0; i < iters; i++) {
        x = f(x); y = f(y); z = f(z);
        const r2 = x * x + y * y + z * z;
        const k = s / r2;
        x *= k; y *= k; z *= k; scale *= k;
      }
      return 0.25 * Math.abs(y) / scale;
    },
  },
  {
    name: 'Mandelbrot',
    kind: '2d',
    formula: 'mandel',
    params: [],
    colorFreq: 1.0,
    home: { cx: -0.6, cy: 0, scale: 1.4 },
  },
  {
    name: 'Burning Ship',
    kind: '2d',
    formula: 'ship',
    params: [],
    colorFreq: 1.0,
    home: { cx: -0.4, cy: -0.5, scale: 1.4 },
  },
  {
    name: 'Julia',
    kind: '2d',
    formula: 'julia',
    params: [
      { key: 'p1', name: 'c.x', def: -0.75, min: -2, max: 1, step: 0.001 },
      { key: 'p2', name: 'c.y', def: 0.1, min: -1.5, max: 1.5, step: 0.001 },
    ],
    colorFreq: 1.0,
    home: { cx: 0, cy: 0, scale: 1.4 },
  },
  {
    name: 'Tricorn',
    kind: '2d',
    formula: 'tricorn',
    params: [],
    colorFreq: 1.0,
    home: { cx: -0.44, cy: 0, scale: 2 },
  },
  {
    name: 'Celtic',
    kind: '2d',
    formula: 'celtic',
    params: [],
    colorFreq: 1.0,
    home: { cx: -0.73, cy: 0, scale: 2 },
  },
  {
    name: 'Buffalo',
    kind: '2d',
    formula: 'buffalo',
    params: [],
    colorFreq: 1.0,
    home: { cx: -0.73, cy: -0.62, scale: 1.45 },
  },
  {
    name: 'Heart',
    kind: '2d',
    formula: 'heart',
    params: [],
    colorFreq: 1.0,
    home: { cx: -0.66, cy: 0, scale: 1.4 },
  },
  {
    name: 'Perpendicular Mandelbrot',
    kind: '2d',
    formula: 'perp',
    params: [],
    colorFreq: 1.0,
    home: { cx: -0.55, cy: 0, scale: 1.6 },
  },
  {
    name: 'Perpendicular Ship',
    kind: '2d',
    formula: 'perpship',
    params: [],
    colorFreq: 1.0,
    home: { cx: -0.39, cy: -0.13, scale: 1.8 },
  },
  {
    name: 'Julia Bulb',
    kind: '3d',
    glsl: 'deJuliaBulb',
    iterCost: 0.02,
    params: [
      { key: 'p1', name: 'power', def: 8, min: 2, max: 16, step: 0.01 },
      // Just inside the Mandelbulb's surface: the set is of one piece, and as intricate as it gets.
      { key: 'p2', name: 'c.x', def: -0.78, min: -1, max: 1, step: 0.005 },
      { key: 'p3', name: 'c.y', def: 0.155, min: -1, max: 1, step: 0.005 },
      { key: 'p4', name: 'c.z', def: 0.235, min: -1, max: 1, step: 0.005 },
      { key: 'p5', name: 'iterations', def: 8, min: 2, max: 20, step: 1 },
    ],
    start: [0, -1.6, 2.6],
    bound: (u) => 1.05 * bulbEscape(u.p1, Math.hypot(u.p2, u.p3, u.p4)),
    colorFreq: 0.9,
    precision: 3e-5,
    de(p, u) {
      const power = u.p1, iters = u.p5 | 0;
      let zx = p[0], zy = p[1], zz = p[2];
      let dr = 1, r = 0;
      for (let i = 0; i < iters; i++) {
        r = Math.hypot(zx, zy, zz);
        if (r > 2) break;
        const theta = Math.acos(clamp(zz / r, -1, 1)) * power;
        const phi = Math.atan2(zy, zx) * power;
        dr = Math.pow(r, power - 1) * power * dr;
        const zr = Math.pow(r, power);
        zx = zr * Math.sin(theta) * Math.cos(phi) + u.p2;
        zy = zr * Math.sin(phi) * Math.sin(theta) + u.p3;
        zz = zr * Math.cos(theta) + u.p4;
      }
      return 0.5 * Math.log(r) * r / dr;
    },
  },
  {
    // Kali's: the Mandelbox's sphere fold after |z| + t in place of its box fold, about a fixed c.
    // Its solid is the points still within the escape radius after the iterations: the
    // estimate is to that, and under zero inside it, at any closeness (|z| / dr never gets
    // there, and what it shows thins to nothing close up).
    name: 'Kalibox',
    kind: '3d',
    glsl: 'deKalibox',
    iterCost: 0.007,
    params: [
      // Past these ends nothing is left of it: every point escapes.
      { key: 'p1', name: 'scale', def: 2, min: 1.3, max: 2.4, step: 0.01 },
      { key: 'p2', name: 'min radius', def: 0.5, min: 0.05, max: 1, step: 0.005 },
      { key: 'p3', name: 'shift x, z', def: -1, min: -2, max: -0.3, step: 0.005 },
      { key: 'p4', name: 'shift y', def: -1, min: -2, max: -0.3, step: 0.005 },
      { key: 'p5', name: 'c.x', def: 0.3, min: -2, max: 2, step: 0.005 },
      { key: 'p6', name: 'c.y', def: 0, min: -2, max: 2, step: 0.005 },
      { key: 'p7', name: 'c.z', def: 0.3, min: -2, max: 2, step: 0.005 },
      { key: 'p8', name: 'iterations', def: 12, min: 2, max: 24, step: 1 },
    ],
    start: [0, -1.6, 5],
    bound: (u) => 1.05 * kaliEscape(u),
    colorFreq: 0.35,
    precision: 1e-6,
    de(p, u) {
      const scale = u.p1, minR2 = u.p2 * u.p2, iters = u.p8 | 0;
      let zx = p[0], zy = p[1], zz = p[2];
      let dr = 1, out = kaliEscape(u);
      // As the Mandelbox's: this far out the iterations left only scale the point.
      const far = (out / BOX_TOL) ** 2;
      for (let i = 0; i < iters; i++) {
        zx = Math.abs(zx) + u.p3; zy = Math.abs(zy) + u.p4; zz = Math.abs(zz) + u.p3;
        const k = scale / clamp(zx * zx + zy * zy + zz * zz, minR2, 1);
        zx = zx * k + u.p5; zy = zy * k + u.p6; zz = zz * k + u.p7;
        dr = dr * k + 1;
        if (zx * zx + zy * zy + zz * zz > far) {
          const left = scale ** (i + 1 - iters);
          dr += (1 - left) / (scale - 1); out *= left;
          break;
        }
      }
      return (Math.hypot(zx, zy, zz) - out) / dr;
    },
  },
  {
    // Knighty's: a box fold and a sphere inversion, the surface where the last y is `thickness`:
    // floors and ceilings, with the open room half way between them.
    name: 'Pseudo-Kleinian',
    kind: '3d',
    glsl: 'dePseudoKleinian',
    iterCost: 0.006,
    params: [
      { key: 'p1', name: 'sphere', def: 1, min: 0.7, max: 1.5, step: 0.005 },
      { key: 'p2', name: 'box x', def: 0.92436, min: 0.5, max: 1.5, step: 0.005 },
      { key: 'p3', name: 'box y', def: 0.92436, min: 0.5, max: 1.5, step: 0.005 },
      { key: 'p4', name: 'box z', def: 0.90756, min: 0.5, max: 1.5, step: 0.005 },
      { key: 'p5', name: 'thickness', def: 0.02, min: 0, max: 0.5, step: 0.005 },
      { key: 'p6', name: 'iterations', def: 10, min: 1, max: 16, step: 1 },
    ],
    // Head in the widest of the room between two sheets, off their mid-plane (rays in it meet nothing).
    start: [0.4, 0.955 - 1.6, 1.25],
    bound: () => 0,
    colorFreq: 1.2,
    precision: 1e-6,
    de(p, u) {
      const size = u.p1, iters = u.p6 | 0;
      let x = p[0], y = p[1], z = p[2];
      let df = 1;
      for (let i = 0; i < iters; i++) {
        x = 2 * clamp(x, -u.p2, u.p2) - x; y = 2 * clamp(y, -u.p3, u.p3) - y; z = 2 * clamp(z, -u.p4, u.p4) - z;
        const k = Math.max(size / (x * x + y * y + z * z), 1);
        x *= k; y *= k; z *= k; df *= k;
      }
      return 0.5 * (Math.abs(y) - u.p5) / df;
    },
  },
  {
    name: 'Icosahedron',
    kind: '3d',
    glsl: 'deIcosahedron',
    iterCost: 0.012,
    params: polyParams(2.618, 4, 0, 1),
    start: [0, -1.6, 3.2],
    bound: (u) => polyBound(u, true),
    colorFreq: 0.5,
    precision: 1e-6,
    de: (p, u) => polyDE(p, u, true),
  },
  {
    name: 'Octahedron',
    kind: '3d',
    glsl: 'deOctahedron',
    iterCost: 0.007,
    params: polyParams(2, 3, 0, 1),
    start: [0, -1.6, 4],
    bound: (u) => polyBound(u, false),
    colorFreq: 0.5,
    precision: 1e-6,
    de: (p, u) => polyDE(p, u, false),
  },
];

// The order lists show them in: the 3D ones, then the 2D. Sessions and bookmarks hold the
// catalogue's indices: new entries go at its end.
export const ORDER = FRACTALS.map((_, i) => i).sort((a, b) => (FRACTALS[a].kind === '3d' ? 0 : 1) - (FRACTALS[b].kind === '3d' ? 0 : 1) || a - b);

// Places worth falling into. Coordinates as strings so the double-double center keeps every digit.
export const FALL_TARGETS = [
  { name: 'Seahorse valley', formula: 'mandel', cx: '-0.7453', cy: '0.1127' },
  { name: 'Elephant valley', formula: 'mandel', cx: '0.2750', cy: '0.0060' },
  { name: 'Feigenbaum point', formula: 'mandel', cx: '-1.4011551890920506', cy: '0' },
  { name: 'Dendrite (i)', formula: 'mandel', cx: '0', cy: '1' },
  { name: 'Antenna tip', formula: 'mandel', cx: '-2', cy: '0' },
  { name: 'Misiurewicz spiral', formula: 'mandel', cx: '-0.77568377', cy: '0.13646737' },
  { name: 'Ship hull', formula: 'ship', cx: '-1.7616', cy: '-0.0283' },
];

// c in halves: the spinning phase wraps at 2 (PHASE_WRAP in main.js).
export const PALETTES = [
  { name: 'Rainbow', a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0, 0.33, 0.67] },
  { name: 'Fire', a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0, 0.1, 0.2] },
  { name: 'Ocean', a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 0.5], d: [0.8, 0.9, 0.3] },
  { name: 'Pastel', a: [0.8, 0.5, 0.4], b: [0.2, 0.4, 0.2], c: [2, 1, 1], d: [0, 0.25, 0.25] },
  { name: 'Neon', a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [2, 1, 0], d: [0.5, 0.2, 0.25] },
  { name: 'Bone', a: [0.55, 0.55, 0.55], b: [0.4, 0.4, 0.4], c: [1, 1, 1], d: [0, 0, 0] },
  { name: 'Copper', a: [0.5, 0.4, 0.3], b: [0.5, 0.4, 0.3], c: [1, 1, 1], d: [0.0, 0.15, 0.3] },
  { name: 'Ice', a: [0.6, 0.7, 0.8], b: [0.3, 0.3, 0.2], c: [1, 1, 1], d: [0.5, 0.6, 0.7] },
  // A loop through cream, apricot, plum and dusty blue: no green or yellow, moderate chroma.
  { name: 'Dusk', a: [0.52, 0.379, 0.404], b: [0.501, 0.312, 0.309], c: [1.5, 1.5, 1.5], d: [0.589, 0.72, 0.884] },
];

export const LAYOUTS_2D = ['floor + Julia sky', 'wall', 'sphere', 'tunnel', 'cylinder'];
