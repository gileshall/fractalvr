import { FRACTALS, ORDER, PALETTES, LAYOUTS_2D, FALL_TARGETS } from './fractals.js';
import { state, notify, setPalette, currentFractal, CHOICES } from './state.js';
import { keep } from './prefs.js';
import { Panel } from './ui.js';
import { TOOLS, BACKGROUNDS } from './tools.js';

// Builds the main window. `app` supplies actions and live readouts.
export function buildMenu(app, upload) {
  const panel = new Panel({ title: 'fractalvr', width: 800, height: 1360, meters: 0.6, upload });
  panel.onClose = () => app.togglePanel(false);

  const slider = (text, key, min, max, step, opts = {}) => ({
    type: 'slider', text, min, max, step, log: !!opts.log, fine: opts.fine, fmt: opts.fmt,
    get: () => state[key],
    set: (v) => { state[key] = v; notify(key); keep(key); },
  });
  const toggle = (text, key) => ({
    type: 'toggle', text,
    get: () => state[key],
    set: (v) => { state[key] = v; notify(key); keep(key); },
  });
  const select = (text, key, options, onSet) => ({
    type: 'select', text, options,
    get: () => (typeof state[key] === 'number' ? state[key] : options.indexOf(state[key])),
    set: (i) => { state[key] = typeof state[key] === 'number' ? i : options[i]; notify(key); keep(key); if (onSet) onSet(i); },
  });

  const fractalTab = () => {
    const f = currentFractal();
    const w = [
      { type: 'select', text: 'fractal', options: ORDER.map((i) => FRACTALS[i].name), get: () => ORDER.indexOf(state.fractal), set: (i) => { app.selectFractal(ORDER[i]); } },
      { type: 'label', text: `${f.name} parameters` },
    ];
    for (const p of f.params) {
      w.push({
        type: 'slider', text: p.name, min: p.min, max: p.max, step: p.step,
        get: () => state.params[p.key],
        set: (v) => { state.params[p.key] = v; notify('params'); },
      });
    }
    if (f.params.length === 0) w.push({ type: 'text', lines: () => ['no parameters; use the 2D tab'] });
    w.push({ type: 'button', text: 'reset parameters', onClick: () => { for (const p of f.params) state.params[p.key] = p.def; notify('params'); } });
    w.push({ type: 'button', text: 'reset view', onClick: () => app.resetView() });
    return w;
  };

  const colorTab = () => [
    { type: 'select', text: 'palette', options: PALETTES.map((p) => p.name), get: () => state.palette, set: (i) => { setPalette(i); keep('palette'); } },
    slider('phase', 'colorPhase', 0, 1, 0.001),
    slider('spin (cycles/s)', 'colorSpin', -0.5, 0.5, 0, { fine: 0.002 }),
    slider('frequency', 'colorFreq', 0.05, 5, 0.01, { log: true }),
    { type: 'button', text: 'stop spin', onClick: () => { state.colorSpin = 0; notify('colorSpin'); } },
    { type: 'label', text: 'lighting (3D)' },
    select('light', 'lightMode', CHOICES.lightMode),
    slider('ambient', 'ambient', 0, 1, 0.01),
  ];

  const moveTab = () => [
    { type: 'select', text: 'controls', options: ['standard', 'heli mode 2'], get: () => CHOICES.controls.indexOf(state.controls), set: (i) => { state.controls = CHOICES.controls[i]; notify('controls'); keep('controls'); } },
    select('fly direction', 'moveDir', CHOICES.moveDir),
    select('turn', 'turnMode', CHOICES.turnMode),
    slider('snap angle', 'snapAngle', 15, 90, 15, { fmt: (v) => `${v}°` }),
    slider('fly speed (m/s)', 'flySpeed', 0.1, 10, 0.1, { log: true }),
    toggle('speed scales with distance to surface', 'deSpeed'),
    toggle('collide with surface', 'collide'),
    slider('standoff (m)', 'standoff', 0.02, 1, 0.01, { log: true }),
    toggle('auto zoom: keep surface at arm length', 'autoZoom'),
    slider('arm length (m)', 'armLength', 0.1, 5, 0.05, { log: true }),
    { type: 'button', text: 'tour: sit back and be taken places', onClick: () => app.tour() },
    toggle('cruise: travel on its own where you look', 'fall'),
    slider('cruise speed (doublings/s, minus is out)', 'fallRate', -4, 4, 0, { fine: 0.02, fmt: (v) => v.toFixed(2) }),
    toggle('zoom to surface after teleport', 'teleportZoom'),
    toggle('comfort vignette', 'vignette'),
    { type: 'button', text: 'reset view', onClick: () => app.resetView() },
  ];

  const tab2d = () => [
    select('layout', 'layout2d', LAYOUTS_2D, () => app.recenter()),
    toggle('Julia sky / back wall', 'julia'),
    toggle('cruise: zoom on its own', 'fall'),
    slider('cruise speed (doublings/s, minus is out)', 'fallRate', -4, 4, 0, { fine: 0.02, fmt: (v) => v.toFixed(2) }),
    toggle('cruising in steers to the boundary', 'autoSteer'),
    { type: 'select', text: 'fall target', options: FALL_TARGETS.map((t) => t.name), get: () => -1, set: (i) => app.jumpToTarget(FALL_TARGETS[i]) },
    toggle('iterations adapt to the view', 'iterAuto'),
    slider('iteration ceiling', 'maxIter', 100, 16000, 50, { log: true, fmt: (v) => String(Math.round(v)) }),
    slider('tunnel: metres per doubling', 'tunnelL', 0.25, 4, 0.05, { log: true }),
    { type: 'button', text: 'home view', onClick: () => app.resetView() },
    { type: 'text', lines: () => app.describe2d() },
  ];

  const renderTab = () => [
    slider('samples per frame (max)', 'resScale', 0.25, 1.5, 0.05, { fmt: (v) => `${Math.round(v * 100)}%` }),
    toggle('hold the refresh rate (image spread over frames)', 'dynamicRes'),
    slider('history resolution', 'histScale', 0.5, 1.0, 0.05, { fmt: (v) => `${Math.round(v * 100)}%` }),
    toggle('accumulate samples over time', 'taa'),
    slider('sharpness', 'sharpness', 0, 1, 0.05),
    toggle('blend silhouettes', 'edgeBlend'),
    toggle('refine while still (steps, detail, iterations)', 'refine'),
    slider('surface grain (finer is rougher, and slower)', 'grain', 1, 4, 0.25, { fmt: (v) => `${v.toFixed(2)} px` }),
    slider('ray steps (moving)', 'maxSteps', 24, 400, 4, { fmt: (v) => String(Math.round(v)) }),
    slider('peripheral reduction', 'foveate', 0, 0.9, 0.05, { fmt: (v) => `${Math.round(v * 100)}%` }),
    slider('headset foveation (coarser edges, faster)', 'ffr', 0, 1, 1 / 3, { fmt: (v) => ['off', 'low', 'medium', 'high'][Math.round(v * 3)] }),
    toggle('ambient occlusion', 'ao'),
    toggle('soft shadows (expensive)', 'shadows'),
    { type: 'select', text: 'refresh rate', options: app.frameRates().map((r) => `${r}`), get: () => app.frameRates().indexOf(app.currentFrameRate()), set: (i) => app.setFrameRate(app.frameRates()[i]) },
    toggle('HUD readout (top right)', 'hud'),
    toggle('controls map beside the menu', 'controlsOpen'),
  ];

  const toolsTab = () => [
    { type: 'select', text: 'tool (left trigger)', options: TOOLS.map((t) => t.name), get: () => state.tool, set: (i) => { state.tool = i; notify('tool'); } },
    { type: 'text', lines: () => [TOOLS[state.tool].hint] },
    slider('2D jump zoom (doublings)', 'teleportZoomStep', 0, 3, 0.05),
    toggle('3D: zoom to surface after teleport', 'teleportZoom'),
    slider('ball speed (m/s)', 'ballSpeed', 1, 40, 0.5, { log: true }),
    slider('ball radius (m)', 'ballRadius', 0.01, 0.2, 0.005, { log: true }),
    { type: 'button', text: 'clear balls', onClick: () => app.clearBalls() },
    { type: 'label', text: 'scene' },
    { type: 'select', text: 'background', options: BACKGROUNDS, get: () => state.background, set: (i) => { state.background = i; notify('background'); keep('background'); } },
    { type: 'text', lines: () => ['passthrough shows the room only in a passthrough session', '(the second button on the page)'] },
    { type: 'label', text: 'bookmarks' },
    { type: 'text', lines: () => app.describeBookmarks() },
    { type: 'button', text: 'bookmark this view', onClick: () => app.bookmark() },
    { type: 'button', text: 'clear bookmarks', onClick: () => app.clearBookmarks() },
  ];

  const infoTab = () => [
    { type: 'text', lines: () => app.describe() },
    { type: 'label', text: 'controls' },
    { type: 'text', lines: () => [
      'L trigger: use tool   R trigger: quick menu',
      'L grip: hold the fractal, turn and move it by hand',
      'R grip: sculpt, the hand\'s x y z change its shape',
      'Y: this menu   X: reset   A/B: zoom in/out',
      'L stick click: hold and twist to turn the colours,',
      '  let go turning to spin them; tap: spin on / off',
      'A+B: cruise on / off, A/B or the stick its speed',
      'tour (quick menu actions, Move tab): a cruise that steers',
      '  itself from place to place; turn stick: next / last,',
      '  zoom: its speed; A+B or flying ends it',
      'sticks: fly (standard or heli mode 2)',
      'stick on a slider: fine adjust',
    ] },
    { type: 'label', text: 'settings' },
    { type: 'text', lines: () => app.describeSettings() },
    { type: 'button', text: 'all settings as they come', onClick: () => app.defaultSettings() },
  ];

  panel.setTabs([
    { name: 'Fractal', widgets: fractalTab },
    { name: 'Color', widgets: colorTab },
    { name: 'Move', widgets: moveTab },
    { name: '2D', widgets: tab2d },
    { name: 'Render', widgets: renderTab },
    { name: 'Tools', widgets: toolsTab },
    { name: 'Info', widgets: infoTab },
  ]);
  return panel;
}
