import { state, DEFAULTS, CHOICES } from './state.js';
import { PALETTES, LAYOUTS_2D } from './fractals.js';
import { BACKGROUNDS } from './tools.js';

// The settings that stay as they were last chosen, from one visit to the next: how the hands
// fly and turn, the light, the palette, where a 2D fractal is laid out, what is behind it.
// What sets the image's cost is a build's to get right, and comes as the build has it.
//
// A choice is kept with the default it was made over. It lapses where a build changes that
// default (the new one was meant to be seen), and where it is no longer among the choices.

const KEY = 'fractalvr.settings';

const flag = (v) => typeof v === 'boolean';
const number = (v) => typeof v === 'number' && Number.isFinite(v);
const word = (key) => (v) => CHOICES[key].includes(v);
const index = (list) => (v) => Number.isInteger(v) && v >= 0 && v < list.length;
const place = (v) => Array.isArray(v) && v.length === 3 && v.every(number);

export const KEPT = {
  controls: word('controls'), moveDir: word('moveDir'), turnMode: word('turnMode'), snapAngle: number, flySpeed: number,
  deSpeed: flag, collide: flag, standoff: number, autoZoom: flag, vignette: flag, teleportZoom: flag,
  lightMode: word('lightMode'), ambient: number, palette: index(PALETTES),
  background: index(BACKGROUNDS), layout2d: index(LAYOUTS_2D), julia: flag, tunnelL: number, autoSteer: flag,
  ballRadius: number, controlsOpen: flag, hud: flag, menuAt: place, controlsAt: place,
};

const read = () => JSON.parse(localStorage.getItem(KEY) ?? '{}');
const write = (all) => localStorage.setItem(KEY, JSON.stringify(all));

// The setting was chosen just now: it is what the next visit starts with.
export function keep(key) {
  if (!KEPT[key]) return;
  const all = read();
  if (state[key] === DEFAULTS[key]) delete all[key];
  else all[key] = { value: state[key], over: DEFAULTS[key] };
  write(all);
}

// A visit begins: the kept choices into the state. Returns those taken, and those lapsed.
export function restore() {
  const all = read(), took = {}, lapsed = {};
  for (const [key, e] of Object.entries(all)) {
    if (KEPT[key] && e.over === DEFAULTS[key] && KEPT[key](e.value)) { state[key] = e.value; took[key] = e.value; }
    else { lapsed[key] = e; delete all[key]; }
  }
  if (Object.keys(lapsed).length) write(all);
  return { took, lapsed };
}

export const kept = () => Object.keys(read());

// Nothing kept any more.
export function forget() { localStorage.removeItem(KEY); }
