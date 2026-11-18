import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { fullscreenVertex, geometryFragment, coneVertex, coneFragment, CONE, accumulateFragment, presentFragment, nearFragment, nearWideFragment, NEAR_TILE, costFragment, COST_ROWS } from './shaders.js';
import { cumulate, heightAt } from './cost.js';
import { eye2dFragment, MAX_LEVELS } from './shaders2d.js';
import { FRACTALS, FORMULAS, ORDER, PALETTES, LAYOUTS_2D } from './fractals.js';
import { wristTurn } from './wrist.js';
import { state, ARM, DEFAULTS, onChange, notify, setFractal, setPalette, currentFractal, currentPalette } from './state.js';
import { keep, restore, kept, forget } from './prefs.js';
import { Rig, SCALE_MIN } from './rig.js';
import { View2D, SCALE2D_MIN, SCALE2D_MAX } from './view2d.js';
import { Input } from './input.js';
import { Pointers } from './pointer.js';
import { buildMenu } from './menu.js';
import { Hud, ControlsPanel, HandLabel, ListPanel, overlayMaterial, OVERLAY_ORDER, loadFonts } from './ui.js';
import { version } from '../package.json';
import { PlaneCache } from './plane.js';
import { Readback } from './readback.js';
import { dd, ddAddD, ddToString } from './dd.js';
import { TOOLS, BACKGROUNDS, BallGun, Bookmarks } from './tools.js';
import { HeadTrace, HeadMotion } from './diag.js';
import { checkBuild } from './fresh.js';
import { startHint } from './hint.js';
import { REPORTS, STORED_TO, store, load, startEdition } from './edition.js';
import { Pilot } from './pilot.js';
import { LEG, LEG_FLOOR, LEG_LOST, TOUR_RATE, TOUR_SPIN, JULIA_FLOOR, fly, face, frontOf, boundaryPoint, stops, Playlist } from './tour.js';
import { tune, createMotion, stepMotion, headFrom, coverSeconds, dropWithin, planSize, planView, CYCLE_MAX } from './imageplan.js';

const TURN_SPEED = 1.6;
const ZOOM_SPEED = 1.4; // e-folds per second at full stick (3D)
const ZOOM2D_SPEED = 1.2; // doublings per second at full stick (2D)
const PAN_SPEED = 1.5; // surface metres per second at full stick
// 2D: iterations of plane work a frame. The start is a guess that the late frames correct.
const PLANE_START = 6e6, PLANE_MIN = 5e5, PLANE_MAX = 6.4e7;
const W_MAX = 32; // accumulated sample weight cap (memory of the running average)

// ---------------------------------------------------------------- renderer

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation(state.ffr);
renderer.xr.cameraAutoUpdate = false;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));
// Passthrough needs an AR session: same app, camera feed where the background would be. It starts
// from this button only; the session offered to the browser's own entry is the VR button's. The
// reference space stays local-floor, as in VR.
const arButton = document.createElement('button');
Object.assign(arButton.style, {
  display: 'none', position: 'absolute', bottom: '20px', left: 'calc(50% + 90px)', width: '170px', padding: '12px 6px',
  border: '1px solid #fff', borderRadius: '4px', background: 'rgba(0,0,0,0.1)', color: '#fff', font: 'normal 13px sans-serif',
  textAlign: 'center', opacity: '0.5', outline: 'none', zIndex: '999',
});
document.body.appendChild(arButton);
if (navigator.xr) {
  navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
    arButton.style.display = '';
    if (!supported) { arButton.textContent = 'PASSTHROUGH NOT SUPPORTED'; return; }
    let session = null;
    arButton.textContent = 'START PASSTHROUGH';
    arButton.style.cursor = 'pointer';
    arButton.onmouseenter = () => { arButton.style.opacity = '1.0'; };
    arButton.onmouseleave = () => { arButton.style.opacity = '0.5'; };
    arButton.onclick = async () => {
      if (session) { session.end(); return; }
      const s = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['local-floor'] });
      s.addEventListener('end', () => { session = null; arButton.textContent = 'START PASSTHROUGH'; }, { once: true });
      await renderer.xr.setSession(s);
      session = s;
      arButton.textContent = 'STOP PASSTHROUGH';
    };
  });
}
for (const ext of ['EXT_color_buffer_float']) {
  if (!renderer.getContext().getExtension(ext)) throw new Error(`${ext} is required`);
}

const rig = new Rig();
const view2d = new View2D();
const plane = new PlaneCache(renderer);

const scene = new THREE.Scene();
scene.add(rig.dolly);
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));

// ---------------------------------------------------------------- passes

const triGeom = new THREE.BufferGeometry();
triGeom.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
const fsMaterial = (vs, fs, uniforms, extra = {}) => new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms, glslVersion: THREE.GLSL3, ...extra });
const fsMesh = (mat) => { const m = new THREE.Mesh(triGeom, mat); m.frustumCulled = false; return m; };

const shared = {
  uPalA: { value: new THREE.Vector3() }, uPalB: { value: new THREE.Vector3() },
  uPalC: { value: new THREE.Vector3() }, uPalD: { value: new THREE.Vector3() },
  uColorFreq: { value: 1 }, uColorPhase: { value: 0 }, uFoveate: { value: 0 },
  uBackground: { value: 0 }, uTime: { value: 0 },
};
// Geometry pass (3D, low res, jittered).
const uGeo = {
  ...shared,
  uFractal: { value: 0 }, uP1: { value: 0 }, uP2: { value: 0 }, uP3: { value: 0 }, uP4: { value: 0 }, uP5: { value: 0 }, uP6: { value: 0 }, uP7: { value: 0 }, uP8: { value: 0 },
  uScale: { value: 1 }, uPixelAngle: { value: 0.002 }, uEpsMul: { value: 1 }, uNormalPx: { value: 1 }, uPrec: { value: 1e-6 }, uMaxSteps: { value: 96 }, uBound: { value: 0 },
  uAOSamples: { value: 3 }, uShadows: { value: 0 }, uLightPos: { value: new THREE.Vector3() }, uLightMode: { value: 1 },
};
// Cone pass (3D): one ray to each block of geometry samples, ahead of them.
const uCone = { ...uGeo, uSpan: { value: new THREE.Vector2(1, 1) }, uConeAngle: { value: 0 }, uConeNdc: { value: 0 } };
const coneScene = new THREE.Scene();
coneScene.add(fsMesh(fsMaterial(coneVertex, coneFragment, uCone)));
uGeo.uClear = { value: null };
uGeo.uConeLay = { value: new THREE.Vector3() };
uGeo.uRelax = { value: 1.3 }; // measured: longer steps fail more often than they gain
const geoScene = new THREE.Scene();
geoScene.add(fsMesh(fsMaterial(fullscreenVertex, geometryFragment, uGeo)));

// Accumulate pass (3D, eye resolution).
const uAcc = {
  ...shared,
  uScale: uGeo.uScale, uLightMode: uGeo.uLightMode, uLightPos: uGeo.uLightPos, uAmbient: { value: 0.35 },
  uGA: { value: null }, uGB: { value: null }, uHA: { value: null }, uHB: { value: null },
  uLowUsed: { value: new THREE.Vector2(8, 8) }, uAccSize: { value: new THREE.Vector2(8, 8) }, uHistSize: { value: new THREE.Vector2(8, 8) }, uEyes: { value: 1 },
  uJitter: { value: new THREE.Vector2() },
  uInvView: { value: [new THREE.Matrix3(), new THREE.Matrix3()] }, uProj: { value: [new THREE.Vector4(), new THREE.Vector4()] },
  uEye: { value: [new THREE.Vector3(), new THREE.Vector3()] },
  uPrevVP: { value: [new THREE.Matrix4(), new THREE.Matrix4()] }, uEyeDelta: { value: [new THREE.Vector3(), new THREE.Vector3()] },
  uWScale: { value: 0 }, uWMax: { value: W_MAX }, uSigma: { value: 0.45 }, uMotionDecay: { value: 0.02 }, uResample: { value: 0.9 }, uDistMin: { value: 0.01 }, uDebug: { value: 0 },
};
const accScene = new THREE.Scene();
accScene.add(fsMesh(fsMaterial(fullscreenVertex, accumulateFragment, uAcc, { depthTest: false, depthWrite: false })));
// The accumulate pass covers the whole target in one draw; the shader picks the eye per pixel.
const accCam = new THREE.Camera();

// Cost pass: the work of a finished image's geometry samples, a texel per band of rows.
const uCost = { uGB: { value: null }, uUsed: { value: new THREE.Vector2(8, 8) } };
const costScene = new THREE.Scene();
costScene.add(fsMesh(fsMaterial(fullscreenVertex, costFragment, uCost, { depthTest: false, depthWrite: false })));
const costReader = new Readback(renderer, 1, COST_ROWS);

// Near pass: the least and greatest distance of a finished image by tile, then with the tiles around.
const uNear = { uHA: { value: null }, uNear: { value: null }, uAcc: { value: new THREE.Vector2(8, 8) }, uTiles: { value: new THREE.Vector2(1, 1) } };
const nearScene = new THREE.Scene();
nearScene.add(fsMesh(fsMaterial(fullscreenVertex, nearFragment, uNear, { depthTest: false, depthWrite: false })));
const nearWideScene = new THREE.Scene();
nearWideScene.add(fsMesh(fsMaterial(fullscreenVertex, nearWideFragment, uNear, { depthTest: false, depthWrite: false })));

// Present pass (3D) and eye pass (2D): the fullscreen quad in the XR scene.
const uShow = {
  // The image on show: its textures, size, camera and tiles, and the palette it was shaded with.
  uHA: { value: null }, uHC: { value: null }, uAccSize: { value: new THREE.Vector2(8, 8) },
  uShownVP: { value: [new THREE.Matrix4(), new THREE.Matrix4()] }, uShownDelta: { value: [new THREE.Vector3(), new THREE.Vector3()] },
  uNear: { value: null }, uTiles: { value: new THREE.Vector2(1, 1) }, uNearInv: { value: 0 },
  uRecolour: { value: 0 }, uWasArg: { value: new THREE.Vector2(1, 0) },
  uWasA: { value: new THREE.Vector3() }, uWasB: { value: new THREE.Vector3() }, uWasC: { value: new THREE.Vector3() }, uWasD: { value: new THREE.Vector3() },
  uFbSize: { value: new THREE.Vector2(1, 1) }, uEyes: { value: 1 },
  uEdgeBlend: { value: 1 }, uVignette: { value: 0 }, uFade: { value: 0 },
  uReproject: { value: 0 }, uEdgeFade: { value: 0.04 }, uStepPx: { value: 2 }, uSteps: { value: 16 }, uDebug: { value: 0 },
  uCover: { value: 0 },
  // This frame's palette.
  uNowArg: { value: new THREE.Vector2(1, 0) },
  uNowA: { value: new THREE.Vector3() }, uNowB: { value: new THREE.Vector3() }, uNowC: { value: new THREE.Vector3() }, uNowD: { value: new THREE.Vector3() },
};
const u2d = {
  ...shared,
  uRoomFromWorld: { value: new THREE.Matrix4() }, uWorldFromRoom: { value: new THREE.Matrix4() },
  uSurfFromRoom: { value: new THREE.Matrix4() }, uRoomFromSurf: { value: new THREE.Matrix4() },
  uLayout: { value: 0 }, uJuliaSky: { value: 1 }, uTunnelL: { value: 1 },
  uFormula: { value: 0 }, uStep: { value: 0 }, uCenterF: { value: new THREE.Vector2() }, uJuliaC: { value: new THREE.Vector2() },
  uMaxIter: { value: 600 }, uRef: { value: view2d.ref.texture }, uRefLen: { value: 0 },
  uLevels0: { value: null }, uLevels1: { value: null }, uNL: { value: 0 }, uT: { value: 1 }, uTexel0: { value: 1 },
  uLvArr: { value: new Int32Array(MAX_LEVELS) }, uLvLayer: { value: new Int32Array(MAX_LEVELS) },
  uLvWin: { value: new Int32Array(2 * MAX_LEVELS) }, uLvSize: { value: new Int32Array(2 * MAX_LEVELS) },
  uLvOff: { value: new Float32Array(2 * MAX_LEVELS) }, uLvTexel: { value: new Float32Array(MAX_LEVELS) },
  uLvValid: { value: new Int32Array(MAX_LEVELS) }, uAnyValid: { value: 0 },
  uJulia: { value: null }, uJuliaExtent: { value: 1 }, uJuliaRes: { value: 1 },
  uScale: { value: 1 }, uRot: { value: 0 }, uVignette: uShow.uVignette, uFade: uShow.uFade,
};
const matShow = fsMaterial(fullscreenVertex, presentFragment, uShow);
const mat2d = fsMaterial(fullscreenVertex, eye2dFragment, u2d);
const screenMesh = fsMesh(matShow);
screenMesh.renderOrder = -1;
scene.add(screenMesh);
const screenAgain = []; // the same again, passes.times - 1 of them

// ---------------------------------------------------------------- targets

const lowCam = new THREE.ArrayCamera([]);
lowCam.matrixWorldAutoUpdate = false;
const coneCam = new THREE.ArrayCamera([]); // the same cameras over the cones' part of their target
coneCam.matrixWorldAutoUpdate = false;
let gRT = null; // geometry samples, low res
let coneRT = null; // how far each block of them is clear
// Accumulation targets, eye res: the image in progress, the last finished, and the last
// finished at full size where that is another.
const accRT = [null, null, null];
// A finished image: accRT[i], its size and camera, the head it was made for and what it was made
// of. tileRT: its distances by tile; then with the tiles around. turned, shifted: how far the
// head now is from the one it was made for, in radians, the shift as the nearest surface shows it.
const images = [0, 1, 2].map((i) => ({
  i, has: false, w: 8, h: 8, m: 1, key: null, level: 0, scale: 1, look: '',
  vp: [new THREE.Matrix4(), new THREE.Matrix4()], eye: [new THREE.Vector3(), new THREE.Vector3()],
  q: new THREE.Quaternion(), p: new THREE.Vector3(), wider: 0, near: 0, turned: 0, shifted: 0,
  pal: { index: 0, freq: 1, phase: 0, cover: false },
  cam: [0, 1].map(() => ({ matrixWorld: new THREE.Matrix4(), projectionMatrix: new THREE.Matrix4() })),
  tileRT: [null, null], tiles: new THREE.Vector2(1, 1),
}));
const fbSize = new THREE.Vector2();
// Portion of gRT in use: eyeW per eye, usedH rows.
const low = { eyeW: 8, usedH: 8, eyes: 1, allocScale: 0, allocKey: '' };
// w, h: the image being made, per eye, in the corner of targets allocated at fullW x fullH.
const acc = { w: 8, h: 8, fullW: 8, fullH: 8, cur: 0 };
// Passes that run. Switched off one at a time to time them on a device (fv profile); a skipped
// pass leaves its last output in place.
const passes = { geo: true, cone: true, acc: true, final: true, times: 1 }; // times: the present pass drawn that often, to weigh it against a frame

// The geometry sample scale. Fixed at state.resScale: 3D spreads the image over frames
// instead (cycle), 2D paces its plane work (planeCtl).
const dyn = { scale: state.resScale };
// 2D: the plane's budget, and the window of frames it is judged over.
const planeCtl = { budget: PLANE_START, n: 0, over: 0, good: 0, patience: 2, probed: false, skip: 0 };

