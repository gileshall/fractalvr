// Fullscreen-triangle shaders for the 3D path: a low-res jittered geometry pass writes a
// G-buffer (orbit trap, view distance, AO, shadow, normal); the accumulate pass gathers
// those samples into an eye-resolution history that is reprojected through world space and
// lights the result into a colour image; the present pass reprojects that image to the
// current head pose.

import { BOX_TOL, FRACTALS, POLY } from './fractals.js';

const vec3 = (v) => `vec3(${v.map((x) => x.toPrecision(9)).join(', ')})`;

export const fullscreenVertex = /* glsl */ `
out vec3 vFar;
out vec2 vNdc;
flat out vec2 vProjZ;

void main() {
  vec4 clip = vec4(position.xy, 1.0, 1.0);
  vec4 v = inverse(projectionMatrix) * clip;
  v.xyz /= v.w;
  vFar = (inverse(viewMatrix) * vec4(v.xyz, 1.0)).xyz;
  vProjZ = vec2(projectionMatrix[2][2], projectionMatrix[3][2]);
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const common = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

in vec3 vFar;
in vec2 vNdc;
flat in vec2 vProjZ;

uniform vec3 uPalA, uPalB, uPalC, uPalD;
uniform float uColorFreq;
uniform float uColorPhase;
uniform float uFoveate;

const float HIGHLIGHT = 0.15; // a surface's highlight at its brightest
vec3 palette(float t) {
  return uPalA + uPalB * cos(6.28318 * (uPalC * t + uPalD));
}

// Column-major: rotates by +a, matching rot2 in fractals.js and View2D.pan.
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

// Peripheral factor 0..1 (0 at the eye centre). Widens the march cone, never cuts steps.
float fovea() {
  return uFoveate * smoothstep(0.35, 1.3, length(vNdc));
}

float depthOf(vec3 worldP) {
  float zv = (viewMatrix * vec4(worldP, 1.0)).z;
  float ndc = (vProjZ.x * zv + vProjZ.y) / (-zv);
  return ndc * 0.5 + 0.5;
}

// ---- backgrounds (linear colour)
uniform int uBackground; // 0 starfield, 1 sky, 2 clouds, 3 water, 4 gradient, 5 passthrough
uniform float uTime;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// Integer-friendly hash (cell coordinates are small integers).
vec3 hash33(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453);
}

float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * noise3(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return s;
}

vec3 rotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }

// One layer of stars: a hashed point per cell, a Gaussian dot around it.
float stars(vec3 rd, float cells, float density, float t) {
  vec3 p = rd * cells;
  vec3 c = floor(p);
  vec3 h = hash33(c);
  if (h.x > density) return 0.0;
  vec3 sp = c + 0.5 + (h - 0.5) * 0.8;
  // Angular distance to the star, in cells, so the dot is round and pixel-sized.
  float d = length(cross(normalize(sp), rd)) * cells;
  float twinkle = 0.8 + 0.2 * sin(t * (1.5 + 3.0 * h.z) + h.y * 40.0);
  float mag = 0.15 + 0.85 * pow(h.y, 4.0);
  return exp(-d * d * 60.0) * mag * twinkle;
}

vec3 daySky(vec3 rd) {
  vec3 sunDir = normalize(vec3(0.4, 0.45, 0.35));
  float y = clamp(rd.y, -1.0, 1.0);
  vec3 col = mix(vec3(0.62, 0.74, 0.90), vec3(0.10, 0.32, 0.78), pow(max(y, 0.0), 0.6));
  if (y < 0.0) col = mix(vec3(0.62, 0.74, 0.90), vec3(0.30, 0.29, 0.27), smoothstep(0.0, 0.15, -y));
  float s = max(dot(rd, sunDir), 0.0);
  col += vec3(1.0, 0.95, 0.85) * (pow(s, 900.0) * 4.0 + pow(s, 12.0) * 0.25);
  return col;
}

vec3 background(vec3 rd) {
  float t = uTime;
  if (uBackground == 5) return vec3(0.0);
  if (uBackground == 1) return daySky(rd);
  if (uBackground == 2) {
    vec3 col = daySky(rd);
    if (rd.y > 0.02) {
      vec2 uv = rd.xz / rd.y;
      float d = fbm(vec3(uv * 0.35 + t * 0.012, t * 0.03));
      float cov = smoothstep(0.42, 0.7, d) * smoothstep(0.02, 0.15, rd.y);
      vec3 cloud = mix(vec3(0.55, 0.58, 0.66), vec3(1.0), smoothstep(0.42, 0.9, d));
      col = mix(col, cloud, cov);
    }
    return col;
  }
  if (uBackground == 3) {
    if (rd.y >= -0.005) return daySky(rd);
    vec2 uv = rd.xz / rd.y;
    float n1 = fbm(vec3(uv * 1.5, t * 0.35)) - 0.5;
    float n2 = fbm(vec3(uv * 1.5 + 7.3, t * 0.3)) - 0.5;
    vec3 nrm = normalize(vec3(n1 * 0.35, 1.0, n2 * 0.35));
    vec3 r = reflect(rd, nrm);
    r.y = abs(r.y);
    float fres = pow(1.0 - clamp(-rd.y, 0.0, 1.0), 3.0);
    vec3 deep = vec3(0.02, 0.10, 0.16);
    return mix(deep, daySky(r), 0.15 + 0.8 * fres);
  }
  if (uBackground == 4) {
    vec3 a = 0.5 + 0.5 * cos(t * 0.05 + vec3(0.0, 2.1, 4.2));
    vec3 b = 0.5 + 0.5 * cos(t * 0.04 + 1.7 + vec3(0.0, 2.1, 4.2));
    vec3 axis = normalize(vec3(sin(t * 0.02), 1.0, cos(t * 0.03)));
    float m = dot(rd, axis) * 0.5 + 0.5;
    return mix(a, b, m) * 0.35;
  }
  // Starfield with a tilted, slowly turning milky way.
  vec3 d = rotY(rd, t * 0.004);
  vec3 axis = normalize(vec3(0.3, 0.85, 0.45));
  float b = dot(d, axis);
  float band = exp(-b * b / 0.035);
  float dust = fbm(d * 5.0 + 3.0);
  float lanes = fbm(d * 14.0 + 9.0);
  vec3 mw = band * (0.12 + 0.35 * dust) * vec3(0.30, 0.30, 0.42) * (0.5 + 0.7 * lanes);
  mw += band * band * dust * dust * vec3(0.45, 0.38, 0.30) * 0.4;
  float st = stars(d, 220.0, 0.05, t) + stars(d, 520.0, 0.04, t) * 0.5 + stars(d, 90.0, 0.02, t) * 1.5;
  st += band * stars(d, 700.0, 0.12, t) * 0.35;
  return vec3(0.003, 0.004, 0.008) + mw + st * (vec3(0.85, 0.9, 1.0) + band * vec3(0.2, 0.1, 0.0));
}

vec3 sky(vec3 rd) { return background(rd); }

`;

// ---------------------------------------------------------------- 3D geometry pass

