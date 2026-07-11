import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveUp, moveDown, moveTo, removeAt } from '../../js/reorder.js';

test('moveUp swaps with previous; no-op at index 0', () => {
  assert.deepEqual(moveUp(['a','b','c'], 1), ['b','a','c']);
  assert.deepEqual(moveUp(['a','b','c'], 0), ['a','b','c']);
});
test('moveDown swaps with next; no-op at last', () => {
  assert.deepEqual(moveDown(['a','b','c'], 1), ['a','c','b']);
  assert.deepEqual(moveDown(['a','b','c'], 2), ['a','b','c']);
});
test('moveTo relocates an item, clamping out-of-range targets', () => {
  assert.deepEqual(moveTo(['a','b','c','d'], 0, 2), ['b','c','a','d']);
  assert.deepEqual(moveTo(['a','b','c'], 2, 0), ['c','a','b']);
  assert.deepEqual(moveTo(['a','b','c'], 1, 99), ['a','c','b']);
});
test('removeAt drops one; immutable (inputs unchanged)', () => {
  const src = ['a','b','c'];
  assert.deepEqual(removeAt(src, 1), ['a','c']);
  assert.deepEqual(src, ['a','b','c']);
});