// A 3D image (geometry and accumulate) is rendered over several display frames in row bands,
// from the pose and settings of its first frame, while the present pass reprojects the last
// finished image to the head. Every frame does the same share of both passes, the geometry a
// few rows ahead of the accumulate rows it feeds: a frame heavier than the last is late on a
// headset however light it is: the bands are equal shares of the image's cost, not of its rows.
// The cost is in accumulate pixels per eye: the accumulate pass, and the geometry samples by
// the estimator iterations they ran (their work), which the geometry pass counts and the cost
// pass reads back from each finished image, band by band. budgets: work per display frame,
// one per quality level, lowered while frames are late. The faster the view moves, the fewer
// frames an image may take, and it shrinks (m, linear) until it fits them; its camera is ahead
// of the eyes along their motion and sees wider than they do, to cover the view while it is on
// show. An image is due before the view leaves what the one on show covers.
const LEVEL_WORK = [1, 1.2, 1.45]; // the work of a geometry sample by quality level, relative
const WORK_M = 0.25; // and by the image's size: as its size to this power
const COST_EVERY = 24; // display frames between measurements, at least
const WORK_START = 100; // work per sample until an image of this fractal has been measured
const GEO_AHEAD = 4; // geometry rows beyond the accumulate rows of the same frame: their kernel and the jitter
const BUDGET_WINDOW = 72; // display frames the budget is judged over
const cost = {
  rows: new Float32Array(COST_ROWS).fill(WORK_START), work: WORK_START, level: 0, m: 1, // the last image measured: work per sample by band, and overall
  cum: new Float64Array(COST_ROWS + 1), // the image in progress: the share of its cost below each band
  due: null, // a finished image to measure: its samples in use, level, size and fractal
  frame: 0, asked: -1e9, // display frames, and the one the last readback was asked for in
};
const cycle = {
  at: 0, total: 1, gAt: 0, cAt: 0, aAt: 0, cone: true, frames: 0, len: 1, fresh: false, // at: display frames done of the image in progress
  whole: true, // the next image in one frame: nothing valid is on show
  force: 0, forceM: 1, // display frames per image and its size, overriding the budget (tests, fv profile)
  hold: false, // no image work at all (fv profile)
  skew: 0, // the image on show is looked at from this far to the side, radians of shift of its nearest surface (fv profile)
  slice: false, // budgeted as in a session, without one (tests)
  lead: true, // images are made for where the eyes will be
  anchor: true, // a full-size image keeps the last one's camera while the head is close to it
  budget: 0, // work per display frame, overriding the budgets (tests)
  budgets: [0, 0, 0], share: 1, // per quality level; share: display frames a full image takes
  ctl: [0, 1, 2].map(() => ({ good: 0, patience: 2, probed: false })),
  win: { n: 0, over: 0, level: 0, skip: 0 },
  m: 1, planned: 1, wider: 0, key: '', level: 0, scale: 1,
  live: '', edited: -1e9, // what the fractal is now, and when that last changed
  q: new THREE.Quaternion(), p: new THREE.Vector3(), // the head the image is made for
  near: 0, // the nearest surface to that head, fractal units
  pal: { index: 0, freq: 1, phase: 0, cover: false }, // the palette it is shaded with, and whether its alpha is its cover of the camera feed
  shown: images[0], // the last finished image
  detail: null, // the last finished at full size
  hist: images[0], // the one the image in progress takes its history from
  anchored: false, // the image in progress is made from the last full-size one's camera
  eye: [new THREE.Vector3(), new THREE.Vector3()], vp: [new THREE.Matrix4(), new THREE.Matrix4()],
  cam: [0, 1].map(() => ({ matrixWorld: new THREE.Matrix4(), matrixWorldInverse: new THREE.Matrix4(), projectionMatrix: new THREE.Matrix4() })),
};

const motion = createMotion();
let stickYaw = 0; // the turn the stick made this frame, radians about the room's up
// The head's place in the room a frame ago, and how far the room has carried it since.
const roomHead = { p: new THREE.Vector3(), has: false, moved: new THREE.Vector3() };
function updateMotion(dt) {
  const head = rig.headWorld();
  if (roomHead.has && motion.has) roomHead.moved.copy(roomHead.p).applyMatrix4(rig.dolly.matrixWorld).sub(motion.p); else roomHead.moved.set(0, 0, 0);
  stepMotion(motion, rig.camera.getWorldQuaternion(motion._q), head, dt, { yaw: stickYaw, up: rig.up(), near: rig.lastDE, cut: fade.value > 0, room: roomHead.moved });
  rig.dolly.worldToLocal(roomHead.p.copy(head));
  roomHead.has = true;
}

const sliced = () => (cycle.slice || (state.dynamicRes && renderer.xr.isPresenting)) && !cycle.whole;
const frameSeconds = () => 1 / (app.currentFrameRate() || state.frameRate || 72);
// The work per geometry sample of an image at a quality level and size, from the last one measured.
const workAt = (lvl, m) => LEVEL_WORK[lvl] / LEVEL_WORK[cost.level] * Math.pow(m / cost.m, WORK_M);
// The cost of an image at full size, in accumulate pixels per eye.
const fullCost = () => {
  const g = Math.max(8, Math.round(fbSize.x / low.eyes * state.resScale)) * Math.max(8, Math.round(fbSize.y * state.resScale));
  return currentFractal().iterCost * cost.work * workAt(still.level, 1) * g + acc.fullW * acc.fullH;
};

// The work of the last finished image goes to a buffer the GPU fills in its own time. First in
// a frame, where the GPU has nothing of the frame's to finish before it can copy: asked for
// after a frame's image work, the copy held the headset's GPU process and the frame ran late.
function measureCost() {
  const d = cost.due;
  if (!d || costReader.busy) return;
  cost.due = null;
  cost.asked = cost.frame;
  uCost.uGB.value = gRT.textures[1];
  uCost.uUsed.value.set(d.w, d.h);
  costReader.request(costScene, accCam, { level: d.level, m: d.m, fractal: d.fractal });
}
// And is taken up once it is there, before the frame's own work is issued.
function readCost() {
  cost.frame++;
  const p = costReader.poll();
  if (!p || p.fractal !== state.fractal) return; // nothing yet, or of a fractal no longer on show
  const bytes = costReader.bytes;
  let sum = 0;
  for (let j = 0; j < COST_ROWS; j++) { cost.rows[j] = bytes[4 * j] * 256 + bytes[4 * j + 1]; sum += cost.rows[j]; }
  cost.work = sum / COST_ROWS;
  cost.level = p.level;
  cost.m = p.m;
}

// Whether what the geometry is a function of has changed since the last frame.
const liveVals = [];
const LIVE_KEYS = ['fractal', 'shadows', 'ao', 'foveate', 'grain'];
function fractalChanged() {
  let n = 0, changed = false;
  const p = state.params;
  for (const key in p) { if (liveVals[n] !== p[key]) { liveVals[n] = p[key]; changed = true; } n++; }
  for (let i = 0; i < LIVE_KEYS.length; i++) { const v = state[LIVE_KEYS[i]]; if (liveVals[n] !== v) { liveVals[n] = v; changed = true; } n++; }
  if (liveVals.length !== n) { liveVals.length = n; changed = true; }
  return changed;
}

// The next image: its size, the display frames it will take, how much wider than the eyes it
// sees and where its camera is against them.
const plan = { m: 1, k: 1, wider: 0, lead: 0, q: new THREE.Quaternion() };
const covers = { turn: Infinity, shift: Infinity };
function planImage() {
  const full = fullCost(), base = acc.fullW * acc.fullH;
  plan.m = 1; plan.k = 1; plan.wider = 0; plan.lead = 0; plan.q.identity();
  if (!cycle.force && !sliced()) return plan;
  const dt = frameSeconds();
  if (cycle.force) { plan.m = cycle.forceM; plan.k = cycle.force; } else {
    const lvl = still.level;
    // Against the accumulate pass of a full image, which no view changes.
    if (!cycle.budgets[lvl]) cycle.budgets[lvl] = base / 24;
    cycle.budgets[lvl] = THREE.MathUtils.clamp(cycle.budgets[lvl], base / 64, base / 2);
    cycle.share = full / (cycle.budget || cycle.budgets[lvl]);
    covers.turn = Infinity; covers.shift = Infinity;
    if (cycle.shown.has && fade.value === 0) coverSeconds(motion, cycle.shown, rig.lastDE, covers);
    planSize(motion, { share: cycle.share, level: lvl, dt, was: cycle.m, coverTurn: covers.turn, coverShift: covers.shift, editing: performance.now() - cycle.edited < 300 }, plan);
  }
  if (cycle.lead) planView(motion, plan.k, dt, plan);
  return plan;
}

// A frame is late when the one before it was more than the headset had time for. Each quality
// level's budget is cut by the share of late frames once that is past what an idle headset
// shows anyway, and raised while it stays there; a raise that cost frames waits twice as long
// before the next. One long frame is one late frame: a hitch is not load.
function updateBudget(dt) {
  if (!state.dynamicRes || !renderer.xr.isPresenting || cycle.force || cycle.hold) return;
  const w = cycle.win;
  // Behind the system's menu the headset slows the frames itself: that is not load.
  if (renderer.xr.getSession().visibilityState !== 'visible') { w.n = 0; w.over = 0; w.skip = BUDGET_WINDOW / 2; return; }
  if (w.skip > 0) { w.skip--; return; }
  if (w.level !== cycle.level) { w.level = cycle.level; w.n = 0; w.over = 0; }
  w.n++;
  if (dt > 1.25 * frameSeconds()) w.over++;
  if (w.n < BUDGET_WINDOW && w.over < BUDGET_WINDOW / 4) return;
  const late = w.over / w.n;
  const c = cycle.ctl[w.level];
  w.n = 0; w.over = 0;
  if (!cycle.budgets[w.level]) return;
  if (late > 0.12) {
    cycle.budgets[w.level] *= THREE.MathUtils.clamp(1 - late, 0.6, 0.9);
    if (c.probed) c.patience = Math.min(c.patience * 2, 16);
    c.probed = false;
    c.good = 0;
  } else if (late <= 0.06) {
    if (c.probed) { c.patience = Math.max(2, c.patience / 2); c.probed = false; }
    if (++c.good >= c.patience) { cycle.budgets[w.level] *= 1.12; c.good = 0; c.probed = true; }
  }
}

// The full-size image whose camera the next keeps: with the room still and the head close to
// the one it was made for, another image from that camera adds its samples to the same
// pixels, where one from the head's new place would resample them all; the present pass
// shows either from where the head is.
function anchorFor(m) {
  const d = cycle.detail;
  if (!cycle.anchor || m < 1 || !d || still.t <= 0 || !detailHolds(d)) return null;
  // detailHolds left the head's turn and shift from it in motion._o, motion._s.
  if (motion._o.length() > tune.anchorTurn) return null;
  return !(isFinite(d.near) && d.near > 0) || motion._s.length() <= tune.anchorSpan * d.near ? d : null;
}

function beginCycle() {
  if (taa.reset) { taa.reset = false; for (const img of images) img.has = false; cycle.detail = null; }
  planImage();
  cycle.m = plan.m;
  cycle.planned = plan.k;
  cycle.wider = plan.wider;
  acc.w = Math.max(8, Math.round(acc.fullW * plan.m));
  acc.h = Math.max(8, Math.round(acc.fullH * plan.m));
  uAcc.uAccSize.value.set(acc.w, acc.h);
  updateLowRect();
  const anchor = anchorFor(plan.m);
  cycle.anchored = !!anchor;
  // The camera: the eyes, moved on along their motion.
  const lead = fade.value === 0 ? plan.lead : 0;
  if (!renderer.xr.isPresenting) rig.camera.matrixWorldInverse.copy(rig.camera.matrixWorld).invert();
  const src = eyeCameras();
  const head = rig.headWorld();
  // About the head, then along its path.
  if (fade.value === 0) motion._m.makeRotationFromQuaternion(plan.q); else motion._m.identity();
  motion._v.copy(head).applyMatrix4(motion._m).negate().add(head).addScaledVector(motion.linVel, lead);
  motion._m.setPosition(motion._v);
  cycle.q.setFromRotationMatrix(motion._m).multiply(motion.q);
  cycle.p.copy(head).addScaledVector(motion.linVel, lead);
  cycle.near = rig.lastDE;
  if (anchor) { cycle.q.copy(anchor.q); cycle.p.copy(anchor.p); cycle.near = anchor.near; cycle.wider = anchor.wider; }
  for (let i = 0; i < src.length; i++) {
    const c = cycle.cam[i];
    c.matrixWorld.multiplyMatrices(motion._m, src[i].matrixWorld);
    c.projectionMatrix.copy(src[i].projectionMatrix);
    if (anchor) { c.matrixWorld.copy(anchor.cam[i].matrixWorld); c.projectionMatrix.copy(anchor.cam[i].projectionMatrix); }
    c.matrixWorldInverse.copy(c.matrixWorld).invert();
    if (plan.wider > 0 && !anchor) {
      const pe = c.projectionMatrix.elements;
      const half = Math.atan(1 / pe[0]);
      const k = Math.tan(half) / Math.tan(Math.min(half + plan.wider, 1.45));
      pe[0] *= k; pe[5] *= k; pe[8] *= k; pe[9] *= k;
    }
    // View without its translation: applied to eye-relative points.
    taa.relView.copy(c.matrixWorldInverse);
    taa.relView.elements[12] = 0; taa.relView.elements[13] = 0; taa.relView.elements[14] = 0;
    cycle.vp[i].multiplyMatrices(c.projectionMatrix, taa.relView);
    cycle.eye[i].setFromMatrixPosition(c.matrixWorld);
  }
  // Its history: the last finished image; for a full-size one after smaller ones, the last
  // full-size one while that still stands for the view, so what it resolved is not lost to them.
  const d = cycle.detail;
  cycle.hist = plan.m === 1 && d && d !== cycle.shown && detailHolds(d) ? d : cycle.shown;
  for (let i = 0; i < src.length; i++) {
    uAcc.uPrevVP.value[i].copy(cycle.hist.vp[i]);
    taa.prevEye[i].copy(cycle.hist.eye[i]);
  }
  uAcc.uHistSize.value.set(cycle.hist.w, cycle.hist.h);
  cycle.look = lookKey();
  decideAccumulation();
  syncLowCam(src.length);
  cycle.cone = passes.cone;
  updateImageUniforms();
  cycle.pal.index = state.palette; cycle.pal.freq = shared.uColorFreq.value; cycle.pal.phase = shared.uColorPhase.value; cycle.pal.cover = shared.uBackground.value === 5;
  cycle.scale = rig.scale;
  cycle.level = still.level;
  cycle.total = cumulate(cost.cum, cost.rows, currentFractal().iterCost * workAt(still.level, cycle.m), low.eyeW * low.usedH, acc.w * acc.h);
  cycle.gAt = 0;
  cycle.cAt = 0;
  cycle.aAt = 0;
  cycle.frames = 0;
  // A whole image in one frame is a long frame by design.
  if (plan.k === 1) cycle.win.skip = 3;
}

// This frame's share of the image.
function renderImage() {
  cycle.fresh = false;
  if (cycle.hold) return;
  if (taa.reset) cycle.at = 0;
  if (fractalChanged()) { cycle.live = liveVals.join('|'); cycle.edited = performance.now(); }
  // The image in progress is of a fractal since changed, or will not cover the view when it
  // arrives, or the one on show already fails to, and another would be on show soon enough.
  if (cycle.at > 0 && !cycle.force && sliced() && fade.value === 0) {
    const left = cycle.planned - cycle.at;
    const grace = cycle.key !== cycle.live ? 0 : dropWithin(motion, cycle, cycle.shown.has ? cycle.shown : null, rig.lastDE, left * frameSeconds());
    if (left >= 3 && grace >= 0 && planImage().k < left + grace) cycle.at = 0;
  }
  if (cycle.at === 0) beginCycle();
  const n = cycle.at + 1;
  const done = n >= cycle.planned;
  const y = heightAt(cost.cum, n / cycle.planned);
  const g0 = cycle.gAt, g1 = done ? low.usedH : Math.min(low.usedH, Math.ceil(low.usedH * y) + GEO_AHEAD);
  const a0 = cycle.aAt, a1 = done ? acc.h : Math.floor(acc.h * y);
  cycle.gAt = g1;
  cycle.aAt = a1;
  if (g1 > g0 && passes.geo) {
    dbg?.gpuBegin('geo');
    // The cones of these rows first.
    const c0 = cycle.cAt, c1 = Math.ceil(g1 / CONE);
    if (cycle.cone && c1 > c0) {
      coneRT.scissor.set(0, c0, low.coneW * low.eyes, c1 - c0);
      coneRT.scissorTest = true;
      renderer.setRenderTarget(coneRT);
      renderer.render(coneScene, coneCam);
      cycle.cAt = c1;
    }
    gRT.scissor.set(0, g0, low.eyeW * low.eyes, g1 - g0);
    gRT.scissorTest = true;
    renderer.setRenderTarget(gRT);
    renderer.render(geoScene, lowCam);
    dbg?.gpuEnd();
  }
  if (a1 > a0 && passes.acc) {
    const rt = accRT[acc.cur];
    const hist = accRT[cycle.hist.has ? cycle.hist.i : (acc.cur + 1) % 3]; // unread with no history, and not the one drawn to
    uAcc.uHA.value = hist.textures[0];
    uAcc.uHB.value = hist.textures[1];
    rt.scissor.set(0, a0, acc.w * low.eyes, a1 - a0);
    rt.scissorTest = true;
    renderer.setRenderTarget(rt);
    dbg?.gpuBegin('acc');
    renderer.render(accScene, accCam);
    dbg?.gpuEnd();
  }
  cycle.frames++;
  cycle.at = n;
  if (!done) return;
  // Three measurements a second at most: the view's cost moves slower than that.
  if (passes.geo && cost.frame - cost.asked >= COST_EVERY) cost.due = { w: low.eyeW * low.eyes, h: low.usedH, level: cycle.level, m: cycle.m, fractal: state.fractal };
  // The finished image goes on show and becomes the history, with the size and camera it was made for.
  if (passes.acc) {
    const img = images[acc.cur];
    tileDistances(img);
    for (let i = 0; i < low.eyes; i++) {
      img.vp[i].copy(cycle.vp[i]);
      img.eye[i].copy(cycle.eye[i]);
      img.cam[i].matrixWorld.copy(cycle.cam[i].matrixWorld);
      img.cam[i].projectionMatrix.copy(cycle.cam[i].projectionMatrix);
    }
    img.w = acc.w; img.h = acc.h; img.m = cycle.m;
    img.key = cycle.key; img.level = cycle.level; img.scale = cycle.scale; img.look = cycle.look;
    img.q.copy(cycle.q);
    img.p.copy(cycle.p);
    img.wider = cycle.wider;
    img.near = cycle.near;
    Object.assign(img.pal, cycle.pal);
    img.has = true;
    cycle.shown = img;
    if (cycle.m === 1) cycle.detail = img;
    // The next is drawn over neither.
    acc.cur = images.find((o) => o !== img && o !== cycle.detail).i;
  }
  taa.frame++;
  cycle.fresh = cycle.frames === 1 && !cycle.anchored; // made this frame, from this frame's eyes
  cycle.len = cycle.frames;
  cycle.at = 0;
  cycle.whole = false;
}

