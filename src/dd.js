// Double-double arithmetic: ~106 bits of mantissa from two JS doubles.
// Values are [hi, lo]. Only what the reference orbit needs.

const SPLIT = 134217729; // 2^27 + 1

function twoSum(a, b) {
  const s = a + b;
  const bb = s - a;
  return [s, (a - (s - bb)) + (b - bb)];
}

function quickTwoSum(a, b) {
  const s = a + b;
  return [s, b - (s - a)];
}

function split(a) {
  const t = SPLIT * a;
  const hi = t - (t - a);
  return [hi, a - hi];
}

function twoProd(a, b) {
  const p = a * b;
  const [ah, al] = split(a);
  const [bh, bl] = split(b);
  return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl];
}

export function dd(x) {
  return [x, 0];
}

export function ddAdd(a, b) {
  const [s, e] = twoSum(a[0], b[0]);
  return quickTwoSum(s, e + a[1] + b[1]);
}

export function ddSub(a, b) {
  const [s, e] = twoSum(a[0], -b[0]);
  return quickTwoSum(s, e + a[1] - b[1]);
}

export function ddMul(a, b) {
  const [p, e] = twoProd(a[0], b[0]);
  return quickTwoSum(p, e + a[0] * b[1] + a[1] * b[0]);
}

export function ddMulD(a, d) {
  const [p, e] = twoProd(a[0], d);
  return quickTwoSum(p, e + a[1] * d);
}

export function ddAddD(a, d) {
  const [s, e] = twoSum(a[0], d);
  return quickTwoSum(s, e + a[1]);
}

export function ddNeg(a) {
  return [-a[0], -a[1]];
}

export function ddAbs(a) {
  return a[0] < 0 || (a[0] === 0 && a[1] < 0) ? ddNeg(a) : a;
}

export function ddToNum(a) {
  return a[0] + a[1];
}

// Decimal string with the full double-double precision, for the info readout.
export function ddToString(a, digits = 32) {
  let sign = '';
  let v = a;
  if (v[0] < 0 || (v[0] === 0 && v[1] < 0)) { sign = '-'; v = ddNeg(v); }
  const ip = Math.floor(v[0]);
  let frac = ddAddD(v, -ip);
  let out = `${sign}${ip}.`;
  for (let i = 0; i < digits; i++) {
    frac = ddMulD(frac, 10);
    const d = Math.floor(frac[0]);
    out += String(Math.max(0, Math.min(9, d)));
    frac = ddAddD(frac, -d);
  }
  return out;
}
