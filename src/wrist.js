import * as THREE from 'three';

// The turn of a wrist between two poses of a hand in the room, radians, clockwise as seen from
// behind it: the change of its roll against the room's level, so that a level sweep of the
// arm is no turn however it points; pointing steeply up or down, where level means nothing,
// its twist about its own ray.
export const LEVEL = [0.2, 0.5]; // the cosine of the ray's pitch: twist alone below, roll alone above

const _d = new THREE.Quaternion(), _a = new THREE.Euler(), _b = new THREE.Euler();

export function wristTurn(prev, now) {
  _d.copy(prev).invert().multiply(now);
  const twist = 2 * Math.atan2(_d.z * Math.sign(_d.w || 1), Math.abs(_d.w));
  _a.setFromQuaternion(prev, 'YXZ');
  _b.setFromQuaternion(now, 'YXZ');
  let roll = _b.z - _a.z;
  roll -= Math.round(roll / (2 * Math.PI)) * 2 * Math.PI;
  const level = THREE.MathUtils.smoothstep(Math.min(Math.cos(_a.x), Math.cos(_b.x)), LEVEL[0], LEVEL[1]);
  return -(twist + (roll - twist) * level);
}