// The least and greatest distance the image just finished holds, by tile.
function tileDistances(img) {
  const tw = Math.ceil(acc.w / NEAR_TILE), th = Math.ceil(acc.h / NEAR_TILE);
  uNear.uHA.value = accRT[img.i].textures[0];
  uNear.uNear.value = img.tileRT[0].texture;
  uNear.uAcc.value.set(acc.w, acc.h);
  uNear.uTiles.value.set(tw, th);
  img.tiles.set(tw, th);
  dbg?.gpuBegin('near');
  for (let i = 0; i < 2; i++) {
    img.tileRT[i].scissor.set(0, 0, tw * low.eyes, th);
    img.tileRT[i].scissorTest = true;
    renderer.setRenderTarget(img.tileRT[i]);
    renderer.render(i === 0 ? nearScene : nearWideScene, accCam);
  }
  dbg?.gpuEnd();
}

// Whether the last full-size image still stands for the view: the same fractal at the same
// scale under the same light, and the head not far from the one it was made for.
function detailHolds(d) {
  if (!d.has || d.key !== cycle.live || d.look !== lookKey() || fade.value > 0) return false;
  if (Math.abs(Math.log(rig.scale / d.scale)) > 1e-6) return false;
  headFrom(motion, d);
  if (motion._o.length() > tune.detailTurn) return false;
  return !(isFinite(d.near) && d.near > 0) || motion._s.length() <= tune.detailSpan * d.near;
}

const skewDir = new THREE.Vector3();
// What is on show, from this frame's eyes: the last finished image.
function showImage() {
  const img = cycle.shown, src = eyeCameras();
  const rt = accRT[img.i];
  uShow.uEyes.value = src.length;
  uShow.uReproject.value = cycle.fresh ? 0 : 1;
  uShow.uHA.value = rt.textures[0];
  uShow.uHC.value = rt.textures[2];
  uShow.uAccSize.value.set(img.w, img.h);
  uShow.uNear.value = img.tileRT[1].texture;
  uShow.uTiles.value.copy(img.tiles);
  // The nearest anything in the image may be to this frame's eyes: the surface nearest the
  // head it was made for, less how far its eyes are from that head and these from them.
  let apart = 0;
  for (let i = 0; i < src.length; i++) {
    uShow.uShownVP.value[i].copy(img.vp[i]);
    const delta = uShow.uShownDelta.value[i].setFromMatrixPosition(src[i].matrixWorld).sub(img.eye[i]);
    if (cycle.skew && isFinite(img.near)) delta.addScaledVector(skewDir.setFromMatrixColumn(src[i].matrixWorld, 0).normalize(), cycle.skew * img.near);
    apart = Math.max(apart, img.eye[i].distanceTo(img.p) + delta.length());
  }
  const near = img.near;
  uShow.uNearInv.value = isFinite(near) && near > 0 ? 1 / Math.max(0.9 * near - apart, 0.1 * near) : 0;
  // The palette as it is now, over the light the image holds: colours turn at the display's rate.
  const was = img.pal, phase = state.colorPhase + colorPhaseAcc;
  const re = was.index !== state.palette || was.freq !== state.colorFreq || was.phase !== phase;
  uShow.uRecolour.value = re ? 1 : 0;
  if (re) {
    const a = PALETTES[was.index];
    uShow.uWasA.value.fromArray(a.a); uShow.uWasB.value.fromArray(a.b); uShow.uWasC.value.fromArray(a.c); uShow.uWasD.value.fromArray(a.d);
    uShow.uWasArg.value.set(was.freq, was.phase);
  }
  headFrom(motion, img);
  img.turned = motion._o.length();
  img.shifted = isFinite(near) && near > 0 ? motion._s.length() / near : 0;
  uShow.uCover.value = img.pal.cover ? 1 : 0;
  const b = currentPalette();
  uShow.uNowA.value.fromArray(b.a); uShow.uNowB.value.fromArray(b.b); uShow.uNowC.value.fromArray(b.c); uShow.uNowD.value.fromArray(b.d);
  uShow.uNowArg.value.set(state.colorFreq, state.colorPhase + colorPhaseAcc);
}

// The plane's budget, by the rule of updateBudget, over the frames that follow plane work: a
// late frame after an idle one is not the plane's doing.
function updatePlaneBudget(dt) {
  if (!state.dynamicRes || !renderer.xr.isPresenting) return;
  const c = planeCtl;
  if (renderer.xr.getSession().visibilityState !== 'visible') { c.n = 0; c.over = 0; c.skip = BUDGET_WINDOW / 2; return; }
  if (c.skip > 0) { c.skip--; return; }
  if (plane.stats.units < 0.25 * plane.stats.budget) return;
  c.n++;
  if (dt > 1.25 * frameSeconds()) c.over++;
  if (c.n < BUDGET_WINDOW && c.over < BUDGET_WINDOW / 4) return;
  const late = c.over / c.n;
  c.n = 0; c.over = 0;
  if (late > 0.12) {
    c.budget = Math.max(PLANE_MIN, c.budget * THREE.MathUtils.clamp(1 - late, 0.6, 0.9));
    if (c.probed) c.patience = Math.min(c.patience * 2, 16);
    c.probed = false;
    c.good = 0;
  } else if (late <= 0.06) {
    if (c.probed) { c.patience = Math.max(2, c.patience / 2); c.probed = false; }
    if (++c.good >= c.patience && c.budget < PLANE_MAX) { c.budget = Math.min(PLANE_MAX, c.budget * 1.12); c.good = 0; c.probed = true; }
  }
}

function updateDynamicRes(dt) {
  dyn.scale = state.resScale;
  if (currentFractal().kind === '3d') updateBudget(dt); else updatePlaneBudget(dt);
}

let settingsStableSince = 0;
let lastSettingsKey = '';
function ensureRenderTargets(now) {
  renderer.getDrawingBufferSize(fbSize);
  const eyes = eyeCount();
  const sizeKey = `${fbSize.x}x${fbSize.y}x${eyes}`;
  const settingsKey = `${state.resScale}|${state.histScale}`;
  const key = `${sizeKey}|${settingsKey}`;
  // A framebuffer change (session start) reallocates at once; sliders would reallocate
  // every frame while dragging, so their values must settle first.
  if (settingsKey !== lastSettingsKey) { lastSettingsKey = settingsKey; settingsStableSince = now; }
  if (gRT && key === low.allocKey) return;
  if (gRT && low.allocKey.startsWith(sizeKey) && now - settingsStableSince < 300) return;
  const eyeWMax = Math.max(8, Math.round(fbSize.x / eyes * state.resScale));
  const h = Math.max(8, Math.round(fbSize.y * state.resScale));
  const half = { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, depthBuffer: false, stencilBuffer: false };
  if (gRT) { gRT.dispose(); coneRT.dispose(); }
  gRT = new THREE.WebGLRenderTarget(eyeWMax * eyes, h, { ...half, count: 2 });
  coneRT = new THREE.WebGLRenderTarget(Math.ceil(eyeWMax / CONE) * eyes, Math.ceil(h / CONE), { ...half, format: THREE.RGFormat });
  uGeo.uClear.value = coneRT.texture;
  acc.fullW = Math.max(8, Math.round(fbSize.x / eyes * state.histScale));
  acc.fullH = Math.max(8, Math.round(fbSize.y * state.histScale));
  low.eyes = eyes;
  for (const img of images) {
    const i = img.i;
    if (accRT[i]) accRT[i].dispose();
    accRT[i] = new THREE.WebGLRenderTarget(acc.fullW * eyes, acc.fullH, { ...half, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, count: 3 });
    accRT[i].textures[2].type = THREE.UnsignedByteType; // the colour image
    for (let j = 0; j < 2; j++) {
      if (img.tileRT[j]) img.tileRT[j].dispose();
      img.tileRT[j] = new THREE.WebGLRenderTarget(Math.ceil(acc.fullW / NEAR_TILE) * eyes, Math.ceil(acc.fullH / NEAR_TILE), half);
    }
  }
  taa.reset = true;
  cycle.at = 0;
  cycle.whole = true;
  low.allocScale = state.resScale;
  low.allocKey = key;
  uAcc.uGA.value = gRT.textures[0];
  uAcc.uGB.value = gRT.textures[1];
}

function updateLowRect() {
  const eyes = eyeCount();
  const k = cycle.m;
  low.eyes = eyes;
  low.eyeW = Math.max(4, Math.floor(gRT.width / eyes * k));
  low.usedH = Math.max(4, Math.floor(gRT.height * k));
  low.coneW = Math.ceil(low.eyeW / CONE);
  low.coneH = Math.ceil(low.usedH / CONE);
  uCone.uSpan.value.set(low.coneW * CONE / low.eyeW, low.coneH * CONE / low.usedH);
  uCone.uConeNdc.value = CONE * Math.hypot(1 / low.eyeW, 1 / low.usedH);
  uAcc.uLowUsed.value.set(low.eyeW * eyes, low.usedH);
  uAcc.uEyes.value = eyes;
}

// Halton (2,3) sub-pixel offsets in [-0.5, 0.5).
const HALTON = Array.from({ length: 16 }, (_, i) => {
  const h = (idx, base) => { let r = 0, f = 1, n = idx; while (n > 0) { f /= base; r += f * (n % base); n = Math.floor(n / base); } return r; };
  return [h(i + 1, 2) - 0.5, h(i + 1, 3) - 0.5];
});
const taa = { frame: 0, reset: true, valid: false, prevEye: [new THREE.Vector3(), new THREE.Vector3()], relView: new THREE.Matrix4() };

// The geometry cameras and the accumulate pass's camera terms, from the image's cameras.
function syncLowCam(n) {
  const src = cycle.cam.slice(0, n);
  while (lowCam.cameras.length < src.length) {
    const c = new THREE.PerspectiveCamera();
    c.viewport = new THREE.Vector4();
    c.matrixWorldAutoUpdate = false;
    lowCam.cameras.push(c);
    const k = new THREE.PerspectiveCamera();
    k.viewport = new THREE.Vector4();
    k.matrixWorldAutoUpdate = false;
    coneCam.cameras.push(k);
  }
  lowCam.cameras.length = coneCam.cameras.length = src.length;
  const override = typeof taa.jitterOverride === 'function' ? taa.jitterOverride(taa.frame) : taa.jitterOverride;
  const jit = state.taa && taa.valid ? (override || HALTON[taa.frame % HALTON.length]) : [0, 0];
  uAcc.uJitter.value.set(jit[0] * 2 / low.eyeW, jit[1] * 2 / low.usedH);
  for (let i = 0; i < src.length; i++) {
    const s = src[i], c = lowCam.cameras[i];
    c.matrixWorld.copy(s.matrixWorld);
    c.matrixWorldInverse.copy(s.matrixWorldInverse);
    c.projectionMatrix.copy(s.projectionMatrix);
    // Unjittered camera terms for the accumulate pass; the sample grid is offset by the jitter.
    const pe = s.projectionMatrix.elements;
    uAcc.uProj.value[i].set(pe[0], pe[5], pe[8], pe[9]);
    uAcc.uInvView.value[i].setFromMatrix4(s.matrixWorld);
    uAcc.uEye.value[i].setFromMatrixPosition(s.matrixWorld);
    // Eye motion since the previous frame, in double, for the eye-relative reprojection.
    uAcc.uEyeDelta.value[i].copy(uAcc.uEye.value[i]).sub(taa.prevEye[i]);
    c.projectionMatrix.elements[8] += jit[0] * 2 / low.eyeW;
    c.projectionMatrix.elements[9] += jit[1] * 2 / low.usedH;
    c.projectionMatrixInverse.copy(c.projectionMatrix).invert();
    c.viewport.set(i * low.eyeW, 0, low.eyeW, low.usedH);
    const k = coneCam.cameras[i];
    k.matrixWorld.copy(c.matrixWorld);
    k.matrixWorldInverse.copy(c.matrixWorldInverse);
    k.projectionMatrix.copy(c.projectionMatrix);
    k.projectionMatrixInverse.copy(c.projectionMatrixInverse);
    k.viewport.set(i * low.coneW, 0, low.coneW, low.coneH);
  }
}

// What an image's light depends on beyond the fractal itself: a full-size image made under
// another does not stand for the view.
const lookKey = () => `${state.background}|${state.lightMode}|${state.ambient}`;

// History is only valid while the geometry is a function of the same inputs: cycle.hist is the
// finished image it is taken from.
function decideAccumulation() {
  cycle.key = cycle.live;
  const h = cycle.hist;
  taa.valid = state.taa && h.has && cycle.key === h.key && fade.value === 0;
  let w = taa.valid ? 1 : 0;
  // Zooming changes the footprint the surface was sampled at: keep the history as a prior.
  const zoomStep = h.has ? Math.abs(Math.log(rig.scale / h.scale)) : 0;
  w *= Math.exp(-zoomStep * 20);
  // Better samples should take over quickly; the coarser history only seeds them.
  if (still.level > h.level) w *= 0.25;
  w *= Math.min(1, (h.w * h.h) / (acc.w * acc.h));
  uAcc.uWScale.value = w;
}

// ---------------------------------------------------------------- stillness and quality levels

// 3D: the room has not moved and parameters are unchanged. The head is free to look about: a
// turn is the image planner's to cover, and takes nothing from what the surface is made with.
// 2D: the view (centre, scale, rotation) and parameters are unchanged.
const still = { key: '', t: 0, level: 0, cap2d: 0 };
const LEVEL_T = [0, 0.3, 1.0];
const LEVEL_STEPS = [1, 1.5, 2];
const LEVEL_EPS = [1, 0.5, 0.25];
const LEVEL_NORMAL = [1.0, 0.75, 0.5];
const LEVEL_AO = [3, 4, 6];

function updateStillness(dt) {
  const f = currentFractal();
  let key;
  if (f.kind === '3d') {
    // Quantised so sub-millimetre settling does not count as motion.
    const p = rig.dolly.position, r = rig.dolly.quaternion;
    const q = 1e-4 * rig.scale;
    key = [state.fractal, Object.values(state.params).join(','), Math.round(p.x / q), Math.round(p.y / q), Math.round(p.z / q),
      Math.round(r.x * 1e5), Math.round(r.y * 1e5), Math.round(r.z * 1e5), Math.round(r.w * 1e5), Math.round(Math.log(rig.scale) * 500)].join('|');
  } else {
    key = [state.fractal, Object.values(state.params).join(','), view2d.cx[0], view2d.cx[1], view2d.cy[0], view2d.cy[1], view2d.scale, view2d.rot, state.layout2d, state.julia].join('|');
  }
  const moving = key !== still.key || sculpt.active || fade.value > 0;
  still.key = key;
  still.t = moving ? 0 : still.t + dt;
  let level = 0;
  if (state.refine) for (let i = 1; i < LEVEL_T.length; i++) if (still.t >= LEVEL_T[i]) level = i;
  still.level = level;
  // 2D iteration cap the plane refines to once the view has held still: what its probes say a
  // still view needs, under the menu's ceiling; the ceiling itself with adapting off. The
  // view's own cap as soon as it moves, and while no probe has said.
  const top = !state.iterAuto ? state.maxIter : plane.need.still > 0 ? Math.min(state.maxIter, plane.need.still) : view2d.maxIter;
  still.cap2d = moving || still.t < 0.5 || !state.refine ? view2d.maxIter : Math.max(view2d.maxIter, top);
}

// ---------------------------------------------------------------- controllers, panel, markers

const modelFactory = new XRControllerModelFactory();
const hands = { left: null, right: null };
const controllerModels = [];
for (let i = 0; i < 2; i++) {
  const ray = renderer.xr.getController(i);
  const grip = renderer.xr.getControllerGrip(i);
  const model = modelFactory.createControllerModel(grip);
  controllerModels.push(model);
  grip.add(model);
  rig.dolly.add(ray, grip);
  ray.addEventListener('connected', (e) => {
    const h = e.data.handedness;
    if (h === 'left' || h === 'right') { hands[h].ray = ray; hands[h].grip = grip; ray.userData.hand = h; }
  });
}
hands.left = { ray: renderer.xr.getController(0), grip: renderer.xr.getControllerGrip(0) };
hands.right = { ray: renderer.xr.getController(1), grip: renderer.xr.getControllerGrip(1) };

// Hands draw after the overlays and depth-test against them. The glTF loads asynchronously.
function tagControllerModels() {
  for (const m of controllerModels) {
    if (m.userData.tagged) continue;
    let found = false;
    m.traverse((o) => { if (o.isMesh) { o.renderOrder = 200; found = true; } });
    if (found) m.userData.tagged = true;
  }
}

