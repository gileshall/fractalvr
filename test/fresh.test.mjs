import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshness } from '../src/fresh.js';

const a = { sha: 'aaa', time: '1' }, b = { sha: 'bbb', time: '2' };

test('the live build is left alone; another is reloaded for once', () => {
  assert.equal(freshness(a, a, null), 'ok');
  assert.equal(freshness(a, a, 'bbb 2'), 'ok');
  assert.equal(freshness(a, b, null), 'reload');
  assert.equal(freshness(a, b, 'ccc 0'), 'reload');
  assert.equal(freshness(a, b, 'bbb 2'), 'stuck');
});

test('a rebuild of the same commit is another build', () => {
  assert.equal(freshness(a, { sha: 'aaa', time: '3' }, null), 'reload');
});
