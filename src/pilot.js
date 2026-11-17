// The way a 3D tour travels: a heading chosen from probe rays against the distance estimate.
// It makes for a surface a few arm's lengths ahead, at a slant, so the room glides along what
// it is near while the nearest of it keeps coming closer (and the room, sized to that, keeps
// getting smaller): never straight at a wall, never off into the open. Vectors are arrays in
// the world; lengths the pilot reasons in are room metres.

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l]; };

// Rodrigues: v turned about the unit axis k by the angle.
function turned(v, k, angle) {
  const c = Math.cos(angle), s = Math.sin(angle), kv = dot(k, v), x = cross(k, v);
  return [v[0] * c + x[0] * s + k[0] * kv * (1 - c), v[1] * c + x[1] * s + k[1] * kv * (1 - c), v[2] * c + x[2] * s + k[2] * kv * (1 - c)];
}

export const REACH = 12; // metres a probe goes before what is that way is called open
const AHEAD = 3.5; // arm's lengths of clear way the heading wants in front of it
const PROBE_STEPS = 32;
const SKY = 2; // what a way out into the open costs, beside a way that ends too far off
const TURN_COST = 0.35; // per radian squared off the heading
const WANDER = 0.3; // how far a liking for one side, slowly changing, tips ways otherwise alike
const WANDER_RATE = 0.25; // radians it drifts in a second's root
const PITCH_MAX = 0.7; // radians the heading may leave the room's level
const PITCH_COST = 6;
export const TURN_MAX = 0.25; // radians a second the heading turns, at most
const TURN_TIME = 1.2; // seconds to close on the way chosen
const TURN_EASE = 0.5; // seconds for the turning itself to change
const LEVEL_OFF = 2; // doublings above the smallest the room can be where the way ahead starts to lengthen
const PER_STEP = 3; // probes a step: the whole fan in a tenth of a second or so

// The fan: the heading, and rings about it. [angle off the heading, angle about it].
const FAN = [[0, 0]];
for (const [off, n, twist] of [[0.3, 6, 0], [0.7, 8, 0.39], [1.2, 8, 0]]) {
  for (let k = 0; k < n; k++) FAN.push([off, twist + (k / n) * 2 * Math.PI]);
}

