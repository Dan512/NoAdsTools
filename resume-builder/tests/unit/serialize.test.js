// resume-builder/tests/unit/serialize.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createResume, addItem, _resetIdsForTest, SCHEMA_VERSION } from '../../js/model.js';
import { toJson, fromJson } from '../../js/serialize.js';

beforeEach(() => _resetIdsForTest());

test('round-trip preserves content', () => {
  const r = createResume();
  r.basics.fullName = 'Ada Lovelace';
  addItem(r, r.sections[0].id).role = 'Analyst';
  const back = fromJson(toJson(r));
  assert.equal(back.ok, true);
  assert.equal(back.resume.basics.fullName, 'Ada Lovelace');
  assert.equal(back.resume.sections[0].items[1].role, 'Analyst');
});

test('malformed input table', () => {
  const cases = [
    ['not json at all', /valid JSON/i],
    ['42', /resume file/i],
    ['{"foo":1}', /resume file/i],
    [JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, sections: [] }), /newer version/i],
  ];
  for (const [text, msgRe] of cases) {
    const out = fromJson(text);
    assert.equal(out.ok, false, text);
    assert.ok(out.errors.some(e => msgRe.test(e)), `${text} → ${out.errors}`);
  }
});

test('older/partial data migrates instead of failing', () => {
  const out = fromJson(JSON.stringify({ schemaVersion: 1, basics: { fullName: 'Ada' } }));
  assert.equal(out.ok, true);
  assert.equal(out.resume.basics.fullName, 'Ada');
  assert.ok(Array.isArray(out.resume.sections));
});

test('XSS-bearing fields survive as DATA (escaping is the renderer’s job)', () => {
  const r = createResume();
  r.basics.fullName = '<img src=x onerror=alert(1)>';
  const back = fromJson(toJson(r));
  assert.equal(back.resume.basics.fullName, '<img src=x onerror=alert(1)>');
});
