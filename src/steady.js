// A squeeze steadies the aim. Pulling a trigger turns the hand, and so does letting it go: the
// point is held where it was just before the trigger began to travel, until the trigger is
// still again, unless the hand strays (a sweep, not a pull). What the hold kept the point from
// the ray by is then made up as the hand moves on, so nothing jumps and a drag goes on from
// where it was pressed; with the trigger let go, it is made up in a moment whether the hand
// moves or not. Points are [x, y] on one surface, in its units.

export const LATELY = 0.15; // seconds of the trigger looked back over
export const FALL = 0.08; // the trigger travels when it has changed by more than this lately
export const REST = 0.03; // the trigger had not yet set off within this of where it came from
export const LEAD = 0.025; // seconds before the trigger set off that the hand began to turn
export const HOLD_MAX = 0.4; // seconds a point is held, at most
export const SETTLE = 0.15; // seconds the point takes back to the ray, the trigger let go and still

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export class Steady {
  constructor() { this.reset(); }

  reset() {
    this.hold = null; // { point, raw, t }: the point held, and the ray's own as the hold began
    this.spent = false; // a hold strayed from or outlasted: none again until the trigger is still
    this.offset = [0, 0]; // the point used, less the ray's, as the last hold left it
    this.from = null; // the ray's point as it did
    this.k = 0; // the share of the offset not yet made up
    this.recent = []; // [age, trigger, point], LATELY back
    this.was = false;
    this.slip = 0; // how far the last press was kept from the ray
  }

  // The point used is not the ray's own.
  get engaged() { return this.hold !== null || this.k > 0; }

  point(at) { return [at[0] + this.offset[0] * this.k, at[1] + this.offset[1] * this.k]; }

  release(at, spent) {
    this.offset = [this.hold.point[0] - at[0], this.hold.point[1] - at[1]];
    this.from = at;
    this.k = 1;
    this.hold = null;
    this.spent = spent;
  }

  // The ray's point LEAD before the trigger set off from where it rested.
  before(lo, hi) {
    const r = this.recent;
    const up = r[r.length - 1][1] >= r[0][1];
    let i = r.length - 1;
    while (i > 0 && (up ? r[i][1] - lo : hi - r[i][1]) > REST) i--;
    const age = r[i][0] + LEAD;
    while (i > 0 && r[i][0] < age) i--;
    return r[i][2];
  }

  // at: the ray's point, or null off the surface. value: the trigger, 0 to 1. stray: how far
  // the ray may go from where a hold began. Returns the point to use.
  update({ at, value, pressed, stray, dt }) {
    if (!at) { this.reset(); this.was = pressed; return null; }
    for (const s of this.recent) s[0] += dt;
    while (this.recent.length && this.recent[0][0] > LATELY) this.recent.shift();
    const oldest = this.recent.length ? this.recent[0][2] : at;
    this.recent.push([0, value, at]);
    let lo = 1, hi = 0;
    for (const s of this.recent) { lo = Math.min(lo, s[1]); hi = Math.max(hi, s[1]); }
    if (hi - lo <= FALL) {
      if (this.hold) this.release(at, false);
      this.spent = false;
      // Nothing held and the trigger still: the point comes back to the ray of itself.
      if (!pressed) this.k = Math.max(0, this.k - dt / SETTLE);
    } else if (!this.hold && !this.spent) {
      // A hand already well on its way is sweeping: nothing to keep it to.
      if (dist(at, oldest) > stray) this.spent = true;
      else {
        const before = this.before(lo, hi);
        this.hold = { point: this.point(before), raw: before, t: 0 };
      }
    }
    if (this.hold) {
      this.hold.t += dt;
      if (dist(at, this.hold.raw) > stray || this.hold.t > HOLD_MAX) this.release(at, true);
    }
    if (!this.hold && this.k > 0) {
      const size = Math.hypot(this.offset[0], this.offset[1]);
      this.k = size > 0 ? Math.min(this.k, Math.max(0, 1 - dist(at, this.from) / size)) : 0;
    }
    const p = this.hold ? this.hold.point : this.point(at);
    if (pressed && !this.was) this.slip = dist(p, at);
    this.was = pressed;
    return p;
  }
}
