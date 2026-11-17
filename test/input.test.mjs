import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.addEventListener = () => {};
const { Input } = await import('../src/input.js');

const button = (pressed) => ({ pressed, value: pressed ? 1 : 0 });
const controller = (handedness, { trigger = false, axes = [0, 0, 0, 0] } = {}) => ({
  handedness, gamepad: { buttons: [button(trigger), button(false), button(false), button(false), button(false), button(false)], axes },
});
const hand = (handedness, pinch) => ({ handedness, hand: {}, gamepad: { buttons: [button(pinch)], axes: [] } });
const input = (sources) => new Input({ xr: { getSession: () => ({ inputSources: sources }) } }, {});

test('a controller flies and its trigger presses', () => {
  const sources = [controller('left', { trigger: true, axes: [0, 0, 1, 0] }), controller('right')];
  const intent = input(sources).poll();
  assert.equal(intent.trigger.left.down, true);
  assert.deepEqual(intent.fly, [1, -0]);
});

test('a tracked hand is no controller: its pinch presses nothing and nothing is not a number', () => {
  const sources = [hand('left', true), hand('right', true)];
  const intent = input(sources).poll();
  for (const h of ['left', 'right']) {
    assert.equal(intent.trigger[h].pressed, false);
    assert.equal(intent.trigger[h].down, false);
  }
  for (const v of [...intent.fly, intent.turn, intent.zoom, intent.climb, ...intent.axes.left, ...intent.axes.right]) assert.equal(v, 0);
});

test('a controller put down with its trigger in lets go without a release', () => {
  const sources = [controller('left', { trigger: true }), controller('right')];
  const i = input(sources);
  i.poll();
  sources[0] = hand('left', false);
  const intent = i.poll();
  assert.equal(intent.trigger.left.pressed, false);
  assert.equal(intent.trigger.left.up, false);
});
