import { FRACTALS, PALETTES } from './fractals.js';

// All user-facing settings live here. The UI binds to these keys directly.
export const ARM = 1; // room metres the nearest surface is kept at, until told otherwise

// What a setting named by a word may be.
export const CHOICES = {
  lightMode: ['fixed', 'headlamp', 'hand'],
  controls: ['standard', 'heli'], // heli is mode 2: left stick climb/yaw, right stick pitch/roll
  moveDir: ['hand', 'head'],
  turnMode: ['snap', 'smooth'],
};

export const state = {
  fractal: 0,
  params: {}, // p1..p4 for the current fractal
  palette: 8, // index into PALETTES: Dusk. Bookmarks hold these indices: add palettes at the end
  colorFreq: 1,
  colorPhase: 0,
  colorSpin: 0, // palette rotations per second

  // lighting
  lightMode: 'headlamp',
  ambient: 0.35,

  // movement
  controls: 'standard',
  moveDir: 'head',
  turnMode: 'smooth',
  snapAngle: 30,
  flySpeed: 3, // room m/s cap at full stick
  deSpeed: true, // speed proportional to distance from surface
  collide: true,
  standoff: 0.03, // room metres kept clear of surfaces (small, so holes stay passable)
  autoZoom: true, // your size follows the nearest surface (kept at armLength); A/B set the arm
  armLength: ARM,
  vignette: false,
  teleportZoom: false,
  taa: true, // accumulate jittered samples into the eye-resolution history
  refine: true, // raise ray steps, surface detail and 2D iterations while holding still
  sharpness: 0.6, // 0 smooth .. 1 crisp (accumulation kernel width)
  edgeBlend: true, // blend silhouettes with the surface behind by accumulated coverage

  // tools (left trigger uses the tool; the quick menu on the right trigger picks one)
  tool: 0, // index into TOOLS
  teleportZoomStep: 0.5, // doublings zoomed in per 2D jump
  ballSpeed: 6, // room m/s
  ballRadius: 0.03, // room metres

  // scene
  background: 4, // index into BACKGROUNDS: the gradient, the cheapest to shade

  // 2D
  layout2d: 2,
  fall: false,
  fallRate: 0.5, // doublings per second the cruise zooms: in, or out where negative
  autoSteer: true,
  iterAuto: true,
  maxIter: 4000,
  julia: true, // Julia set of the centre on the sky / back wall
  tunnelL: 1.0, // tunnel metres per doubling

  // render
  resScale: 0.6, // upper bound for the geometry sample target
  histScale: 1.0, // accumulation history resolution relative to the eye buffer
  dynamicRes: true, // hold the refresh rate: spread a 3D image over frames, lower the 2D texel budget
  maxSteps: 256,
  grain: 2, // the size of what a surface is resolved to while moving, in pixels: finer is rougher, and slower
  ao: true,
  shadows: false,
  foveate: 0,
  ffr: 1, // headset fixed foveation of the eye buffers (0 off, 1 strongest)
  frameRate: 72,

  // ui
  panelOpen: false,
  controlsOpen: true, // controls map shown alongside the menu
  menuAt: null, // [x, y, z] in the room where the menu was last put down by hand
  controlsAt: null, // and the controls map
  hud: false,
};

// The settings as a build comes.
export const DEFAULTS = Object.freeze({ ...state, params: Object.freeze({}) });

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); }
export function notify(key) { for (const fn of listeners) fn(key); }

export function currentFractal() { return FRACTALS[state.fractal]; }
export function currentPalette() { return PALETTES[state.palette]; }

export function setFractal(i) {
  state.fractal = ((i % FRACTALS.length) + FRACTALS.length) % FRACTALS.length;
  const f = currentFractal();
  state.params = {};
  for (const p of f.params) state.params[p.key] = p.def;
  state.colorFreq = f.colorFreq;
  notify('fractal');
}

export function setPalette(i) {
  state.palette = ((i % PALETTES.length) + PALETTES.length) % PALETTES.length;
  notify('palette');
}
