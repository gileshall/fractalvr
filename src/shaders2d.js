// 2D path: escape-time fractals painted on room-attached surfaces. Iteration counts live in
// a plane-space pyramid (an array texture, one toroidal window per octave of detail) that is
// filled and refined by the plane pass; the eye pass just looks them up per pixel, so head
// motion never touches the fractal and palette changes are free.
//
// A texel holds the smooth iteration count where the point escaped, minus the iterations it
// ran where it did not, and -1e9 where no number of them would do.

import { common } from './shaders.js';
import { PROBE_EDGES } from './planeplan.js';
import { STEP_ABS_RE, STEP_ABS_X, STEP_ABS_Y, STEP_NEG } from './fractals.js';

// Room-attached surfaces for the 2D layouts. Surface space = room space rotated/offset by
// the recenter frame.
export const surfaceChunk = /* glsl */ `
uniform mat4 uRoomFromWorld;
uniform mat4 uWorldFromRoom;
uniform mat4 uSurfFromRoom;
uniform mat4 uRoomFromSurf;
uniform int uLayout;     // 0 floor, 1 wall, 2 sphere, 3 tunnel, 4 cylinder
uniform int uJuliaSky;
uniform float uTunnelL;  // metres per doubling along the tunnel

const float HEAD_Y = 1.6;
const float CEIL_Y = 3.0;
const float WALL_Z = 2.5;
const float SPHERE_R = 4.0;
const float TUNNEL_R = 1.5;
const float CYL_R = 3.0;

void surfaceRay(vec3 roW, vec3 rdW, out vec3 ro, out vec3 rd) {
  vec3 roR = (uRoomFromWorld * vec4(roW, 1.0)).xyz;
  vec3 rdR = normalize(mat3(uRoomFromWorld) * rdW);
  ro = (uSurfFromRoom * vec4(roR, 1.0)).xyz;
  rd = normalize(mat3(uSurfFromRoom) * rdR);
}

float cylT(vec3 ro, vec3 rd, vec3 a, float r, bool vertical) {
  vec2 o = vertical ? (ro.xz - a.xz) : (ro.xy - a.xy);
  vec2 d = vertical ? rd.xz : rd.xy;
  float A = dot(d, d);
  float B = dot(o, d);
  float C = dot(o, o) - r * r;
  float h = B * B - A * C;
  if (h < 0.0 || A < 1e-12) return -1.0;
  float t = (-B + sqrt(h)) / A;
  return t > 0.0 ? t : -1.0;
}

// Which surface the ray hits: 0 fractal, 1 julia, 2 grid floor, 3 dark ceiling, 4 dark back
// wall, -1 none. uv is the surface coordinate in metres.
int surfaceHit(vec3 ro, vec3 rd, out float t, out vec2 uv) {
  t = 1e30;
  int which = -1;
  uv = vec2(0.0);
  if (uLayout == 0) {
    float tf = -ro.y / rd.y;
    float tc = (CEIL_Y - ro.y) / rd.y;
    if (tf > 0.0) { t = tf; which = 0; vec3 p = ro + rd * t; uv = vec2(p.x, -p.z); }
    if (tc > 0.0 && tc < t) { t = tc; which = uJuliaSky == 1 ? 1 : 3; vec3 p = ro + rd * t; uv = vec2(p.x, -p.z) * 0.8; }
  } else if (uLayout == 1) {
    float tw = (-WALL_Z - ro.z) / rd.z;
    float tb = (WALL_Z - ro.z) / rd.z;
    float tf = -ro.y / rd.y;
    float tc = (CEIL_Y - ro.y) / rd.y;
    if (tw > 0.0) { t = tw; which = 0; vec3 p = ro + rd * t; uv = vec2(p.x, p.y - HEAD_Y); }
    if (tb > 0.0 && tb < t) { t = tb; which = uJuliaSky == 1 ? 1 : 4; vec3 p = ro + rd * t; uv = vec2(-p.x, p.y - HEAD_Y) * 0.8; }
    if (tf > 0.0 && tf < t) { t = tf; which = 2; vec3 p = ro + rd * t; uv = p.xz; }
    if (tc > 0.0 && tc < t) { t = tc; which = 3; vec3 p = ro + rd * t; uv = p.xz; }
  } else if (uLayout == 2) {
    vec3 c = vec3(0.0, HEAD_Y, 0.0);
    vec3 o = ro - c;
    float b = dot(o, rd);
    float h = b * b - (dot(o, o) - SPHERE_R * SPHERE_R);
    if (h > 0.0) {
      t = -b + sqrt(h);
      which = 0;
      vec3 d = normalize(o + rd * t);
      float f = -d.z;
      uv = 2.0 * d.xy / max(1.0 + f, 1e-4);
    }
  } else if (uLayout == 3) {
    float tt = cylT(ro, rd, vec3(0.0, HEAD_Y, 0.0), TUNNEL_R, false);
    if (tt > 0.0) {
      t = tt;
      which = 0;
      vec3 p = ro + rd * t;
      vec2 q = p.xy - vec2(0.0, HEAD_Y);
      float theta = atan(q.y, q.x);
      float e = clamp(p.z / uTunnelL, -60.0, 60.0);
      float r = exp2(e);
      uv = r * vec2(cos(theta), sin(theta));
    }
  } else {
    float tt = cylT(ro, rd, vec3(0.0), CYL_R, true);
    float tf = -ro.y / rd.y;
    float tc = (CEIL_Y - ro.y) / rd.y;
    if (tt > 0.0) { t = tt; which = 0; vec3 p = ro + rd * t; uv = vec2(atan(p.x, -p.z) * CYL_R, p.y - HEAD_Y); }
    if (tf > 0.0 && tf < t) { t = tf; which = 2; vec3 p = ro + rd * t; uv = p.xz; }
    if (tc > 0.0 && tc < t) { t = tc; which = 3; vec3 p = ro + rd * t; uv = p.xz; }
  }
  return which;
}
`;