loadFonts(import.meta.env.BASE_URL).catch((e) => console.error('the brand faces did not load; the windows stay blank', e));
const hud = new Hud();
const hint = startHint();
rig.camera.add(hud.mesh);
const handLabels = { left: new HandLabel() };
const controls = new ControlsPanel();
controls.onClose = () => { state.controlsOpen = false; notify('controlsOpen'); keep('controlsOpen'); };
rig.dolly.add(controls.mesh);

const teleportMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), overlayMaterial({ color: 0x9fb4ff }));
teleportMarker.renderOrder = OVERLAY_ORDER;
teleportMarker.visible = false;
scene.add(teleportMarker);
const grabMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), overlayMaterial({ color: 0xffd080 }));
grabMarker.renderOrder = OVERLAY_ORDER;
grabMarker.visible = false;
scene.add(grabMarker);
const aimLine = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
  new THREE.LineBasicMaterial({ color: 0xffd080, depthTest: true, depthFunc: THREE.AlwaysDepth, depthWrite: true }));
aimLine.renderOrder = OVERLAY_ORDER;
aimLine.visible = false;
rig.dolly.add(aimLine);

// ---------------------------------------------------------------- tools

const ballGun = new BallGun(scene);
const bookmarks = new Bookmarks();
const quick = new ListPanel({ title: 'quick menu' });
quick.mesh.position.set(0, 0.14, -0.06);
quick.mesh.rotation.x = -0.55;
// Camera tool: a frame in front of the eyes while aiming, a print at the hand afterwards.
const viewfinder = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(0.5, 0.375)),
  new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: true, depthFunc: THREE.AlwaysDepth, depthWrite: true }));
viewfinder.renderOrder = OVERLAY_ORDER;
viewfinder.position.z = -1;
viewfinder.visible = false;
rig.camera.add(viewfinder);
const photo = { rt: null, scene: new THREE.Scene(), mesh: null, cam: new THREE.PerspectiveCamera(), print: null, until: 0, status: '', count: 0 };
photo.cam.matrixWorldAutoUpdate = false;
photo.print = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.18), overlayMaterial({ color: 0xffffff }));
photo.print.renderOrder = OVERLAY_ORDER;
photo.print.position.set(0, 0.16, -0.08);
photo.print.rotation.x = -0.55;
photo.print.visible = false;
const tools = {
  holding: false, use: false, useDown: false, useUp: false, useArmed: false,
  quickOpen: false, quickArmed: false, quickT: 0, quickMoved: false, quickPalette: 0, sculptArmed: false, fireT: 0, label: '', labelUntil: 0,
  consumed: { left: false, right: false }, // trigger presses spent on closing the menu
  nav: { qy: { armed: true, t: 0 }, qx: { armed: true, t: 0 } },
};
const QUICK_TAP = 0.35; // seconds: a right trigger let go sooner, the stick not touched, was not a choice
const QUICK_ACTIONS = [
  { name: 'tour: sit back, be taken places', run: () => app.tour() },
  { name: 'reset view', run: () => app.resetView() },
  { name: 'cruise on / off', run: () => cruiseLatch(0) },
  { name: 'next 2D layout', run: () => { state.layout2d = (state.layout2d + 1) % LAYOUTS_2D.length; notify('layout2d'); keep('layout2d'); app.recenter(); } },
  { name: 'next background', run: () => { state.background = (state.background + 1) % BACKGROUNDS.length; notify('background'); keep('background'); } },
  { name: 'clear balls', run: () => ballGun.clear() },
  { name: 'remove last bookmark', run: () => { if (bookmarks.list.length) bookmarks.remove(bookmarks.list.length - 1); } },
  ...(REPORTS ? [{ name: 'save report (views, state, head trace)', run: () => { saveReport().catch(() => {}); } }] : []), // errors are logged and shown by saveReport
];

// ---------------------------------------------------------------- app actions (used by the menu)

let colorPhaseAcc = 0;
const PHASE_WRAP = 2; // every palette repeats within two turns of its phase: their rates are halves
const surfFrame = new THREE.Matrix4();
const fade = { value: 0, target: 0, onBlack: null };
const perf = { fps: 0, ms: 0, acc: 0, n: 0, window: 0 };
const headTrace = new HeadTrace();
const headMotion = new HeadMotion();
const deskHead = new THREE.Vector3(0, 1.6, 0); // desktop head position (room)

const PLACE = ['fractal', 'params', 'colorFreq', 'colorPhase', 'armLength', 'fall', 'panelOpen']; // not settings: where one is
const app = {
  togglePanel(open) {
    if (open === undefined && state.panelOpen && !panelInView()) { placePanels(); return; }
    state.panelOpen = open ?? !state.panelOpen;
    dbg?.event('menu', { open: state.panelOpen });
    panel.mesh.visible = state.panelOpen;
    controls.mesh.visible = state.panelOpen && state.controlsOpen;
    if (state.panelOpen) { placePanels(); hint.fade(); }
  },
  selectFractal(i) {
    setFractal(i);
    cost.rows.fill(WORK_START); cost.work = WORK_START; cost.level = 0; cost.m = 1; cost.due = null; cost.asked = -1e9;
    const f = currentFractal();
    if (f.kind === '3d') {
      screenMesh.material = matShow;
      rig.reset(f);
    } else {
      screenMesh.material = mat2d;
      view2d.home(f);
      rig.reset({ start: [0, 0, 0] });
      app.recenter();
      plane.reset();
    }
    state.fall = false;
  },
  tour() { if (tour.on) endTour('asked'); else startTour(); },
  version() { return [`${version}   build ${__BUILD__.sha}${__BUILD__.dirty ? ' (modified)' : ''}`]; },
  describeSettings() {
    const n = kept().length;
    return ['how you fly and turn, the light, palette, 2D layout,', 'background and where the windows sit stay as you set', `them between visits: ${n ? `${n} kept` : 'none yet'}`];
  },
  // Every setting as the build has it, and nothing kept. The place and its colours stay.
  defaultSettings() {
    if (tour.on) endTour('settings');
    forget();
    for (const key of Object.keys(DEFAULTS)) {
      if (PLACE.includes(key) || state[key] === DEFAULTS[key]) continue;
      // A passthrough session's background is its own: what it puts back is the default.
      if (key === 'background' && arBackground !== null) { arBackground = DEFAULTS.background; continue; }
      state[key] = DEFAULTS[key];
      if (key === 'palette') setPalette(state.palette); else notify(key);
      if (key === 'layout2d') app.recenter();
    }
  },
  resetView() {
    const f = currentFractal();
    if (f.kind === '3d') {
      rig.reset(f);
      // The size too: the start is no start with the surface held at the nose.
      if (state.armLength !== ARM) { state.armLength = ARM; notify('armLength'); }
    } else { view2d.home(f); app.recenter(); }
  },
  recenter() {
    // Surfaces face the way the head is looking, centred under it.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion);
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    surfFrame.makeRotationY(yaw).setPosition(rig.camera.position.x, 0, rig.camera.position.z);
    u2d.uSurfFromRoom.value.copy(surfFrame).invert();
    u2d.uRoomFromSurf.value.copy(surfFrame);
  },
  jumpToTarget(t) {
    const idx = FRACTALS.findIndex((f) => f.formula === t.formula);
    if (state.fractal !== idx) app.selectFractal(idx);
    view2d.setTarget(t);
    view2d.scale = 1.4;
    setCruise(true, Math.abs(state.fallRate) || CRUISE_START);
  },
  frameRates() {
    const s = renderer.xr.getSession();
    return s && s.supportedFrameRates ? Array.from(s.supportedFrameRates) : [];
  },
  currentFrameRate() {
    const s = renderer.xr.getSession();
    return s ? s.frameRate : 0;
  },
  setFrameRate(r) {
    const s = renderer.xr.getSession();
    if (!s || !s.updateTargetFrameRate || !r) return;
    const rates = app.frameRates();
    if (rates.length && !rates.includes(r)) return;
    s.updateTargetFrameRate(r).catch((e) => console.error('frame rate', e));
  },
  describe() {
    const f = currentFractal();
    const h = rig.headWorld();
    const lines = [
      `${perf.fps.toFixed(0)} fps   ${perf.ms.toFixed(1)} ms/frame   ${app.currentFrameRate() || '-'} Hz`,
      `${f.name}   still ${still.t.toFixed(1)} s   tool ${TOOLS[state.tool].name}   ${BACKGROUNDS[state.background]}`,
    ];
    if (tour.on) lines.push(`tour: ${tour.stop.name}, ${Math.round(tour.t)} s`);
    if (state.fall) lines.push(`cruise ${state.fallRate < 0 ? 'out' : 'in'} at ${Math.abs(state.fallRate).toFixed(2)} doublings/s`);
    if (f.kind === '3d') {
      lines.push(`samples ${low.eyeW * low.eyes}x${low.usedH}  history ${acc.w * low.eyes}x${acc.h}  fb ${fbSize.x}x${fbSize.y}`);
      lines.push(`image at ${Math.round(cycle.m * 100)}% over ${cycle.len} frame${cycle.len === 1 ? '' : 's'}`);
      lines.push(`quality level ${still.level}: steps x${LEVEL_STEPS[still.level]}, footprint x${LEVEL_EPS[still.level] * state.grain}`);
      lines.push(`zoom ${(1 / rig.scale).toExponential(2)}x   scale ${rig.scale.toExponential(2)}`);
      lines.push(`head ${h.x.toFixed(4)} ${h.y.toFixed(4)} ${h.z.toFixed(4)}`);
      lines.push(`surface ${(rig.lastDE / rig.scale).toFixed(3)} m away (${rig.lastDE.toExponential(2)} units)`);
    } else {
      lines.push(plane.describe());
      lines.push(`cap ${still.cap2d} (base ${view2d.maxIter})   budget ${(planeCtl.budget / 1e6).toFixed(2)}M   fb ${fbSize.x}x${fbSize.y}`);
      lines.push(...view2d.describe());
    }
    return lines;
  },
  describe2d() { return [...view2d.describe(), plane.describe(), `cap ${still.cap2d}`]; },
  describeBookmarks() {
    const l = bookmarks.list;
    if (!l.length) return ['none yet'];
    return l.slice(-6).map((b) => b.name).concat(l.length > 6 ? [`and ${l.length - 6} more`] : []);
  },
  bookmark() { const e = captureBookmark(); bookmarks.add(e); notify('bookmarks'); },
  clearBookmarks() { bookmarks.clear(); notify('bookmarks'); },
  clearBalls() { ballGun.clear(); },
};

const panel = buildMenu(app, (src, dst, box, pos) => renderer.copyTextureToTexture(src, dst, box, pos));
rig.dolly.add(panel.mesh);
const pointers = new Pointers({ rig, hands, panels: [panel, controls], domElement: renderer.domElement });

// Is the menu within about 75 degrees of where the head points (room space)?
function panelInView() {
  const cam = rig.camera;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  fwd.y = 0;
  const to = panel.mesh.position.clone().sub(cam.position);
  to.y = 0;
  if (fwd.lengthSq() < 1e-6 || to.lengthSq() < 1e-6) return true;
  return fwd.normalize().dot(to.normalize()) > Math.cos(THREE.MathUtils.degToRad(75));
}

// A place in the room a window may come back to: in view, and within reach of a ray.
function placeUsable(at) {
  const cam = rig.camera;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  fwd.y = 0;
  const to = new THREE.Vector3().fromArray(at).sub(cam.position);
  const rise = to.y;
  to.y = 0;
  const far = to.length();
  if (fwd.lengthSq() < 1e-6 || far < 0.3 || far > 3 || Math.abs(rise) > 1.5) return false;
  return fwd.normalize().dot(to.normalize()) > Math.cos(THREE.MathUtils.degToRad(75));
}

// A window comes back where it was last put down in the room, while that is in view. Else the
// menu 1.3 m ahead at chest height, and the controls map beside the menu. Both face the head.
function placePanels() {
  const cam = rig.camera;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const put = (mesh, at, fresh) => {
    if (mesh.parent !== rig.dolly) rig.dolly.attach(mesh);
    if (at && placeUsable(at)) mesh.position.fromArray(at); else fresh();
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(cam.position.x, mesh.position.y, cam.position.z), mesh.position, new THREE.Vector3(0, 1, 0)));
  };
  put(panel.mesh, state.menuAt, () => panel.mesh.position.copy(cam.position).addScaledVector(fwd, 1.3).setY(cam.position.y - 0.25));
  put(controls.mesh, state.controlsAt, () => {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(panel.mesh.quaternion), behind = new THREE.Vector3(0, 0, -1).applyQuaternion(panel.mesh.quaternion);
    controls.mesh.position.copy(panel.mesh.position).addScaledVector(right, (panel.meters + controls.meters) / 2 + 0.08).addScaledVector(behind, 0.1);
  });
}

pointers.log = (kind, data) => dbg?.event(kind, data);
pointers.onPress = (hand) => input.pulse(hand, 0.5, 12);
// A window put down is where it opens next.
pointers.onMoved = (p) => {
  const key = p === panel ? 'menuAt' : 'controlsAt';
  state[key] = p.mesh.position.toArray().map((v) => Math.round(v * 1000) / 1000);
  notify(key);
  keep(key);
};

// The hands at the windows, for telemetry: each ray in the room (origin, direction), its
// trigger, and the point used with the window it is on.
function aimFrame(intent) {
  if (!state.panelOpen || !intent.xr) return null;
  const out = {}, d = new THREE.Vector3();
  for (const h of ['left', 'right']) {
    const ray = hands[h].ray, a = pointers.aim[h];
    d.set(0, 0, -1).applyQuaternion(ray.quaternion);
    out[h[0]] = [...ray.position.toArray(), d.x, d.y, d.z].map((v) => Math.round(v * 1e4) / 1e4)
      .concat([Math.round(intent.trigger[h].value * 100) / 100, a ? a.panel.title[0] : null, a ? Math.round(a.x) : null, a ? Math.round(a.y) : null]);
  }
  return out;
}

onChange((key) => {
  if (key === 'fractal') panel.rebuild(); else panel.markAll();
  if (key === 'frameRate') app.setFrameRate(state.frameRate);
  if (key === 'controlsOpen') controls.mesh.visible = state.panelOpen && state.controlsOpen;
  if (key === 'resScale') dyn.scale = Math.min(dyn.scale, state.resScale);
  if (key === 'ffr') renderer.xr.setFoveation(state.ffr);
});

let arBackground = null; // background in use before a passthrough session
renderer.xr.addEventListener('sessionstart', () => {
  dyn.scale = state.resScale;
  Object.assign(planeCtl, { n: 0, over: 0, good: 0, patience: 2, probed: false, skip: 0 });
  cycle.budgets.fill(0);
  for (const c of cycle.ctl) { c.good = 0; c.patience = 2; c.probed = false; }
  cycle.win.n = 0; cycle.win.over = 0; cycle.win.skip = 0;
  perf.window = 0; perf.acc = 0; perf.n = 0; perf.fps = 0;
  app.setFrameRate(state.frameRate);
  // An AR session composites over the camera feed: show it where the background would be,
  // and put the previous background back when the session ends.
  const blend = renderer.xr.getSession().environmentBlendMode;
  if (blend && blend !== 'opaque') {
    arBackground = state.background;
    state.background = BACKGROUNDS.indexOf('passthrough');
    notify('background');
  }
  panel.rebuild();
});
renderer.xr.addEventListener('sessionend', () => {
  if (arBackground !== null) {
    if (state.background === BACKGROUNDS.indexOf('passthrough')) { state.background = arBackground; notify('background'); }
    arBackground = null;
  }
  rig.camera.fov = 75;
  rig.camera.aspect = innerWidth / innerHeight;
  rig.camera.updateProjectionMatrix();
  panel.rebuild();
});

// ---------------------------------------------------------------- desktop look