// The distance estimators and what a march reads, for both geometry passes.
export const estimators = /* glsl */ `
uniform int uFractal;
uniform float uP1, uP2, uP3, uP4, uP5, uP6, uP7, uP8;
uniform float uScale;      // fractal units per room metre
uniform float uPixelAngle; // radians per pixel of the accumulation target
uniform float uEpsMul;     // surface threshold relative to the pixel footprint
uniform float uNormalPx;   // normal footprint in accumulation pixels
uniform float uPrec;       // float32 noise of the estimator relative to |p|
uniform int uMaxSteps;
uniform float uBound;      // bounding sphere radius, 0 = unbounded
uniform int uAOSamples;    // 0 = off
uniform int uShadows;
uniform vec3 uLightPos;    // world space
uniform int uLightMode;    // 0 fixed world light, 1 headlamp, 2 hand torch

float gTrap;
float gWork = 0.0; // estimator iterations run for this sample

float deMandelbulb(vec3 p) {
  float power = uP1;
  int iters = int(uP3);
  vec3 z = p;
  float dr = 1.0;
  float r = 0.0;
  gTrap = 1e9;
  for (int i = 0; i < 20; i++) {
    if (i >= iters) break;
    r = length(z);
    if (r > 2.0) break;
    float theta = acos(clamp(z.z / r, -1.0, 1.0)) * power;
    float phi = atan(z.y, z.x) * power + uP2;
    dr = pow(r, power - 1.0) * power * dr + 1.0;
    float zr = pow(r, power);
    z = zr * vec3(sin(theta) * cos(phi), sin(phi) * sin(theta), cos(theta)) + p;
    gTrap = min(gTrap, r);
    gWork += 1.0;
  }
  return 0.5 * log(r) * r / dr;
}

float deMandelbox(vec3 p) {
  float scale = uP1;
  float minR2 = uP2 * uP2;
  float fold = uP3;
  int iters = int(uP4);
  vec3 z = p;
  float dr = 1.0;
  float as = abs(scale);
  // Once z is this far out the iterations left only scale it: the folds and p move the
  // estimate by less than BOX_TOL of itself, and the derivative grows as it would have.
  float far = as > 1.0 ? (3.4642 * fold * as + length(p)) / ((as - 1.0) * ${BOX_TOL}) : 1e18;
  far *= far;
  gTrap = 1e9;
  for (int i = 0; i < 24; i++) {
    if (i >= iters) break;
    z = clamp(z, -fold, fold) * 2.0 - z;
    float r2 = dot(z, z);
    if (r2 < minR2) { float t = 1.0 / minR2; z *= t; dr *= t; }
    else if (r2 < 1.0) { float t = 1.0 / r2; z *= t; dr *= t; }
    z = scale * z + p;
    dr = dr * as + 1.0;
    gTrap = min(gTrap, r2);
    gWork += 1.0;
    if (dot(z, z) > far) { dr += (1.0 - pow(as, float(i + 1 - iters))) / (as - 1.0); break; }
  }
  return length(z) / dr;
}

float deMenger(vec3 z) {
  float off = uP1;
  mat2 R = rot2(uP2);
  int iters = int(uP3);
  float sc = 1.0;
  gTrap = 1e9;
  for (int i = 0; i < 12; i++) {
    if (i >= iters) break;
    z.xz = R * z.xz;
    z = abs(z);
    if (z.x < z.y) z.xy = z.yx;
    if (z.x < z.z) z.xz = z.zx;
    if (z.y < z.z) z.yz = z.zy;
    z = z * 3.0 - vec3(off) * 2.0;
    if (z.z < -off) z.z += 2.0 * off;
    sc *= 3.0;
    gTrap = min(gTrap, length(z));
  }
  gWork += float(iters);
  return (length(z) - 1.0) / sc;
}

float deSierpinski(vec3 z) {
  float scale = uP1;
  mat2 R = rot2(uP2);
  int iters = int(uP3);
  float sc = 1.0;
  gTrap = 1e9;
  for (int i = 0; i < 16; i++) {
    if (i >= iters) break;
    z.xy = R * z.xy;
    if (z.x + z.y < 0.0) z.xy = -z.yx;
    if (z.x + z.z < 0.0) z.xz = -z.zx;
    if (z.y + z.z < 0.0) z.zy = -z.yz;
    z = z * scale - vec3(scale - 1.0);
    sc *= scale;
    gTrap = min(gTrap, length(z));
  }
  gWork += float(iters);
  return length(z) / sc;
}

float deQuatJulia(vec3 p) {
  vec4 c = vec4(uP1, uP2, uP3, 0.0);
  int iters = int(uP4);
  vec4 z = vec4(p, 0.0);
  float md2 = 1.0;
  float mz2 = dot(z, z);
  gTrap = 1e9;
  for (int i = 0; i < 20; i++) {
    if (i >= iters) break;
    md2 *= 4.0 * mz2;
    gWork += 1.0;
    z = vec4(z.x * z.x - dot(z.yzw, z.yzw), 2.0 * z.x * z.yzw) + c;
    mz2 = dot(z, z);
    gTrap = min(gTrap, mz2);
    if (mz2 > 4.0) break;
  }
  return 0.25 * sqrt(mz2 / md2) * log(mz2);
}

float deApollonian(vec3 p) {
  float s = uP1;
  int iters = int(uP3);
  float scale = 1.0;
  gTrap = 1e9;
  p.xz = rot2(uP2) * p.xz;
  for (int i = 0; i < 12; i++) {
    if (i >= iters) break;
    p = -1.0 + 2.0 * fract(0.5 * p + 0.5);
    float r2 = dot(p, p);
    gTrap = min(gTrap, r2);
    float k = s / r2;
    p *= k;
    scale *= k;
  }
  gWork += float(iters);
  return 0.25 * abs(p.y) / scale;
}

float deJuliaBulb(vec3 p) {
  float power = uP1;
  vec3 c = vec3(uP2, uP3, uP4);
  int iters = int(uP5);
  vec3 z = p;
  float dr = 1.0;
  float r = 0.0;
  gTrap = 1e9;
  for (int i = 0; i < 20; i++) {
    if (i >= iters) break;
    r = length(z);
    if (r > 2.0) break;
    float theta = acos(clamp(z.z / r, -1.0, 1.0)) * power;
    float phi = atan(z.y, z.x) * power;
    dr = pow(r, power - 1.0) * power * dr;
    float zr = pow(r, power);
    z = zr * vec3(sin(theta) * cos(phi), sin(phi) * sin(theta), cos(theta)) + c;
    gTrap = min(gTrap, r);
    gWork += 1.0;
  }
  return 0.5 * log(r) * r / dr;
}

float deKalibox(vec3 p) {
  float scale = uP1;
  float minR2 = uP2 * uP2;
  vec3 shift = vec3(uP3, uP4, uP3);
  vec3 c = vec3(uP5, uP6, uP7);
  int iters = int(uP8);
  vec3 z = p;
  float dr = 1.0;
  // Past this radius a step only takes the point further out: the solid is what is within
  // it after the iterations.
  float escape = (scale * length(shift) + length(c)) / (scale - 1.0);
  // As the Mandelbox's: this far out the iterations left only scale the point.
  float far = escape / ${BOX_TOL};
  far *= far;
  gTrap = 1e9;
  for (int i = 0; i < 24; i++) {
    if (i >= iters) break;
    z = abs(z) + shift;
    float r2 = dot(z, z);
    float k = scale / clamp(r2, minR2, 1.0);
    z = z * k + c;
    dr = dr * k + 1.0;
    gTrap = min(gTrap, r2);
    gWork += 1.0;
    if (dot(z, z) > far) {
      float left = pow(scale, float(i + 1 - iters));
      dr += (1.0 - left) / (scale - 1.0);
      escape *= left;
      break;
    }
  }
  return (length(z) - escape) / dr;
}

float dePseudoKleinian(vec3 p) {
  float size = uP1;
  vec3 box = vec3(uP2, uP3, uP4);
  int iters = int(uP6);
  float df = 1.0;
  gTrap = 1e9;
  for (int i = 0; i < 16; i++) {
    if (i >= iters) break;
    p = 2.0 * clamp(p, -box, box) - p;
    float r2 = dot(p, p);
    gTrap = min(gTrap, r2);
    float k = max(size / r2, 1.0);
    p *= k;
    df *= k;
  }
  gWork += float(iters);
  return 0.5 * (abs(p.y) - uP5) / df;
}

// A polyhedral group as a fold onto one chamber (POLY in fractals.js).
vec3 polyFold(vec3 z, bool icosa) {
  z = abs(z);
  if (icosa) {
    const vec3 n1 = ${vec3(POLY.icosa.n1)};
    const vec3 n2 = ${vec3(POLY.icosa.n2)};
    for (int k = 0; k < 2; k++) {
      z -= 2.0 * max(dot(z, n1), 0.0) * n1;
      z = abs(z - 2.0 * max(dot(z, n2), 0.0) * n2);
    }
  } else {
    if (z.x < z.y) z.xy = z.yx;
    if (z.x < z.z) z.xz = z.zx;
    if (z.y < z.z) z.yz = z.zy;
  }
  return z;
}

vec3 polyDir(float t, bool icosa) {
  vec3 a = icosa ? ${vec3(POLY.icosa.corners[0])} : ${vec3(POLY.octa.corners[0])};
  vec3 b = icosa ? ${vec3(POLY.icosa.corners[1])} : ${vec3(POLY.octa.corners[1])};
  vec3 c = icosa ? ${vec3(POLY.icosa.corners[2])} : ${vec3(POLY.octa.corners[2])};
  return normalize(t < 1.0 ? mix(a, b, t) : mix(b, c, t - 1.0));
}

// A solid with faces across n, and at each step smaller copies of it where o meets a face.
float dePoly(vec3 z, bool icosa) {
  float scale = uP1;
  vec3 n = polyDir(uP3, icosa);
  vec3 o = polyDir(uP2, icosa);
  o *= (scale - 1.0) / dot(o, n);
  mat2 R = rot2(uP4);
  int iters = int(uP5);
  float sc = 1.0;
  gTrap = 1e9;
  for (int i = 0; i < 14; i++) {
    if (i >= iters) break;
    z.xz = R * z.xz;
    z = polyFold(z, icosa) * scale - o;
    sc *= scale;
    gTrap = min(gTrap, length(z));
  }
  gWork += float(iters) + 1.0;
  return (dot(polyFold(z, icosa), n) - 1.0) / sc;
}

float deIcosahedron(vec3 p) { return dePoly(p, true); }
float deOctahedron(vec3 p) { return dePoly(p, false); }

// uFractal is the catalogue's index.
float map(vec3 p) {
${FRACTALS.map((f, i) => (f.kind === '3d' ? `  if (uFractal == ${i}) return ${f.glsl}(p);
` : '')).join('')}  return 1e9;
}

// Entry distance into a bounding sphere, or -1 when the ray misses it entirely.
float boundEntry(vec3 ro, vec3 rd, float radius) {
  if (uBound <= 0.0) return 0.0;
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  if (c <= 0.0) return 0.0;
  float h = b * b - c;
  if (h < 0.0 || b > 0.0) return -1.0;
  return -b - sqrt(h);
}
`;