// Escape-time iteration shared by the plane pass and the eye pass's direct evaluation.
const iterChunk = /* glsl */ `
uniform int uFormula;    // what is shown (FORMULAS): 2 a Julia set, the others the plane of c
uniform int uStep;       // its iteration: the STEP bits of fractals.js
uniform vec2 uCenterF;   // float view of the centre (Julia sky, cardioid test)
uniform vec2 uJuliaC;
uniform int uMaxIter;
uniform sampler2D uRef;
uniform int uRefLen;

// A point of the reference orbit, and its x^2 - y^2 to the orbit's own precision.
vec3 fetchRef(int m) {
  return texelFetch(uRef, ivec2(m & 1023, m >> 10), 0).xyz;
}

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }

// |a + d| - |a| without cancellation.
float diffabs(float a, float d) {
  if (a >= 0.0) return (a + d >= 0.0) ? d : -(2.0 * a + d);
  return (a + d > 0.0) ? 2.0 * a + d : -d;
}

// The iteration at Z + d less the iteration at Z, with no difference of near-equal numbers taken.
vec2 stepDelta(vec3 Z, vec2 d) {
  if (uStep == 0) return 2.0 * cmul(Z.xy, d) + cmul(d, d);
  float re = 2.0 * (Z.x * d.x - Z.y * d.y) + d.x * d.x - d.y * d.y;
  if ((uStep & ${STEP_ABS_RE}) != 0) re = diffabs(Z.z, re);
  float x = Z.x, y = Z.y, ex = d.x, ey = d.y;
  if ((uStep & ${STEP_ABS_X}) != 0) { ex = diffabs(x, ex); x = abs(x); }
  if ((uStep & ${STEP_ABS_Y}) != 0) { ey = diffabs(y, ey); y = abs(y); }
  float im = 2.0 * (x * ey + ex * (y + ey));
  return vec2(re, (uStep & ${STEP_NEG}) != 0 ? -im : im);
}

// The iteration itself, less its c.
vec2 stepOf(vec2 z) {
  if (uStep == 0) return cmul(z, z);
  float re = z.x * z.x - z.y * z.y;
  if ((uStep & ${STEP_ABS_RE}) != 0) re = abs(re);
  if ((uStep & ${STEP_ABS_X}) != 0) z.x = abs(z.x);
  if ((uStep & ${STEP_ABS_Y}) != 0) z.y = abs(z.y);
  float im = 2.0 * z.x * z.y;
  return vec2(re, (uStep & ${STEP_NEG}) != 0 ? -im : im);
}

// Perturbed about the reference orbit. Smooth iteration count, -1.0 where the cap ran out.
float iterPerturbed(vec2 dc, int maxIter) {
  vec2 d = vec2(0.0);
  int m = 0;
  vec3 Zn = fetchRef(0);
  for (int i = 0; i < 16384; i++) {
    if (i >= maxIter) break;
    d = stepDelta(Zn, d) + dc;
    m++;
    Zn = fetchRef(m);
    vec2 z = Zn.xy + d;
    float zz = dot(z, z);
    if (zz > 256.0) return float(i + 1) - log2(log2(zz)) + 4.0;
    if (zz < dot(d, d) || m >= uRefLen - 1) { d = z; m = 0; Zn = fetchRef(0); }
  }
  return -1.0;
}

float iterPlain(vec2 z, vec2 c, int maxIter) {
  for (int i = 0; i < 16384; i++) {
    if (i >= maxIter) break;
    z = stepOf(z) + c;
    float zz = dot(z, z);
    if (zz > 256.0) return float(i + 1) - log2(log2(zz)) + 4.0;
  }
  return -1.0;
}

// Main cardioid or period-2 bulb, by a margin wider than the rounding of the test.
bool inMainBody(vec2 c) {
  float q = (c.x - 0.25) * (c.x - 0.25) + c.y * c.y;
  if (q * (q + (c.x - 0.25)) < 0.25 * c.y * c.y - 2e-6) return true;
  return (c.x + 1.0) * (c.x + 1.0) + c.y * c.y < 0.0625 - 2e-6;
}

// Iteration count for a complex offset dc from the view centre; -2.0 where known to be interior.
float iterAt(vec2 dc, int maxIter) {
  if (uFormula == 2) return iterPlain(uCenterF + dc, uJuliaC, maxIter);
  if (uFormula == 0 && length(dc) > 1e-6 && inMainBody(uCenterF + dc)) return -2.0;
  return iterPerturbed(dc, maxIter);
}
`;

