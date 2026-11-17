import test from 'node:test';
import assert from 'node:assert/strict';

const ctx = new Proxy({}, { get: (o, k) => (k === 'measureText' ? (t) => ({ width: t.length * 16 }) : () => {}), set: () => true });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
const { Panel } = await import('../src/ui.js');

function panel() {
  const p = new Panel({ title: 't', width: 800, height: 1320 });
  const s = { pressed: 0, on: false, pick: 0, v: 0.5 };
  p.setTabs([
    { name: 'One', widgets: () => [
      { type: 'label', text: 'a label' },
      { type: 'button', text: 'go', onClick: () => { s.pressed++; } },
      { type: 'toggle', text: 'flag', get: () => s.on, set: (v) => { s.on = v; } },
      { type: 'select', text: 'which', options: ['aa', 'bb', 'cc'], get: () => s.pick, set: (v) => { s.pick = v; } },
      { type: 'slider', text: 'much', min: 0, max: 1, get: () => s.v, set: (v) => { s.v = v; } },
    ] },
    { name: 'Two', widgets: () => [{ type: 'label', text: 'other' }] },
  ]);
  return { p, s, w: Object.fromEntries(p.widgets.map((w) => [w.type, w])) };
}

test('a press just under the tabs, or in the gap between two rows, takes the nearest', () => {
  const { p, s, w } = panel();
  const tabs = p.tabHits[1];
  assert.equal(p.pointerDown('r', tabs.x + 50, tabs.y + tabs.h + 6), null);
  assert.equal(p.lastPressed, 'tab Two');
  assert.equal(p.tab, 1);
  p.pointerDown('r', 50, tabs.y + tabs.h + 6);
  assert.equal(p.tab, 0);
  const again = Object.fromEntries(p.widgets.map((x) => [x.type, x]));
  p.pointerDown('r', 400, again.button.y + again.button.h + 2); // nearer the button than the toggle
  assert.equal(s.pressed, 1);
  assert.equal(s.on, false);
  p.pointerDown('r', 400, again.toggle.y - 2);
  assert.equal(s.on, true);
  assert.ok(w.button);
});

test('a press on a label by a button takes the button; far from anything, nothing', () => {
  const { p, s, w } = panel();
  p.pointerDown('r', 400, w.label.y + w.label.h - 3);
  assert.equal(s.pressed, 1);
  p.pointerDown('r', 400, w.label.y + 8);
  assert.equal(p.lastPressed, 'label a label');
  assert.equal(s.pressed, 1);
  p.pointerDown('r', 400, 1300);
  assert.equal(p.lastPressed, 'nothing');
});

test('the title is the title to its edge, and what a press would take is what is lit', () => {
  const { p, w } = panel();
  assert.equal(p.pointerDown('r', 300, 55), 'title');
  p.pointerMove('r', 400, w.toggle.y - 2);
  assert.equal(p.isHot(w.toggle), true);
  p.pointerMove('r', p.tabHits[1].x + 20, p.tabHits[1].y + 10);
  assert.equal(p.isHot(p.tabHits[1]), true);
  assert.ok(p.dirtyRects.includes(p.tabHits[1]));
});

test('a choice is taken from just outside it', () => {
  const { p, s, w } = panel();
  const pill = w.select.pills[2];
  p.pointerDown('r', pill.x + pill.w / 2, pill.y + pill.h + 6);
  assert.equal(s.pick, 2);
  assert.equal(p.lastPressed, 'select which: cc');
});

test('a slider held a moment leaves only its rows of the window, and let go, all of it is back', () => {
  const { p, w } = panel();
  const box = () => { const a = p.mesh.geometry.attributes.position; return [a.getY(2), a.getY(0)]; };
  const uvs = () => Array.from(p.mesh.geometry.attributes.uv.array);
  p.update(performance.now());
  const whole = box(), wholeUv = uvs();
  assert.ok(Math.abs(whole[1] - whole[0] - p.metersH) < 1e-6);
  p.pointerDown('r', 400, w.slider.y + 40);
  p.update(performance.now());
  assert.deepEqual(box(), whole); // a press alone does not hide the rest
  p.update(performance.now() + 400);
  const cut = box();
  const rows = (w.slider.h + 36) / 1320 * p.metersH;
  assert.ok(Math.abs(cut[1] - cut[0] - rows) < 1e-6, `${cut}`);
  const uv = uvs();
  assert.ok(Math.abs(uv[1] - (w.slider.y - 18) / 1320) < 1e-6 && Math.abs(uv[5] - (w.slider.y + w.slider.h + 18) / 1320) < 1e-6);
  p.pointerUp('r');
  p.update(performance.now() + 500);
  assert.deepEqual(box(), whole);
  assert.deepEqual(uvs(), wholeUv);
});

const { sliderValue, sliderShare, sliderSnap } = await import('../src/ui.js');

test('a slider about nought: its middle is nought, and small values have as much track as large', () => {
  const w = { min: -0.5, max: 0.5, fine: 0.002 };
  assert.equal(sliderValue(w, 0.5), 0);
  assert.equal(sliderValue(w, 0.53), 0);
  assert.ok(Math.abs(sliderValue(w, 1) - 0.5) < 1e-12 && Math.abs(sliderValue(w, 0) + 0.5) < 1e-12);
  for (const v of [-0.5, -0.11, -0.02, -0.002, 0, 0.002, 0.02, 0.11, 0.5]) {
    assert.ok(Math.abs(sliderValue(w, sliderShare(w, v)) - v) < 1e-9, `${v}`);
    assert.equal(sliderSnap(w, v), v);
  }
  // from 0.01 to 0.02 is as long as from 0.1 to 0.2, and a sixth of a 748 px track's half and more
  const span = (a, b) => sliderShare(w, b) - sliderShare(w, a);
  assert.ok(Math.abs(span(0.01, 0.02) - span(0.1, 0.2)) < 1e-9);
  assert.ok(span(0.01, 0.02) * 748 > 40);
  // a hand that wanders 4 px about 0.02 moves it by under a tenth
  const f = sliderShare(w, 0.02);
  assert.ok(Math.abs(sliderValue(w, f + 4 / 748) / 0.02 - 1) < 0.1);
  assert.equal(sliderSnap(w, 0.02137), 0.021);
  assert.equal(sliderSnap(w, 0.0004), 0);
  assert.equal(sliderSnap(w, 3), 0.5);
});

test('a plain slider and a log one are as they were', () => {
  const lin = { min: 0, max: 1, step: 0.01 }, log = { min: 0.1, max: 10, step: 0.1, log: true };
  assert.ok(Math.abs(sliderValue(lin, 0.25) - 0.25) < 1e-12);
  assert.ok(Math.abs(sliderValue(log, 0.5) - 1) < 1e-12);
  assert.ok(Math.abs(sliderShare(log, 1) - 0.5) < 1e-12);
  assert.ok(Math.abs(sliderSnap(lin, 0.253) - 0.25) < 1e-12);
  assert.ok(Math.abs(sliderSnap(log, 1.04) - 1) < 1e-12);
});