let yaw = 0, pitch = 0;
renderer.domElement.addEventListener('click', () => {
  if (renderer.xr.isPresenting || pointers.mouseOnPanel(rig.camera)) return;
  if (state.panelOpen) app.togglePanel(false);
  else renderer.domElement.requestPointerLock();
});
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * 0.002;
  pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.002, -1.55, 1.55);
});
addEventListener('resize', () => {
  rig.camera.aspect = innerWidth / innerHeight;
  rig.camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- 2D surface geometry in JS (teleport aim, gaze)

function surfaceHit(ro, rd) {
  const L = state.layout2d;
  const HEAD_Y = 1.6;
  const planeT = (axis, v) => { const t = (v - ro[axis]) / rd[axis]; return t > 0 ? t : -1; };
  const at = (t) => ro.clone().addScaledVector(rd, t);
  if (L === 0) {
    const t = planeT('y', 0);
    if (t < 0) return null;
    const p = at(t);
    return { t, p, uv: [p.x, -p.z] };
  }
  if (L === 1) {
    const t = planeT('z', -2.5);
    if (t < 0) return null;
    const p = at(t);
    return { t, p, uv: [p.x, p.y - HEAD_Y] };
  }
  if (L === 2) {
    const o = ro.clone().sub(new THREE.Vector3(0, HEAD_Y, 0));
    const b = o.dot(rd);
    const h = b * b - (o.lengthSq() - 16);
    if (h < 0) return null;
    const t = -b + Math.sqrt(h);
    const p = at(t);
    const d = p.clone().sub(new THREE.Vector3(0, HEAD_Y, 0)).normalize();
    const f = -d.z;
    return { t, p, uv: [2 * d.x / Math.max(1 + f, 1e-4), 2 * d.y / Math.max(1 + f, 1e-4)] };
  }
  if (L === 3) {
    const ox = ro.x, oy = ro.y - HEAD_Y;
    const A = rd.x * rd.x + rd.y * rd.y, B = ox * rd.x + oy * rd.y, C = ox * ox + oy * oy - 2.25;
    const h = B * B - A * C;
    if (h < 0 || A < 1e-12) return null;
    const t = (-B + Math.sqrt(h)) / A;
    if (t <= 0) return null;
    const p = at(t);
    const theta = Math.atan2(p.y - HEAD_Y, p.x);
    const r = Math.pow(2, THREE.MathUtils.clamp(p.z / state.tunnelL, -60, 60));
    return { t, p, uv: [r * Math.cos(theta), r * Math.sin(theta)] };
  }
  const A = rd.x * rd.x + rd.z * rd.z, B = ro.x * rd.x + ro.z * rd.z, C = ro.x * ro.x + ro.z * ro.z - 9;
  const h = B * B - A * C;
  if (h < 0 || A < 1e-12) return null;
  const t = (-B + Math.sqrt(h)) / A;
  if (t <= 0) return null;
  const p = at(t);
  return { t, p, uv: [Math.atan2(p.x, -p.z) * 3, p.y - HEAD_Y] };
}

// Surface-space ray from a world origin and direction.
function toSurface(origin, dir) {
  const inv = rig.dolly.matrixWorld.clone().invert();
  const ro = origin.clone().applyMatrix4(inv).applyMatrix4(u2d.uSurfFromRoom.value);
  const rd = dir.clone().transformDirection(inv).transformDirection(u2d.uSurfFromRoom.value).normalize();
  return { ro, rd };
}

// Complex number (double-double) under the head's forward ray; the pyramid centres there.
const gaze = { c: null };
function updateGaze() {
  const origin = rig.camera.getWorldPosition(new THREE.Vector3());
  const dir = rig.camera.getWorldDirection(new THREE.Vector3());
  const { ro, rd } = toSurface(origin, dir);
  const hit = surfaceHit(ro, rd);
  if (!hit || !isFinite(hit.uv[0]) || !isFinite(hit.uv[1])) { if (!gaze.c) gaze.c = [view2d.cx, view2d.cy]; return; }
  const c = Math.cos(view2d.rot), s = Math.sin(view2d.rot);
  const [u, v] = hit.uv;
  // Far points on the tunnel or the horizon would put the fine levels nowhere useful.
  const r = Math.hypot(u, v);
  const k = r > 64 ? 64 / r : 1;
  gaze.c = [ddAddD(view2d.cx, (c * u - s * v) * k * view2d.scale), ddAddD(view2d.cy, (s * u + c * v) * k * view2d.scale)];
}

// The smallest stretch of the fractal's surface a pixel covers, metres: the plane keeps no
// level finer than that in step. Sampled over one eye's view, a few times a second.
const footprint = { rho: 1e-3, frame: 0, m: new THREE.Matrix4(), o: new THREE.Vector3(), d: new THREE.Vector3() };
const FOOT_GRID = 7, FOOT_EVERY = 8;
function updateFootprint() {
  const F = footprint;
  if (F.frame++ % FOOT_EVERY) return;
  const cam = eyeCameras()[0];
  // World to surface.
  F.m.copy(rig.dolly.matrixWorld).invert().premultiply(u2d.uSurfFromRoom.value);
  const ro = F.o.setFromMatrixPosition(cam.matrixWorld).applyMatrix4(F.m).clone();
  const at = (x, y) => {
    F.d.set(x, y, 0.5).applyMatrix4(cam.projectionMatrixInverse).applyMatrix4(cam.matrixWorld).applyMatrix4(F.m).sub(ro).normalize();
    const hit = surfaceHit(ro, F.d);
    return hit && isFinite(hit.uv[0]) && isFinite(hit.uv[1]) ? hit.uv : null;
  };
  const px = 2 / (fbSize.x / low.eyes), py = 2 / fbSize.y;
  let rho = Infinity;
  for (let j = 0; j < FOOT_GRID; j++) {
    for (let i = 0; i < FOOT_GRID; i++) {
      // Inward by a pixel at the far edges, for the neighbours to be in view.
      const x = (2 * i / (FOOT_GRID - 1) - 1) * (1 - px), y = (2 * j / (FOOT_GRID - 1) - 1) * (1 - py);
      const a = at(x, y), b = at(x + px, y), c = at(x, y + py);
      if (!a || !b || !c) continue;
      const r = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - a[0], c[1] - a[1]));
      if (r > 0 && r < rho) rho = r;
    }
  }
  if (isFinite(rho)) F.rho = rho;
}

// ---------------------------------------------------------------- per-frame logic

const snapLatch = { armed: true };
const sizeSettle = { key: '' };
const HEAD_DIM = [0.005, 0.04]; // room metres from a surface: black .. clear
let headDim = 0;
let teleportAim = null;
let aimArmed = false;
const aimSmooth = { has: false, point: new THREE.Vector3() };

function smoothAim(point, dt) {
  if (!aimSmooth.has) { aimSmooth.point.copy(point); aimSmooth.has = true; }
  else aimSmooth.point.lerp(point, 1 - Math.exp(-dt * 10));
  return aimSmooth.point;
}

// Cruise: travel that goes on by itself. state.fallRate is its speed in doublings a second,
// in where positive. The zoom control is its throttle while it runs, with a stop at rest on
// the way through zero.
const CRUISE_MAX = 4;
const CRUISE_START = 0.5;
const CRUISE_THROTTLE = 1.5; // doublings a second gained in a second of full stick
const cruise = { wait: false }; // the zoom control comes back to rest before it is the throttle

function setCruise(on, rate = state.fallRate) {
  const stepped = Math.round(rate * 20) !== Math.round(state.fallRate * 20);
  const turned = on !== state.fall;
  state.fall = on;
  state.fallRate = rate;
  if (turned) notify('fall');
  if (stepped) notify('fallRate');
}

// On, the way `dir` says (0: as it last went); off if it is on.
function cruiseLatch(dir) {
  if (state.fall) { setCruise(false); return; }
  const speed = Math.abs(state.fallRate) || CRUISE_START;
  cruise.wait = true;
  setCruise(true, (dir || Math.sign(state.fallRate) || 1) * speed);
}

// z: the zoom control, -1..1. rest: nothing of it is touched.
function cruiseThrottle(z, rest, dt) {
  if (rest) cruise.wait = false;
  if (!z || cruise.wait) return;
  const was = state.fallRate;
  let rate = THREE.MathUtils.clamp(was + z * CRUISE_THROTTLE * dt, tour.on ? 0 : -CRUISE_MAX, CRUISE_MAX);
  if (was !== 0 && rate * was <= 0) { rate = 0; cruise.wait = true; }
  setCruise(true, rate);
}

// A tour: a cruise that steers itself (src/tour.js), from one place to the next. The zoom
// control stays its throttle, and stops it at rest; the turn control goes on to the next
// place or back; flying, holding the fractal, a teleport or cruise off end it where it is.
const tour = {
  on: false, list: null, stop: null, cut: null, // cut: the fade to the next place, while it is under way
  armed: false, // the fly controls have been at rest since it began: a push on them now is meant
  pilot: new Pilot(), front: new THREE.Vector3(0, 0, -1),
  t: 0, floorT: 0, lostT: 0, insideT: 0,
  rate: { ...TOUR_RATE }, was: null, hint: 0,
  nav: true, // the turn control has been let go since it last chose a place: one push, one place
};

function startTour() {
  if (tour.on) return;
  tour.was = { fallRate: state.fallRate, colorSpin: state.colorSpin, autoSteer: state.autoSteer };
  tour.list = new Playlist(stops(bookmarks.list));
  tour.rate = { ...TOUR_RATE };
  tour.on = true;
  tour.armed = false;
  tour.cut = null;
  tour.hint = 2;
  if (!state.colorSpin) { state.colorSpin = TOUR_SPIN; notify('colorSpin'); }
  if (!state.autoSteer) { state.autoSteer = true; notify('autoSteer'); }
  if (state.panelOpen) app.togglePanel(false);
  // It sets off from where the room is, the way the head faces.
  const f = currentFractal();
  beginLeg({ name: `${f.name}, from here`, fractal: state.fractal, kind: f.kind, here: true });
}

function endTour(why) {
  if (!tour.on) return;
  tour.on = false;
  dbg?.event('tour', { end: why, stop: tour.stop.name, leg: Math.round(tour.t * 10) / 10 });
  setCruise(false, tour.was.fallRate);
  if (state.colorSpin !== tour.was.colorSpin && Math.abs(state.colorSpin) === TOUR_SPIN) { state.colorSpin = tour.was.colorSpin; notify('colorSpin'); }
  if (!tour.was.autoSteer && state.autoSteer) { state.autoSteer = false; notify('autoSteer'); }
  setToolLabel('tour over: it is yours', 3);
}

// The place put on show: in the black of a cut, but for the tour's first.
function placeStop(stop) {
  const f = FRACTALS[stop.fractal];
  if (stop.mark) applyBookmark(stop.mark);
  else if (stop.home) app.selectFractal(stop.fractal);
  else if (stop.edge) {
    app.selectFractal(stop.fractal);
    const c = boundaryPoint(f, state.params, Math.random);
    view2d.cx = dd(c[0]);
    view2d.cy = dd(c[1]);
  } else if (stop.target) {
    app.selectFractal(stop.fractal);
    view2d.setTarget(stop.target);
  }
}

function beginLeg(stop) {
  placeStop(stop);
  const f = currentFractal();
  tour.stop = stop;
  tour.t = 0; tour.floorT = 0; tour.lostT = 0; tour.insideT = 0;
  if (f.kind === '3d') {
    rig.dolly.updateMatrixWorld(true);
    tour.front.copy(frontOf(rig.camera));
    // From a fractal's start: toward it. Elsewhere: the way the head faces.
    const head = rig.headWorld();
    const way = stop.home && f.bound(state.params) > 0 && head.lengthSq() > 1e-12
      ? head.clone().negate().normalize()
      : tour.front.clone().applyQuaternion(rig.dolly.quaternion);
    tour.pilot.reset(way.toArray());
    if (stop.home) { face(rig, tour.pilot.heading, tour.front); rig.dolly.updateMatrixWorld(true); }
  }
  cruise.wait = true;
  setCruise(true, tour.rate[f.kind]);
  taa.reset = true;
  dbg?.event('tour', { stop: stop.name, fractal: stop.fractal });
  const place = stop.here ? f.name : stop.name;
  if (tour.hint > 0) { tour.hint--; setToolLabel([place, 'turn stick: next place', 'A+B or fly: it is yours'], 6); }
  else setToolLabel(['tour', place], 6);
}

function tourGo(stop) {
  tour.cut = () => { tour.cut = null; if (tour.on) beginLeg(stop); };
  startFade(tour.cut);
}

function updateTour(intent, dt) {
  if (!tour.on) return;
  // A cut some other fade took the place of never comes.
  if (tour.cut && fade.onBlack !== tour.cut) tour.cut = null;
  // The turn control is the tour's: on to the next place, or back to the one before.
  const turn = tools.holding ? 0 : intent.turn;
  intent.turn = 0;
  if (Math.abs(turn) < 0.3) tour.nav = true;
  if (tour.cut) return;
  const f = currentFractal();
  // Cruise off (A+B, the menu, a fractal or a bookmark chosen) is the tour off.
  if (!state.fall) { endTour('cruise off'); return; }
  const push = tools.holding ? 0 : Math.hypot(intent.fly[0], intent.fly[1], intent.climb);
  if (!push) tour.armed = true;
  const reset = intent.recenter && f.kind === '3d';
  if ((tour.armed && push > 0.1) || grab.active || reset || (TOOLS[state.tool].key === 'teleport' && tools.use)) { endTour('taken over'); return; }
  if (state.fallRate > 0) { tour.rate[f.kind] = state.fallRate; tour.t += dt; }
  const step = tour.nav && Math.abs(turn) >= 0.6 ? Math.sign(turn) : 0;
  if (step) tour.nav = false;
  let end = step !== 0 || tour.t >= LEG;
  // Stopped, it is being looked at: nothing gives a place up then.
  const going = state.fallRate > 0;
  if (f.kind === '3d') {
    tour.floorT += going && rig.scale <= rig.minScale * 1.05 ? dt : 0;
    tour.lostT = going && tour.pilot.lost ? tour.lostT + dt : 0;
    tour.insideT = rig.lastDE > 0 ? 0 : tour.insideT + dt;
    end ||= tour.floorT >= LEG_FLOOR || tour.lostT >= LEG_LOST || tour.insideT >= 1;
  } else {
    const julia = f.formula === 'julia';
    // The centre within the set, and no way out of it found: nothing but black ahead.
    tour.lostT = going && view2d.dark ? tour.lostT + dt : 0;
    end ||= tour.lostT >= LEG_LOST || view2d.scale <= (julia ? JULIA_FLOOR : SCALE2D_MIN * 100);
  }
  if (end) tourGo(step < 0 ? tour.list.prev() : tour.list.next());
}

function zoomAtRest(intent) {
  return !intent.zoom && !intent.a.right.pressed && !intent.b.right.pressed;
}

// The tool hand's ray (left controller), or the view on the desktop.
function aimRay(intent) {
  const origin = new THREE.Vector3(), dir = new THREE.Vector3();
  if (intent.xr) {
    hands.left.ray.getWorldPosition(origin);
    hands.left.ray.getWorldDirection(dir).negate();
  } else {
    rig.camera.getWorldPosition(origin);
    rig.camera.getWorldDirection(dir);
  }
  return { origin, dir };
}