// ---------------------------------------------------------------- plane pass

// Fills texels of one pyramid level (or the Julia sky texture). Texel (x, y) of a toroidal
// window starting at grid index uWin holds grid index uWin + ((x, y) - uWin) mod T. A refine
// keeps what escaped or has already run to the cap; with a cap of zero it is a copy.
export const planeVertex = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const planeFragment = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
out vec4 fragColor;
uniform int uT;
uniform ivec2 uWin;
uniform vec2 uOrigOff;   // grid origin minus view centre, complex units
uniform float uTexel;    // complex units per texel
uniform sampler2DArray uOld;
uniform int uOldLayer;
uniform int uRefine;     // 1: keep texels that escaped or ran this far
` + iterChunk + /* glsl */ `
void main() {
  ivec2 tx = ivec2(gl_FragCoord.xy);
  if (uRefine == 1) {
    float old = texelFetch(uOld, ivec3(tx, uOldLayer), 0).r;
    if (old >= 0.0 || -old >= float(uMaxIter)) { fragColor = vec4(old, 0.0, 0.0, 1.0); return; }
  }
  ivec2 rel = tx - uWin;
  ivec2 i = uWin + ((rel % uT) + uT) % uT;
  vec2 dc = uOrigOff + vec2(i) * uTexel;
  float n = iterAt(dc, uMaxIter);
  fragColor = vec4(n >= 0.0 ? n : (n < -1.5 ? -1e9 : -float(uMaxIter)), 0.0, 0.0, 1.0);
}
`;

export const MAX_LEVELS = 12;
const FAR_ITER = 200;

// What the levels (and the Julia sky, the last column) hold, for the cost of work on them.
// A pixel is two 16-bit numbers (r,g and b,a), means over all the texels of a level.
// Row 0: iterations of the texels that escaped; the share that ran to their cap, of 65535.
// Row 1: iterations a refine to uNext would run; iterations those that ran to their cap did.
export const STATS_TAPS = 32;
export const statsFragment = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
out vec4 o;
uniform sampler2DArray uLevels0, uLevels1;
uniform sampler2D uJulia;
uniform int uT;
uniform int uJuliaRes;
uniform int uArr[${MAX_LEVELS}];
uniform ivec4 uRect[${MAX_LEVELS}];  // grid indices in use: x, y, w, h
uniform float uNext[${MAX_LEVELS}];
uniform vec2 uJit;
void main() {
  int j = int(gl_FragCoord.x);
  bool level = j < ${MAX_LEVELS};
  float next = 0.0;
  if (level) next = uNext[j];
  float esc = 0.0, inside = 0.0, due = 0.0, ran = 0.0;
  for (int a = 0; a < ${STATS_TAPS}; a++) {
    for (int b = 0; b < ${STATS_TAPS}; b++) {
      vec2 f = (vec2(float(a), float(b)) + uJit) / ${STATS_TAPS}.0;
      float n;
      if (level) {
        ivec4 r = uRect[j];
        ivec2 p = (r.xy + ivec2(f * vec2(r.zw))) & (uT - 1);
        n = uArr[j] == 0 ? texelFetch(uLevels0, ivec3(p, j), 0).r : texelFetch(uLevels1, ivec3(p, j), 0).r;
      } else {
        n = texelFetch(uJulia, ivec2(f * float(uJuliaRes)), 0).r;
      }
      if (n >= 0.0) esc += n;
      else if (n > -1e8) { inside += 1.0; ran += -n; if (-n < next) due += next; }
    }
  }
  float taps = ${STATS_TAPS * STATS_TAPS}.0;
  vec2 v = gl_FragCoord.y < 1.0 ? vec2(esc / taps, inside / taps * 65535.0) : vec2(due, ran) / taps;
  v = floor(min(v + 0.5, 65535.0));
  vec2 hi = floor(v / 256.0);
  o = vec4(hi.x, v.x - hi.x * 256.0, hi.y, v.y - hi.y * 256.0) / 255.0;
}
`;

