// Decisions of the 2D plane cache that need no GPU: which octaves it holds, what a texel costs,
// how far a refine goes, how a window follows the gaze.
//
// Octave k is a grid of texels 2^k times the finest, in complex units, whatever the view's
// scale: zooming never invalidates a level, it only brings one more into use.

export const CAP_STEP = 4; // a refine re-runs interior texels from zero, so its caps climb fast
export const CATCH_UP = 0.7; // while moving, a level this far under the view's cap is brought up: more than one step of PROBE_EDGES
export const TEXEL_COST = 3; // a texel's fixed cost, in iterations
export const UNKNOWN_INTERIOR = 0.25; // share of texels taken to run to the cap where nothing is measured
export const BORROWED_INTERIOR = 0.1; // the least, where the measurement is a coarser level's
export const SHIFT_MIN = 48; // texels the gaze moves before a window follows
export const SHIFT_MAX = 128; // texels a window moves at once
// Caps a probe's escape counts are told apart at: half octaves from the least cap of all.
export const PROBE_EDGES = Array.from({ length: 15 }, (_, b) => Math.round(100 * Math.pow(2, b / 2)));
export const EPS_MOVE = 0.05; // share of points a moving view may leave short of their escape
export const EPS_STILL = 0.002; // and a still one

// The finest octave held at a view scale. `prev` (null at first) is kept through a quarter
// octave either side, so a scale resting on a power of two does not swap levels back and forth.
export function octaveBase(scale, prev) {
  const e = Math.log2(scale);
  if (prev !== null && e >= prev - 0.25 && e < prev + 1.25) return prev;
  return Math.floor(e);
}

// The octave layer j of n holds when the finest held is `base`: each octave has one layer for good.
export function layerOctave(j, base, n) {
  return base + ((((j - base) % n) + n) % n);
}

// The cap a level's refines climb from: what its texels that did not escape have run to on
// average, where that is measured (stats.C, as a mean over all texels), and at least `cap`,
// which every one of them has. A level refined but for a block its window moved over is
// then taken to the target in one go, not back up from the block's cap.
export function reached(stats, cap) {
  if (!stats || stats.I <= 0) return cap;
  return Math.max(cap, stats.C / stats.I);
}

// The cap a level is refined to next; 0 for none. `cap` is what every texel of it has run to,
// `base` the view's cap, `target` what a still view is taken to (base while it moves).
export function refineTo(cap, stats, base, target) {
  if (cap >= target) return 0;
  const from = reached(stats, cap);
  if (target <= base) return from < CATCH_UP * base ? base : 0;
  const next = Math.max(base, from * CAP_STEP);
  return next * 2 >= target ? target : next;
}

// The least cap that leaves no more than a share `eps` of a probe's n points short of their
// escape. tails[b]: how many escaped at PROBE_EDGES[b] iterations or later, as far as the
// probe ran. No more than `ceiling`.
export function capFor(tails, n, eps, ceiling) {
  for (let b = 0; b < PROBE_EDGES.length; b++) {
    if (PROBE_EDGES[b] >= ceiling) break;
    if (tails[b] <= eps * n) return PROBE_EDGES[b];
  }
  return ceiling;
}

// Iterations a new texel costs at `cap`. stats: { W: mean iterations of escaped texels over
// all texels, I: share of texels that ran to their cap }, the level's own or a coarser one's.
export function fillCost(stats, own, cap) {
  if (!stats) return UNKNOWN_INTERIOR * cap + TEXEL_COST;
  return stats.W + (own ? stats.I : Math.max(stats.I, BORROWED_INTERIOR)) * cap + TEXEL_COST;
}

// Iterations per texel of refining a level to `cap`. stats.D is measured for stats.next.
export function refineCost(stats, cap) {
  if (!stats) return UNKNOWN_INTERIOR * cap + TEXEL_COST;
  if (stats.next === cap) return stats.D + TEXEL_COST;
  return stats.I * cap + TEXEL_COST;
}

// How a T-wide window at the gaze's offset (jx, jy) texels from where it should be moves:
// null (stay), 'far' (nothing worth keeping), or { axis: 0 | 1, c } with c signed texels.
export function shiftPlan(jx, jy, T) {
  const ax = Math.abs(jx), ay = Math.abs(jy);
  if (Math.max(ax, ay) < SHIFT_MIN) return null;
  if (Math.max(ax, ay) >= T >> 1) return 'far';
  const axis = ax >= ay ? 0 : 1, j = axis === 0 ? jx : jy;
  return { axis, c: Math.sign(j) * Math.min(Math.abs(j), SHIFT_MAX) };
}

// Indices [a, b) of a toroidal axis of T texels as texture runs [start, length], split at the wrap.
export function spans(a, b, T) {
  const out = [];
  let ta = ((a % T) + T) % T;
  let len = b - a;
  while (len > 0) {
    const n = Math.min(len, T - ta);
    out.push([ta, n]);
    len -= n;
    ta = 0;
  }
  return out;
}

// Progress through a block of w x h texels, row by row, a part row at a time where a whole
// one is more than there is budget for. p: { done: whole rows, col: texels of the next }.
// Takes up to n texels; returns the pieces [x, y, w, h] (block coordinates) and advances p.
export function advance(p, w, h, n) {
  const out = [];
  if (p.col > 0 && n > 0) {
    const c = Math.min(w - p.col, n);
    out.push([p.col, p.done, c, 1]);
    p.col += c;
    n -= c;
    if (p.col === w) { p.col = 0; p.done++; }
  }
  if (p.col === 0) {
    const rows = Math.min(h - p.done, Math.floor(n / w));
    if (rows > 0) { out.push([0, p.done, w, rows]); p.done += rows; n -= rows * w; }
    if (p.done < h && n > 0) { out.push([0, p.done, n, 1]); p.col = n; }
  }
  return out;
}
