// The image planner: from how the view is moving, the size of the next image, the display
// frames it may take, how much wider than the eyes it sees and where its camera is aimed.
// Nothing here draws: tools/replay.mjs runs the same rules over a recorded session's head.
import * as THREE from 'three';

export const CYCLE_MAX = [32, 32, 96]; // display frames per image at most, by quality level: a still view waits for its full size
export const CYCLE_MIN = 3; // and the fewest an image is shrunk to fit
export const WIDER_STEP = 0.03;
export const tune = {
  small: 0.4, // the smallest image, as a share of full size
  smallTurn: 0.25, // and while the view turns: a small image covers the turn, a late one leaves its edge bare
  turnSpan: 0.2, // radians the view may turn while one image is made: the wider camera covers it
  // Radians the nearest surface may shift by while one image is made. The present pass moves
  // each surface to where it now is, but what a silhouette uncovers was never in the image:
  // it is shown as what is beside the silhouette on the far side, which is wrong where the eye
  // has come round the edge of a body, and as wide as the shift. Larger images at 0.15 scored
  // better against converged renders (tools/motionbench.js) and made that wider.
  parallaxSpan: 0.06,
  hold: 0.3, // seconds the planned rates take to fall after the motion does: the size does not pump
  turnSlack: 0.08, // radians of the view the image on show may fail to cover before the next is due
  bare: 0.01, // radians of the view left bare by the image on show before the one in progress may be dropped
  // An image in progress that would arrive with this much of the view bare is dropped even for
  // one that arrives this many display frames later: it was aimed where the view no longer is.
  dropPast: 0.1, dropFrames: 8,
  widen: 0.75, // the angle an image sees past the eyes' view on each side, in the head's turn while it is drawn
  widerMax: 0.2, // radians, at most
  // How far ahead of the eyes an image's camera is, in the time the image takes: near the
  // middle of its time on show, so the head passes the place it was made for.
  lead: 1.25,
  leadMax: 0.25, // seconds, at most
  // A head that is speeding up will be turning faster while the image is on show: the rate
  // planned for is the one its acceleration gives over the image's time, by these factors.
  ahead: 2, // for the angle seen past the eyes' view
  aheadAim: 1, // for where the camera is aimed
  aheadMax: 0.2, // seconds of acceleration counted, at most
  editFrames: 6, // display frames per image at most while the fractal is being changed
  // A full-size image after smaller ones takes its history from the last full-size one while
  // the head is within this turn of the one that was made for and the nearest surface has
  // shifted by no more than this.
  detailTurn: 0.6, detailSpan: 0.15,
  // With the room still, the next full-size image is made from the last one's camera while
  // the head is within this turn and this shift of it: its samples add to the same pixels.
  // The view's edge is bare by the turn, and what that camera cannot see past a silhouette
  // is a guess as wide as the shift, so both are kept small: in a session, with the room
  // still, the head was within 0.03 rad of where it had been for a second or more three
  // quarters of the time, and nine tenths of the frames shown from such a camera were within
  // 0.01 of shift.
  anchorTurn: 0.03, anchorSpan: 0.03,
};

const UP = new THREE.Vector3(0, 1, 0);
const VEL_SECONDS = 0.08, ACC_SECONDS = 0.05; // smoothing of the head's velocities, and of its turn's acceleration

// How fast the view changes. The head's own turn and travel are measured and smoothed; the
// turn the stick commands and the room's own travel are known exactly, and so are kept apart:
// they start and stop when they do, with no smoothing behind them. turn, parallax: radians
// per second, of the whole view and of the nearest surface.
export function createMotion() {
  return {
    turn: 0, parallax: 0, turnHeld: 0, parallaxHeld: 0, headParHeld: 0, has: false,
    q: new THREE.Quaternion(), p: new THREE.Vector3(),
    headVel: new THREE.Vector3(), headAcc: new THREE.Vector3(), stickRate: 0, // radians per second, the stick's about up
    up: new THREE.Vector3(0, 1, 0), // the room's up in the world
    headLin: new THREE.Vector3(), // the head's own travel, in the room
    angVel: new THREE.Vector3(), linVel: new THREE.Vector3(), // the head's and the stick's turn together; the head's travel and the room's
    _q: new THREE.Quaternion(), _y: new THREE.Quaternion(), _d: new THREE.Quaternion(), _v: new THREE.Vector3(), _w: new THREE.Vector3(), _m: new THREE.Matrix4(), _t: new THREE.Matrix4(),
    _o: new THREE.Vector3(), _s: new THREE.Vector3(),
  };
}