export const CONE = 4; // geometry samples to the side of a cone

export const geometryFragment = common + estimators + /* glsl */ `
layout(location = 0) out vec4 gA; // trap, view distance (-1 sky), ao * shadow, 0
layout(location = 1) out vec4 gB; // normal, work

uniform sampler2D uClear; // the cone pass: how far every sample of a cone is clear, its work per sample
uniform vec3 uConeLay;   // samples and cones to an eye's width; 1 where the cone pass ran
uniform float uRelax;    // a step, in what the estimate vouches for

// Zero where the estimate has no slope to give one.
vec3 calcNormal(vec3 p, float eps) {
  vec2 e = vec2(1.0, -1.0) * 0.5773 * eps;
  vec3 g = e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) + e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx);
  float l = dot(g, g);
  return l > 0.0 && l < 1e30 ? g * inversesqrt(l) : vec3(0.0);
}

// Each sample is normalised by its own reach so the footprint does not change the strength.
float calcAO(vec3 p, vec3 n, float px) {
  float sc = uScale * 0.4;
  float occ = 0.0, sca = 1.0;
  float step = 0.375 / float(uAOSamples);
  for (int i = 0; i < 8; i++) {
    if (i >= uAOSamples) break;
    float k = 0.03 + step * float(i);
    float h = max(k * sc, 3.0 * px);
    float d = map(p + h * n);
    occ += (h - d) / h * k * sca;
    sca *= 0.8;
  }
  return clamp(1.0 - 1.5 * occ * 3.0 / float(uAOSamples), 0.0, 1.0);
}

float softShadow(vec3 ro, vec3 rd, float mint, float maxt) {
  float res = 1.0;
  float t = mint;
  for (int i = 0; i < 24; i++) {
    float h = map(ro + rd * t);
    res = min(res, 12.0 * h / t);
    t += clamp(h, mint * 0.5, maxt * 0.1);
    if (res < 0.005 || t > maxt) break;
  }
  return clamp(res, 0.0, 1.0);
}

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vFar - cameraPosition);

  float t = boundEntry(ro, rd, uBound);
  if (uConeLay.z > 0.0) {
    float eye = floor(gl_FragCoord.x / uConeLay.x);
    vec2 cone = texelFetch(uClear, ivec2(int(eye * uConeLay.y) + int(gl_FragCoord.x - eye * uConeLay.x) / ${CONE}, int(gl_FragCoord.y) / ${CONE}), 0).rg;
    if (t >= 0.0) t = max(t, cone.r);
    gWork = cone.g;
  }
  bool hit = false;
  float eps = 0.0;
  float px = 0.0;
  float d = 0.0;
  float epsScale = uEpsMul * (1.0 + 2.0 * fovea());
  float tmax = min(1000.0 * uScale + 6.0, 8000.0); // short of what the accumulation reads as sky
  float prec = 0.0;

  if (t >= 0.0) {
    // Steps are longer than the estimate vouches for while the one after vouches for the
    // rest: the two clear spheres meet. Where they do not, back to the estimate's own step,
    // and by its own steps from there.
    float relax = uRelax, clear = 0.0, stride = 0.0;
    for (int i = 0; i < 2048; i++) {
      vec3 p = ro + rd * t;
      d = map(p);
      bool past = stride > clear && d * 0.9 + clear < stride;
      px = t * uPixelAngle;
      // Floors: a fraction of a room metre, and the estimator's float32 noise at |p|; below
      // that the surface cannot be located and marching finer only adds noise.
      prec = length(p) * uPrec;
      eps = max(max(px * epsScale, uScale * 2e-5), prec);
      if (d < eps && !past) { hit = true; break; }
      // Out of steps hugging a surface: shade it there. Otherwise the sample is unknown
      // (neither surface nor sky) and the accumulation ignores it.
      if (i + 1 >= uMaxSteps) {
        if (d < 6.0 * eps) { hit = true; break; }
        gA = vec4(0.0, -2.0, 1.0, 1.0);
        gB = vec4(0.0, 0.0, 0.0, gWork);
        return;
      }
      if (past) { t += clear - stride; clear = 0.0; stride = 0.0; relax = 1.0; continue; }
      clear = d * 0.9;
      stride = clear * relax;
      t += stride;
      if (t > tmax) break;
      if (uBound > 0.0 && dot(p, p) > uBound * uBound * 1.1 && dot(p, rd) > 0.0) break;
    }
  }

  if (!hit) {
    gA = vec4(0.0, -1.0, 1.0, 1.0);
    gB = vec4(0.0, 0.0, 0.0, gWork);
    return;
  }
  // Hits land anywhere under the threshold: back to it, and neighbours are of one surface.
  t -= max(eps - max(d, 0.0), 0.0);
  vec3 p = ro + rd * t;
  float trap = gTrap;
  // Shading footprints stay well above the noise floor so normals and AO are smooth.
  vec3 n = calcNormal(p, max(max(px * uNormalPx, eps * 2.0), prec * 4.0));
  if (n == vec3(0.0)) n = -rd; // facing the eye, rather than nothing the accumulation can average
  float ao = uAOSamples > 0 ? calcAO(p, n, max(px, prec * 3.0)) : 1.0;
  float sh = 1.0;
  if (uShadows == 1) {
    vec3 l1;
    float shMax = uScale * 2.0;
    if (uLightMode == 0) l1 = normalize(vec3(0.6, 0.7, 0.3));
    else { vec3 dl = uLightPos - p; float dist = length(dl); l1 = dl / dist; shMax = min(shMax, dist); }
    sh = softShadow(p + n * eps * 4.0, l1, eps * 8.0, shMax);
  }
  gA = vec4(trap, t, ao * sh, 0.0);
  gB = vec4(n, gWork);
}
`;

