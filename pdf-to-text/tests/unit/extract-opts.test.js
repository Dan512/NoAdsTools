import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsOcr, assembleText, outName } from '../../js/extract-opts.js';

test('needsOcr true when stripped text is below the floor', () => {
  assert.equal(needsOcr('', 8), true);
  assert.equal(needsOcr('   \n  ', 8), true);
  assert.equal(needsOcr('ab', 8), true);
  assert.equal(needsOcr('hello world', 8), false);
});
test('assembleText joins pages with --- Page N --- separators', () => {
  const s = assembleText([{ text: 'one' }, { text: 'two' }]);
  assert.match(s, /--- Page 1 ---\none/);
  assert.match(s, /--- Page 2 ---\ntwo/);
});
test('assembleText keeps empty pages as empty sections', () => {
  const s = assembleText([{ text: '' }, { text: 'x' }]);
  assert.match(s, /--- Page 1 ---/);
  assert.match(s, /--- Page 2 ---\nx/);
});
test('assembleText numbers sections by each page\'s source page number', () => {
  const s = assembleText([{ page: 5, text: 'e' }, { page: 6, text: 'f' }]);
  assert.match(s, /--- Page 5 ---\ne/); assert.match(s, /--- Page 6 ---\nf/);
});
test('outName appends .txt to the stem', () => {
  assert.equal(outName('report'), 'report.txt');
});