// What the probes hold: tile j of the atlas is PROBE_P x PROBE_P points over level j's window,
// run to the ceiling. A pixel is two 16-bit counts (r,g and b,a); column j, row r holds counts
// 2r and 2r+1 of: points that escaped at PROBE_EDGES[b] iterations or later, b = 0..14; then
// points that never did (the main body apart).
export const PROBE_P = 64;
export const PROBE_ROWS = (PROBE_EDGES.length + 1) / 2;
export const probeStatsFragment = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 o;
uniform sampler2D uProbe;
const float EDGE[${PROBE_EDGES.length}] = float[${PROBE_EDGES.length}](${PROBE_EDGES.map((e) => e.toFixed(1)).join(', ')});
void main() {
  int j = int(gl_FragCoord.x);
  int s = 2 * int(gl_FragCoord.y);
  vec2 v = vec2(0.0);
  for (int a = 0; a < ${PROBE_P}; a++) {
    for (int b = 0; b < ${PROBE_P}; b++) {
      float n = texelFetch(uProbe, ivec2(j * ${PROBE_P} + a, b), 0).r;
      for (int k = 0; k < 2; k++) {
        int at = s + k;
        bool hit = at < ${PROBE_EDGES.length} ? n >= EDGE[min(at, ${PROBE_EDGES.length - 1})] : (n < 0.0 && n > -1e8);
        if (hit) v[k] += 1.0;
      }
    }
  }
  vec2 hi = floor(v / 256.0);
  o = vec4(hi.x, v.x - hi.x * 256.0, hi.y, v.y - hi.y * 256.0) / 255.0;
}
`;

// ---------------------------------------------------------------- eye pass

export const eye2dFragment = common + surfaceChunk + iterChunk + /* glsl */ `
precision highp sampler2DArray;
out vec4 fragColor;
uniform sampler2DArray uLevels0, uLevels1;
uniform int uNL;
uniform int uT;
uniform float uTexel0;            // metres per texel of level 0 at the current scale
// Level L, finest first, is layer uLvLayer[L] of one of the two arrays.
uniform int uLvArr[${MAX_LEVELS}];
uniform int uLvLayer[${MAX_LEVELS}];
uniform ivec2 uLvWin[${MAX_LEVELS}];  // grid indices held: from here,
uniform ivec2 uLvSize[${MAX_LEVELS}]; // this many
uniform vec2 uLvOff[${MAX_LEVELS}];   // grid origin minus centre, metres at the current scale
uniform float uLvTexel[${MAX_LEVELS}]; // metres per texel at the current scale
uniform int uLvValid[${MAX_LEVELS}];
uniform int uAnyValid;
uniform sampler2D uJulia;
uniform float uJuliaExtent;
uniform int uJuliaRes;
uniform float uScale;    // complex units per metre
uniform float uRot;
uniform float uVignette;
uniform float uFade;