// ---------------------------------------------------------------- 3D cone pass

// One ray down the middle of each CONE x CONE block of geometry samples, marched while the
// estimate at it clears every sample of the block: their own marches begin where it ends.
export const coneVertex = /* glsl */ `
uniform vec2 uSpan; // what the cones cover of the samples' view: whole blocks, so 1 or a little more

out vec3 vFar;
out vec2 vNdc;
flat out vec2 vProjZ;

void main() {
  vNdc = (position.xy * 0.5 + 0.5) * uSpan * 2.0 - 1.0;
  vec4 v = inverse(projectionMatrix) * vec4(vNdc, 1.0, 1.0);
  v.xyz /= v.w;
  vFar = (inverse(viewMatrix) * vec4(v.xyz, 1.0)).xyz;
  vProjZ = vec2(projectionMatrix[2][2], projectionMatrix[3][2]);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const coneFragment = common + estimators + /* glsl */ `
out vec4 cone; // how far every sample of the cone is clear, the cone's work per sample

uniform float uConeAngle; // radians from a cone's axis to its farthest sample, at most
uniform float uConeNdc;   // the same in vNdc
const float CONE_STOP = 0.125; // the cone ends where a step gains less than this share of the estimate

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vFar - cameraPosition);
  // No sample of the cone is inside the bound before its axis is inside one this much wider.
  float t = boundEntry(ro, rd, uBound + length(ro) * uConeAngle);
  if (t < 0.0) { cone = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // The widest threshold a sample of the cone has.
  float epsScale = uEpsMul * (1.0 + 2.0 * uFoveate * smoothstep(0.35, 1.3, length(vNdc) + uConeNdc));
  float tmax = min(1000.0 * uScale + 6.0, 8000.0);
  for (int i = 0; i < 2048; i++) {
    if (i >= uMaxSteps) break;
    vec3 p = ro + rd * t;
    float d = map(p) * 0.9;
    // Within d of p there is no surface. A sample's ray at t + s is no further from p than
    // s + r, and its threshold there no more than e: clear, and not yet a hit, while
    // s + r + e <= d.
    float r = (t + d) * uConeAngle;
    float e = max(max((t + d) * uPixelAngle * epsScale, uScale * 2e-5), (length(p) + d) * uPrec);
    float s = d - r - e;
    if (s < d * CONE_STOP) break;
    t += s;
    if (t > tmax) break;
    if (uBound > 0.0 && dot(p, p) > uBound * uBound * 1.1 && dot(p, rd) > 0.0) break;
  }
  // Half floats round either way.
  cone = vec4(t * 0.999, gWork / float(${CONE * CONE}), 0.0, 1.0);
}
`;

// ---------------------------------------------------------------- cost

// The work of the geometry samples, reduced to one texel per band of rows: 256 samples spread
// over the band, their mean as 16 bits in red (high) and green.
export const COST_ROWS = 64;
export const costFragment = /* glsl */ `
precision highp float;
uniform sampler2D uGB;
uniform vec2 uUsed; // samples in use: width, rows
out vec4 o;