// The rotation vector of a quaternion.
function rotationVector(d, out) {
  const s = d.w < 0 ? -1 : 1;
  const sin = Math.hypot(d.x, d.y, d.z);
  return out.set(d.x, d.y, d.z).multiplyScalar(sin > 1e-12 ? s * 2 * Math.atan2(sin, s * d.w) / sin : 0);
}

// One display frame. q, p: the head in the world. yaw: the turn the stick made this frame,
// radians about up (the room's, in the world), already in q. room: how far the room's own
// motion carried the head this frame, already in p. near: the distance of the nearest surface.
// cut: the view jumped, which is not motion.
export function stepMotion(motion, q, p, dt, { yaw = 0, up = UP, near = Infinity, cut = false, room = null } = {}) {
  motion.up.copy(up);
  if (!motion.has || cut || dt <= 0) {
    motion.headVel.set(0, 0, 0); motion.headAcc.set(0, 0, 0); motion.headLin.set(0, 0, 0); motion.linVel.set(0, 0, 0); motion.stickRate = 0;
    motion.angVel.set(0, 0, 0); motion.turn = 0; motion.parallax = 0; motion.turnHeld = 0; motion.parallaxHeld = 0; motion.headParHeld = 0;
  } else {
    // The head's own turn: the world rotation since the last frame, less the stick's.
    const d = motion._d.copy(motion.q).invert().premultiply(q);
    if (yaw) d.premultiply(motion._y.setFromAxisAngle(up, -yaw));
    rotationVector(d, motion._v).divideScalar(dt);
    const was = motion._w.copy(motion.headVel);
    motion.headVel.lerp(motion._v, 1 - Math.exp(-dt / VEL_SECONDS));
    motion._v.copy(motion.headVel).sub(was).divideScalar(dt);
    motion.headAcc.lerp(motion._v, 1 - Math.exp(-dt / ACC_SECONDS));
    motion._v.copy(p).sub(motion.p);
    if (room) motion._v.sub(room);
    motion.headLin.lerp(motion._v.divideScalar(dt), 1 - Math.exp(-dt / VEL_SECONDS));
    // The stick turns the room the head moves in, and its velocities with it.
    if (yaw) { motion.headVel.applyAxisAngle(up, yaw); motion.headAcc.applyAxisAngle(up, yaw); motion.headLin.applyAxisAngle(up, yaw); }
    motion.stickRate = yaw / dt;
    motion.angVel.copy(motion.headVel).addScaledVector(up, motion.stickRate);
    motion.turn = motion.angVel.length();
    motion.linVel.copy(motion.headLin);
    if (room) motion.linVel.addScaledVector(room, 1 / dt);
    const per = isFinite(near) && near > 0 ? 1 / near : 0;
    motion.parallax = motion.linVel.length() * per;
    // The head's own rates are held; the room's travel is as fast as it is now.
    const fall = Math.exp(-dt / tune.hold);
    motion.turnHeld = Math.max(motion.turn, motion.turnHeld * fall);
    motion.headParHeld = Math.max(motion.headLin.length() * per, motion.headParHeld * fall);
    motion.parallaxHeld = motion.headParHeld + (room ? room.length() / dt * per : 0);
  }
  motion.q.copy(q);
  motion.p.copy(p);
  motion.has = true;
}

// The head against the one an image was made for: the turn (a rotation vector) in motion._o
// and the shift in motion._s.
export function headFrom(motion, img) {
  rotationVector(motion._d.copy(img.q).invert().premultiply(motion.q), motion._o);
  motion._s.copy(motion.p).sub(img.p);
}

// Seconds until |a + b t| passes r: 0 when it already has.
export function secondsWithin(a, b, r) {
  const aa = a.lengthSq(), bb = b.lengthSq(), ab = a.dot(b);
  if (aa > r * r) return 0;
  if (bb < 1e-18) return Infinity;
  return (-ab + Math.sqrt(ab * ab - bb * (aa - r * r))) / bb;
}

const nearOf = (near) => (isFinite(near) && near > 0 ? near : 0);