function handle3D(intent, dt) {
  const s = rig.scale;
  const q = new THREE.Quaternion();
  if (state.moveDir === 'hand' && intent.xr) hands.left.ray.getWorldQuaternion(q);
  else rig.camera.getWorldQuaternion(q);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();

  // A held trigger or grip freezes the room: the sticks belong to that tool.
  const mv = tools.holding ? { fly: [0, 0], climb: 0, turn: 0, zoom: 0 } : intent;
  let speed = state.flySpeed;
  if (state.deSpeed) {
    const deRoom = rig.deAtHead() / s;
    if (isFinite(deRoom) && deRoom > 0) speed = THREE.MathUtils.clamp(deRoom * 0.9, 0.12, state.flySpeed);
  }
  if (intent.boost) speed *= 4;
  if (mv.fly[1]) rig.fly(fwd, mv.fly[1] * speed * dt);
  if (mv.fly[0]) rig.fly(right, mv.fly[0] * speed * dt);
  if (mv.climb) rig.fly(rig.up(), mv.climb * speed * dt);
  const cruising = state.fall && !tools.holding;
  if (cruising) {
    cruiseThrottle(THREE.MathUtils.clamp(mv.zoom, -1, 1), zoomAtRest(intent), dt);
    // In: toward what is looked at. Out: back from it, and never toward the nearest surface,
    // so going out does not end up smaller against a wall behind.
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.camera.getWorldQuaternion(new THREE.Quaternion()));
    if (tour.on) {
      // A tour steers itself, and turns the room to keep its way in front.
      stickYaw = fly(rig, tour.pilot, tour.front, state.armLength, state.fallRate * state.armLength * 0.7 * dt, dt);
    } else {
      if (state.fallRate < 0) {
        dir.negate();
        const h = rig.headWorld().clone();
        const n = rig.normalAt(h, Math.max(rig.deAt(h) * 0.1, 1e-6));
        const into = dir.dot(n);
        if (into < 0) dir.addScaledVector(n, -into);
      }
      rig.fly(dir, Math.abs(state.fallRate) * state.armLength * 0.7 * dt);
      if (state.fallRate < 0 && rig.scale >= rig.maxScale) setCruise(false);
    }
  }

  const lx = mv.turn;
  if (state.turnMode === 'snap' && intent.xr) {
    if (snapLatch.armed && Math.abs(lx) > 0.6) { rig.turn(-Math.sign(lx) * THREE.MathUtils.degToRad(state.snapAngle)); snapLatch.armed = false; }
    if (Math.abs(lx) < 0.3) snapLatch.armed = true;
  } else if (lx) {
    stickYaw = -lx * TURN_SPEED * dt;
    rig.turn(stickYaw);
  }

  const ly = THREE.MathUtils.clamp(mv.zoom, -1, 1);
  // Zoom stops where the estimator's float32 noise would exceed three pixels at arm's length.
  const f = currentFractal();
  const pxRoom = state.armLength * uGeo.uPixelAngle.value;
  rig.minScale = Math.max(SCALE_MIN, f.precision * Math.max(1, rig.headWorld().length()) / (3 * pxRoom));
  // Size and collision follow travel only: head motion alone never rescales or pushes the room.
  const travelling = !tools.holding && !!(mv.fly[0] || mv.fly[1] || mv.climb || (cruising ? state.fallRate : ly));
  const sizeKey = `${state.autoZoom}|${state.armLength}`;
  if (sizeKey !== sizeSettle.key) { sizeSettle.key = sizeKey; rig.settle = true; }
  if (state.autoZoom || state.fall) {
    if (ly && !cruising) {
      // The zoom control sets how near the nearest surface is kept: said, as nothing else shows it.
      const was = state.armLength;
      state.armLength = THREE.MathUtils.clamp(was * Math.exp(-ly * dt * 1.2), 0.05, 20);
      if (Math.round(Math.log(was) * 20) !== Math.round(Math.log(state.armLength) * 20)) notify('armLength');
      const a = state.armLength;
      setToolLabel(['nearest surface kept at', a < 1 ? `${Math.round(a * 100)} cm` : `${a.toFixed(1)} m`], 1.5);
    }
    if (!tools.holding && (travelling || rig.settle)) {
      if (rig.autoZoom(dt, state.armLength) && !travelling) rig.settle = false;
    }
  } else {
    rig.settle = false;
    if (ly) rig.zoom(Math.exp(-ly * ZOOM_SPEED * dt));
  }

  if (state.collide && travelling) rig.resolveCollision(state.standoff);
  rig.dolly.updateMatrixWorld(true);
  // The head inside a surface dims the view instead of moving the room.
  const deRoom = rig.deAtHead() / rig.scale;
  headDim = state.collide ? 1 - THREE.MathUtils.smoothstep(deRoom, HEAD_DIM[0], HEAD_DIM[1]) : 0;

  // Teleport tool: hold the left trigger to aim, release to go.
  const teleport = TOOLS[state.tool].key === 'teleport';
  if (teleport && tools.use) {
    const { origin, dir } = aimRay(intent);
    const hit = rig.march(origin, dir, 160, 0.03);
    if (hit) {
      // Off the surface along its normal where that is open room; where it is not (a thin
      // wall, a fold, a crevice), back along the ray, which is. The marker is smoothed, the
      // landing is not: a point between two good ones can be inside a wall.
      const standoff = Math.max(state.standoff, 0.4) * s;
      const target = rig.openAlong(hit.point, hit.normal, standoff)
        ? hit.point.clone().addScaledVector(hit.normal, standoff)
        : rig.standOn(origin, dir, hit.t, standoff);
      teleportAim = { point: target };
      teleportMarker.visible = true;
      teleportMarker.position.copy(smoothAim(target, dt));
      teleportMarker.scale.setScalar(0.04 * s);
      aimLine.visible = intent.xr;
      if (intent.xr) {
        aimLine.position.copy(hands.left.ray.position);
        aimLine.quaternion.copy(hands.left.ray.quaternion);
        aimLine.scale.z = hit.t / s;
      }
    } else {
      teleportAim = null;
      aimSmooth.has = false;
      teleportMarker.visible = false;
      aimLine.visible = false;
    }
  } else {
    teleportMarker.visible = false;
    aimLine.visible = false;
    if (teleport && tools.useUp && teleportAim) {
      const target = teleportAim.point;
      startFade(() => {
        rig.teleportTo(target);
        if (state.teleportZoom) {
          const de = rig.deAtHead();
          if (de > 0) rig.setScale(de / state.armLength);
        }
        if (state.collide) rig.resolveCollision(state.standoff);
        rig.settle = true;
      });
    }
    teleportAim = null;
    aimSmooth.has = false;
  }
}

function handle2D(intent, dt) {
  const tunnel = state.layout2d === 3;
  const mv = tools.holding ? { fly: [0, 0], climb: 0, turn: 0, zoom: 0 } : intent;
  const boost = intent.boost ? 3 : 1;
  // With the fractal held, zooming and turning go on, and the place held stays under the ray.
  const zt = grab.active ? intent : mv;
  if (tunnel) {
    if (mv.fly[1]) view2d.zoom(Math.pow(2, -mv.fly[1] * ZOOM2D_SPEED * dt * boost));
    if (mv.fly[0]) view2d.pan(mv.fly[0] * PAN_SPEED * dt * 0.5, 0);
  } else {
    const k = PAN_SPEED * dt * boost;
    if (mv.fly[0] || mv.fly[1]) view2d.pan(mv.fly[0] * k, mv.fly[1] * k);
  }
  if (state.fall && !tools.holding) {
    cruiseThrottle(THREE.MathUtils.clamp(mv.zoom + mv.climb, -1, 1), zoomAtRest(intent) && !mv.climb, dt);
    if (state.fallRate > 0 ? view2d.scale <= SCALE2D_MIN : view2d.scale >= SCALE2D_MAX) setCruise(false);
  } else {
    if (zt.climb) view2d.zoom(Math.pow(2, -zt.climb * ZOOM2D_SPEED * dt));
    if (zt.zoom) view2d.zoom(Math.pow(2, -THREE.MathUtils.clamp(zt.zoom, -1, 1) * ZOOM2D_SPEED * dt * boost));
  }
  if (zt.turn) view2d.rot += zt.turn * dt * 1.0;
  const held = grab.active && grab.uv && !tunnel ? { p: grab.c, u: grab.uv[0], v: grab.uv[1] } : null;
  if (held) view2d.hold(held.p, held.u, held.v);

  view2d.need = plane.need.move;
  view2d.update(dt, held);
  rig.dolly.updateMatrixWorld(true);

  // Teleport tool: point at the surface, release to jump there and zoom in a step.
  const teleport = TOOLS[state.tool].key === 'teleport';
  if (teleport && (tools.use || tools.useUp)) {
    const { origin, dir } = aimRay(intent);
    const { ro, rd } = toSurface(origin, dir);
    const hit = surfaceHit(ro, rd);
    if (hit && tools.use) {
      const pRoom = hit.p.clone().applyMatrix4(surfFrame);
      teleportMarker.visible = true;
      teleportMarker.position.copy(pRoom.applyMatrix4(rig.dolly.matrixWorld));
      teleportMarker.scale.setScalar(0.03 * rig.scale);
      teleportAim = hit;
      // While aiming the right stick sets how far each jump zooms.
      if (intent.axes.right[1]) state.teleportZoomStep = THREE.MathUtils.clamp(state.teleportZoomStep + intent.axes.right[1] * dt * 0.6, 0, 3);
      setToolLabel(`jump + zoom ${state.teleportZoomStep.toFixed(2)} doublings`);
    } else if (tools.useUp && teleportAim) {
      const uv = teleportAim.uv;
      const step = state.teleportZoomStep;
      startFade(() => { view2d.pan(uv[0], uv[1]); view2d.zoom(Math.pow(2, -step)); });
      teleportAim = null;
      teleportMarker.visible = false;
    } else {
      teleportMarker.visible = false;
    }
  } else {
    teleportMarker.visible = false;
    teleportAim = null;
  }
}

// Hold the left grip away from the windows and the fractal is in the hand: it turns as the
// hand turns, about the place the hand points at, and moves as the hand moves. The room is
// what moves, so the sky and the light stay with the fractal. In 2D the place the hand points
// at stays under its ray, the picture turns about it with the wrist, and zooming is into it.
const grab = {
  active: false, fractal: 0, pivot: new THREE.Vector3(), // the place held, in the world
  q: new THREE.Quaternion(), p: new THREE.Vector3(), // the hand a frame ago, in the room
  uv: null, // 2D: where the ray is on the surface, metres
  c: null, // 2D: the point of the plane held
  t: 0,
  _q: new THREE.Quaternion(), _t: new THREE.Vector3(), _c: new THREE.Vector3(), _d: new THREE.Vector3(),
};
const GRAB_FAR = 12; // metres along the ray past which a 2D surface is out of the hand's reach
const GRAB_SLIP = 6; // metres in a frame: not a drag (the seam of a surface, a ray come back to it)

// Where a hand's ray meets the 2D surface, within reach.
function surfaceUnder(hand) {
  const { ro, rd } = toSurface(hand.getWorldPosition(grab._c), hand.getWorldDirection(grab._d).negate());
  const hit = surfaceHit(ro, rd);
  if (!hit || !isFinite(hit.uv[0]) || !isFinite(hit.uv[1]) || hit.t > GRAB_FAR) return null;
  hit.rd = rd;
  return hit;
}

// Whether a surface shows the picture the right way round from where the hand is (1), or
// mirrored (-1): a turn of the wrist has to turn it the way the wrist went.
function surfaceSide(hand, at) {
  const origin = hand.getWorldPosition(new THREE.Vector3()), dir = hand.getWorldDirection(new THREE.Vector3()).negate();
  const q = hand.getWorldQuaternion(grab._q);
  const toward = (x, y) => {
    const s = toSurface(origin, new THREE.Vector3(x, y, 0).applyQuaternion(q).multiplyScalar(1e-3).add(dir).normalize());
    const hit = surfaceHit(s.ro, s.rd);
    return hit ? [hit.uv[0] - at[0], hit.uv[1] - at[1]] : null;
  };
  const r = toward(1, 0), u = toward(0, 1);
  if (!r || !u) return 1;
  return r[0] * u[1] - r[1] * u[0] < 0 ? -1 : 1;
}

// A frame of holding a 2D fractal: where the ray is now, and the wrist's turn. The tunnel's
// wall is the plane wound about its centre, a doubling for every stretch of its length: a
// place dragged along it is the picture zoomed, and dragged around it the picture turned.
function hold2D(hand) {
  const roll = wristTurn(grab.q, hand.quaternion);
  grab.q.copy(hand.quaternion);
  const hit = surfaceUnder(hand);
  grabMarker.visible = !!hit;
  const was = grab.uv;
  grab.uv = hit ? hit.uv : null;
  if (!hit) return;
  const [u, v] = hit.uv;
  grabMarker.position.copy(hit.p).applyMatrix4(surfFrame).applyMatrix4(rig.dolly.matrixWorld);
  grabMarker.scale.setScalar(0.012 * rig.scale);
  if (state.layout2d === 3) {
    view2d.rot += roll * (hit.rd.z > 0 ? -1 : 1); // looking back up it, the wall turns the other way
    const r0 = was ? Math.hypot(was[0], was[1]) : 0, r1 = Math.hypot(u, v);
    if (!(r0 > 0 && r1 > 0)) return;
    view2d.zoom(r0 / r1);
    view2d.rot += Math.atan2(was[1], was[0]) - Math.atan2(v, u);
    return;
  }
  // The ray back on the surface, or across a seam of it: a new hold, not a drag.
  if (!was || Math.hypot(u - was[0], v - was[1]) > GRAB_SLIP) grab.c = view2d.at(u, v);
  view2d.rot += roll * surfaceSide(hand, hit.uv);
}

function handleGrab(intent, dt) {
  const f = currentFractal();
  const grip = intent.grip.left, hand = hands.left.ray;
  if (grip.down && !pointers.busy('left') && !tools.use && !knob.held && fade.value === 0) {
    grab.fractal = state.fractal;
    grab.q.copy(hand.quaternion);
    grab.p.copy(hand.position);
    grab.t = 0;
    if (f.kind === '3d') {
      grab.active = true;
      // What the hand points at; pointing at the sky, the surface nearest the head.
      const origin = hand.getWorldPosition(grab._c);
      const hit = rig.march(origin, hand.getWorldDirection(grab._d).negate(), 160);
      if (hit) grab.pivot.copy(hit.point);
      else {
        const head = rig.headWorld(), de = rig.deAt(head);
        if (isFinite(de) && de > 0) grab.pivot.copy(head).addScaledVector(rig.normalAt(head, Math.max(de * 0.1, 1e-6)), -de);
        else grab.pivot.copy(origin);
      }
    } else {
      const hit = surfaceUnder(hand);
      grab.active = !!hit;
      grab.uv = hit ? hit.uv : null;
      if (hit) grab.c = view2d.at(hit.uv[0], hit.uv[1]);
      else setToolLabel('point at the fractal to take hold of it', 2);
    }
  }
  if (grab.active && (!grip.pressed || grab.fractal !== state.fractal || fade.value > 0)) {
    grab.active = false;
    dbg?.event('grab', { of: f.kind, held: Math.round(grab.t * 100) / 100 });
  }
  grabMarker.visible = grab.active;
  if (!grab.active) return;
  grab.t += dt;
  if (f.kind === '2d') { hold2D(hand); return; }
  // The hand's turn and shift since the last frame, in the room.
  const q = grab._q.copy(grab.q).invert().premultiply(hand.quaternion);
  const t = grab._t.copy(hand.position).sub(grab.p);
  grab.q.copy(hand.quaternion);
  grab.p.copy(hand.position);
  rig.carry(rig.dolly.worldToLocal(grab._c.copy(grab.pivot)), q, t);
  rig.dolly.updateMatrixWorld(true);
  grabMarker.position.copy(grab.pivot);
  grabMarker.scale.setScalar(0.012 * rig.scale);
}

// Sculpting: hold the right grip away from the windows and move the hand to sweep the
// continuous parameters (x y z = first to third). A slow hand is a fine one.
const SCULPT_SPAN = 0.5; // metres of a quick hand for a parameter's whole range
const SCULPT_FINE = [0.25, 0.15]; // hand metres per second below which the sweep is finer, down to this share
const sculpt = { active: false, p: new THREE.Vector3(), d: new THREE.Vector3() };
function handleSculpt(use, dt) {
  const cont = currentFractal().params.filter((p) => p.step < 1);
  const hand = hands.right.grip.position;
  if (use.down) { sculpt.active = true; sculpt.p.copy(hand); }
  if (!use.held) sculpt.active = false;
  if (!sculpt.active) return;
  if (!cont.length) { setToolLabel('nothing here to sculpt', 2); return; }
  const d = sculpt.d.copy(hand).sub(sculpt.p);
  sculpt.p.copy(hand);
  const gain = dt > 0 ? THREE.MathUtils.clamp(d.length() / dt / SCULPT_FINE[0], SCULPT_FINE[1], 1) : 0;
  const deltas = [d.x, d.y, -d.z];
  const lines = [];
  let changed = false;
  for (let k = 0; k < 3; k++) {
    const p = cont[k];
    if (!p) continue;
    const v = THREE.MathUtils.clamp(state.params[p.key] + (deltas[k] / SCULPT_SPAN) * (p.max - p.min) * gain, p.min, p.max);
    if (v !== state.params[p.key]) { state.params[p.key] = v; changed = true; }
    lines.push(`${p.name} ${v.toFixed(3)}`);
  }
  if (changed) notify('params');
  setToolLabel(lines);
}

// The colour knob: the left stick pressed in. Held, the hand's roll turns the palette, half a
// turn of the wrist the whole of it. Let go while it turns and the palette keeps turning, a
// quarter as fast; let go still and it stays. A tap stops the spin, or starts it again.
const KNOB_GAIN = 1 / Math.PI; // palette turns per radian of roll
const KNOB_TAP = 0.3, KNOB_TAP_TURN = 0.03; // a tap: no longer than this (seconds), and the palette turned no further
// Palette turns per second: the hand slower than KNOB_STILL as it lets go is still; faster,
// the palette keeps KNOB_THROW of the hand's rate, SPIN_MAX at most.
const KNOB_STILL = 0.1, KNOB_THROW = 0.25, SPIN_MAX = 0.5;
// The quick menu's palette page: the left stick, full over, changes the spin by SPIN_EASE a
// second and as much again as the spin is, in steps of SPIN_STEP.
const SPIN_EASE = 0.03, SPIN_STEP = 0.005;
const knob = { held: false, t: 0, turned: 0, rate: 0, resume: 0.05, q: new THREE.Quaternion(), d: new THREE.Quaternion() };
function handleColour(intent, dt) {
  const btn = intent.stick.left, hand = hands.left.ray.quaternion;
  // A press with the stick pushed over is the thumb flying, not a press.
  if (btn.down && !tools.holding && Math.hypot(intent.axes.left[0], intent.axes.left[1]) < 0.1) {
    knob.held = true; knob.t = 0; knob.turned = 0; knob.rate = 0;
    knob.q.copy(hand);
  }
  if (!knob.held) return;
  if (btn.pressed) {
    // The roll since the last frame: the hand's turn about its own pointing axis, clockwise.
    const d = knob.d.copy(knob.q).invert().multiply(hand);
    knob.q.copy(hand);
    const turn = -2 * Math.atan2(d.z * Math.sign(d.w || 1), Math.abs(d.w)) * KNOB_GAIN;
    knob.t += dt;
    knob.turned += Math.abs(turn);
    colorPhaseAcc = (colorPhaseAcc + turn) % PHASE_WRAP;
    if (dt > 0) knob.rate += (turn / dt - knob.rate) * (1 - Math.exp(-dt / 0.1));
    setToolLabel('colour: twist to turn it, let go turning to spin');
    return;
  }
  knob.held = false;
  if (knob.t < KNOB_TAP && knob.turned < KNOB_TAP_TURN) state.colorSpin = state.colorSpin ? 0 : knob.resume;
  else state.colorSpin = Math.abs(knob.rate) > KNOB_STILL ? THREE.MathUtils.clamp(knob.rate * KNOB_THROW, -SPIN_MAX, SPIN_MAX) : 0;
  if (state.colorSpin) knob.resume = state.colorSpin;
  notify('colorSpin');
  dbg?.event('colour', { spin: state.colorSpin });
  setToolLabel(state.colorSpin ? `colour spin ${state.colorSpin.toFixed(2)} turns/s` : 'colour spin off', 1.5);
}