export class Pilot {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.heading = [0, 0, -1];
    this.reset([0, 0, -1]);
  }

  reset(heading) {
    this.heading = unit(heading);
    this.rate = [0, 0, 0]; // the heading's turning: axis times radians a second
    this.rays = FAN.map(() => null); // { dir, free, open } as each was last probed
    this.next = 0;
    this.like = unit([this.rng() - 0.5, this.rng() - 0.5, this.rng() - 0.5]);
    this.lost = false; // every way is open: nothing to travel by
    this.near = Infinity; // metres to the nearest surface
    this.target = this.heading;
  }

  // The fan's k-th way, about the heading with the room's up for its top.
  way(k, up) {
    const [off, about] = FAN[k];
    const h = this.heading;
    let side = cross(h, up);
    side = len(side) < 1e-6 ? unit(cross(h, [up[1], up[2], up[0]])) : unit(side);
    const top = cross(side, h);
    const so = Math.sin(off);
    return unit(add(add([h[0] * Math.cos(off), h[1] * Math.cos(off), h[2] * Math.cos(off)], side, so * Math.cos(about)), top, so * Math.sin(about)));
  }

  // How far a way is clear, in room metres, and whether it ends in the open.
  probe(pos, dir, scale, de, arm) {
    const cap = REACH * scale;
    let t = 0, d = 0;
    for (let i = 0; i < PROBE_STEPS; i++) {
      d = de(pos[0] + dir[0] * t, pos[1] + dir[1] * t, pos[2] + dir[2] * t);
      if (d < Math.max(0.01 * t, 0.02 * arm * scale)) return { dir, free: t / scale, open: false };
      t += d;
      if (t >= cap) {
        // Past the reach with as much room about as way gone: the open, not a passage.
        d = de(pos[0] + dir[0] * cap, pos[1] + dir[1] * cap, pos[2] + dir[2] * cap);
        return { dir, free: REACH, open: d > 3 * arm * scale };
      }
    }
    return { dir, free: t / scale, open: false };
  }

  // pos: the head. scale: world units a room metre. up: the room's. de(x, y, z): the estimate.
  // arm: metres the nearest surface is kept at. floor: the smallest scale the room can have.
  // Returns the heading after dt seconds.
  step({ pos, scale, floor, up, de, arm, dt }) {
    for (let n = 0; n < PER_STEP; n++) {
      const k = this.next;
      this.next = (this.next + 1) % FAN.length;
      this.rays[k] = this.probe(pos, this.way(k, up), scale, de, arm);
    }
    // The side liked drifts: two flights from one place part ways.
    const j = WANDER_RATE * Math.sqrt(dt);
    this.like = unit(add(this.like, [this.rng() - 0.5, this.rng() - 0.5, this.rng() - 0.5], 2 * j));

    // The way wanted ahead lengthens as the room nears the smallest it can be, so the flight
    // levels off along the surface before the room stops shrinking; and where the surface is
    // nearer than the arm all the same, so it turns off.
    const near = this.near = de(pos[0], pos[1], pos[2]) / scale;
    const crowd = Math.max(1, arm / Math.max(near, 0.05 * arm));
    const level = 1 + 2 * Math.max(0, 1 - Math.log2(scale / floor) / LEVEL_OFF);
    const want = AHEAD * arm * crowd * crowd * level;
    let best = -Infinity, target = null, lost = true, seen = 0;
    for (const r of this.rays) {
      if (!r) continue;
      seen++;
      if (!r.open) lost = false;
      const off = Math.acos(Math.max(-1, Math.min(1, dot(r.dir, this.heading))));
      const pitch = Math.asin(Math.max(-1, Math.min(1, dot(r.dir, up))));
      const over = Math.max(0, Math.abs(pitch) - PITCH_MAX);
      const score = -Math.abs(Math.log(Math.max(r.free, 0.05 * arm) / want)) - (r.open ? SKY : 0)
        - TURN_COST * off * off - PITCH_COST * over * over + WANDER * dot(r.dir, this.like);
      if (score > best) { best = score; target = r.dir; }
    }
    this.lost = lost && seen === FAN.length;
    if (this.lost) {
      // Nothing in reach: toward the nearest of it, down the estimate's slope.
      const e = Math.max(near * scale * 0.01, 1e-7);
      const g = [de(pos[0] + e, pos[1], pos[2]) - de(pos[0] - e, pos[1], pos[2]), de(pos[0], pos[1] + e, pos[2]) - de(pos[0], pos[1] - e, pos[2]), de(pos[0], pos[1], pos[2] + e) - de(pos[0], pos[1], pos[2] - e)];
      if (len(g) > 0) target = unit([-g[0], -g[1], -g[2]]);
    }
    if (target) {
      // No steeper than PITCH_MAX from the room's level.
      const rise = dot(target, up), flat = add(target, up, -rise), fl = len(flat);
      const lim = Math.sin(PITCH_MAX);
      if (Math.abs(rise) > lim && fl > 1e-6) target = unit(add([flat[0] / fl * Math.cos(PITCH_MAX), flat[1] / fl * Math.cos(PITCH_MAX), flat[2] / fl * Math.cos(PITCH_MAX)], up, Math.sign(rise) * lim));
      this.target = target;
    }

    // Turn toward it: the turning eased, and no faster than TURN_MAX.
    const h = this.heading;
    const axis = cross(h, this.target), sin = len(axis);
    const angle = Math.atan2(sin, dot(h, this.target));
    const speed = Math.min(angle / TURN_TIME, TURN_MAX);
    const wish = sin > 1e-9 ? [axis[0] / sin * speed, axis[1] / sin * speed, axis[2] / sin * speed] : [0, 0, 0];
    const k = 1 - Math.exp(-dt / TURN_EASE);
    this.rate = add(this.rate, add(wish, this.rate, -1), k);
    const w = len(this.rate);
    if (w > 1e-9) this.heading = unit(turned(h, [this.rate[0] / w, this.rate[1] / w, this.rate[2] / w], w * dt));
    return this.heading;
  }
}