// Seconds until the view leaves what an image covers, at the view's present velocities: by
// its turn into out.turn, by the shift of the nearest surface into out.shift.
export function coverSeconds(motion, img, near, out) {
  headFrom(motion, img);
  out.turn = secondsWithin(motion._o, motion.angVel, img.wider + tune.turnSlack);
  out.shift = nearOf(near) ? secondsWithin(motion._s, motion.linVel, tune.parallaxSpan * near) : Infinity;
  return out;
}

// Whether the view has turned past what an image covers.
export function bare(motion, img) {
  headFrom(motion, img);
  return motion._o.length() > img.wider + tune.bare;
}

// How many display frames later than an image in progress a new one may arrive and still
// replace it: -1 when the one in progress is kept. t: seconds until it is done. shown: the
// image on show, if there is one.
export function dropWithin(motion, img, shown, near, t) {
  headFrom(motion, img);
  const past = motion._o.addScaledVector(motion.angVel, t).length() - img.wider;
  if (past > tune.dropPast) return tune.dropFrames;
  if (past > tune.turnSlack) return 0;
  if (nearOf(near) && motion._s.addScaledVector(motion.linVel, t).length() > tune.parallaxSpan * near) return 0;
  return shown && bare(motion, shown) ? 0 : -1;
}

// The size of the next image and the display frames it takes. share: the display frames a
// full image takes. dt: seconds a display frame. was: the size of the image before.
// coverTurn, coverShift: seconds the image on show still covers the view. A turn may shrink
// the image further than anything else may: what a turn leaves bare is the edge of the view.
export function planSize(motion, { share, level, dt, was, coverTurn = Infinity, coverShift = Infinity, editing = false }, out) {
  const top = CYCLE_MAX[level];
  let turn = Math.min(tune.turnSpan / Math.max(motion.turnHeld * dt, 1e-9), coverTurn / dt);
  let rest = Math.min(tune.parallaxSpan / Math.max(motion.parallaxHeld * dt, 1e-9), coverShift / dt);
  if (editing) rest = Math.min(rest, tune.editFrames);
  turn = THREE.MathUtils.clamp(turn, CYCLE_MIN, top);
  rest = THREE.MathUtils.clamp(rest, CYCLE_MIN, top);
  let m = Math.min(1, Math.max(tune.small, Math.sqrt(rest / share)), Math.max(tune.smallTurn, Math.sqrt(turn / share)));
  // In twentieths, and not chasing small changes: every change of size resamples the history.
  m = Math.round(m * 20) / 20;
  if (m < 1 && Math.abs(m - was) < 0.075) m = Math.max(tune.smallTurn, was);
  out.m = m;
  out.k = Math.min(top, Math.max(1, Math.ceil(share * m * m)));
  return out;
}

// What an image of k display frames sees past the eyes' view (out.wider, radians on each
// side), and where its camera is against the eyes: turned by out.q, and out.lead seconds on
// along the head's path. The head is expected to keep its turn, or by its acceleration to
// gain on it. The stick, held, turns the view at its rate, and let go stops it at once: the
// camera is aimed between the two, and sees wide enough for both.
export function planView(motion, k, dt, out) {
  const T = (k - 1) * dt;
  const h = Math.min(T, tune.aheadMax);
  const rate = Math.max(motion.headVel.length(), motion._v.copy(motion.headVel).addScaledVector(motion.headAcc, h * tune.ahead).length());
  const steady = THREE.MathUtils.smoothstep(rate + motion.parallax, 0.05, 0.15);
  const wider = k > 1 ? steady * tune.widen * (rate + motion.parallax) * k * dt + Math.abs(motion.stickRate) * T : 0;
  out.wider = Math.min(tune.widerMax, Math.max(0, Math.ceil(wider / WIDER_STEP - 0.25)) * WIDER_STEP);
  out.lead = steady * Math.min(tune.leadMax, tune.lead * T);
  motion._v.copy(motion.headVel).addScaledVector(motion.headAcc, h * tune.aheadAim).multiplyScalar(out.lead);
  const ang = motion._v.length();
  out.q.setFromAxisAngle(ang > 0 ? motion._v.divideScalar(ang) : UP, ang).premultiply(motion._y.setFromAxisAngle(motion.up, motion.stickRate * T));
  return out;
}