// Bilinear over four taps where escaped and interior texels never mix: the heavier class
// wins, so the set boundary stays crisp.
float combine(float v[4], float w[4]) {
  float wIn = 0.0, wEsc = 0.0, n = 0.0;
  for (int k = 0; k < 4; k++) {
    if (v[k] < 0.0) wIn += w[k]; else { wEsc += w[k]; n += v[k] * w[k]; }
  }
  return wEsc > wIn ? n / wEsc : -1.0;
}

// Point q (metres from the centre, plane axes) in level L. False when outside its window.
bool sampleLevel(int L, vec2 q, out float n) {
  vec2 g = (q - uLvOff[L]) / uLvTexel[L];
  vec2 gf = floor(g);
  vec2 f = g - gf;
  ivec2 i = ivec2(gf);
  ivec2 w0 = uLvWin[L];
  float v[4];
  float w[4];
  for (int k = 0; k < 4; k++) {
    ivec2 ij = i + ivec2(k & 1, k >> 1);
    ivec2 rel = ij - w0;
    if (any(lessThan(rel, ivec2(0))) || any(greaterThanEqual(rel, uLvSize[L]))) return false;
    ivec2 tx = ((ij % uT) + uT) % uT;
    v[k] = uLvArr[L] == 0 ? texelFetch(uLevels0, ivec3(tx, uLvLayer[L]), 0).r : texelFetch(uLevels1, ivec3(tx, uLvLayer[L]), 0).r;
    w[k] = ((k & 1) == 0 ? 1.0 - f.x : f.x) * ((k >> 1) == 0 ? 1.0 - f.y : f.y);
  }
  n = combine(v, w);
  return true;
}

// Finest valid level at or above L that contains q.
bool sampleFrom(int L, vec2 q, out float n, out int used) {
  for (int l = 0; l < ${MAX_LEVELS}; l++) {
    if (l < L || l >= uNL) continue;
    if (uLvValid[l] == 1 && sampleLevel(l, q, n)) { used = l; return true; }
  }
  return false;
}

float fractalAt(vec2 q, float rho) {
  float Ls = log2(max(rho, 1e-30) / uTexel0);
  if (uAnyValid == 0) return -1.0;
  int L0 = int(clamp(floor(Ls), 0.0, float(uNL - 1)));
  float fr = clamp(Ls - float(L0), 0.0, 1.0);
  float n0, n1;
  int u0, u1;
  if (!sampleFrom(L0, q, n0, u0)) {
    // Beyond the coarsest level (the far end of the tunnel): a few iterations in place. With
    // that level still to come (a far jump): dark rather than a full-screen evaluation.
    if (uLvValid[uNL - 1] == 0) return -1.0;
    return iterAt(q * uScale, min(uMaxIter, ${FAR_ITER}));
  }
  if (fr < 0.01 || u0 != L0 || L0 + 1 >= uNL) return n0;
  if (!sampleFrom(L0 + 1, q, n1, u1) || u1 != L0 + 1) return n0;
  if (n0 >= 0.0 && n1 >= 0.0) return mix(n0, n1, fr);
  return fr < 0.5 ? n0 : n1;
}

