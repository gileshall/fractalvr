import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const { state, DEFAULTS, CHOICES } = await import('../src/state.js');
const { keep, restore, kept, forget, KEPT } = await import('../src/prefs.js');

const KEY = 'fractalvr.settings';
// A new visit: the page as it loads, the store as it was left.
const visit = () => { for (const k of Object.keys(DEFAULTS)) if (k !== 'params') state[k] = DEFAULTS[k]; return restore(); };
const choose = (key, value) => { state[key] = value; keep(key); };

test('a choice is there at the next visit, and the visit after', () => {
  store.clear();
  choose('controls', 'heli');
  choose('flySpeed', 1.5);
  choose('vignette', true);
  choose('palette', 3);
  for (let n = 0; n < 2; n++) {
    const { took, lapsed } = visit();
    assert.deepEqual(took, { controls: 'heli', flySpeed: 1.5, vignette: true, palette: 3 });
    assert.deepEqual(lapsed, {});
    assert.equal(state.controls, 'heli');
    assert.equal(state.flySpeed, 1.5);
    assert.equal(state.vignette, true);
    assert.equal(state.palette, 3);
  }
});

test('a setting put back as it came is not kept', () => {
  store.clear();
  choose('moveDir', 'hand');
  assert.deepEqual(kept(), ['moveDir']);
  choose('moveDir', DEFAULTS.moveDir);
  assert.deepEqual(kept(), []);
  assert.deepEqual(visit().took, {});
});

test('what sets the image\'s cost, the place and its colours are not kept', () => {
  store.clear();
  for (const key of ['resScale', 'grain', 'maxSteps', 'ao', 'maxIter', 'fractal', 'colorPhase', 'colorSpin', 'fall', 'fallRate', 'armLength', 'panelOpen']) {
    assert.equal(KEPT[key], undefined, key);
    choose(key, typeof DEFAULTS[key] === 'boolean' ? !DEFAULTS[key] : DEFAULTS[key] + 1);
  }
  assert.deepEqual(kept(), []);
  for (const key of Object.keys(KEPT)) assert.ok(key in DEFAULTS, key);
});

test('a choice lapses where the build has changed the default it was made over', () => {
  store.clear();
  store.set(KEY, JSON.stringify({ background: { value: 1, over: (DEFAULTS.background + 1) % 6 }, hud: { value: !DEFAULTS.hud, over: DEFAULTS.hud } }));
  const { took, lapsed } = visit();
  assert.deepEqual(took, { hud: !DEFAULTS.hud });
  assert.deepEqual(Object.keys(lapsed), ['background']);
  assert.equal(state.background, DEFAULTS.background);
  assert.deepEqual(kept(), ['hud']);
});

test('a choice lapses where it is no longer one, or no longer kept', () => {
  store.clear();
  store.set(KEY, JSON.stringify({
    controls: { value: 'yoke', over: DEFAULTS.controls },
    palette: { value: 999, over: DEFAULTS.palette },
    layout2d: { value: 1.5, over: DEFAULTS.layout2d },
    flySpeed: { value: '3', over: DEFAULTS.flySpeed },
    vignette: { value: 1, over: DEFAULTS.vignette },
    resScale: { value: 0.3, over: DEFAULTS.resScale },
    turnMode: { value: CHOICES.turnMode.find((m) => m !== DEFAULTS.turnMode), over: DEFAULTS.turnMode },
  }));
  const { took, lapsed } = visit();
  assert.deepEqual(Object.keys(took), ['turnMode']);
  assert.deepEqual(Object.keys(lapsed).sort(), ['controls', 'flySpeed', 'layout2d', 'palette', 'resScale', 'vignette']);
  for (const key of Object.keys(lapsed)) assert.equal(state[key], DEFAULTS[key], key);
  assert.deepEqual(kept(), ['turnMode']);
});

test('a store that is not what was written fails the visit', () => {
  store.clear();
  store.set(KEY, '{"controls":');
  assert.throws(() => visit(), SyntaxError);
});

test('forgotten, nothing is kept', () => {
  store.clear();
  choose('lightMode', 'hand');
  forget();
  assert.deepEqual(kept(), []);
  assert.deepEqual(visit().took, {});
  assert.equal(state.lightMode, DEFAULTS.lightMode);
});

test('where a window was put down is kept, and only a place of three numbers', () => {
  forget();
  state.menuAt = [0.4, 1.1, -1.2];
  keep('menuAt');
  state.menuAt = DEFAULTS.menuAt;
  assert.deepEqual(restore().took, { menuAt: [0.4, 1.1, -1.2] });
  assert.deepEqual(state.menuAt, [0.4, 1.1, -1.2]);
  state.menuAt = DEFAULTS.menuAt;
  localStorage.setItem('fractalvr.settings', JSON.stringify({ menuAt: { value: [1, 2], over: null }, controlsAt: { value: [1, 2, null], over: null } }));
  const r = restore();
  assert.deepEqual(r.took, {});
  assert.deepEqual(Object.keys(r.lapsed).sort(), ['controlsAt', 'menuAt']);
  assert.equal(state.menuAt, null);
  forget();
});