// ---------------------------------------------------------------- tool handling

// Press-and-hold buttons become tool actions only when the press started away from the
// windows (a press on a window is a click or a drag, handled by the pointers).
function armed(btn, key, free) {
  const down = btn.down && free;
  if (down) tools[key] = true;
  const up = tools[key] && btn.up;
  const held = tools[key] && btn.pressed;
  if (!btn.pressed) tools[key] = false;
  return { down, held, up };
}

// Stick as a stepper: one step on push, then repeats while held. `v` is as the stick's curve
// leaves it: a flick of six tenths of the way steps, and the other axis must be the lesser.
function navStep(v, across, st, dt) {
  if (Math.abs(v) < 0.08) { st.armed = true; st.t = 0; return 0; }
  if (Math.abs(v) < 0.28 || Math.abs(v) < Math.abs(across)) return 0;
  if (st.armed) { st.armed = false; st.t = 0; return Math.sign(v); }
  st.t += dt;
  if (st.t > 0.3) { st.t = 0.12; return Math.sign(v); }
  return 0;
}

function setToolLabel(text, seconds = 0.5) {
  tools.label = text;
  tools.labelUntil = performance.now() + seconds * 1000;
}

function toolSetting(key) {
  if (key === 'balls') return `speed ${state.ballSpeed.toFixed(1)} m/s (left stick)`;
  if (key === 'teleport') return `2D jump zoom ${state.teleportZoomStep.toFixed(2)} doublings (left stick)`;
  if (key === 'camera') return photo.status || STORED_TO;
  return `${bookmarks.list.length} bookmarks (the marks page lists them)`;
}

function openQuick() {
  quick.setPages([
    { name: 'tools', items: TOOLS.map((t) => `${t.name}   ${t.hint}`) },
    { name: 'actions', items: QUICK_ACTIONS.map((a) => a.name) },
    { name: 'fractal', items: ORDER.map((i) => FRACTALS[i].name) },
    { name: 'palette', items: PALETTES.map((p) => p.name) },
    { name: 'marks', items: bookmarks.list.map((b) => b.name) },
  ]);
  quick.setPage(0); // always the tools first: the way to a thing is the same each time
  quickHighlightCurrent();
}

const quickPage = () => quick.pages[quick.page].name;

function quickHighlightCurrent() {
  const page = quickPage();
  if (page === 'tools') quick.highlight = state.tool;
  else if (page === 'fractal') quick.highlight = ORDER.indexOf(state.fractal);
  else if (page === 'palette') quick.highlight = state.palette;
  else quick.highlight = Math.min(quick.highlight, Math.max(0, quick.items().length - 1));
}

function activateQuick() {
  const i = quick.highlight, page = quickPage();
  if (page === 'tools') { if (TOOLS[i] && i !== state.tool) { state.tool = i; notify('tool'); } }
  else if (page === 'marks') { if (bookmarks.list[i]) restoreBookmark(bookmarks.list[i]); }
  else if (page === 'fractal') { if (ORDER[i] !== state.fractal) app.selectFractal(ORDER[i]); }
  else if (page === 'palette') { setPalette(i); keep('palette'); }
  else if (QUICK_ACTIONS[i]) QUICK_ACTIONS[i].run();
}

function captureBookmark() {
  const f = currentFractal();
  const e = {
    name: `${f.name} ${bookmarks.list.length + 1}`, t: Date.now(), fractal: state.fractal, params: { ...state.params },
    palette: state.palette, colorFreq: state.colorFreq, colorPhase: state.colorPhase, layout2d: state.layout2d, background: state.background,
  };
  if (f.kind === '3d') e.rig = { pos: rig.dolly.position.toArray(), quat: rig.dolly.quaternion.toArray(), scale: rig.scale };
  else e.view = { cx: ddToString(view2d.cx, 40), cy: ddToString(view2d.cy, 40), scale: view2d.scale, rot: view2d.rot };
  return e;
}

function restoreBookmark(e) {
  startFade(() => applyBookmark(e));
}

function applyBookmark(e) {
  if (state.fractal !== e.fractal) app.selectFractal(e.fractal);
  Object.assign(state.params, e.params);
  setPalette(e.palette);
  state.colorFreq = e.colorFreq;
  state.colorPhase = e.colorPhase;
  state.background = e.background;
  if (e.rig) {
    rig.dolly.position.fromArray(e.rig.pos);
    rig.dolly.quaternion.fromArray(e.rig.quat);
    rig.dolly.scale.setScalar(e.rig.scale);
    rig.dolly.updateMatrixWorld(true);
    rig.settle = false; // the saved size is exact
  }
  if (e.view) {
    state.layout2d = e.layout2d;
    view2d.setTarget({ cx: e.view.cx, cy: e.view.cy });
    view2d.scale = e.view.scale;
    view2d.rot = e.view.rot;
    app.recenter();
    plane.reset();
  }
  state.fall = false;
  notify('params');
  taa.reset = true;
}

// Two eyes on the desktop, side by side in the canvas, each with a session's off-centre view:
// every pass as a headset runs it, for the benches (fv.twin.on).
const twin = { on: false, apart: 0.064, skew: 0.12, cams: [new THREE.PerspectiveCamera(), new THREE.PerspectiveCamera()], pair: new THREE.ArrayCamera(), m: new THREE.Matrix4() };
twin.pair.cameras = twin.cams;
twin.pair.matrixWorldAutoUpdate = false;
const eyeCount = () => (renderer.xr.isPresenting || twin.on ? 2 : 1);
const eyeCameras = () => (renderer.xr.isPresenting ? renderer.xr.getCamera().cameras : twin.on ? twin.cams : [rig.camera]);
function updateTwin() {
  if (!twin.on || renderer.xr.isPresenting) return;
  const cam = rig.camera, w = fbSize.x / 2;
  for (let i = 0; i < 2; i++) {
    const c = twin.cams[i];
    c.matrixWorld.multiplyMatrices(cam.matrixWorld, twin.m.makeTranslation((i - 0.5) * twin.apart, 0, 0));
    c.matrixWorldInverse.copy(c.matrixWorld).invert();
    c.fov = cam.fov; c.near = cam.near; c.far = cam.far; c.aspect = w / fbSize.y;
    c.updateProjectionMatrix();
    c.projectionMatrix.elements[8] = (0.5 - i) * 2 * twin.skew;
    c.projectionMatrixInverse.copy(c.projectionMatrix).invert();
    c.viewport = (c.viewport ?? new THREE.Vector4()).set(i * w, 0, w, fbSize.y);
  }
  twin.pair.matrixWorld.copy(cam.matrixWorld);
  twin.pair.matrixWorldInverse.copy(cam.matrixWorld).invert();
  twin.pair.projectionMatrix.copy(cam.projectionMatrix);
}

// Shade the given eye cameras' views side by side into an offscreen target, as a canvas.
function renderEyes(srcs) {
  const eyes = eyeCount();
  const n = srcs.length;
  const w = Math.min(2048, Math.round(fbSize.x / eyes));
  const h = Math.round(w * fbSize.y / (fbSize.x / eyes));
  if (!photo.rt || photo.rt.width !== n * w || photo.rt.height !== h) {
    if (photo.rt) photo.rt.dispose();
    photo.rt = new THREE.WebGLRenderTarget(n * w, h, { depthBuffer: true, stencilBuffer: false });
  }
  if (!photo.mesh) { photo.mesh = fsMesh(screenMesh.material); photo.scene.add(photo.mesh); }
  photo.mesh.material = screenMesh.material;
  const fb = uShow.uFbSize.value.clone();
  const savedEyes = uShow.uEyes.value;
  uShow.uFbSize.value.set(n * w, h);
  uShow.uEyes.value = n;
  const xrRT = renderer.getRenderTarget();
  renderer.xr.enabled = false;
  renderer.setRenderTarget(photo.rt);
  for (let i = 0; i < n; i++) {
    const src = srcs[i];
    photo.cam.matrixWorld.copy(src.matrixWorld);
    photo.cam.matrixWorldInverse.copy(src.matrixWorldInverse);
    photo.cam.projectionMatrix.copy(src.projectionMatrix);
    photo.cam.projectionMatrixInverse.copy(src.projectionMatrix).invert();
    // The clear ignores the viewport: scissor each eye so it keeps the other.
    photo.rt.viewport.set(i * w, 0, w, h);
    photo.rt.scissor.set(i * w, 0, w, h);
    photo.rt.scissorTest = true;
    renderer.setRenderTarget(photo.rt);
    renderer.render(photo.scene, photo.cam);
  }
  photo.rt.viewport.set(0, 0, n * w, h);
  photo.rt.scissorTest = false;
  renderer.setRenderTarget(xrRT);
  renderer.xr.enabled = true;
  uShow.uFbSize.value.copy(fb);
  uShow.uEyes.value = savedEyes;
  const W = n * w;
  const px = new Uint8Array(W * h * 4);
  renderer.readRenderTargetPixels(photo.rt, 0, 0, W, h, px);
  const c = document.createElement('canvas');
  c.width = W; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, h);
  for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * W * 4, (h - y) * W * 4), y * W * 4);
  ctx.putImageData(img, 0, 0);
  return c;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// Report: both eyes as seen, the full state and the last seconds of head poses and rig state,
// enough to reproduce the view on the desktop (fv.loadReport).
function saveReport() {
  const presenting = renderer.xr.isPresenting;
  const srcs = eyeCameras();
  const c = renderEyes(srcs);
  const name = `report-${stamp()}`;
  const data = {
    time: new Date().toISOString(), userAgent: navigator.userAgent, presenting, frameRate: app.currentFrameRate(),
    bookmark: captureBookmark(), state: JSON.parse(JSON.stringify(state)), describe: app.describe(),
    fb: [fbSize.x, fbSize.y], acc: { ...acc }, low: { ...low }, dyn: { scale: dyn.scale }, plane: { budget: planeCtl.budget, ...plane.stats },
    still: { t: still.t, level: still.level }, perf: { fps: perf.fps, ms: perf.ms },
    head: { pos: rig.camera.position.toArray(), quat: rig.camera.quaternion.toArray() },
    eyes: srcs.map((s) => ({ proj: s.projectionMatrix.toArray(), world: s.matrixWorld.toArray() })),
    trace: headTrace.dump(),
  };
  setToolLabel('saving report...', 3);
  return Promise.all([store(name, c.toDataURL('image/jpeg', 0.92)), store(name, JSON.stringify(data))])
    .then(([img]) => { setToolLabel(`saved ${img}`, 3); dbg?.event('report', { name }); return name; })
    .catch((e) => { console.error(e); setToolLabel(`report error: ${e.message}`, 4); throw e; });
}

// Shade the left eye's view and hand it to the server.
function takePhoto() {
  const c = renderEyes(eyeCameras().slice(0, 1));
  const w = c.width, h = c.height;
  photo.count++;
  photo.status = 'saving...';
  store(`photo-${stamp()}`, c.toDataURL('image/jpeg', 0.92))
    .then((file) => { photo.status = `saved ${file}`; setToolLabel(photo.status, 3); })
    .catch((e) => { console.error(e); photo.status = `error: ${e.message}`; setToolLabel(photo.status, 4); });
  // Print for the hand: a downscaled copy.
  const small = document.createElement('canvas');
  small.width = 512; small.height = Math.round(512 * h / w);
  small.getContext('2d').drawImage(c, 0, 0, small.width, small.height);
  if (photo.print.material.map) photo.print.material.map.dispose();
  const tex = new THREE.CanvasTexture(small);
  tex.colorSpace = THREE.SRGBColorSpace;
  photo.print.material.map = tex;
  photo.print.material.needsUpdate = true;
  photo.print.visible = true;
  photo.until = performance.now() + 4000;
  tools.flash = 1;
}

function handleTools(intent, dt) {
  const f = currentFractal();
  const leftFree = !pointers.busy('left') && !tools.consumed.left;
  const rightFree = !pointers.busy('right') && !tools.consumed.right;
  for (const h of ['left']) if (handLabels[h].mesh.parent !== hands[h].grip) hands[h].grip.add(handLabels[h].mesh);
  if (quick.mesh.parent !== hands.right.grip) hands.right.grip.add(quick.mesh);
  if (photo.print.parent !== hands.left.grip) hands.left.grip.add(photo.print);

  const use = armed(intent.trigger.left, 'useArmed', leftFree && !fade.onBlack && !grab.active);
  const qk = armed(intent.trigger.right, 'quickArmed', rightFree && !sculpt.active);
  const shape = armed(intent.grip.right, 'sculptArmed', rightFree && !tools.quickOpen);
  tools.use = use.held; tools.useDown = use.down; tools.useUp = use.up;
  tools.holding = use.held || qk.held || shape.held || grab.active || knob.held;

  // Quick menu on the right trigger: the right stick moves and turns its pages, release
  // chooses. On the tools page the left stick tunes the tool under the highlight. A tap, the
  // list hardly seen and nothing moved, chooses nothing.
  if (qk.held) {
    if (!tools.quickOpen) { tools.quickOpen = true; tools.quickT = 0; tools.quickMoved = false; tools.quickPalette = state.palette; openQuick(); }
    tools.quickT += dt;
    const [sx, sy] = intent.axes.right;
    const dx = navStep(sx, sy, tools.nav.qx, dt);
    if (dx) {
      if (state.palette !== tools.quickPalette) setPalette(tools.quickPalette); // a palette only tried
      quick.setPage(quick.page + dx);
      quickHighlightCurrent();
    }
    const dy = navStep(sy, sx, tools.nav.qy, dt);
    if (dy) quick.step(-dy);
    if (dx || dy) { tools.quickMoved = true; input.pulse('right', 0.4, 10); }
    const page = quickPage();
    if (page === 'tools') {
      const key = TOOLS[quick.highlight].key, ly = intent.axes.left[1];
      if (ly && key === 'balls') state.ballSpeed = THREE.MathUtils.clamp(state.ballSpeed * Math.exp(ly * dt * 1.5), 1, 40);
      if (ly && key === 'teleport') state.teleportZoomStep = THREE.MathUtils.clamp(state.teleportZoomStep + ly * dt * 0.6, 0, 3);
      quick.footer = toolSetting(key);
    } else if (page === 'palette') {
      // The palette under the highlight is tried as it is passed; the left stick sets the spin.
      if (quick.highlight !== state.palette) setPalette(quick.highlight);
      const ly = intent.axes.left[1];
      if (ly) {
        tools.spin = THREE.MathUtils.clamp((tools.spin ?? state.colorSpin) + ly * dt * (SPIN_EASE + Math.abs(tools.spin ?? state.colorSpin)), -SPIN_MAX, SPIN_MAX);
        const spin = Math.round(tools.spin / SPIN_STEP) * SPIN_STEP;
        if (spin !== state.colorSpin) {
          state.colorSpin = spin; notify('colorSpin');
          if (spin) knob.resume = spin;
          tools.quickMoved = true;
        }
      } else tools.spin = state.colorSpin;
      quick.footer = `spin ${state.colorSpin.toFixed(3)} turns/s (left stick)`;
    } else quick.footer = page === 'marks' && !bookmarks.list.length ? 'gps tool + left trigger saves a view' : 'release to choose; stick left/right for pages';
    quick.update();
    quick.mesh.visible = true;
  } else if (tools.quickOpen) {
    tools.quickOpen = false;
    quick.mesh.visible = false;
    const chose = qk.up && (tools.quickMoved || tools.quickT >= QUICK_TAP);
    if (state.palette !== tools.quickPalette && !(chose && quickPage() === 'palette')) setPalette(tools.quickPalette);
    dbg?.event('quick', { page: quickPage(), item: quick.items()[quick.highlight] ?? null, held: Math.round(tools.quickT * 100) / 100, chose });
    if (chose) activateQuick();
  }

  handleSculpt(shape, dt);

  // The left trigger drives the current tool (teleport is handled with the movement).
  const key = TOOLS[state.tool].key;
  viewfinder.visible = key === 'camera' && use.held;
  if (key === 'camera' && use.up) takePhoto();
  if (key === 'gps' && use.down) {
    const e = captureBookmark();
    bookmarks.add(e);
    setToolLabel(`saved ${e.name}`, 2);
  }
  if (key === 'balls') {
    if (f.kind !== '3d') { if (use.down) setToolLabel('ball gun works in 3D', 2); }
    else {
      const ry = intent.axes.right[1];
      if (use.held && ry) state.ballSpeed = THREE.MathUtils.clamp(state.ballSpeed * Math.exp(ry * dt * 1.5), 1, 40);
      tools.fireT += dt;
      if (use.down || (use.held && tools.fireT > 0.18)) {
        tools.fireT = 0;
        const { origin, dir } = aimRay(intent);
        ballGun.fire(origin, dir, state.ballSpeed, state.ballRadius, rig.scale);
      }
      if (use.held) setToolLabel(`balls ${state.ballSpeed.toFixed(1)} m/s (right stick)`);
    }
  }
  if (f.kind === '3d') {
    const de = (p) => rig.deAt(p);
    const normalAt = (p, eps) => rig.normalAt(p, eps);
    ballGun.update(dt, de, normalAt, rig.scale, rig.up());
  } else if (ballGun.balls.length) ballGun.clear();

  // Hand label and photo print lifetimes.
  const now = performance.now();
  const label = handLabels.left;
  if (now < tools.labelUntil) { label.mesh.visible = true; label.set([].concat(tools.label)); } else label.mesh.visible = false;
  if (photo.print.visible && now > photo.until) photo.print.visible = false;
  if (tools.flash > 0) tools.flash = Math.max(0, tools.flash - dt * 4);
}