void main() {
  float band = gl_FragCoord.y - 0.5;
  float sum = 0.0;
  for (int j = 0; j < 4; j++) {
    int y = int((band + (float(j) + 0.5) / 4.0) / ${COST_ROWS}.0 * uUsed.y);
    float shift = fract(0.37 * band + 0.618 * float(j));
    for (int i = 0; i < 64; i++) {
      sum += texelFetch(uGB, ivec2(int((float(i) + shift) / 64.0 * uUsed.x), y), 0).w;
    }
  }
  float v = floor(min(sum / 256.0, 65535.0));
  float hi = floor(v / 256.0);
  o = vec4(hi / 255.0, (v - hi * 256.0) / 255.0, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------- accumulate

// Every eye-resolution pixel gathers the 3x3 low-res samples around it. Samples are grouped
// by surface (view distance within 8 percent); a wide kernel decides which surface owns the
// pixel and a narrow kernel weights the attributes. A pixel keeps the surface its history
// holds while that surface still carries at least 40 percent of the wide weight, so jitter
// cannot flip silhouette pixels every frame; the running share of the owner (alpha) lets the
// present pass blend the silhouette. Unknown samples (rays out of steps) are ignored.
// Lighting of an accumulated sample: palette and lights.
const shading = /* glsl */ `
uniform float uScale;      // fractal units per room metre
uniform int uLightMode;    // 0 fixed world light, 1 headlamp, 2 hand torch
uniform vec3 uLightPos;
uniform float uAmbient;

// Linear colour of a sample (trap, view distance, ao * shadow) with normal N, seen from ro
// along rd; alpha 1 where it is the background. spec: its highlight, of HIGHLIGHT.
vec4 shadeSample(vec4 A, vec3 N, vec3 ro, vec3 rd, out float spec) {
  spec = 0.0;
  if (A.y < 0.0) return vec4(background(rd), 1.0);
  vec3 p = ro + rd * A.y;
  vec3 n = dot(N, N) > 1e-8 ? normalize(N) : vec3(0.0, 1.0, 0.0);
  vec3 base = palette(A.x * uColorFreq + uColorPhase);
  vec3 l1;
  float atten = 1.0;
  if (uLightMode == 0) {
    l1 = normalize(vec3(0.6, 0.7, 0.3));
  } else {
    vec3 dl = uLightPos - p;
    float dist = length(dl);
    l1 = dl / dist;
    if (uLightMode == 2) atten = 1.0 / (1.0 + pow(dist / (uScale * 3.0), 2.0));
  }
  vec3 l2 = normalize(vec3(-0.5, 0.2, -0.7));
  float dif1 = clamp(dot(n, l1), 0.0, 1.0) * atten;
  float dif2 = clamp(dot(n, l2), 0.0, 1.0) * 0.3;
  float vis = A.z; // ambient occlusion times shadow
  float amb = uAmbient * (0.7 + 0.3 * n.y);
  vec3 h = normalize(l1 - rd);
  spec = pow(clamp(dot(n, h), 0.0, 1.0), 12.0) * dif1 * vis;
  vec3 col = base * (dif1 * vis * vec3(1.0, 0.95, 0.9) + dif2 * vec3(0.7, 0.8, 1.0) + amb * vis) + spec * HIGHLIGHT;
  return vec4(col, 0.0);
}
`;

export const accumulateFragment = common + shading + /* glsl */ `
layout(location = 0) out vec4 oA; // trap, view distance (-1 sky, -2 unknown), ao * shadow, alpha (owner share)
layout(location = 1) out vec4 oB; // normal, weight
layout(location = 2) out vec4 oC; // shaded colour (gamma encoded); alpha: the highlight in it, or over the camera feed its cover
uniform sampler2D uGA, uGB;      // low-res samples
uniform sampler2D uHA, uHB;      // previous accumulation (linear filtering)
uniform vec2 uLowUsed;           // low-res pixels in use, both eyes side by side
uniform vec2 uAccSize;           // accumulation pixels per eye
uniform vec2 uHistSize;          // the history image's pixels per eye, from the same corner of its texture
uniform int uEyes;
uniform vec2 uJitter;            // this frame's jitter in NDC units
uniform mat3 uInvView[2];        // current view -> world rotation (with the room scale)
uniform vec4 uProj[2];           // P00, P11, P02, P12 of the unjittered projection
uniform vec3 uEye[2];
uniform mat4 uPrevVP[2];         // previous unjittered clip from eye-relative world (no translation)
uniform vec3 uEyeDelta[2];       // current eye minus previous eye, computed in double
uniform float uWScale;           // history weight multiplier (0 resets)
uniform float uWMax;
uniform float uSigma;            // attribute kernel width in accumulation pixels
uniform float uMotionDecay;      // history weight loss per pixel of parallax in its reprojection
uniform float uResample;         // history weight kept through a resampling
uniform float uDistMin;          // world distance below which a surface is too close to reproject
uniform int uDebug;              // 1: write the reprojection motion (pixels) into alpha. For fv profile, 2: no history; 3: the centre sample alone

const float SKY = 1e4;
const float WIDE = 0.8;

// Same surface: distances within 8 percent, with an absolute floor so points at the eye
// (inside a wall, or at extreme zoom) do not compare as noise.
bool same(float a, float b) {
  if (a >= SKY || b >= SKY) return a >= SKY && b >= SKY;
  return abs(a - b) < 0.08 * min(a, b) + 0.5 * uDistMin;
}

// View-space direction from the projection terms, rotated to world: no inverse matrix, no
// translation, so a still camera reprojects onto exactly the same texel at any zoom.
vec3 rayDir(int eye, vec2 ndc) {
  vec4 p = uProj[eye];
  return normalize(uInvView[eye] * vec3((ndc.x + p.z) / p.x, (ndc.y + p.w) / p.y, -1.0));
}

// History at texel position pos, read inside the eye's texel rectangle [lo, hi]. Where the four nearest texels
// hold one surface: Catmull-Rom with five bilinear taps (Karis), clamped to those four, since
// the filter's negative lobes would otherwise ring and repeated every frame that ringing grows
// without bound. Where they do not (a silhouette): bilinear over the texels on the nearest
// texel's surface, so nothing blends across the edge, with the owner's share (alpha) scaled by
// their coverage, so a silhouette the history only half supports is decided by the new samples
// instead of drifting. An unknown nearest texel is returned as is.
void fetchHist(vec2 pos, ivec2 lo, ivec2 hi, out vec4 a, out vec4 b) {
  vec2 size = vec2(textureSize(uHA, 0));
  vec2 c = floor(pos - 0.5) + 0.5;
  vec2 f = pos - c;
  ivec2 i0 = ivec2(floor(pos - 0.5));
  vec4 ta[4];
  vec4 tb[4];
  for (int j = 0; j < 4; j++) {
    ivec2 cc = clamp(i0 + ivec2(j & 1, j >> 1), lo, hi);
    ta[j] = texelFetch(uHA, cc, 0);
    tb[j] = texelFetch(uHB, cc, 0);
  }
  int n = (f.x >= 0.5 ? 1 : 0) + (f.y >= 0.5 ? 2 : 0);
  if (ta[n].y < -1.5) { a = ta[n]; b = tb[n]; return; }
  float ref = ta[n].y < 0.0 ? SKY : ta[n].y;
  bool on[4];
  bool one = true;
  for (int j = 0; j < 4; j++) {
    on[j] = ta[j].y > -1.5 && same(ta[j].y < 0.0 ? SKY : ta[j].y, ref);
    one = one && on[j];
  }
  a = vec4(0.0); b = vec4(0.0);
  float wsum = 0.0;
  if (!one) {
    for (int j = 0; j < 4; j++) {
      if (!on[j]) continue;
      float w = ((j & 1) == 1 ? f.x : 1.0 - f.x) * ((j >> 1) == 1 ? f.y : 1.0 - f.y);
      a += ta[j] * w; b += tb[j] * w; wsum += w;
    }
    // Texels on other surfaces count as none of the owner's share.
    float cover = a.w;
    a /= wsum; b /= wsum;
    a.w = cover;
    return;
  }
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 off12 = w2 / w12;
  vec2 t0 = (c - 1.0) / size;
  vec2 t3 = (c + 2.0) / size;
  vec2 t12 = (c + off12) / size;
  vec2 uvLo = (vec2(lo) + 0.5) / size;
  vec2 uvHi = (vec2(hi) + 0.5) / size;
  #define TAP(uvT, w) { vec2 u = clamp(uvT, uvLo, uvHi); a += texture(uHA, u) * (w); b += texture(uHB, u) * (w); wsum += (w); }
  TAP(vec2(t12.x, t0.y), w12.x * w0.y)
  TAP(vec2(t0.x, t12.y), w0.x * w12.y)
  TAP(vec2(t12.x, t12.y), w12.x * w12.y)
  TAP(vec2(t3.x, t12.y), w3.x * w12.y)
  TAP(vec2(t12.x, t3.y), w12.x * w3.y)
  a /= wsum; b /= wsum;
  a = clamp(a, min(min(ta[0], ta[1]), min(ta[2], ta[3])), max(max(ta[0], ta[1]), max(ta[2], ta[3])));
  b = clamp(b, min(min(tb[0], tb[1]), min(tb[2], tb[3])), max(max(tb[0], tb[1]), max(tb[2], tb[3])));
}

void gather(int eye, ivec2 local, vec2 ndc, vec3 dir, out vec4 gA, out vec4 gB) {
  ivec2 acc = ivec2(uAccSize);
  int lowW = int(uLowUsed.x) / uEyes;
  int lowH = int(uLowUsed.y);
  ivec2 lo = ivec2(eye * lowW, 0);
  ivec2 hi = ivec2(eye * lowW + lowW - 1, lowH - 1);

  // The jitter offsets the projection, so the rendered image is shifted by -uJitter: this
  // pixel sits at ndc - uJitter in the sample grid, and sample centre s holds the point
  // whose unjittered position is s + uJitter.
  vec2 fl = ((ndc - uJitter) * 0.5 + 0.5) * vec2(lowW, lowH) - 0.5;
  ivec2 ic = ivec2(floor(fl + 0.5));
  float k[9];
  float kw[9];
  vec4 sA[9];
  vec4 sB[9];
  float dist[9];
  float kwAll = 0.0;
  float dNear = SKY;
  int top = -1;
  float kwTop = -1.0;
  for (int j = 0; j < 9; j++) {
    if (uDebug == 3 && j != 4) { k[j] = 0.0; kw[j] = 0.0; dist[j] = SKY; sA[j] = vec4(0.0); sB[j] = vec4(0.0); continue; }
    ivec2 ij = ic + ivec2(j % 3 - 1, j / 3 - 1);
    ivec2 c = ij + lo;
    bool inside = all(greaterThanEqual(c, lo)) && all(lessThanEqual(c, hi));
    c = clamp(c, lo, hi);
    vec2 sn = ((vec2(ij) + 0.5) / vec2(lowW, lowH)) * 2.0 - 1.0 + uJitter;
    vec2 dpx = (sn - ndc) * uAccSize * 0.5;
    float d2 = dot(dpx, dpx);
    sA[j] = texelFetch(uGA, c, 0);
    sB[j] = texelFetch(uGB, c, 0);
    bool known = inside && sA[j].y > -1.5;
    dist[j] = sA[j].y < 0.0 ? SKY : sA[j].y;
    k[j] = known ? exp(-d2 / (2.0 * uSigma * uSigma)) : 0.0;
    kw[j] = known ? exp(-d2 / (2.0 * WIDE * WIDE)) : 0.0;
    kwAll += kw[j];
    if (known && kw[j] > 0.2) dNear = min(dNear, dist[j]);
    if (kw[j] > kwTop) { kwTop = kw[j]; top = j; }
  }

  // History at this pixel's ray, reprojected at the nearest known depth (dilated). Everything
  // is relative to the previous eye so deep zooms keep their precision.
  vec3 rel = dir * dNear + uEyeDelta[eye];
  vec4 pc = uPrevVP[eye] * vec4(rel, 1.0);
  float Wh = 0.0;
  float motionH = 0.0;
  float parallaxH = 0.0;
  vec4 hA = vec4(0.0), hB = vec4(0.0);
  // A surface at the eye reprojects to nowhere useful: start fresh instead of smearing.
  if (uWScale > 0.0 && uDebug != 2 && pc.w > 0.0 && kwAll > 0.0 && dNear > uDistMin) {
    vec2 puv = (pc.xy / pc.w) * 0.5 + 0.5;
    if (all(greaterThanEqual(puv, vec2(0.0))) && all(lessThanEqual(puv, vec2(1.0)))) {
      vec2 centre = (vec2(local) + 0.5) / uAccSize;
      float motionPx = length((puv - centre) * uAccSize);
      motionH = motionPx;
      // Below a twentieth of a pixel the history is read in place: no resampling at all.
      float kept = 1.0;
      if (motionPx < 0.05 && uHistSize == uAccSize) {
        ivec2 hp = ivec2(eye * acc.x, 0) + local;
        hA = texelFetch(uHA, hp, 0);
        hB = texelFetch(uHB, hp, 0);
      } else {
        // A turn maps the history exactly however far it moves it; only the part of the motion
        // that depends on depth is as uncertain as the depth.
        vec4 pr = uPrevVP[eye] * vec4(dir, 1.0);
        float parallaxPx = pr.w > 0.0 ? length((puv - (pr.xy / pr.w * 0.5 + 0.5)) * uAccSize) : motionPx;
        parallaxH = parallaxPx;
        kept = uResample * exp(-uMotionDecay * parallaxPx);
        ivec2 hist = ivec2(uHistSize);
        ivec2 e0 = ivec2(eye * hist.x, 0);
        fetchHist(puv * uHistSize + vec2(e0), e0, e0 + hist - 1, hA, hB);
      }
      // The filter can overshoot: keep every channel in range.
      hA.z = clamp(hA.z, 0.0, 1.0);
      hA.w = clamp(hA.w, 0.0, 1.0);
      hB.w = clamp(hB.w, 0.0, uWMax);
      if (hA.y > -1.5) Wh = hB.w * uWScale * kept;
    }
  }

  // Which surface owns the pixel: the history's while it keeps enough of the wide weight,
  // otherwise the nearest surface if it does, otherwise the heaviest sample's.
  float hd = hA.y < 0.0 ? SKY : hA.y;
  bool conf[9];
  float shareH = 0.0;
  if (Wh > 0.0) {
    for (int j = 0; j < 9; j++) {
      float dp = dist[j] >= SKY ? SKY : length(dir * dist[j] + uEyeDelta[eye]);
      conf[j] = kw[j] > 0.0 && same(dp, hd);
      if (conf[j]) shareH += kw[j];
    }
    shareH /= kwAll;
  }
  // The owner's share is smoothed: slowly once converged, so jitter cannot flip ownership
  // image to image, and quickly downward when the owner is absent, so a surface the jitter
  // missed is kept for an image or two. Under motion the new samples are trusted at once, and
  // an owner the parallax has carried off the pixel is let go with them, so nothing trails.
  float alphaH = 0.0;
  if (Wh > 0.0 && shareH <= 0.0) {
    // How far the history's own surface now lies from this pixel: it was read where the new
    // samples' surface used to be, and a nearer one has moved further since.
    float offH = 0.0;
    if (hd < SKY) {
      vec3 now = normalize(rel) * hd - uEyeDelta[eye];
      offH = length(cross(normalize(now), dir)) * uProj[eye].y * uAccSize.y * 0.5;
    }
    alphaH = hA.w * 0.7 * (1.0 - smoothstep(0.5, 2.0, max(parallaxH, offH)));
  } else if (Wh > 0.0) {
    alphaH = mix(hA.w, shareH, clamp(max(1.0 / (Wh + 1.0), motionH * 0.2), 0.04, 1.0));
  }
  bool keep = Wh > 0.0 && alphaH >= 0.3;
  float share = alphaH;
  if (!keep) {
    Wh = 0.0;
    if (kwAll <= 0.0) {
      // Nothing known this frame: carry the history untouched, or mark unknown.
      if (hB.w > 0.0 && uWScale > 0.0) { gA = hA; gB = hB; } else { gA = vec4(0.0, -2.0, 1.0, 1.0); gB = vec4(0.0); }
      return;
    }
    float ref = dNear;
    float shareN = 0.0;
    for (int j = 0; j < 9; j++) if (kw[j] > 0.0 && same(dist[j], ref)) shareN += kw[j];
    shareN /= kwAll;
    if (shareN < 0.4) ref = dist[top];
    share = 0.0;
    for (int j = 0; j < 9; j++) { conf[j] = kw[j] > 0.0 && same(dist[j], ref); if (conf[j]) share += kw[j]; }
    share /= kwAll;
  }

  float kC = 0.0;
  vec4 accA = vec4(0.0);
  vec3 accN = vec3(0.0);
  for (int j = 0; j < 9; j++) {
    if (!conf[j]) continue;
    kC += k[j];
    accA += sA[j] * k[j];
    accN += sB[j].xyz * k[j];
  }
  if (kC <= 0.0) {
    // Owner confirmed only by samples too far for the narrow kernel, or absent: keep the
    // history with the decayed share.
    if (Wh > 0.0) { gA = vec4(hA.xyz, share); gB = vec4(hB.xyz, Wh); } else { gA = vec4(0.0, -2.0, 1.0, 1.0); gB = vec4(0.0); }
    return;
  }
  accA /= kC;
  accN /= kC;
  bool skyOwner = accA.y < 0.0;
  float W = Wh + kC;
  vec4 A = (hA * Wh + accA * kC) / W;
  vec3 N = hB.xyz * Wh + accN * kC;
  N = dot(N, N) > 1e-8 ? normalize(N) : accN;
  // Distance is re-measured every frame.
  A.y = skyOwner ? -1.0 : accA.y;
  A.w = uDebug == 1 ? motionH : share;
  gA = A;
  gB = vec4(N, min(W, uWMax));
}

void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  ivec2 acc = ivec2(uAccSize);
  int eye = (uEyes == 2 && pix.x >= acc.x) ? 1 : 0;
  ivec2 local = pix - ivec2(eye * acc.x, 0);
  vec2 ndc = ((vec2(local) + 0.5) / uAccSize) * 2.0 - 1.0;
  vec3 dir = rayDir(eye, ndc);
  vec4 A, B;
  gather(eye, local, ndc, dir, A, B);
  oA = A;
  oB = B;
  float spec;
  vec4 c = shadeSample(A, B.xyz, uEye[eye], dir, spec);
  // Passthrough: the background lets the camera feed through.
  oC = vec4(pow(max(c.rgb, 0.0), vec3(0.4545)), uBackground == 5 ? 1.0 - c.a : spec);
}
`;

// ---------------------------------------------------------------- near and far by tile

// What the present pass may skip of a ray: per tile of NEAR_TILE image pixels, the least and
// the greatest distance the image holds in it (red, green; FAR_TILE where it holds sky or
// nothing) and the greatest step in distance from one pixel to the next, as a share of the
// nearer (blue; over the tile and to the pixels beside it), and then the same over each tile
// and the eight around it.
export const NEAR_TILE = 16;
const FAR_TILE = '6.0e4'; // as far as a half float goes
export const nearFragment = /* glsl */ `
precision highp float;
uniform sampler2D uHA;
uniform ivec2 uAcc;   // image pixels per eye
uniform ivec2 uTiles; // tiles per eye
out vec4 o;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int eye = p.x >= uTiles.x ? 1 : 0;
  ivec2 base = ivec2(p.x - eye * uTiles.x, p.y) * ${NEAR_TILE};
  float lo = ${FAR_TILE}, hi = 0.0, jump = 0.0;
  float below[${NEAR_TILE + 1}];
  for (int j = 0; j <= ${NEAR_TILE}; j++) {
    float left = 0.0;
    for (int i = 0; i <= ${NEAR_TILE}; i++) {
      ivec2 q = min(base + ivec2(i, j), uAcc - 1);
      float d = texelFetch(uHA, ivec2(q.x + eye * uAcc.x, q.y), 0).y;
      if (d <= 0.0) d = ${FAR_TILE};
      if (i < ${NEAR_TILE} && j < ${NEAR_TILE}) { lo = min(lo, d); hi = max(hi, d); }
      if (i > 0) jump = max(jump, abs(d - left) / min(d, left));
      if (j > 0) jump = max(jump, abs(d - below[i]) / min(d, below[i]));
      left = d;
      below[i] = d;
    }
  }
  o = vec4(lo, hi, jump, 1.0);
}
`;
export const nearWideFragment = /* glsl */ `
precision highp float;
uniform sampler2D uNear;
uniform ivec2 uTiles;
out vec4 o;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int eye = p.x >= uTiles.x ? 1 : 0;
  ivec2 l = ivec2(p.x - eye * uTiles.x, p.y);
  float lo = ${FAR_TILE}, hi = 0.0, jump = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      ivec2 q = clamp(l + ivec2(i, j), ivec2(0), uTiles - 1);
      vec3 v = texelFetch(uNear, ivec2(q.x + eye * uTiles.x, q.y), 0).xyz;
      lo = min(lo, v.x); hi = max(hi, v.y); jump = max(jump, v.z);
    }
  }
  o = vec4(lo, hi, jump, 1.0);
}
`;

// ---------------------------------------------------------------- present (3D composite)

// Shows the last completed colour image from the current head pose. The image is a surface
// seen from its own eye: each pixel's ray is followed through it to the first place it meets
// what the image holds there, so a turn is exact and whatever is nearer moves over what is
// further. The tiles the ray crosses say between which distances that can be, and how steep
// the image is there. Where they leave no more than a pixel of doubt, or nothing steep enough
// for the move to fold one part over another, the place is found from the distance the image
// holds, taken again where that leads; otherwise the ray is walked from the nearest to the
// furthest in equal steps of the image. A ray that passes behind a silhouette into what the
// image never saw and meets nothing after shows the surface beside the silhouette, mirrored
// about it. Silhouettes are blended with the surface behind by the accumulated coverage.
// Writes depth.
export const presentFragment = common + /* glsl */ `
out vec4 fragColor;
uniform sampler2D uHA;     // trap, view distance (-1 sky, -2 unknown), ao * shadow, owner share
uniform sampler2D uHC;     // colour (gamma encoded); alpha: the highlight in it, or (uCover) its cover of the camera feed
uniform int uCover;
uniform vec2 uAccSize;     // image pixels per eye
uniform vec2 uFbSize;
uniform int uEyes;
uniform int uEdgeBlend;
uniform float uVignette;
uniform float uFade;
uniform int uReproject;    // 0: the image was rendered for this frame's pose
uniform mat4 uShownVP[2];  // clip of the image's eye from points relative to that eye
uniform vec3 uShownDelta[2]; // this frame's eye minus the image's eye
uniform float uEdgeFade;   // fraction of the image's width over which the view darkens beyond its border
uniform sampler2D uNear;   // least and greatest distance and steepest step in the image by tile, with the tiles around
uniform ivec2 uTiles;      // tiles per eye
uniform float uNearInv;    // one over the least distance from this frame's eyes to anything in the image
uniform float uStepPx;     // image pixels per step of a ray, at least
uniform int uSteps;        // steps of a ray, at most; 0: no ray is walked
uniform int uDebug;        // 1: the tiles are not asked; 2: shows the lookups each pixel made, a sixty-fourth each; 3: tints each pixel by the rule that placed it; 4: shows the rule alone, an eighth each
uniform int uRecolour;     // 1: the palette has changed since the image was shaded
uniform vec3 uWasA, uWasB, uWasC, uWasD, uNowA, uNowB, uNowC, uNowD; // the palette it was shaded with, and this frame's
uniform vec2 uWasArg, uNowArg; // frequency and phase of each

const float NONE = 1e30;
const int STEPS_MAX = 16;
const float TILE = ${NEAR_TILE}.0;
const int TILES_MAX = 4;   // tiles looked up along a ray

ivec2 gLo, gHi;
int gLookups = 0;
// 0: as the direction finds it; 1: by the distance found, unwalked; 2: met on the walk (faint white); 3: behind a silhouette, the far side shown (red); 5: nothing met (blue); 6: off the image (yellow)
int gRule = 0;
vec4 gA, gB;   // clip of a point along the ray at inverse distance s: gA + gB * s
vec3 gRd, gDelta;

vec2 uvAt(float s) {
  vec4 c = gA + gB * s;
  return c.w > 1e-6 ? (c.xy / c.w) * 0.5 + 0.5 : vec2(-1.0);
}
// The image's distance at uv: NONE for the sky, the unknown and beyond its border.
float distAt(vec2 uv) {
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0)))) return NONE;
  gLookups++;
  float d = texelFetch(uHA, gLo + ivec2(uv * uAccSize), 0).y;
  return d > 0.0 ? d : NONE;
}
// The ray's point at inverse distance s, from the image's eye: its distance times s.
float reach(float s) { return length(gDelta * s + gRd); }
// Whether that point is at or behind what the image holds at distance d there.
bool behind(float d, float s) { return d < NONE && d * s <= reach(s); }

// A shaded colour of a surface with this trap, in this frame's palette: the image keeps its
// light and its highlight, and the palette's share of the rest is exchanged. Exact but where
// the image is clipped, or a channel of the old palette had nothing in it.
vec3 recolour(vec4 c, float trap) {
  vec3 was = uWasA + uWasB * cos(6.28318 * (uWasC * (trap * uWasArg.x + uWasArg.y) + uWasD));
  vec3 now = uNowA + uNowB * cos(6.28318 * (uNowC * (trap * uNowArg.x + uNowArg.y) + uNowD));
  float s = uCover == 1 ? 0.0 : c.a * HIGHLIGHT;
  vec3 lit = max(pow(c.rgb, vec3(2.2)) - s, 0.0) * (max(now, 0.0) + 1e-4) / (max(was, 0.0) + 1e-4) + s;
  return pow(lit, vec3(0.4545));
}

void main() {
  vec3 rd = normalize(vFar - cameraPosition);
  int eye = (uEyes == 2 && gl_FragCoord.x * 2.0 >= uFbSize.x) ? 1 : 0;
  vec2 eyeFb = vec2(uFbSize.x / float(uEyes), uFbSize.y);
  vec2 uv = (gl_FragCoord.xy - vec2(float(eye) * eyeFb.x, 0.0)) / eyeFb;
  ivec2 acc = ivec2(uAccSize);
  ivec2 lo = ivec2(eye * acc.x, 0);
  ivec2 hi = lo + acc - 1;
  vec2 texSize = vec2(textureSize(uHC, 0));
  // How far outside the image this pixel's lookup lands, in image widths.
  float outside = 0.0;
  // Where along the ray the image is met, as inverse distance; negative: the image's own distance stands.
  float sMet = -1.0;
  if (uReproject == 1) {
    gLo = lo; gHi = hi; gRd = rd; gDelta = uShownDelta[eye];
    gA = uShownVP[eye] * vec4(rd, 0.0);
    gB = uShownVP[eye] * vec4(gDelta, 1.0);
    outside = 1.0;
    if (gA.w > 0.0) {
      vec2 raw = (gA.xy / gA.w) * 0.5 + 0.5;
      // Between which distances the image lies where the ray may cross it.
      float moved = length(gDelta);
      vec2 uN = uvAt(uNearInv);
      float cross = length((uN - raw) * uAccSize);
      float dLo = 1.0 / uNearInv, dHi = NONE, steep = NONE;
      int nt = max(int(ceil(cross / (1.5 * TILE))) + 1, 2);
      if (cross >= 0.05 && nt <= TILES_MAX && uDebug != 1) {
        dLo = NONE; dHi = 0.0; steep = 0.0;
        for (int i = 0; i < TILES_MAX; i++) {
          if (i >= nt) break;
          vec2 p = clamp(mix(raw, uN, float(i) / float(nt - 1)), vec2(0.0), vec2(1.0));
          ivec2 tile = min(ivec2(p * uAccSize / TILE), uTiles - 1);
          gLookups++;
          vec3 v = texelFetch(uNear, ivec2(tile.x + eye * uTiles.x, tile.y), 0).xyz;
          dLo = min(dLo, v.x); dHi = max(dHi, v.y); steep = max(steep, v.z);
        }
        // Half floats, rounded either way.
        dLo = dLo < ${FAR_TILE} * 0.9 ? dLo * 0.98 : NONE;
        dHi = dHi < ${FAR_TILE} * 0.9 ? dHi * 1.02 : NONE;
      }
      float s0 = dLo < NONE ? min(uNearInv, 1.0 / max(dLo - moved, 0.25 * dLo)) : 0.0;
      float s1 = dHi < NONE ? 1.0 / (dHi + moved) : 0.0;
      float span = length((uvAt(s0) - uvAt(s1)) * uAccSize);
      if (cross < 0.05 || dLo >= NONE) {
        // The eye where the image's was, or sky all along: as the direction finds it.
      } else if (span <= 1.0 || uSteps == 0 || steep * length((uvAt(s0) - raw) * uAccSize) < 0.5) {
        // A pixel of doubt at most, or an image the move cannot fold: each look at the distance
        // found halves what is left of the doubt, at least.
        float s = 0.5 * (s0 + s1);
        float px = span / max(s0 - s1, 1e-30);
        for (int i = 0; i < 4; i++) {
          float d = distAt(uvAt(s));
          if (d >= NONE) break;
          float was = s;
          s = reach(s) / d;
          sMet = s;
          if (abs(s - was) * px < 0.25) break;
        }
        if (sMet > 0.0) raw = uvAt(sMet);
        gRule = 1;
      } else {
        int n = min(int(ceil(span / uStepPx)), min(uSteps, STEPS_MAX));
        float ds = (s0 - s1) / float(n);
        float sFree = s0;      // the last step found in front of the image
        bool hidden = false;   // behind a silhouette, in what the image never saw
        float sIn = s0;        // where the ray went behind it
        bool met = false, gone = false;
        for (int k = 1; k <= STEPS_MAX; k++) {
          if (k > n) break;
          float s = k == n ? s1 : s0 - ds * float(k);
          bool b = behind(distAt(uvAt(s)), s);
          if (!b) { hidden = false; sFree = s; continue; }
          if (hidden) continue;
          // Between the last step in front and this one: where, to a pixel of the image.
          float a = sFree, e = s;
          for (int j = 0; j < 6; j++) {
            if (j >= 2 && length((uvAt(a) - uvAt(e)) * uAccSize) < 1.0) break;
            float mid = 0.5 * (a + e);
            if (behind(distAt(uvAt(mid)), mid)) e = mid; else a = mid;
          }
          vec2 uA = uvAt(a);
          // Out of what the image does not cover: nothing to show.
          if (any(lessThan(uA, vec2(0.0))) || any(greaterThanEqual(uA, vec2(1.0)))) { raw = uA; gone = true; break; }
          float dA = distAt(uA), dE = distAt(uvAt(e));
          float sE = reach(e) / dE;
          // A nearer surface begins there and the ray is well behind it: a silhouette passed.
          if (dE < 0.92 * dA && sE - e > 0.25 * ds) { hidden = true; sIn = a; continue; }
          // The surface, and once more at the distance it holds.
          sMet = e;
          vec2 u2 = uvAt(sE);
          float d2 = distAt(u2);
          if (abs(d2 - dE) < 0.08 * dE) sMet = sE;
          met = true;
          break;
        }
        gRule = met ? 2 : hidden ? 3 : gone ? 6 : 5;
        if (met) raw = uvAt(sMet);
        else if (hidden) {
          vec2 uIn = uvAt(sIn);
          float dIn = distAt(uIn);
          float sBg = dIn < NONE ? reach(sIn) / dIn : 0.0;
          vec2 uM = 2.0 * uIn - uvAt(sBg);
          float dM = distAt(uM);
          raw = dM >= 0.92 * dIn && all(greaterThanEqual(uM, vec2(0.0))) && all(lessThan(uM, vec2(1.0))) ? uM : uIn;
        } else if (!gone) raw = uvAt(s1);
      }
      uv = clamp(raw, vec2(0.0), vec2(1.0));
      vec2 over = max(max(-raw, raw - 1.0), vec2(0.0));
      outside = max(over.x, over.y);
    }
  }
  vec2 tc = clamp(uv * uAccSize, vec2(0.5), uAccSize - 0.5) + vec2(lo);
  ivec2 ip = clamp(ivec2(tc), lo, hi);
  vec4 A = texelFetch(uHA, ip, 0);
  vec4 col = texture(uHC, tc / texSize);
  bool re = uRecolour == 1;
  if (re && A.y >= 0.0) col.rgb = recolour(col, A.x);

  // Silhouette: blend with the neighbour on the other surface by the owner's share.
  if (uEdgeBlend == 1 && A.w < 0.98 && A.y > -1.5) {
    ivec2 o[4];
    o[0] = ivec2(1, 0); o[1] = ivec2(-1, 0); o[2] = ivec2(0, 1); o[3] = ivec2(0, -1);
    float best = 0.0;
    ivec2 bq = ip;
    float dHere = A.y < 0.0 ? 1e4 : A.y;
    for (int i = 0; i < 4; i++) {
      ivec2 q = clamp(ip + o[i], lo, hi);
      float qy = texelFetch(uHA, q, 0).y;
      if (qy < -1.5) continue;
      float sep = abs(log((qy < 0.0 ? 1e4 : qy) / dHere));
      if (sep > 0.22 && sep > best) { best = sep; bq = q; }
    }
    if (best > 0.0) {
      vec4 other = texelFetch(uHC, bq, 0);
      if (re) { vec4 B = texelFetch(uHA, bq, 0); if (B.y >= 0.0) other.rgb = recolour(other, B.x); }
      float a = clamp(A.w, 0.0, 1.0);
      col = vec4(pow(mix(pow(other.rgb, vec3(2.2)), pow(col.rgb, vec3(2.2)), a), vec3(0.4545)), mix(other.a, col.a, a));
    }
  }

  // Distance along this pixel's ray to the point shown.
  float t = sMet > 0.0 ? 1.0 / sMet : A.y;
  // Beyond the image there is nothing to show: dark, rather than its border smeared outward.
  float lost = smoothstep(0.0, uEdgeFade, outside);
  gl_FragDepth = A.y < 0.0 || lost >= 1.0 ? 1.0 : depthOf(cameraPosition + rd * t);
  if (uCover == 0) col.a = 1.0;
  col.rgb *= 1.0 - lost;
  col.rgb *= 1.0 - uVignette * smoothstep(0.6, 1.2, length(vNdc));
  col.rgb *= 1.0 - uFade;
  if (uDebug == 3 && gRule > 1) {
    vec3 tint = gRule == 2 ? vec3(1.0) : gRule == 3 ? vec3(1.0, 0.0, 0.0) : gRule == 5 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 1.0, 0.0);
    col.rgb = mix(col.rgb, tint, gRule == 2 ? 0.15 : 0.7);
  }
  fragColor = uDebug == 2 ? vec4(vec3(float(gLookups) / 64.0), 1.0) : uDebug == 4 ? vec4(vec3(float(gRule) / 8.0), 1.0) : col;
}
`;