float juliaAt(vec2 z) {
  float E = uJuliaExtent;
  if (any(greaterThan(abs(z), vec2(E)))) return iterPlain(z, uJuliaC, 64);
  vec2 g = (z + E) / (2.0 * E) * float(uJuliaRes) - 0.5;
  vec2 gf = floor(g);
  vec2 f = g - gf;
  ivec2 i = ivec2(gf);
  float v[4];
  float w[4];
  for (int k = 0; k < 4; k++) {
    ivec2 ij = clamp(i + ivec2(k & 1, k >> 1), ivec2(0), ivec2(uJuliaRes - 1));
    v[k] = texelFetch(uJulia, ij, 0).r;
    w[k] = ((k & 1) == 0 ? 1.0 - f.x : f.x) * ((k >> 1) == 0 ? 1.0 - f.y : f.y);
  }
  return combine(v, w);
}

// Cosine palette with a Gaussian pixel filter on its argument, so bands finer than a
// pixel fade to the palette mean instead of aliasing.
vec3 paletteAA(float t, float w) {
  vec3 k = 3.14159265 * uPalC * w;
  vec3 att = exp(-0.5 * k * k);
  return uPalA + uPalB * att * cos(6.28318 * (uPalC * t + uPalD));
}

vec3 shadeIter(float n, float w) {
  if (n < 0.0) return vec3(0.0);
  float tArg = sqrt(n) * 0.12 * uColorFreq + uColorPhase;
  return paletteAA(tArg, w);
}

vec3 grid(vec2 uv) {
  vec2 g = abs(fract(uv) - 0.5);
  float l = smoothstep(0.47, 0.5, max(g.x, g.y));
  return mix(vec3(0.03, 0.03, 0.05), vec3(0.1, 0.12, 0.18), l);
}

void main() {
  vec3 roW = cameraPosition;
  vec3 rdW = normalize(vFar - cameraPosition);
  vec3 ro, rd;
  surfaceRay(roW, rdW, ro, rd);
  float t;
  vec2 uv;
  int which = surfaceHit(ro, rd, t, uv);
  // Derivatives before any divergence: plane metres per pixel drive the level choice.
  vec2 q = rot2(uRot) * uv;
  float rho = max(length(dFdx(q)), length(dFdy(q)));
  float n = -1.0;
  if (which == 0) n = fractalAt(q, rho);
  else if (which == 1) n = juliaAt(uv);
  float tArg = sqrt(max(n, 0.0)) * 0.12 * uColorFreq + uColorPhase;
  float wArg = fwidth(tArg);

  vec3 skyE = pow(background(rdW), vec3(0.4545));
  vec3 col;
  float alphaOut = 1.0;
  if (which < 0) {
    col = skyE;
    alphaOut = 0.0;
    gl_FragDepth = 1.0;
  } else {
    if (which <= 1) col = shadeIter(n, wArg);
    else if (which == 2) col = pow(grid(uv), vec3(0.4545));
    else col = pow(vec3(0.02, 0.02, 0.03), vec3(0.4545));
    float fog = 1.0 - exp(-t / 40.0);
    col = mix(col, skyE, fog);
    alphaOut = 1.0 - fog;
    vec3 pRoom = (uRoomFromSurf * vec4(ro + rd * t, 1.0)).xyz;
    vec3 pWorld = (uWorldFromRoom * vec4(pRoom, 1.0)).xyz;
    gl_FragDepth = depthOf(pWorld);
  }
  float r = length(vNdc);
  col *= 1.0 - uVignette * smoothstep(0.6, 1.2, r);
  col *= 1.0 - uFade;
  fragColor = vec4(col, uBackground == 5 ? alphaOut : 1.0);
}
`;