function startFade(onBlack) {
  fade.target = 1;
  fade.onBlack = onBlack;
}

function updateFade(dt) {
  const rate = fade.target > fade.value ? 10 : 6;
  fade.value = THREE.MathUtils.clamp(fade.value + Math.sign(fade.target - fade.value) * rate * dt, 0, 1);
  if (fade.target === 1 && fade.value >= 1) {
    if (fade.onBlack) { fade.onBlack(); fade.onBlack = null; }
    fade.target = 0;
  }
  // The camera shutter flashes toward white by fading the opposite way.
  const dim = currentFractal().kind === '3d' ? headDim : 0;
  uShow.uFade.value = tools.flash > 0 ? -tools.flash : Math.max(fade.value, dim);
}

function updateSharedUniforms() {
  const pal = currentPalette();
  shared.uPalA.value.fromArray(pal.a);
  shared.uPalB.value.fromArray(pal.b);
  shared.uPalC.value.fromArray(pal.c);
  shared.uPalD.value.fromArray(pal.d);
  shared.uColorPhase.value = state.colorPhase + colorPhaseAcc;
  shared.uColorFreq.value = state.colorFreq;
  shared.uFoveate.value = renderer.xr.isPresenting ? state.foveate : 0;
  shared.uBackground.value = state.background;
  shared.uTime.value = (performance.now() / 1000) % 100000;
}

// Everything a 3D image is made from, set once when it begins so its bands agree.
function updateImageUniforms() {
  updateSharedUniforms();
  const f = currentFractal();
  const lvl = still.level;
  uGeo.uFractal.value = state.fractal;
  for (let k = 1; k <= 8; k++) uGeo[`uP${k}`].value = state.params[`p${k}`] ?? 0;
  uGeo.uScale.value = rig.scale;
  // Surfaces are resolved to the accumulation pixel, finer still when holding still.
  const p11 = lowCam.cameras[0].projectionMatrix.elements[5];
  uGeo.uPixelAngle.value = (2 / p11) / acc.h;
  // From a cone's axis to the corner of its block, as the angle is at the middle of the view: its widest.
  uCone.uConeAngle.value = CONE * Math.hypot(1 / (lowCam.cameras[0].projectionMatrix.elements[0] * low.eyeW), 1 / (p11 * low.usedH));
  uGeo.uConeLay.value.set(low.eyeW, low.coneW, cycle.cone ? 1 : 0);
  uGeo.uEpsMul.value = LEVEL_EPS[lvl] * state.grain;
  uGeo.uNormalPx.value = LEVEL_NORMAL[lvl];
  uGeo.uPrec.value = f.precision;
  uGeo.uMaxSteps.value = Math.round(state.maxSteps * LEVEL_STEPS[lvl]);
  uGeo.uBound.value = f.bound(state.params);
  uGeo.uAOSamples.value = state.ao ? LEVEL_AO[lvl] : 0;
  uGeo.uShadows.value = state.shadows ? 1 : 0;
  uGeo.uLightMode.value = state.lightMode === 'fixed' ? 0 : state.lightMode === 'headlamp' ? 1 : 2;
  if (state.lightMode === 'hand' && renderer.xr.isPresenting) {
    hands.right.grip.getWorldPosition(uGeo.uLightPos.value);
  } else {
    const q = rig.camera.getWorldQuaternion(new THREE.Quaternion());
    const off = new THREE.Vector3(0.35, 0.5, 0).applyQuaternion(q).multiplyScalar(rig.scale);
    uGeo.uLightPos.value.copy(rig.headWorld()).add(off);
  }
  uAcc.uAmbient.value = state.ambient;
  // Gather kernel width: narrow is crisper, wide is smoother.
  uAcc.uSigma.value = THREE.MathUtils.lerp(0.6, 0.25, state.sharpness);
  uAcc.uDistMin.value = 0.01 * rig.scale; // one room centimetre
}

function updateUniforms(dt) {
  if (!knob.held) colorPhaseAcc = (colorPhaseAcc + state.colorSpin * dt) % PHASE_WRAP;
  uShow.uFbSize.value.copy(fbSize);
  uShow.uVignette.value = state.vignette && renderer.xr.isPresenting ? 0.8 : 0;
  uShow.uEdgeBlend.value = state.edgeBlend ? 1 : 0;
  const f = currentFractal();
  if (f.kind === '3d') return;
  updateSharedUniforms();
  u2d.uWorldFromRoom.value.copy(rig.dolly.matrixWorld);
  u2d.uRoomFromWorld.value.copy(rig.dolly.matrixWorld).invert();
  u2d.uLayout.value = state.layout2d;
  u2d.uFormula.value = FORMULAS[f.formula].id;
  u2d.uStep.value = FORMULAS[f.formula].step;
  u2d.uScale.value = view2d.scale;
  u2d.uRot.value = view2d.rot;
  const c = view2d.centerFloat();
  u2d.uCenterF.value.set(c[0], c[1]);
  const jc = f.formula === 'julia' ? [state.params.p1, state.params.p2] : c;
  u2d.uJuliaC.value.set(jc[0], jc[1]);
  u2d.uJuliaSky.value = state.julia && f.formula !== 'julia' ? 1 : 0;
  u2d.uMaxIter.value = view2d.maxIter;
  u2d.uRef.value = view2d.ref.texture;
  u2d.uRefLen.value = view2d.ref.length;
  u2d.uTunnelL.value = state.tunnelL;
  plane.setIteration({ formula: u2d.uFormula.value, step: u2d.uStep.value, centerF: c, juliaC: jc, ref: view2d.ref.texture, refLen: view2d.ref.length });
}

// Fill and refine the pyramid, then hand its lookup tables to the eye pass.
function updatePlane() {
  updateGaze();
  updateFootprint();
  const jc = u2d.uJuliaC.value;
  const julia = u2d.uJuliaSky.value === 1 || currentFractal().formula === 'julia' ? { c: [jc.x, jc.y], cap: Math.min(view2d.maxIter, 300) } : null;
  plane.update({ view: view2d, gaze: gaze.c, base: view2d.maxIter, target: still.cap2d, rho: footprint.rho, budget: planeCtl.budget, julia, ceiling: state.iterAuto ? state.maxIter : 0 });
  plane.fillEyeUniforms(u2d, view2d);
}

function updateHud(now) {
  hud.mesh.visible = state.hud && renderer.xr.isPresenting;
  hud.dom.style.display = state.hud && !renderer.xr.isPresenting ? 'block' : 'none';
  if (!state.hud || now - hud.last < 500) return;
  hud.set(app.describe(), now);
}

// Console hook. shot() saves a centre crop of the next desktop frame through the server;
// drive() runs frames from a timer, which the embedded test browser does not throttle.
const shots = [];
window.fv = {
  state, notify, rig, view2d, app, uGeo, uCone, uAcc, uShow, u2d, panel, pointers, renderer, taa, still, dyn, cycle, cost, tune, motion, plane, acc, low, passes, fade, perf,
  tools, ballGun, bookmarks, quick, tour, startTour, endTour, photo, takePhoto, captureBookmark, restoreBookmark, twin, hands, knob, grab, surfaceUnder,
  accRT: () => accRT, gRT: () => gRT, coneRT: () => coneRT, look: (y, p) => { yaw = y; pitch = p; }, deskHead,
  shot: (name, w = 560, h = 420, dy = 0) => new Promise((res, rej) => shots.push({ name, w, h, dy, res, rej })),
  drive: (ms) => { renderer.setAnimationLoop(null); setInterval(frame, ms); },
  frame, // one frame, for callers that stopped the animation loop and step it themselves
  present: () => { renderer.setRenderTarget(null); renderer.render(scene, twin.on ? twin.pair : rig.camera); }, // the last frame's present pass again, as fv.uShow now is
  headTrace, headMotion, report: () => saveReport(), renderEyes,
  // Desktop head motion: fv.headSim({ sway, jitter, rot, rotJitter }) (metres, degrees) or null.
  headSim: (opts = {}) => headMotion.simulate(opts),
  // Reproduce a saved report: its view, state and recorded head motion.
  loadReport: async (name) => {
    const d = await load(name);
    restoreBookmark(d.bookmark);
    headMotion.play(d.trace);
    return d;
  },
};

// Also reports mean absolute Laplacian of the luminance (high-frequency content).
function saveShot(s) {
  const src = renderer.domElement;
  const c = document.createElement('canvas');
  c.width = s.w; c.height = s.h;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, (src.width - s.w) / 2, (src.height - s.h) / 2 + s.dy, s.w, s.h, 0, 0, s.w, s.h);
  const d = ctx.getImageData(0, 0, s.w, s.h).data;
  const lum = (i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  let sum = 0, n = 0;
  for (let y = 1; y < s.h - 1; y++) for (let x = 1; x < s.w - 1; x++) {
    const i = 4 * (y * s.w + x);
    sum += Math.abs(4 * lum(i) - lum(i - 4) - lum(i + 4) - lum(i - 4 * s.w) - lum(i + 4 * s.w));
    n++;
  }
  const detail = sum / n;
  store(s.name, c.toDataURL('image/jpeg', 0.9)).then((file) => s.res({ file, detail, data: d, w: s.w, h: s.h }), s.rej);
}

// The 2D plane's part of a telemetry frame; null in 3D.
function planeFrame() {
  if (currentFractal().kind === '3d') return null;
  const s = plane.stats;
  return {
    u: Math.round(s.units), b: Math.round(planeCtl.budget), tx: s.texels, lv: [s.valid, s.filling, s.refining, s.idle],
    cap: [view2d.maxIter, still.cap2d], need: [plane.need.move, plane.need.still, plane.need.probed], dbl: Math.round(view2d.doublings() * 100) / 100, lay: state.layout2d,
  };
}

// What the edition runs beside the app (src/edition.js): here, telemetry in debug builds.
let dbg = null;
startEdition({
  renderer, state, rig, still, dyn, cycle, cost, motion, acc, low, perf, fbSize, app, onChange, notify, planeFrame, aimFrame,
  saveReport, renderEyes, eyeCameras, upload: store, setToolLabel,
}).then((h) => {
  if (!h) return;
  dbg = h;
  window.fv.dbg = dbg;
  dbg.event('settings', settings);
}, (e) => console.error('edition failed to start', e));

// A page the browser brought back from its own copy may be an old build: the live one, then.
const fresh = () => { if (!renderer.xr.isPresenting) checkBuild(__BUILD__).catch((e) => console.error('build check failed', e)); };
fresh();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') fresh(); });
window.addEventListener('pageshow', (e) => { if (e.persisted) fresh(); });

const input = new Input(renderer, hands);
// The choices kept from the last visit, each taken up as the menu would have set it.
const settings = restore();
for (const key of Object.keys(settings.took)) notify(key);
if (Object.keys(settings.lapsed).length) console.warn('settings kept from before no longer apply', settings.lapsed);
app.selectFractal(0);
setPalette(state.palette);

const clock = new THREE.Clock();
renderer.setAnimationLoop(frame);
function frame() {
  dbg?.frameStart();
  readCost();
  measureCost();
  plane.poll();
  plane.measure();
  const dt = Math.min(clock.getDelta(), 0.1);
  perf.acc += dt; perf.n++; perf.window += dt;
  if (perf.acc > 0.5) { perf.fps = perf.n / perf.acc; perf.ms = 1000 * perf.acc / perf.n; perf.acc = 0; perf.n = 0; }
  updateDynamicRes(dt);

  const intent = input.poll();
  dbg?.intent(intent);
  // The runtime may deliver frames with no viewer pose (session start).
  if (renderer.xr.isPresenting && renderer.xr.getCamera().cameras.length === 0) return;
  if (!intent.xr) {
    rig.camera.rotation.set(pitch, yaw, 0, 'YXZ');
    rig.camera.position.copy(deskHead);
    if (headMotion.active) headMotion.apply(rig.camera, deskHead);
    rig.camera.updateMatrixWorld();
  }
  if (intent.menu) app.togglePanel();
  if (intent.report && REPORTS) saveReport().catch(() => {}); // saveReport logs and shows its errors
  if (intent.recenter) { if (currentFractal().kind === '3d') app.resetView(); else app.recenter(); }
  const turn = (intent.nextFractal ? 1 : 0) - (intent.prevFractal ? 1 : 0);
  if (turn) app.selectFractal(ORDER[(ORDER.indexOf(state.fractal) + turn + ORDER.length) % ORDER.length]);
  if (intent.nextPalette) { setPalette(state.palette + 1); keep('palette'); }
  if (intent.latch && !tools.holding) cruiseLatch(intent.latchDir);
  if (intent.tour) app.tour();
  if (intent.toolPick && TOOLS[intent.toolPick - 1]) { state.tool = intent.toolPick - 1; notify('tool'); }
  // A trigger pressed away from the windows closes the menu and is otherwise ignored.
  const MISS = 0.1; // metres from a window's edge
  for (const h of ['left', 'right']) {
    if (!intent.trigger[h].pressed) tools.consumed[h] = false;
    if (state.panelOpen && intent.trigger[h].down && !pointers.busy(h)) {
      // Just beside a window is a miss, not a wish to be rid of it.
      const off = pointers.off[h];
      dbg?.event('menu.away', { hand: h, off: Number.isFinite(off) ? Math.round(off * 1000) / 1000 : null, closed: off > MISS });
      if (off > MISS) app.togglePanel(false);
      tools.consumed[h] = true;
    }
  }

  // Thumbstick over a menu slider nudges it instead of moving.
  for (const h of ['left', 'right']) {
    const aim = pointers.aim[h];
    if (aim && intent.xr && aim.panel === panel) {
      const axis = intent.axes[h][0];
      if (Math.abs(axis) > 0.3 && panel.nudge(aim.x, aim.y, axis * dt * 0.5)) { intent.fly = [0, 0]; intent.climb = 0; intent.turn = 0; intent.zoom = 0; }
    }
  }

  ensureRenderTargets(performance.now());
  tagControllerModels();
  if (renderer.xr.isPresenting) renderer.xr.updateCamera(rig.camera);
  pointers.update(intent, rig.camera, dt);
  handleGrab(intent, dt);
  handleColour(intent, dt);
  stickYaw = 0;
  handleTools(intent, dt);
  updateTour(intent, dt);
  if (currentFractal().kind === '3d') handle3D(intent, dt); else handle2D(intent, dt);
  updateFade(dt);
  // After the fade: in its black a bookmark or a tour may have put another fractal on show.
  const is3d = currentFractal().kind === '3d';
  controls.draw(state.controls);

  rig.dolly.updateMatrixWorld(true);
  if (renderer.xr.isPresenting) renderer.xr.updateCamera(rig.camera);
  updateTwin();
  updateStillness(dt);
  headTrace.record({ t: performance.now(), dt, camera: rig.camera, dolly: rig.dolly, intent, still, dynScale: dyn.scale, fps: perf.fps });
  updateUniforms(dt);
  panel.update(performance.now());
  updateHud(performance.now());

  const xrRT = renderer.getRenderTarget();
  renderer.xr.enabled = false;
  if (is3d) {
    // Black: whatever is on show is from before the cut.
    if (fade.value >= 1) { cycle.at = 0; cycle.whole = true; cycle.detail = null; }
    updateMotion(dt);
    renderImage();
    showImage();
  } else {
    cycle.at = 0;
    cycle.whole = true;
    motion.has = false;
    dbg?.gpuBegin('plane');
    updatePlane();
    dbg?.gpuEnd();
  }
  renderer.setRenderTarget(xrRT);
  renderer.xr.enabled = true;
  screenMesh.visible = passes.final;
  while (screenAgain.length < passes.times - 1) {
    const again = fsMesh(screenMesh.material);
    again.renderOrder = -1;
    scene.add(again);
    screenAgain.push(again);
  }
  for (let i = 0; i < screenAgain.length; i++) { screenAgain[i].visible = passes.final && i < passes.times - 1; screenAgain[i].material = screenMesh.material; }
  dbg?.gpuBegin('final');
  renderer.render(scene, twin.on && !renderer.xr.isPresenting ? twin.pair : rig.camera);
  dbg?.gpuEnd();
  if (shots.length && !renderer.xr.isPresenting) saveShot(shots.shift());
  dbg?.frameEnd(dt, intent);
}
